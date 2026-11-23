import { expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, GenerationTask, Harness, hook } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

it("spikes a beforeRequest wait across abort and restart", async () => {
	const dir = await mkdtemp(join(tmpdir(), "usage-pause-spike-"));
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("continued")]);
	const models = createModels();
	models.setProvider(faux.provider);
	let entered = 0;
	const release = new AbortController();
	async function open() {
		const registry = createRegistry();
		registry.install(defineExtension({ name: "request-wait-spike", hooks: [hook(GenerationTask, {
			beforeRequest: async (_request, _api, taskContext) => {
				entered++;
				const signal = AbortSignal.any([release.signal, taskContext.abortSignal!]);
				if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
				taskContext.abortSignal?.throwIfAborted();
			},
		})] }));
		const storage = await openNodeSqliteStorage(join(dir, "db.sqlite"));
		return Harness.open(storage, { models, registry, settings: { retry: { baseDelayMs: 10 } } }, context);
	}
	async function waitForEntries(expected: number) {
		for (let i = 0; i < 200 && entered < expected; i++) await Bun.sleep(10);
		expect(entered).toBe(expected);
	}
	let harness = await open();
	try {
		let conversation = await harness.root(context);
		await conversation.configure({ model: { provider: "faux", modelId: "faux-1" } }, context);
		await conversation.submit({ type: "input", content: "stop this", requestId: "stop" }, context);
		await waitForEntries(1);
		await conversation.abort(context);
		expect(faux.state.callCount).toBe(0);
		await conversation.submit({ type: "input", content: "continue this", requestId: "restart" }, context);
		await waitForEntries(2);
		await Bun.sleep(250);
		expect(entered).toBe(2);
		expect(faux.state.callCount).toBe(0);
		await harness.close(context);
		harness = await open();
		conversation = await harness.root(context);
		harness.resume();
		await waitForEntries(3);
		await Bun.sleep(250);
		expect(entered).toBe(3);
		expect(faux.state.callCount).toBe(0);
		release.abort();
		for (let i = 0; i < 200 && faux.state.callCount === 0; i++) await Bun.sleep(10);
		expect(faux.state.callCount).toBe(1);
	} finally {
		await harness.close(context);
		await rm(dir, { recursive: true, force: true });
	}
});
