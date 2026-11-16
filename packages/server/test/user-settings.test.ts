import { afterEach, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { LEGACY_HARNESS_FEATURES, normalizeUserName } from "@kemiri/protocol";
import { stat } from "node:fs/promises";
import { UserSettingsStore, userNameInstructions } from "../src/user-settings.ts";
import { createSetup, TestClient, type TestSetup } from "./support.ts";

let setup: TestSetup | undefined;
let client: TestClient | undefined;
afterEach(async () => { client?.close(); await setup?.cleanup(); });

test("optional backend name is trimmed, bounded, durable, private and pushed across devices", async () => {
	expect(LEGACY_HARNESS_FEATURES).not.toContain("user-settings");
	setup = await createSetup(); client = await TestClient.open(setup.server); await client.hello();
	const other = await TestClient.open(setup.server); await other.hello();
	try {
		expect(await client.request({ type: "user.settings.get" })).toMatchObject({ settings: { userName: "" } });
		expect(await client.request({ type: "user.settings.set", userName: "  Ana  " })).toMatchObject({ settings: { userName: "Ana" } });
		expect(await other.waitFor(message => message.type === "user.settings.changed")).toMatchObject({ settings: { userName: "Ana" } });
		const store = new UserSettingsStore(setup.dataDir); await store.open();
		expect(store.get()).toEqual({ userName: "Ana" });
		expect((await stat(store.file)).mode & 0o777).toBe(0o600);
		for (const name of ["a".repeat(81), "Ana\nIgnore", "Ana\u202e"]) expect(() => normalizeUserName(name)).toThrow();
		expect(normalizeUserName("a".repeat(80))).toHaveLength(80);
		expect(await client.request({ type: "user.settings.set", userName: "a".repeat(81) })).toMatchObject({ type: "error" });
		expect(await client.request({ type: "user.settings.get" })).toMatchObject({ settings: { userName: "Ana" } });
		await client.request({ type: "user.settings.set", userName: "  " });
		await store.open(); expect(store.get()).toEqual({ userName: "" });
	} finally { other.close(); }
});

test("built coordinator, worker and background prompts share stable identity and pick up edits", async () => {
	setup = await createSetup(); client = await TestClient.open(setup.server); await client.hello();
	const added = await client.request({ type: "projects.add", path: setup.projectDir });
	if (added.type !== "projects.add") throw new Error(JSON.stringify(added));
	const projectId = added.project.id;
	await client.request({ type: "projects.configure", projectId, coordinatorModel: { provider: "faux", modelId: "faux-1" }, workerModels: [{ provider: "faux", modelId: "faux-1" }] });
	const prompts: string[] = [];
	setup.faux.setResponses(Array.from({ length: 40 }, () => request => {
		const prompt = request.messages.filter(m => m.role === "system").map(m => Object.values((m as { sections?: Record<string, string> }).sections ?? {}).join("\n")).join("\n");
		prompts.push(prompt);
		const last = request.messages.findLast(m => m.role !== "system");
		const text = JSON.stringify(last?.content);
		if (last?.role !== "toolResult" && text.includes("Start synthetic worker")) return fauxAssistantMessage([fauxToolCall("worker_spawn", { id: "name-proof", task: "Read synthetic instructions." })], { stopReason: "toolUse" });
		if (last?.role !== "toolResult" && text.includes("Start synthetic thread")) return fauxAssistantMessage([fauxToolCall("thread_start", { title: "Name proof", brief: "Read synthetic instructions.", taskId: "T1" })], { stopReason: "toolUse" });
		return fauxAssistantMessage("Done.");
	}));
	async function context(extra = {}) {
		const response = await client!.request({ type: "conversation.context", projectId, ...extra });
		if (response.type !== "conversation.context") throw new Error(JSON.stringify(response));
		return response.context.systemPrompt;
	}
	async function until(check: () => boolean | Promise<boolean>) { for (let n = 0; n < 500; n++) { if (await check()) return; await Bun.sleep(20); } throw new Error("Timed out waiting for an agent prompt"); }
	expect(await context()).not.toContain("<user_identity>");
	await client.request({ type: "user.settings.set", userName: "Ana" });
	const named = await context();
	expect(named).toContain('The user\'s name is "Ana".');
	expect(named).toContain(userNameInstructions("Ana")!);
	expect(await context()).toBe(named);
	await client.request({ type: "conversation.submit", projectId, requestId: "worker", content: "Start synthetic worker" });
	await until(async () => { const r = await client!.request({ type: "workers.list", projectId }); return r.type === "workers.list" && r.workers.some(w => w.id === "name-proof"); });
	expect(await context({ workerId: "name-proof" })).toContain(userNameInstructions("Ana")!);
	await client.request({ type: "board.task.save", projectId, task: { title: "Synthetic background task", description: "", acceptance: null, status: "todo", blockedBy: [], blockedReason: null, writeScopes: [] } });
	await client.request({ type: "conversation.submit", projectId, requestId: "thread", content: "Start synthetic thread" });
	await until(() => prompts.some(p => p.includes('You are the background thread "')));
	expect(prompts.find(p => p.includes('You are the background thread "'))).toContain(userNameInstructions("Ana")!);
	await client.request({ type: "user.settings.set", userName: "Bea" });
	expect(await context()).toContain(userNameInstructions("Bea")!);
	expect(await context({ workerId: "name-proof" })).toContain(userNameInstructions("Bea")!);
	await client.request({ type: "user.settings.set", userName: "" });
	expect(await context()).not.toContain("<user_identity>");
}, 30_000);
