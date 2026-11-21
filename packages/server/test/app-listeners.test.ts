import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { AgentApps } from "../src/agent-apps.ts";
import { linuxAppListenerSource, parseAppListeners, type AppListener } from "../src/app-listeners.ts";
import { createSetup, errorOf, TestClient } from "./support.ts";

test("ss parses numeric IPv4, IPv6 and wildcard listeners, with optional multiple PIDs", async () => {
	const output = [
		'LISTEN 0 4096 127.0.0.1:5173 0.0.0.0:* users:(("bun",pid=82,fd=9),("bun",pid=83,fd=10))',
		'LISTEN 0 4096 [::]:8080 [::]:* users:(("bun",pid=82,fd=11))',
		'LISTEN 0 511 *:9090 *:*',
		'LISTEN 0 511 0.0.0.0:4000 0.0.0.0:*',
		'LISTEN 0 511 [::1]:3000 [::]:*',
		'ESTAB 0 0 127.0.0.1:5000 127.0.0.1:5001',
		'LISTEN 0 0 [::]:* [::]:*',
	].join("\n");
	const commands: unknown[] = [];
	const run = async (file: string, args: string[]) => { commands.push([file, args]); return output; };
	const expected = [
		{ address: "127.0.0.1", port: 5173, pids: [82, 83] }, { address: "::", port: 8080, pids: [82] },
		{ address: "*", port: 9090, pids: [] }, { address: "0.0.0.0", port: 4000, pids: [] }, { address: "::1", port: 3000, pids: [] },
	];
	expect(parseAppListeners(output)).toEqual(expected);
	expect(await linuxAppListenerSource(run, "linux").listeners()).toEqual(expected);
	expect(await linuxAppListenerSource(run, "darwin").listeners()).toBeNull();
	expect(commands).toEqual([["ss", ["-ltnpH"]]]);
});

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
	let now = Date.parse("2026-01-02T00:00:00Z");
	let sockets: AppListener[] | null = [];
	const cwds = new Map<number, string>();
	const linked: string[] = [];
	const setup = await createSetup({ terminals: false, now: () => now, appListenerSource: {
		listeners: async () => sockets, cwd: async pid => cwds.get(pid) ?? null, workspaces: async () => linked,
	} });
	cleanups.push(() => setup.cleanup());
	const client = await TestClient.open(setup.server);
	cleanups.push(() => client.close());
	await client.request({ type: "hello", protocolVersion: 1, client: { name: "test", version: "0", features: ["apps"] } });
	const added = await client.request({ type: "projects.add", path: setup.projectDir });
	if (added.type !== "projects.add") throw errorOf(added);
	const projectId = added.project.id;
	const registry = setup.server.manager.apps!;
	async function list() {
		const answer = await client.request({ type: "apps.list", projectId });
		if (answer.type !== "apps.list") throw errorOf(answer);
		return answer;
	}
	return { registry, client, projectId, setup, cwds, linked, list, setSockets(next: AppListener[] | null) { sockets = next; now += 1001; },
		advance(ms: number) { now += ms; } };
}

const listener = (port: number, pid = 1, address = "127.0.0.1"): AppListener => ({ port, address, pids: [pid] });

test("owner suggestions require a matching cwd and disappear when ignored or published", async () => {
	const { cwds, linked, setSockets, setup, client, projectId, list, registry } = await fixture();
	const projectData = registry.options.store.projectDir(projectId);
	const linkedDir = `${setup.projectDir}-linked`;
	linked.push(linkedDir);
	cwds.set(1, join(setup.projectDir, "src"));
	cwds.set(2, join(projectData, "workspaces", "worker", "src"));
	cwds.set(3, `${setup.projectDir}-different/src`);
	cwds.set(4, join(linkedDir, "src"));
	cwds.set(5, join(projectData, "threads", "docs", "workers", "worker"));
	cwds.set(6, join(projectData, "threads", "docs", "logs"));
	setSockets([listener(5100), listener(5101, 2, "0.0.0.0"), listener(5102, 3), listener(5103, 4, "::"),
		listener(5104, 5, "*"), listener(5105, 6), listener(5106, 32), listener(5107, 1, "::1"), listener(80), listener(setup.server.port)]);
	const first = await list();
	expect(first.apps).toEqual([]);
	expect(first.detected).toEqual([5100, 5101, 5103, 5104].map(port => ({ port })));
	expect((await client.request({ type: "apps.publishDetected", projectId, port: 5102 })).type).toBe("error");
	expect((await client.request({ type: "apps.ignoreDetected", projectId, port: 5101 })).type).toBe("apps.ignoreDetected");
	expect((await list()).detected).not.toContainEqual({ port: 5101 });
	await client.request({ type: "apps.settings.set", settings: { addresses: { mode: "template", template: "http://oven.example.test:{port}" }, policy: "ask" } });
	const published = await client.request({ type: "apps.publishDetected", projectId, port: 5100 });
	expect(published).toMatchObject({ type: "apps.publishDetected", app: { state: "live", ownerPublished: true, name: "Port 5100", url: "http://oven.example.test:5100/" } });
	expect((await list()).detected).not.toContainEqual({ port: 5100 });
	expect((await registry.options.store.require(projectId)).apps?.approved).toBeUndefined();
	setSockets([listener(5100)]);
	await registry.refresh();
	setSockets([listener(5100), listener(5101, 2)]);
	expect((await list()).detected).toEqual([{ port: 5101 }]);
});

test("a stopped app is reversible, unavailable scans are not stops, and inactive records expire without a schema bump", async () => {
	const { cwds, setSockets, setup, client, projectId, list, registry, advance } = await fixture();
	cwds.set(1, setup.projectDir);
	setSockets([listener(5100), listener(5101)]);
	const publish = (port: number) => client.request({ type: "apps.publishDetected", projectId, port });
	await client.request({ type: "apps.settings.set", settings: { addresses: { mode: "template", template: "http://oven.example.test:{port}" }, policy: "on" } });
	const first = await publish(5100), second = await publish(5101);
	if (first.type !== "apps.publishDetected" || second.type !== "apps.publishDetected") throw new Error("Missing fixtures");
	await client.request({ type: "apps.unpublish", projectId, appId: second.app.appId });
	setSockets(null);
	expect(await list()).toMatchObject({ listenerChecksAvailable: false, apps: [{ state: "unpublished" }, { state: "live" }] });
	const observer = await TestClient.open(setup.server);
	cleanups.push(() => observer.close());
	await observer.request({ type: "hello", protocolVersion: 1, client: { name: "test", version: "0", features: ["apps"] } });
	setSockets([]);
	await registry.refresh();
	await observer.waitFor(message => message.type === "apps.changed" && message.projectId === projectId);
	expect((await list()).apps[1]).toMatchObject({ state: "stopped", url: null });
	const stored = await registry.options.store.require(projectId);
	expect(stored.version).toBe(1);
	expect(stored.apps?.records?.[1]).toMatchObject({ state: "live", url: first.app.url, stoppedAt: expect.any(String) });
	const reopened = new AgentApps(registry.options);
	expect((await reopened.list(projectId))[1]?.state).toBe("stopped");
	setSockets([listener(5100)]);
	expect((await list()).apps[1]).toMatchObject({ state: "live", url: first.app.url });
	setSockets([]);
	expect((await list()).apps[1]?.state).toBe("stopped");
	advance(86_400_000);
	await registry.refresh();
	expect((await list()).apps).toEqual([]);
	expect((await registry.options.store.require(projectId)).apps).toMatchObject({ records: [], activity: [] });
});
