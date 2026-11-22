import { stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { APP_LOG_LIMIT, ManagedAppProcesses } from "../src/managed-app-process.ts";
import { appStartReceipt } from "../src/app-tools.ts";
import { encodeProjectAppRegistry, readAppRegistry } from "../src/app-registry-document.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { BoardDoc } from "../src/board.ts";
import { afterEach, expect, test } from "bun:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DEFAULT_APP_SETTINGS, HARNESS_FEATURES, type ProjectApp } from "@kemiri/protocol";
import { appAddress, appInstructions, validateAppSettings } from "../src/app-addresses.ts";
import { AgentApps, appPublishReceipt } from "../src/agent-apps.ts";
import { createSetup, errorOf, TestClient, type TestSetup } from "./support.ts";

const template = { mode: "template", template: "http://oven.example.test:{port}" } as const;
const faux = { provider: "faux", modelId: "faux-1" };
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

async function fixture(features?: readonly string[], options?: Parameters<typeof createSetup>[0]) {
	const setup = await createSetup({ terminals: false, ...options, ...(features ? { features } : {}) });
	const client = await TestClient.open(setup.server);
	cleanup.push(() => client.close());
	const hello = await client.request({ type: "hello", protocolVersion: 1, client: { name: "apps-test", features: ["apps"] } });
	if (hello.type !== "hello") throw errorOf(hello);
	const added = await client.request({ type: "projects.add", path: setup.projectDir });
	if (added.type !== "projects.add") throw errorOf(added);
	const projectId = added.project.id;
	const configured = await client.request({ type: "projects.configure", projectId, coordinatorModel: faux, workerModels: [faux] });
	if (configured.type !== "projects.configure") throw errorOf(configured);
	const { runtime } = await setup.server.manager.open(projectId);
	const agent = { publisher: { id: "main", kind: "coordinator" as const, threadId: "main", conversationId: runtime.conversation.id } };
	return { setup, client, hello, projectId, runtime, agent };
}

function listen() {
	const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null, { status: 404 }) });
	cleanup.push(() => listener.stop(true));
	return listener.port!;
}

async function until(check: () => Promise<boolean> | boolean) {
	for (let i = 0; i < 250; i++) {
		if (await check()) return;
		await Bun.sleep(20);
	}
	throw new Error("Timed out waiting for app lifecycle change");
}

function lastText(request: TranscriptContext) {
	const last = request.messages.findLast(message => message.role !== "system");
	const content = last?.content;
	return typeof content === "string" ? content : Array.isArray(content) ? content.map(part => part.type === "text" ? part.text : "").join("") : "";
}

function fauxCalls(setup: TestSetup, rules: (text: string) => ReturnType<typeof fauxAssistantMessage> | undefined) {
	setup.faux.setResponses(Array.from({ length: 40 }, () => request => rules(lastText(request)) ?? fauxAssistantMessage("Done.")));
}

const call = (name: string, args: Parameters<typeof fauxToolCall>[1] = {}) => fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

async function submit(client: TestClient, projectId: string, content: string) {
	const result = await client.request({ type: "conversation.submit", projectId, requestId: crypto.randomUUID(), content });
	if (result.type !== "conversation.submit") throw errorOf(result);
}

async function list(client: TestClient, projectId: string): Promise<ProjectApp[]> {
	const response = await client.request({ type: "apps.list", projectId });
	if (response.type !== "apps.list") throw errorOf(response);
	return response.apps;
}

test("unadvertised apps have no RPCs or agent tools", async () => {
	const { hello, client, projectId, runtime } = await fixture(HARNESS_FEATURES.filter(feature => feature !== "apps"));
	expect(hello.features).not.toContain("apps");
	expect((await client.request({ type: "apps.list", projectId })).type).toBe("error");
	expect(runtime.registry.snapshot().tools().map(({ tool }) => tool.name)).not.toContain("app_publish");
});

