import { expect, it } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createHarnessModels } from "../src/models.ts";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { SetTimer } from "@earendil-works/pi-durable";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USAGE_RESET_MARGIN_MS, UsagePauseGate } from "../src/usage-pause.ts";
import { UsagePauseModels } from "../src/usage-pause-models.ts";
import { createSetup, entryText, TestClient, ViewClient } from "./support.ts";

const LOGIN = "openai-codex";
const START = Date.parse("2027-01-01T12:00:00Z");
const RESET = START + 3_600_000;
const iso = (at: number) => new Date(at).toISOString();
const CLOCK_TICK_MS = 50;

function fakeClock() {
	let now = START;
	const timers = new Map<() => void, number>();
	const setTimer: SetTimer = (fire, delay) => {
		timers.set(fire, now + delay);
		return () => { timers.delete(fire); };
	};
	return { now: () => now, setTimer, advanceTo: (time: number) => {
		now = time;
		for (const [fire, at] of timers) if (at <= now) { timers.delete(fire); fire(); }
	} };
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 4_000;
	while (!await predicate() && Date.now() < deadline) await Bun.sleep(10);
	expect(await predicate()).toBe(true);
}

it("persists a 100% hold, wakes at the latest reset plus margin, and notifies only once", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "usage-pause-"));
	const clock = fakeClock();
	const notices: string[] = [];
	const options = { dataDir, ...clock, onLimitReached: (pause: { since: string }) => notices.push(pause.since) };
	let gate = await UsagePauseGate.open(options);
	try {
		gate.observeReading(LOGIN, [{ label: "5-hour limit", usedPercent: 99, resetsAt: iso(RESET) }]);
		expect(gate.state()).toEqual([]);
		gate.observeReading(LOGIN, [
			{ label: "5-hour limit", usedPercent: 100, resetsAt: iso(RESET) },
			{ label: "Weekly limit", usedPercent: 101, resetsAt: iso(RESET + 10_000) },
		]);
		expect(gate.state()).toEqual([{ providerLogin: LOGIN, reason: "Weekly limit reached.", pausedBy: "limit-reached", since: iso(START), until: iso(RESET + 10_000 + USAGE_RESET_MARGIN_MS) }]);
		gate.close();
		gate = await UsagePauseGate.open(options);
		gate.observeReading(LOGIN, [{ label: "5-hour limit", usedPercent: 100, resetsAt: iso(RESET) }]);
		await gate.wait("anthropic");
		let sent = false;
		const waiting = gate.wait(LOGIN).then(() => { sent = true; });
		clock.advanceTo(RESET + 10_000 + USAGE_RESET_MARGIN_MS - 1);
		await Bun.sleep(0);
		expect(sent).toBe(false);
		clock.advanceTo(RESET + 10_000 + USAGE_RESET_MARGIN_MS);
		await waiting;
		expect(sent).toBe(true);
		expect(gate.state()).toEqual([]);
		expect(notices).toEqual([iso(START)]);
	} finally { gate.close(); await rm(dataDir, { recursive: true, force: true }); }
});

it("offers a conversation exemption only for the drain monitor and holds an unknown reset until explicit resume", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "usage-pause-"));
	const gate = await UsagePauseGate.open({ dataDir });
	try {
		gate.pause(LOGIN, "Fast drain", { pausedBy: "drain-monitor" });
		const revoke = gate.exempt(LOGIN, "one conversation");
		expect(gate.canSend(LOGIN)).toBe(false);
		await gate.wait(LOGIN, undefined, "one conversation");
		revoke();
		expect(gate.canSend(LOGIN, "one conversation")).toBe(false);
		gate.resume(LOGIN, "Investigation finished");
		const unknown = { label: "Usage limit", usedPercent: 100, resetsAt: null };
		gate.observeReading(LOGIN, [unknown]);
		expect(gate.state()[0]?.until).toBeUndefined();
		gate.exempt(LOGIN, "one conversation");
		const abort = new AbortController();
		const waiting = gate.wait(LOGIN, abort.signal, "one conversation");
		abort.abort(new Error("Stopped"));
		await expect(waiting).rejects.toThrow("Stopped");
		gate.resume(LOGIN, "Manual override");
		gate.observeReading(LOGIN, [unknown]);
		expect(gate.state()).toEqual([]);
		gate.observeReading(LOGIN, [{ ...unknown, usedPercent: 10 }]);
		gate.observeReading(LOGIN, [unknown]);
		expect(gate.isPaused(LOGIN)).toBe(true);
	} finally { gate.close(); await rm(dataDir, { recursive: true, force: true }); }
});

