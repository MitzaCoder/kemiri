import { afterEach, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactExtension } from "../src/artifact-tools.ts";
import { ArtifactStore } from "../src/artifacts.ts";
import type { Project } from "../src/projects.ts";
import { WorkerBrowserService, unsavedProofList, type WorkerBrowser } from "../src/worker-browser.ts";
import { WorkerService } from "../src/workers.ts";
import { createSetup, entryText, TestClient, ViewClient } from "./support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "worker-proof-test-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const options = { dataDir: root, log: () => {}, findBrowser: () => null };
	const service = new WorkerBrowserService(options);
	await service.ready;
	const browser = await service.prepare("p", 2, { binary: "/unused/browser", chromium: "/unused/chromium" });
	if (typeof browser === "string") throw new Error(browser);
	cleanups.push(() => service.cleanup("p", 2, true));
	return { root, options, service, browser };
}

test("empty/missing proof folders and unknown workers have no notice", async () => {
	const { service, browser } = await fixture();
	expect(await service.unsavedProof("p", 2)).toBeUndefined();
	expect(await service.unsavedProof("p", 3)).toBeUndefined();
	await rm(browser.proof, { recursive: true });
	expect(await service.unsavedProof("p", 2)).toBeUndefined();
});

test("proof scanning is recursive, ignores hidden/scratch directories and symlinks, and caps names", async () => {
	const { service, browser } = await fixture();
	for (const folder of ["nested", ".hidden", "tmp", "temp", "scratch"]) {
		await mkdir(join(browser.proof, folder));
		await writeFile(join(browser.proof, folder, "ignored.txt"), "synthetic");
	}
	await writeFile(join(browser.proof, ".hidden.txt"), "hidden");
	await symlink(join(browser.proof, "nested"), join(browser.proof, "linked"));
	await symlink(join(browser.proof, "nested", "ignored.txt"), join(browser.proof, "link.txt"));
	await writeFile(join(browser.proof, "line\nbreak.txt"), "quoted");
	for (let index = 0; index < 24; index++) await writeFile(join(browser.proof, `${String(index).padStart(2, "0")}.png`), "proof");
	const proof = (await service.unsavedProof("p", 2))!;
	expect(proof.total).toBe(26);
	expect(proof.names).toHaveLength(20);
	expect(unsavedProofList(proof)).toEndWith("and 6 more");
	expect(unsavedProofList({ directory: "unused", names: ["line\nbreak.txt"], total: 1 })).toBe('"line\\nbreak.txt"');
	await Promise.all(Array.from({ length: 24 }, (_, index) => rm(join(browser.proof, `${String(index).padStart(2, "0")}.png`))));
	expect((await service.unsavedProof("p", 2))?.names).toEqual(["line\nbreak.txt", "nested/ignored.txt"]);
});

test("path and paths saves, versions and real-path aliases persist receipts across restarts", async () => {
	const { root, options, service, browser } = await fixture();
	const store = new ArtifactStore({ dataDir: join(root, "artifacts") });
	const tool = createArtifactExtension({ store, project: () => ({ id: "p", path: root }) as Project,
		workspaceDirs: [], workerIdOf: async () => "worker", onSavedSource: (id, path) => service.recordSavedProof("p", id, path),
	}).tools!.find(tool => tool.name === "artifact_save")!;
	const api = { conversationId: 2, agent: async () => ({ cwd: root }), now: () => 1,
		memo: async (_key: string, id: string) => id };
	const one = join(browser.proof, "one--web-after.txt");
	const two = join(browser.proof, "two.txt");
	const three = join(browser.proof, "three.txt");
	for (const path of [one, two, three]) await writeFile(path, "proof");
	const alias = join(root, "alias.txt");
	await symlink(one, alias);
	for (const args of [{ path: alias }, { paths: [two, three] }, { paths: [one, two] }]) {
		const result = await tool.execute(args, api as never, BACKGROUND_CONTEXT) as { isError?: boolean };
		expect(result.isError).toBeUndefined();
	}
	expect((await store.list("p")).find(artifact => artifact.name === "two.txt")?.version).toBe(2);
	expect(await service.unsavedProof("p", 2)).toBeUndefined();
	const restarted = new WorkerBrowserService(options);
	await restarted.ready;
	expect(await restarted.unsavedProof("p", 2)).toBeUndefined();
	// Receipts mean "was saved", independent of version pruning or later artifact deletion.
	for (const artifact of await store.list("p")) await store.delete("p", artifact.id);
	expect(await restarted.unsavedProof("p", 2)).toBeUndefined();
	await writeFile(join(browser.proof, "new.txt"), "new");
	expect((await restarted.unsavedProof("p", 2))?.names).toEqual(["new.txt"]);
});

test("proof diagnostics are absent without a browser service and best-effort on errors/timeouts", async () => {
	expect(await new WorkerService({ coordinators: {} } as never).unsavedProof(2)).toBeUndefined();
	const logs: string[] = [];
	const service = (scan: () => Promise<undefined>) => new WorkerService({ coordinators: {}, project: () => ({ id: "p" }),
		browsers: { unsavedProof: scan }, log: (message: string) => logs.push(message) } as never);
	expect(await service(async () => { throw new Error("broken folder"); }).unsavedProof(2)).toBeUndefined();
	expect(logs.join()).toContain("broken folder");
	expect(await service(() => new Promise(() => {})).unsavedProof(2)).toBeUndefined();
});