test("templates substitute only valid HTTP addresses, and agent instructions state the bind and host facts", () => {
	expect(appAddress(template, 45454, "/docs")?.href).toBe("http://oven.example.test:45454/docs");
	const withPath = validateAppSettings({ addresses: { mode: "template", template: "https://{port}.apps.example.test{path}" }, policy: "on" });
	expect(appAddress(withPath.addresses, 45454, "/docs")?.href).toBe("https://45454.apps.example.test/docs");
	for (const invalid of ["ftp://oven.example.test:{port}", "https://oven.example.test/", "https://oven.example.test/{port}", "https://user@oven.example.test:{port}", "https://oven.example.test:{port}?x={path}", "https://{path}.example.test:{port}"]) {
		expect(() => validateAppSettings({ addresses: { mode: "template", template: invalid }, policy: "ask" })).toThrow("Use an HTTP or HTTPS address");
	}
	expect(appInstructions({ addresses: template, policy: "ask" })).toBe("Apps: this backend can publish an app you serve to the owner's devices. Serve on 0.0.0.0, and use app_start with the command and port. Devices reach it at http://oven.example.test:PORT/; the app must accept the Host name oven.example.test. Managed apps survive backend service restarts when a user scope is available. A localhost link only works on the server itself; never give one to the owner.");
	expect(appInstructions(DEFAULT_APP_SETTINGS)).toContain("Ask the owner to run kemiri tailscale enable --apps on the backend");
});

test("publishing rejects low, own, silent and missing ports, unsafe paths, a shared origin and policy off", async () => {
	const { setup, client, projectId, runtime, agent } = await fixture();
	const apps = setup.server.manager.apps!;
	const publish = (port: number, path?: string) => apps.publish(projectId, { name: "App", port, path }, agent, runtime.activeApps);
	const port = listen();
	const missing = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	const missingPort = missing.port!;
	missing.stop(true);
	const silent = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	cleanup.push(() => silent.stop(true));
	await expect(publish(81)).rejects.toThrow("1024 to 65535");
	await expect(publish(setup.server.port)).rejects.toThrow("Kemiri's own port");
	await expect(publish(missingPort)).rejects.toThrow("Nothing answered HTTP");
	await expect(publish(silent.port)).rejects.toThrow("Nothing answered HTTP");
	await expect(publish(port, "//outside.example.test")).rejects.toThrow("one slash");
	const settings = await client.request({ type: "apps.settings.set", settings: { addresses: template, policy: "off" } });
	expect(settings.type).toBe("apps.settings.set");
	await expect(publish(port)).rejects.toThrow("Agents may not publish");
	await client.request({ type: "apps.settings.set", settings: { addresses: { mode: "template", template: "http://oven.example.test:{port}" }, policy: "on" } });
	// The actual HTTP status does not matter: the listener above responds 404.
	expect((await publish(port)).state).toBe("live");
	const shared = new AgentApps({ ...apps.options, backendOrigins: () => [`http://oven.example.test:${port}`] });
	await expect(shared.publish(projectId, { name: "App", port }, agent, runtime.activeApps)).rejects.toThrow("different origin from Kemiri");
});

test("faux agent publishes and lists; owner approval persists and the next publication gets a link", async () => {
	const { setup, client, projectId, runtime, agent } = await fixture();
	const settings = await client.request({ type: "apps.settings.get" });
	expect(settings).toMatchObject({ type: "apps.settings.get", settings: DEFAULT_APP_SETTINGS });
	await client.request({ type: "apps.settings.set", settings: { addresses: template, policy: "ask" } });
	const port = listen();
	let seenList = "", secondAppId = "never-match";
	fauxCalls(setup, text => {
		if (text === "Publish") return call("app_publish", { port, name: "Orders" });
		if (text === "List") return call("app_list");
		if (text.includes(secondAppId)) seenList = text;
	});
	const projectFile = setup.server.manager.store.projectFile(projectId);
	const previousShape = await Bun.file(projectFile).json();
	await submit(client, projectId, "Publish");
	await client.waitFor(message => message.type === "apps.changed" && message.projectId === projectId);
	const [pending] = await list(client, projectId);
	expect(pending).toMatchObject({ state: "pending", url: null, publishedBy: agent.publisher });
	expect(appPublishReceipt(pending!).warning).toContain("owner must allow");
	const allowed = await client.request({ type: "apps.allow", projectId, appId: pending!.appId });
	expect(allowed).toMatchObject({ type: "apps.allow", app: { state: "live", url: `http://oven.example.test:${port}/` } });
	const second = await setup.server.manager.apps!.publish(projectId, { name: "API", port }, agent, runtime.activeApps);
	expect(second.state).toBe("live");
	secondAppId = second.appId;
	await submit(client, projectId, "List");
	await until(() => seenList.includes(second.appId));
	const stopped = await client.request({ type: "apps.unpublish", projectId, appId: second.appId });
	expect(stopped).toMatchObject({ type: "apps.unpublish", app: { state: "unpublished", url: null } });
	const { apps: durable, ...legacy } = await Bun.file(projectFile).json();
	expect(legacy).toEqual(previousShape); // The old reader consumes these same version-1 fields, ignoring the rest.
	expect(durable.approved).toBe(true);
	expect(durable.activity.map((entry: { kind: string }) => entry.kind)).toEqual(["published", "allowed", "published", "unpublished"]);
	expect(durable.activity.at(-1)).toMatchObject({ actor: "owner", publishedBy: agent.publisher });
	// Stopping a publication never stops the HTTP process.
	expect((await fetch(`http://127.0.0.1:${port}`)).status).toBe(404);
});