it.each([false, true])("waits before one retry on a provider denial (second denial: %s)", async failAgain => {
	const dataDir = await mkdtemp(join(tmpdir(), "usage-pause-"));
	const clock = fakeClock();
	const gate = await UsagePauseGate.open({ dataDir, ...clock });
	try {
		const faux = fauxProvider({ provider: LOGIN });
		const models = createModels();
		models.setProvider(faux.provider);
		const denied = (reset: number) => fauxAssistantMessage([], { stopReason: "error", errorMessage: `429 {"type":"usage_limit_reached","resets_at":${reset / 1_000}}` });
		faux.setResponses([denied(RESET), failAgain ? denied(RESET + 3_600_000) : fauxAssistantMessage("continued"), fauxAssistantMessage("unexpected third request")]);
		const wrapped = new UsagePauseModels({ gate, label: () => "ChatGPT", isSubscriptionLogin: async () => true, now: clock.now }).wrap(models);
		const response = wrapped.completeSimple(faux.getModel(), { messages: [] });
		await waitFor(() => gate.isPaused(LOGIN));
		expect(faux.state.callCount).toBe(1);
		clock.advanceTo(RESET + USAGE_RESET_MARGIN_MS);
		const answer = await response;
		expect(answer.stopReason).toBe(failAgain ? "error" : "stop");
		if (failAgain) expect(answer.errorMessage).toBe("ChatGPT subscription allowance exhausted.");
		expect(faux.state.callCount).toBe(2);
	} finally { gate.close(); await rm(dataDir, { recursive: true, force: true }); }
});

it("takes a confirmed Claude 429 out of SDK retries until its reset, without waiting on a network deadline", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "usage-pause-"));
	const clock = fakeClock();
	const gate = await UsagePauseGate.open({ dataDir, ...clock });
	try {
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("anthropic", async () => ({ type: "oauth", access: "example-access", refresh: "example-refresh", expires: Date.now() + 3_600_000 }));
		const models = createHarnessModels({ credentials });
		const model = models.getModels("anthropic")[0]!;
		const wrapped = new UsagePauseModels({ gate, label: () => "Claude", isSubscriptionLogin: async () => true, now: clock.now }).wrap(models);
		let sent = 0;
		const transport = Object.assign(async () => {
			sent++;
			return Response.json({ type: "error", error: { type: "rate_limit_error", message: "Allowance exhausted" } }, { status: 429, headers: {
				"anthropic-ratelimit-unified-status": "rejected",
				"anthropic-ratelimit-unified-reset": String((sent === 1 ? RESET : RESET + 3_600_000) / 1_000),
			} });
		}, { preconnect: fetch.preconnect });
		const response = wrapped.completeSimple(model, { messages: [{ role: "user", content: "Write a short greeting", timestamp: START }] }, {
			fetch: transport, maxRetries: 2, timeoutMs: 25,
		});
		await waitFor(() => gate.isPaused("anthropic"));
		await Bun.sleep(55);
		expect(sent).toBe(1);
		expect(gate.state()[0]?.until).toBe(iso(RESET + USAGE_RESET_MARGIN_MS));
		clock.advanceTo(RESET + USAGE_RESET_MARGIN_MS);
		expect((await response).errorMessage).toBe("Claude subscription allowance exhausted.");
		expect(sent).toBe(2);
	} finally { gate.close(); await rm(dataDir, { recursive: true, force: true }); }
});

