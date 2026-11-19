import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openBoard, saveTask } from "../src/board.ts";
import { createModels, type Message, type TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AntigravityInstaller } from "../src/antigravity-install.ts";
import { antigravityDefinition } from "../src/official-agents/antigravity.ts";
import { OfficialAgentSessions } from "../src/official-agents/provider.ts";
import { FileCredentialStore } from "../src/credentials.ts";
import type { AuthLogin } from "@kemiri/protocol";
import { createSetup, entryText, errorOf, TestClient, ViewClient } from "./support.ts";

const AGY = { provider: "antigravity", modelId: "gemini-3.8-flash" };
const FAUX = { provider: "faux", modelId: "faux-1" };
const fakeAgent = new URL("./fixtures/fake-acp.ts", import.meta.url).pathname;
const eventFile = (dataDir: string) => join(dataDir, "official-agents", "antigravity", "profile", "fake-events.jsonl");
const fixtureEvents = async (dataDir: string) => (await readFile(eventFile(dataDir), "utf8")).trim().split("\n").map(line => JSON.parse(line));
const agentDir = (dataDir: string) => join(dataDir, "official-agents", AGY.provider);
const authEvents = async (dataDir: string) => (await readFile(join(agentDir(dataDir), "fake-auth-events.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
const subscriptionProfiles = async (dataDir: string) => (await readdir(agentDir(dataDir))).filter(name => name.startsWith("subscription-"));
const setCredential = (store: FileCredentialStore) => store.modify(AGY.provider, async () => ({ type: "api_key", key: "synthetic-fixture" }));

async function workerSetup(brief: string, options: { isolated?: boolean; signedOut?: boolean; log?: (message: string) => void } = {}) {
	const setup = await createSetup({ antigravityCommand: fakeAgent, ...(options.log ? { log: options.log } : {}) });
	try {
		await setCredential(setup.credentials);
		if (options.signedOut) await writeFile(join(setup.projectDir, "signed-out"), "");
		if (options.isolated) expect(await Bun.spawn(["jj", "git", "init"], { cwd: setup.projectDir, stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
		const client = await TestClient.open(setup.server);
		await client.hello();
		const added = await client.request({ type: "projects.add", path: setup.projectDir });
		if (added.type !== "projects.add") throw new Error(JSON.stringify(added));
		const projectId = added.project.id;
		expect((await client.request({ type: "projects.configure", projectId, coordinatorModel: FAUX, workerModels: [AGY] })).type).toBe("projects.configure");
		const { runtime } = await setup.server.manager.open(projectId);
		await runtime.harness.commit(async tx => {
			const board = await openBoard(tx, runtime.conversation.id);
			saveTask(board, { task: { title: "Read the fixture", description: "", acceptance: null, status: "todo", blockedBy: [], blockedReason: null, writeScopes: [] }, author: "coordinator", now: new Date().toISOString() });
		}, BACKGROUND_CONTEXT);
		setup.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("worker_spawn", { id: "official", task: brief, taskId: "T1", isolation: options.isolated ? "workspace" : "shared" })], { stopReason: "toolUse" }),
			...Array.from({ length: 16 }, () => (request: TranscriptContext) => {
				const last = request.messages.at(-1);
				if (last?.role === "user" && typeof last.content === "string") {
					if (last.content === "Stop the worker.") return fauxAssistantMessage([fauxToolCall("worker_stop", { id: "official" })], { stopReason: "toolUse" });
					if (last.content.startsWith("Follow up: ")) return fauxAssistantMessage([fauxToolCall("worker_send", { id: "official", message: last.content.slice(11) })], { stopReason: "toolUse" });
				}
				return fauxAssistantMessage("Coordinator acknowledged.");
			}),
		]);
		const view = new ViewClient(client);
		await view.start(projectId);
		return { setup, client, view, projectId, submit: (content = "Delegate.") => client.request({ type: "conversation.submit", projectId, requestId: content, content }), cleanup: async () => { client.close(); await setup.cleanup(); } };
	} catch (error) { await setup.cleanup(); throw error; }
}

test("official-agent worker receives its brief in its isolated workspace and reports with ACP progress", async () => {
	const s = await workerSetup("Read the fixture and report.", { isolated: true });
	try {
		await s.submit();
		await s.view.waitForView(v => v.entries.some(entry => entryText(entry).includes("[worker official reported]")));
		const workers = await s.client.request({ type: "workers.list", projectId: s.projectId });
		if (workers.type !== "workers.list") throw new Error(JSON.stringify(workers));
		const worker = workers.workers[0]!;
		expect(worker.workspacePath).toBeTruthy();
		const transcript = new ViewClient(s.client);
		await transcript.start(s.projectId, { workerId: "official" });
		const serialized = JSON.stringify(transcript.view?.entries);
		expect(serialized).toContain("read: Read fixture (in_progress)");
		expect(serialized).toContain("read: Read fixture (completed)");
		expect(serialized).toContain("Permission: approved (allow_once)");
		expect(serialized).not.toContain('"type":"toolCall"');
		expect(serialized).toContain('"totalTokens":18');
		const events = await fixtureEvents(s.setup.dataDir);
		expect(events).toContainEqual({ event: "session/new", cwd: worker.workspacePath, actualCwd: worker.workspacePath, mcpServers: [] });
		expect(events).toContainEqual({ event: "initialize", version: 1, sanitized: true, hasKey: true, args: ["acp", "--gemini-dir", join(s.setup.dataDir, "official-agents", "antigravity", "profile"), "--app-data-dir", "antigravity-acp", "--sandbox"] });
		expect(events).toContainEqual({ event: "model", model: AGY.modelId });
		const prompt = events.find(e => e.event === "prompt").text;
		expect(prompt).toContain('You are the worker "official"');
		expect(prompt).toContain("Your first board task is T1. If reassigned, use the board task named in the new brief.");
		expect(prompt).toContain("--- User input ---\nRead the fixture and report.");
		const catalog = await s.client.request({ type: "models.list" });
		if (catalog.type !== "models.list") throw new Error(JSON.stringify(catalog));
		expect(catalog.models.find(m => m.provider === AGY.provider && m.modelId === "other")?.workerOnly).toBe(true);
		expect(catalog.providers.find(p => p.id === AGY.provider)?.officialAgent?.installedVersion).toBe("1.5.12");
	} finally { await s.cleanup(); }
}, 30_000);

async function watchHeld(s: Awaited<ReturnType<typeof workerSetup>>) {
	// Wait on a coordinator view event before watching the worker's live progress, not on a timer or process poll.
	await s.view.waitForView(v => v.entries.some(entry => entry.kind === "pi.tool-result"));
	const transcript = new ViewClient(s.client);
	await transcript.start(s.projectId, { workerId: "official" });
	await transcript.waitForView(v => JSON.stringify(v).includes("Permission: approved"));
}

async function waitForLogin(client: TestClient, loginId: string, status: AuthLogin["status"]): Promise<AuthLogin> {
	const event = await client.waitFor(m => m.type === "credentials.login" && m.login.id === loginId && m.login.status === status);
	if (event.type !== "credentials.login") throw new Error("Expected an OAuth login event");
	return event.login;
}

async function startSubscription(client: TestClient) {
	const start = await client.request({ type: "credentials.loginStart", providerId: AGY.provider });
	if (start.type !== "credentials.loginStart") throw new Error("Expected Antigravity to offer OAuth");
	return waitForLogin(client, start.login.id, "prompt");
}

async function signInWithFakeCode(client: TestClient) {
	const login = await startSubscription(client);
	const link = login.events.find(event => event.type === "auth_url");
	if (!link || !login.prompt) throw new Error("Expected a browser link and code prompt");
	expect(login.prompt.type).toBe("manual_code");
	const value = `synthetic-${new URL(link.url).searchParams.get("state")}`;
	expect((await client.request({ type: "credentials.loginAnswer", loginId: login.id, promptId: login.prompt.id, value })).type).toBe("credentials.loginAnswer");
	const completed = await waitForLogin(client, login.id, "succeeded");
	expect(completed.events.some(event => event.type === "auth_url")).toBe(false);
	return { value, url: link.url };
}

async function authType(client: TestClient) {
	const result = await client.request({ type: "models.list" });
	if (result.type !== "models.list") throw new Error("Expected a model catalog");
	const provider = result.providers.find(p => p.id === AGY.provider);
	expect(provider?.oauth).toMatchObject({ name: "Google AI subscription", isSubscription: true });
	return provider?.authType;
}

test("switching Antigravity sign-in cancels the old process and the same worker uses the newly selected account", async () => {
	const logs: string[] = [];
	const s = await workerSetup("HOLD_TURN", { log: message => logs.push(message) });
	try {
		expect(await authType(s.client)).toBe("api_key");
		await s.submit();
		await watchHeld(s);
		const { value, url } = await signInWithFakeCode(s.client);
		expect(await authType(s.client)).toBe("oauth");
		expect(await fixtureEvents(s.setup.dataDir)).toContainEqual({ event: "cancel" });
		const profiles = await subscriptionProfiles(s.setup.dataDir);
		expect(profiles).toHaveLength(1);
		const profile = join(agentDir(s.setup.dataDir), profiles[0]!);
		const privateToken = await readFile(join(profile, "fake-native-auth"), "utf8");
		expect(JSON.parse(await readFile(s.setup.credentials.path, "utf8"))).toEqual({ [AGY.provider]: {
			type: "oauth", access: "", refresh: "", expires: Number.MAX_SAFE_INTEGER, nativeProfile: profiles[0]!.slice(13),
		} });
		expect((await stat(profile)).mode & 0o777).toBe(0o700);
		await s.view.waitForView(v => v.entries.some(e => entryText(e).startsWith("[worker official failed:")));
		await s.submit("Follow up: FAIL_REFRESH");
		await s.view.waitForView(v => v.entries.some(e => entryText(e).includes("Sign in again under Settings")));
		const apiKey = `synthetic-${crypto.randomUUID()}`;
		expect((await s.client.request({ type: "credentials.set", providerId: AGY.provider, apiKey })).type).toBe("credentials.set");
		expect(await authType(s.client)).toBe("api_key");
		expect(await subscriptionProfiles(s.setup.dataDir)).toHaveLength(0);
		await s.submit("Follow up: Report with the API key.");
		await s.view.waitForView(v => v.entries.some(e => entryText(e).startsWith("[worker official reported]")));
		const events = await authEvents(s.setup.dataDir);
		expect(events.filter(e => e.event === "open")).toEqual([
			{ event: "open", mode: "gemini-api-key", usesSelectedAuth: true },
			{ event: "open", mode: "oauth-personal", usesSelectedAuth: true },
			{ event: "open", mode: "gemini-api-key", usesSelectedAuth: true },
		]);
		expect(events).toContainEqual({ event: "logout", method: "oauth-personal", hadNativeAuth: true });
		expect(events.some(e => e.event === "authenticate")).toBe(false);
		const retained = [JSON.stringify(logs), JSON.stringify(s.view.view?.entries), JSON.stringify(events), JSON.stringify(await fixtureEvents(s.setup.dataDir))].join("\n");
		for (const secret of [value, url, privateToken, apiKey]) expect(retained.includes(secret)).toBe(false);
	} finally { await s.cleanup(); }
}, 30_000);

test("Antigravity sign-out calls native logout and removes the profile and marker", async () => {
	const setup = await createSetup({ antigravityCommand: fakeAgent });
	const client = await TestClient.open(setup.server);
	try {
		await client.hello();
		await signInWithFakeCode(client);
		expect(await client.request({ type: "credentials.delete", providerId: AGY.provider })).toMatchObject({ type: "credentials.delete", deleted: true });
		expect(await setup.credentials.read(AGY.provider)).toBeUndefined();
		expect(await authType(client)).toBeUndefined();
		expect(await subscriptionProfiles(setup.dataDir)).toHaveLength(0);
		expect(await authEvents(setup.dataDir)).toContainEqual({ event: "logout", method: "oauth-personal", hadNativeAuth: true });
	} finally { client.close(); await setup.cleanup(); }
});

for (const action of ["cancel", "timeout", "save key"] as const) test(`Antigravity ${action} ends an unanswered native login without saving a marker`, async () => {
	const setup = await createSetup({ antigravityCommand: fakeAgent, ...(action === "timeout" ? { logins: { idleTimeoutMs: 1_500 } } : {}) });
	const client = await TestClient.open(setup.server);
	try {
		await client.hello();
		const login = await startSubscription(client);
		const pid = (await authEvents(setup.dataDir)).find(event => event.event === "login-started").pid as number;
		if (action === "cancel") expect((await client.request({ type: "credentials.loginCancel", loginId: login.id })).type).toBe("credentials.loginCancel");
		if (action === "save key") expect((await client.request({ type: "credentials.set", providerId: AGY.provider, apiKey: `synthetic-${crypto.randomUUID()}` })).type).toBe("credentials.set");
		const finished = await waitForLogin(client, login.id, action === "timeout" ? "failed" : "cancelled");
		if (action === "timeout") expect(finished.error).toContain("timed out");
		expect(finished.events.some(event => event.type === "auth_url")).toBe(false);
		expect(await authType(client)).toBe(action === "save key" ? "api_key" : undefined);
		// Deletion is serialized behind the native process cleanup, even after the UI has seen cancel.
		expect((await client.request({ type: "credentials.delete", providerId: AGY.provider })).type).toBe("credentials.delete");
		expect(await subscriptionProfiles(setup.dataDir)).toHaveLength(0);
		expect(() => process.kill(pid, 0)).toThrow();
	} finally { client.close(); await setup.cleanup(); }
}, 10_000);

test("worker stop sends ACP cancel and rejects permission requests during teardown", async () => {
	const s = await workerSetup("HOLD_TURN");
	try {
		await s.submit();
		await watchHeld(s);
		await s.submit("Stop the worker.");
		await s.view.waitForView(v => v.entries.some(entry => entry.kind === "pi.tool-result" && JSON.stringify(entry).includes('Stopped worker')));
		expect(await fixtureEvents(s.setup.dataDir)).toContainEqual({ event: "late-permission", selection: { outcome: "cancelled" } });
	} finally { await s.cleanup(); }
}, 30_000);

test("a backend restart reloads the session and sends a continuation, not the original brief", async () => {
	const s = await workerSetup("HOLD_TURN");
	try {
		await s.submit();
		await watchHeld(s);
		const nextClient = await TestClient.open(await s.setup.restart());
		try {
			await nextClient.hello();
			const view = new ViewClient(nextClient);
			await view.start(s.projectId);
			await view.waitForView(v => v.entries.some(entry => entryText(entry).includes("[Kemiri was interrupted and resumed this turn.]")));
			const events = await fixtureEvents(s.setup.dataDir);
			expect(events).toContainEqual({ event: "session/load", cwd: s.setup.projectDir, actualCwd: s.setup.projectDir, sessionId: "fake-acp-session", mcpServers: [] });
			const prompts = events.filter(e => e.event === "prompt").map(e => e.text);
			expect(prompts).toHaveLength(2);
			expect(prompts[0]).toContain("HOLD_TURN");
			expect(prompts[1]).toMatch(/^Kemiri restarted while you worked\./);
			expect(prompts[1]).not.toContain("HOLD_TURN");
			expect(s.setup.models.getModel(AGY.provider, "other")?.name).toBe("Another model");
		} finally { nextClient.close(); }
	} finally { await s.cleanup(); }
}, 30_000);

for (const mode of ["signed-out", "died"] as const) test(`worker reports ${mode} with a readable reason`, async () => {
	const s = await workerSetup(mode === "died" ? "DIE_DURING_TURN" : "Read the fixture.", { signedOut: mode === "signed-out" });
	try {
		await s.submit();
		const expected = mode === "died" ? "agent process died" : "Settings → Accounts and API keys";
		await s.view.waitForView(v => v.entries.some(entry => entryText(entry).startsWith("[worker official failed:") && entryText(entry).includes(expected)));
		const board = await s.client.request({ type: "board.get", projectId: s.projectId });
		if (board.type !== "board.get") throw new Error(JSON.stringify(board));
		expect(board.board.tasks.find(task => task.id === "T1")).toMatchObject({ status: "blocked", blockedReason: expect.stringContaining(expected) });
	} finally { await s.cleanup(); }
}, 30_000);

test("project configuration refuses a worker-only coordinator or report-audit model", async () => {
	const s = await workerSetup("Read the fixture.");
	try {
		for (const change of [{ coordinatorModel: AGY }, { reportAudit: { mode: "model" as const, model: AGY, dailyTokens: 65_000 } }]) {
			expect(errorOf(await s.client.request({ type: "projects.configure", projectId: s.projectId, ...change })).message).toContain("only in worker conversations");
		}
	} finally { await s.cleanup(); }
});

test("a journal replays done and failed turns without prompting twice", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "official-journal-"));
	const credentials = new FileCredentialStore(join(dataDir, "credentials.json"));
	const definition = antigravityDefinition(dataDir, fakeAgent);
	await setCredential(credentials);
	async function turn(sessionId: string, text: string) {
		const sessions = new OfficialAgentSessions(dataDir, credentials);
		try {
			const models = createModels({ credentials });
			models.setProvider(sessions.provider(definition));
			const message: Message = { role: "user", content: text, timestamp: 1 };
			sessions.tag(message, { projectId: "fake", conversationId: 1, turnId: "one-turn", cwd: dataDir });
			return await models.completeSimple(models.getModel(AGY.provider, AGY.modelId)!, { messages: [message] }, { sessionId });
		} finally { await sessions.close(); }
	}
	try {
		for (const [sessionId, text, stopReason] of [["done", "Report.", "stop"], ["failed", "DIE_DURING_TURN", "error"]]) {
			const first = await turn(sessionId!, text!);
			const replay = await turn(sessionId!, text!);
			expect(replay.stopReason).toBe(stopReason! as "stop" | "error");
			expect(replay.content).toEqual(first.content.filter(block => block.type === "text"));
			expect(replay.errorMessage).toEqual(first.errorMessage);
		}
		expect((await fixtureEvents(dataDir)).filter(event => event.event === "prompt")).toHaveLength(2);
		const dir = join(dataDir, "official-agents", "antigravity");
		for (const file of (await readdir(dir)).filter(name => name.endsWith(".json"))) expect((await stat(join(dir, file))).mode & 0o777).toBe(0o600);
	} finally { await rm(dataDir, { recursive: true, force: true }); }
});