test("off address mode records without a link; task close, drop and archive clear attached apps", async () => {
	const { setup, client, projectId, runtime, agent } = await fixture();
	await client.request({ type: "apps.settings.set", settings: { addresses: { mode: "off" }, policy: "on" } });
	const apps = setup.server.manager.apps!;
	const port = listen();
	for (const change of [{ status: "done" }, { status: "dropped" }, { archived: true }] as const) {
		const task = await runtime.board.saveTask({ task: { title: "Order form", description: "A synthetic order form.", acceptance: null, status: "in_progress", blockedBy: [], blockedReason: null, writeScopes: [] } }, "user");
		const app = await apps.publish(projectId, { name: "Orders", port, taskId: task.id }, agent, runtime.activeApps);
		expect(app).toMatchObject({ taskId: task.id, url: null, state: "live", mode: "off" });
		expect(appPublishReceipt(app).warning).toContain("No app address is configured");
		if ("archived" in change) await runtime.harness.commit(async tx => {
			const document = await tx.doc(BoardDoc, runtime.conversation.id);
			document.tasks.find(row => row.id === task.id)!.archived = true;
		}, BACKGROUND_CONTEXT);
		else await runtime.board.saveTask({ taskId: task.id, expectedRevision: task.revision, task: { ...task, ...change } }, "user");
		await until(async () => (await apps.list(projectId)).find(row => row.appId === app.appId)?.state === "unpublished");
	}
});

test("worker defaults to its task; forget and thread archive clean only unbound apps", async () => {
	const { setup, client, projectId, runtime } = await fixture();
	await client.request({ type: "apps.settings.set", settings: { addresses: template, policy: "on" } });
	const port = listen();
	const task = await runtime.board.saveTask({ task: { title: "Order form", description: "A synthetic order form.", acceptance: null, status: "in_progress", blockedBy: [], blockedReason: null, writeScopes: [] } }, "user");
	fauxCalls(setup, text => {
		if (text === "Delegate") return fauxAssistantMessage([
			fauxToolCall("worker_spawn", { id: "orders", task: "Publish assigned", taskId: task.id, isolation: "shared" }),
			fauxToolCall("worker_spawn", { id: "misc", task: "Publish unassigned", isolation: "shared" }),
		], { stopReason: "toolUse" });
		if (text === "Forget") return call("worker_forget", { id: "misc", removeWorkspace: false });
		if (text.startsWith("Publish")) return call("app_publish", { name: text, port });
	});
	await submit(client, projectId, "Delegate");
	await until(async () => (await list(client, projectId)).length === 2);
	const rows = await list(client, projectId);
	expect(rows.find(app => app.publishedBy.id === "orders")).toMatchObject({ taskId: task.id, state: "live" });
	expect(rows.find(app => app.publishedBy.id === "misc")?.taskId).toBeUndefined();
	await until(async () => (await runtime.workers.list()).workers.every(worker => worker.status !== "running"));
	await submit(client, projectId, "Forget");
	await until(async () => (await list(client, projectId)).some(app => app.publishedBy.id === "misc" && app.state === "unpublished"));
	const started = await runtime.threads.start({ id: "docs", title: "API docs", brief: "Publish from a thread", model: null, thinkingLevel: null, onFinish: "record", startedBy: "main", scheduleId: null, taskId: task.id, key: "apps-thread" });
	if (!started.ok) throw new Error(started.message);
	const thread = started.record.id;
	await until(async () => (await list(client, projectId)).some(app => app.publishedBy.kind === "thread"));
	await runtime.threads.finish(started.record, "Published the sample.", "finished-app-thread");
	await runtime.threads.archive(thread, true);
	await until(async () => (await list(client, projectId)).some(app => app.publishedBy.kind === "thread" && app.state === "unpublished"));
	expect((await list(client, projectId)).find(app => app.publishedBy.id === "orders")?.state).toBe("live");
}, 20_000);

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const bunAppCommand = (code: string) => `exec ${quote(process.execPath)} --no-env-file -e ${quote(code)}`;
function availableTestPort() {
	const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
	const port = listener.port!;
	listener.stop(true);
	return port;
}