it("holds a coordinator across server restart, lets another project send, and accepts Stop while waiting", async () => {
	const login = "opencode-go";
	const subscription = fauxProvider({ provider: login, models: [{ id: "test-subscription" }] });
	let usedPercent = 5;
	const endpointReset = new Date(Date.now() + 3_600_000).toISOString();
	const setup = await createSetup({ configureModels: models => models.setProvider({ ...subscription.provider,
		auth: { apiKey: { name: "Synthetic plan", resolve: async () => ({ auth: { apiKey: "example-key" } }) } },
	}), subscriptionUsage: {
		fetch: Object.assign(async () => Response.json({ usage: { rolling: { status: "ok", percent: usedPercent, resetsAt: endpointReset } } }), { preconnect: fetch.preconnect }),
	} });
	const connect = async () => {
		const client = await TestClient.open(setup.server);
		const hello = await client.request({ type: "hello", protocolVersion: 1, client: { name: "test", version: "0", features: ["in-app-alerts", "usage-pause"] } });
		expect(hello.type === "hello" && hello.features?.includes("usage-pause")).toBe(true);
		return client;
	};
	await setup.credentials.modify(login, async () => ({ type: "api_key", key: "example-key" }));
	let client = await connect();
	try {
		const subscriptionModel = { provider: login, modelId: subscription.getModel().id };
		const add = async (path: string, model = subscription.getModel()) => {
			const result = await client.request({ type: "projects.add", path });
			if (result.type !== "projects.add") throw new Error(JSON.stringify(result));
			const configured = await client.request({ type: "projects.configure", projectId: result.project.id,
				coordinatorModel: { provider: model.provider, modelId: model.id }, workerModels: [subscriptionModel] });
			expect(configured.type).toBe("projects.configure");
			return result.project.id;
		};
		const projectId = await add(setup.projectDir);
		const secondPath = join(setup.root, "other-project");
		await mkdir(secondPath);
		const otherId = await add(secondPath, setup.faux.getModel());
		const submit = (project: string, requestId: string) => client.request({ type: "conversation.submit", projectId: project, requestId, content: requestId });
		const pause = await client.request({ type: "usage-pause.pause", providerLogin: login });
		expect(pause.type === "usage-pause.pause" && pause.pauses[0]?.pausedBy).toBe("owner");
		await client.waitFor(message => message.type === "usage-pause.changed" && message.pauses[0]?.providerLogin === login);
		const view = new ViewClient(client);
		await view.start(projectId);
		await submit(projectId, "stop waiting");
		await view.waitForView(value => value.entries.some(entry => entryText(entry).includes("stop waiting")));
		expect((await client.request({ type: "conversation.abort", projectId })).type).toBe("conversation.abort");
		await submit(projectId, "wait across restart");
		await view.waitForView(value => value.entries.some(entry => entryText(entry).includes("wait across restart")));
		setup.faux.setResponses([fauxAssistantMessage("Other provider answered")]);
		await submit(otherId, "other provider");
		await waitFor(() => setup.faux.state.callCount === 1);
		expect(subscription.state.callCount).toBe(0);
		const waitForCheckpoint = async (admission: string) => {
			const { runtime } = await setup.server.manager.open(projectId);
			await waitFor(async () => (await runtime.harness.inspect(BACKGROUND_CONTEXT)).tasks.some(({ record }) =>
				record.kind === "pi.generation" && record.state.status === "running" &&
				(record.state.checkpoint as { admission?: string }).admission === admission));
		};
		const reopenRepeatedly = async (admission: string, providerCalls: number) => {
			await waitForCheckpoint(admission);
			for (let restart = 0; restart < 6; restart++) {
				await setup.restart();
				await waitForCheckpoint(admission);
				expect(subscription.state.callCount).toBe(providerCalls);
			}
			client.close();
			client = await connect();
			const next = new ViewClient(client);
			await next.start(projectId);
			return next;
		};
		const next = await reopenRepeatedly("before-send", 0);
		const state = await client.request({ type: "usage-pause.get" });
		expect(state.type === "usage-pause.get" && state.pauses[0]?.providerLogin).toBe(login);
		await Bun.sleep(CLOCK_TICK_MS);
		expect(subscription.state.callCount).toBe(0);
		subscription.setResponses([fauxAssistantMessage("Continued after the pause")]);
		expect((await client.request({ type: "usage-pause.resume", providerLogin: login })).type).toBe("usage-pause.resume");
		await next.waitForView(value => value.entries.some(entry => entry.kind === "pi.assistant" && entryText(entry).includes("Continued after the pause")));
		expect(subscription.state.callCount).toBe(1);

		// A real usage-endpoint reading re-arms the gate. The unaffected coordinator can spawn and stop a waiting worker.
		usedPercent = 100;
		await client.request({ type: "subscriptions.usage", refresh: true });
		const exhausted = await client.request({ type: "usage-pause.get" });
		expect(exhausted.type === "usage-pause.get" && exhausted.pauses[0]?.until).toBe(iso(Date.parse(endpointReset) + USAGE_RESET_MARGIN_MS));
		const limitAlert = await client.waitFor(message => message.type === "notifications.alert" && message.alert.kind === "usage_limit_reached");
		expect(limitAlert).toMatchObject({ type: "notifications.alert", alert: { level: "important" } });
		const otherView = new ViewClient(client);
		await otherView.start(otherId);
		setup.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("worker_spawn", { id: "waiting-worker", task: "Read the notebook" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Worker started"),
		]);
		await submit(otherId, "start worker");
		await otherView.waitForView(value => value.entries.some(entry => entryText(entry).includes("Worker started")), 3_000);
		setup.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("worker_stop", { id: "waiting-worker" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Worker stopped"),
		]);
		await submit(otherId, "stop worker");
		await otherView.waitForView(value => value.entries.some(entry => entryText(entry).includes('Stopped worker "waiting-worker"')), 3_000);
		expect(subscription.state.callCount).toBe(1);

		// The same restarts must not forget that a provider denial has already used the first send.
		usedPercent = 7;
		await client.request({ type: "subscriptions.usage", refresh: true });
		await client.request({ type: "usage-pause.resume", providerLogin: login });
		const denied = fauxAssistantMessage([], { stopReason: "error", errorMessage: "GoUsageLimitError" });
		subscription.setResponses([denied, denied, fauxAssistantMessage("should never send a third time")]);
		await submit(projectId, "request denied by provider");
		const afterDenial = await reopenRepeatedly("retry-after-limit", 2);
		await client.request({ type: "usage-pause.resume", providerLogin: login });
		await afterDenial.waitForView(value => JSON.stringify(value.docs["pi.live"]).includes("subscription allowance exhausted"), 5_000);
		expect(subscription.state.callCount).toBe(3);
	} finally { client.close(); }
}, 25_000);

it("turns off the gate and its requests on a backend without the feature", async () => {
	const setup = await createSetup({ features: ["projects"] });
	const client = await TestClient.open(setup.server);
	try {
		const hello = await client.hello();
		expect(hello.type === "hello" && hello.features?.includes("usage-pause")).toBe(false);
		expect(setup.server.usagePause).toBeUndefined();
		expect((await client.request({ type: "usage-pause.get" })).type).toBe("error");
	} finally { client.close(); }
});