function lastText(request: TranscriptContext): string {
	const last = request.messages.findLast(message => message.role !== "system");
	const content = last && "content" in last ? last.content : undefined;
	return typeof content === "string" ? content : Array.isArray(content)
		? content.flatMap(block => block.type === "text" ? [block.text] : []).join("") : "";
}

async function workerProofScenario(mode: "decline" | "save" | "restart") {
	const setup = await createSetup();
	cleanups.push(setup.cleanup);
	let client = await TestClient.open(setup.server);
	cleanups.push(async () => client.close());
	await client.hello();
	const added = await client.request({ type: "projects.add", path: setup.projectDir });
	if (added.type !== "projects.add") throw new Error("add failed");
	const projectId = added.project.id;
	await client.request({ type: "projects.configure", projectId,
		coordinatorModel: { provider: "faux", modelId: "faux-1" }, coordinatorThinkingLevel: "low",
		workerModels: [{ provider: "faux", modelId: "faux-1" }] });
	const { runtime } = await setup.server.manager.open(projectId);
	let browser: WorkerBrowser | undefined;
	let reminders = 0;
	let savedRounds = 0;
	let firstNotice!: () => void;
	const noticed = new Promise<void>(resolve => { firstNotice = resolve; });
	setup.faux.setResponses(Array.from({ length: 30 }, () => async (request, options) => {
		const text = lastText(request);
		if (text === "Delegate proof") return fauxAssistantMessage([fauxToolCall("worker_spawn", { id: "proof", task: "Create synthetic proof" })], { stopReason: "toolUse" });
		if (text === "Create synthetic proof") {
			const worker = (await runtime.workers.list()).workers[0]!;
			const prepared = await setup.server.manager.browsers.prepare(projectId, worker.conversationId, { binary: "/unused/browser", chromium: "/unused/chromium" });
			if (typeof prepared === "string") throw new Error(prepared);
			browser = prepared;
			await writeFile(join(browser.proof, "discard--web-after.png"), "synthetic");
			if (mode === "save") await writeFile(join(browser.proof, "keep--web-before.png"), "synthetic");
			return fauxAssistantMessage("## Report\nOutcome: done");
		}
		if (text.startsWith("Unsaved proof files in ")) {
			reminders++;
			firstNotice();
			if (mode === "restart" && reminders === 1) await new Promise<void>(resolve => {
				options?.signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			if (mode === "save") return fauxAssistantMessage([fauxToolCall("artifact_save", {
				paths: [join(browser!.proof, "discard--web-after.png"), join(browser!.proof, "keep--web-before.png")],
			})], { stopReason: "toolUse" });
			return fauxAssistantMessage("## Report\nOutcome: done\nProof omitted because it is a discarded scratch capture.");
		}
		const last = request.messages.findLast(message => message.role !== "system");
		if (mode === "save" && last?.role === "toolResult" && last.toolName === "artifact_save") {
			if (savedRounds++ === 0) return fauxAssistantMessage([fauxToolCall("artifact_save", {
				path: join(browser!.proof, "discard--web-after.png"),
			})], { stopReason: "toolUse" });
			return fauxAssistantMessage("## Report\nOutcome: done\nSelected proof saved.");
		}
		return fauxAssistantMessage("Report received.");
	}));
	let view = new ViewClient(client);
	await view.start(projectId);
	await client.request({ type: "conversation.submit", projectId, requestId: "proof", content: "Delegate proof" });
	let server = setup.server;
	if (mode === "restart") {
		await noticed;
		client.close();
		server = await setup.restart();
		client = await TestClient.open(server);
		await client.hello();
		view = new ViewClient(client);
		await view.start(projectId);
	}
	const reported = await view.waitForView(view => view.entries.some(entry => entryText(entry).startsWith("[worker proof reported]")), 20_000);
	const text = entryText(reported.entries.find(entry => entryText(entry).startsWith("[worker proof reported]"))!);
	if (mode === "save") {
		expect(text).toContain("Selected proof saved.");
		expect(text).not.toContain("Unsaved proof files:");
		const saved = await server.artifacts.list(projectId);
		expect(saved).toHaveLength(2);
		expect(saved.find(artifact => artifact.name.startsWith("discard"))?.version).toBe(2);
	} else {
		expect(text).toContain("Proof omitted because");
		expect(text).toContain('Unsaved proof files: "discard--web-after.png" (1 of 1).');
		expect(await server.artifacts.list(projectId)).toHaveLength(0);
	}
	if (mode !== "restart") expect(reminders).toBe(1);
	const worker = (await (await server.manager.open(projectId)).runtime.workers.list()).workers[0]!;
	const page = await client.request({ type: "conversation.page", projectId, workerId: "proof", order: "ascending" });
	if (page.type !== "conversation.page") throw new Error("page failed");
	expect(page.entries.filter(entry => entryText(entry).startsWith("Unsaved proof files in "))).toHaveLength(1);
	await server.manager.browsers.cleanup(projectId, worker.conversationId, true);
}

test("a worker gets one proof reminder, can decline it, and its coordinator receives remaining names",
	() => workerProofScenario("decline"), 30_000);
test("saving proof with paths then a path version removes the warning from the coordinator report",
	() => workerProofScenario("save"), 30_000);
test("the proof reminder is submitted once across restart and its final answer is reported",
	() => workerProofScenario("restart"), 30_000);