async function appAnswers(port: number) {
	try { return (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) })).ok; }
	catch { return false; }
}

test("managed app reattaches after a backend restart, supplies logs and stops through the owner RPC", async () => {
	const { setup, client, projectId, runtime, agent } = await fixture();
	await client.request({ type: "apps.settings.set", settings: { addresses: template, policy: "on" } });
	const apps = setup.server.manager.apps!;
	const port = availableTestPort();
	const appId = crypto.randomUUID();
	try {
		const command = bunAppCommand(`console.log("synthetic startup log"); Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response("Bakery ready") })`);
		const app = await apps.startManaged(projectId, { port, command, name: "Bakery service" }, agent, runtime.activeApps, appId);
		expect(app.state).toBe("live");
		expect(app.managed).toBeDefined();
		expect(await appAnswers(port)).toBe(true);
		const doc = (await setup.server.manager.store.require(projectId)).apps!;
		const prior = JSON.parse(JSON.stringify(encodeProjectAppRegistry({ apps: doc }))).apps;
		expect(readAppRegistry(prior, projectId)?.records?.[0]?.managedProcess).toMatchObject({ command, cwd: setup.projectDir,
			logPath: apps.logPath(appId), process: { pid: expect.any(Number), startTime: expect.any(String) } });
		delete prior.records[0].managedProcess;
		expect(readAppRegistry(prior, projectId)?.records?.[0]).toMatchObject({ appId, state: "live" });
		client.close();
		await setup.restart();
		expect(await appAnswers(port)).toBe(true);
		const reopened = await TestClient.open(setup.server);
		try {
			await reopened.hello();
			expect(await list(reopened, projectId)).toMatchObject([{ appId, state: "live", managed: app.managed! }]);
			expect(await reopened.request({ type: "apps.log", projectId, appId })).toMatchObject({ type: "apps.log", text: expect.stringContaining("synthetic startup log") });
			expect(await reopened.request({ type: "apps.unpublish", projectId, appId })).toMatchObject({ type: "apps.unpublish", app: { state: "unpublished" } });
			expect(await appAnswers(port)).toBe(false);
		} finally { reopened.close(); }
	} finally { await setup.server.manager.apps!.stopApp(projectId, appId, "owner").catch(() => undefined); }
}, 15000);

test("managed starts refuse a cwd that escapes through a symlink and return the log from an early exit", async () => {
	const { setup, client, projectId, runtime, agent } = await fixture();
	await client.request({ type: "apps.settings.set", settings: { addresses: template, policy: "on" } });
	const apps = setup.server.manager.apps!;
	const port = availableTestPort();
	const command = bunAppCommand('console.error("synthetic early failure"); process.exit(3)');
	await symlink(setup.root, join(setup.projectDir, "escape"));
	await expect(apps.startManaged(projectId, { port, command, name: "Outside", cwd: "escape" }, agent, runtime.activeApps)).rejects.toThrow("inside this project");
	await expect(apps.startManaged(projectId, { port, command, name: "Early failure" }, agent, runtime.activeApps)).rejects.toThrow("synthetic early failure");
	expect(await appAnswers(port)).toBe(false);
	expect((await apps.list(projectId)).every(app => app.state === "unpublished")).toBe(true);
}, 12000);