test("the pin verifies SHA-512 before installing the one executable from its archive", async () => {
	const dataDir = await mkdtemp(join(tmpdir(), "official-install-"));
	try {
		const tar = Buffer.alloc(2048);
		tar.write("antigravity");
		tar.write("00000000004\0", 124);
		tar[156] = 48;
		tar.write("fake", 512);
		const archive = gzipSync(tar);
		const sha512 = createHash("sha512").update(archive).digest("hex");
		const release = { url: "https://example.com/agy.tar.gz", sha512 };
		const options = { dataDir, platform: "linux_amd64", fetch: (async () => new Response(new Uint8Array(archive))) as unknown as typeof fetch };
		const bad = new AntigravityInstaller({ ...options, pin: { version: "0.0.1", platforms: { linux_amd64: { ...release, sha512: "0".repeat(128) } } } });
		await expect(bad.ensure()).rejects.toThrow("SHA-512 mismatch");
		expect(await bad.installedVersion()).toBeNull();
		const installer = new AntigravityInstaller({ ...options, pin: { version: "0.0.1", platforms: { linux_amd64: release } } });
		const binary = await installer.ensure();
		expect(await readFile(binary, "utf8")).toBe("fake");
		expect(await installer.installedVersion()).toBe("0.0.1");
		expect((await stat(binary)).mode & 0o777).toBe(0o755);
	} finally { await rm(dataDir, { recursive: true, force: true }); }
});