test("detached fallback checks start time before signaling and caps log files", async () => {
	const { setup } = await fixture();
	const processes = new ManagedAppProcesses(setup.dataDir, async () => undefined);
	const id = crypto.randomUUID();
	const command = bunAppCommand('console.log("l".repeat(1300000)); console.log("synthetic tail marker"); setInterval(() => {}, 5000)');
	const owned = await processes.launch(id, command, setup.projectDir);
	try {
		expect(owned.unit).toBeUndefined();
		await processes.stop(id, { ...owned, startTime: `${owned.startTime}:other` });
		expect(await processes.alive(id, owned)).toBe(true);
		await until(async () => (await processes.tail(id, 4096)).includes("synthetic tail marker"));
		const size = (await stat(processes.logPath(id))).size + (await stat(`${processes.logPath(id)}.1`)).size;
		expect(size).toBeLessThanOrEqual(APP_LOG_LIMIT);
	} finally { await processes.stop(id, owned); }
	expect(await processes.alive(id, owned)).toBe(false);
}, 12000);

test("pruning a stopped managed app removes its log; external stop never kills its listener", async () => {
	let now = Date.now();
	const { setup, client, projectId, runtime, agent } = await fixture(undefined, { now: () => now });
	await client.request({ type: "apps.settings.set", settings: { addresses: template, policy: "on" } });
	const apps = setup.server.manager.apps!;
	const port = availableTestPort();
	const command = bunAppCommand(`console.log("pruned log"); Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch: () => new Response("ready") })`);
	const appId = crypto.randomUUID();
	try {
		const app = await apps.startManaged(projectId, { name: "Pruned", port, command }, agent, runtime.activeApps, appId);
		const receipt = appStartReceipt(app, apps.logPath(appId));
		if (!receipt.survivesRestart) expect(receipt.warning).toContain("will not survive");
		await apps.reconcile(projectId, async () => () => false);
		expect(await appAnswers(port)).toBe(false);
		expect(await Bun.file(apps.logPath(appId)).exists()).toBe(true);
		now += 86_400_001;
		expect((await apps.list(projectId)).find(app => app.appId === appId)).toBeUndefined();
		expect(await Bun.file(apps.logPath(appId)).exists()).toBe(false);
	} finally { await apps.stopApp(projectId, appId, "owner").catch(() => undefined); }
	const foreign = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("external") });
	try {
		const app = await apps.publish(projectId, { name: "External", port: foreign.port! }, agent, runtime.activeApps);
		await apps.stopApp(projectId, app.appId, agent.publisher);
		expect(await appAnswers(foreign.port!)).toBe(true);
	} finally { foreign.stop(true); }
}, 15000);

test("slow listener and linked-workspace scans do not hold the project document update", async () => {
	const { setup, projectId, runtime, agent } = await fixture();
	const port = listen();
	const listenerEntered = Promise.withResolvers<void>();
	const listenerRelease = Promise.withResolvers<void>();
	const workspaceEntered = Promise.withResolvers<void>();
	const workspaceRelease = Promise.withResolvers<void>();
	const outside = join(setup.root, "linked-synthetic-workspace");
	const apps = new AgentApps({ store: setup.server.manager.store, settings: () => ({ addresses: template, policy: "on" }),
		backendPort: () => setup.server.port, backendOrigins: () => [], changed: () => {},
		listenerSource: { listeners: async () => {
			listenerEntered.resolve(); await listenerRelease.promise;
			return [{ address: "127.0.0.1", port, pids: [1234] }];
		}, cwd: async () => outside, workspaces: async () => {
			workspaceEntered.resolve(); await workspaceRelease.promise; return [outside];
		} },
	});
	const reading = apps.listForOwner(projectId);
	try {
		await listenerEntered.promise;
		const first = await Promise.race([apps.publish(projectId, { port, name: "First" }, agent, runtime.activeApps), Bun.sleep(600).then(() => null)]);
		expect(first?.name).toBe("First");
		listenerRelease.resolve();
		await workspaceEntered.promise;
		const laterPort = listen();
		const second = await Promise.race([apps.publish(projectId, { port: laterPort, name: "Second" }, agent, runtime.activeApps), Bun.sleep(600).then(() => null)]);
		expect(second?.name).toBe("Second");
	} finally {
		listenerRelease.resolve();
		workspaceRelease.resolve();
		await reading.catch(() => undefined);
	}
	expect((await reading).apps.map(app => [app.name, app.state])).toEqual([["Second", "live"], ["First", "live"]]);
});

test("app logs are not available to anonymous optional-mode connections", async () => {
	const { client, projectId } = await fixture(undefined, { auth: { mode: "optional" } });
	expect(await client.request({ type: "apps.log", projectId, appId: crypto.randomUUID() })).toMatchObject({ type: "error", error: { code: "auth_required" } });
});
