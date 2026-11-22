import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { appInstructions, validateAppSettings } from "../src/app-addresses.ts";
import { appPublishReceipt } from "../src/agent-apps.ts";
import type { AppListener } from "../src/app-listeners.ts";
import { loopbackTarget, parseServeStatus, serveUnavailable } from "../src/tailscale.ts";
import { fakeTailscale } from "./fake-tailscale.ts";
import { createSetup, errorOf, TestClient } from "./support.ts";

const startPort = 27300;
const settings = { policy: "on", addresses: { mode: "tailscale-serve", startPort, endPort: startPort + 4 } } as const;
const cleanups: (() => unknown)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function fixture() {
	const fake = fakeTailscale();
	let now = Date.now();
	let listening: AppListener[] | null = [];
	const warnings: string[] = [];
	const setup = await createSetup({ terminals: false, appTailscale: fake.tailscale, now: () => now, log: line => warnings.push(line),
		appListenerSource: { listeners: async () => listening, cwd: async () => null, workspaces: async () => [] } });
	const client = await TestClient.open(setup.server);
	cleanups.push(() => client.close());
	await client.hello();
	const added = await client.request({ type: "projects.add", path: setup.projectDir });
	if (added.type !== "projects.add") throw errorOf(added);
	const projectId = added.project.id;
	const appServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Example") });
	cleanups.push(() => appServer.stop(true));
	const localPort = appServer.port!;
	const listener = (port: number): AppListener => ({ port, address: "127.0.0.1", pids: [] });
	listening = [listener(localPort)];
	const apps = setup.server.manager.apps!;
	const projectFile = apps.options.store.projectFile(projectId);
	const journal = Bun.file(join(apps.options.store.dataDir, "app-serve-ownership.json"));
	const publish = (id = crypto.randomUUID() as string) => apps.publish(projectId, { port: localPort, path: "/docs", name: "Example app", taskId: id },
		{ publisher: { id: "main", threadId: "main", kind: "coordinator", conversationId: 42 } }, async () => () => true, id);
	return { fake, setup, client, projectId, projectFile, journal, apps, publish, warnings, localPort,
		ports(ports: number[] | null) { listening = ports?.map(listener) ?? null; now += 1001; },
		advance(ms: number) { now += ms; }, writes: () => fake.commands.filter(command => command[1] === "serve" && command[2] !== "status") };
}

test("Tailscale status trims the name, checks the service account and sends exact CLI arguments", async () => {
	const fake = fakeTailscale();
	const status = await fake.tailscale.status();
	expect(status.hostname).toBe(fake.hostname);
	expect(serveUnavailable(status)).toBeUndefined();
	const mapping = { hostname: fake.hostname, httpsPort: startPort, target: loopbackTarget(4300) };
	await fake.tailscale.add(mapping);
	expect((await fake.tailscale.serveStatus()).matches(mapping)).toBe(true);
	await fake.tailscale.remove(startPort);
	expect(fake.commands).toEqual([
		["tailscale", "status", "--json"], ["tailscale", "debug", "prefs"],
		["tailscale", "serve", "--bg", "--yes", "--https=27300", "http://127.0.0.1:4300"],
		["tailscale", "serve", "status", "--json"], ["tailscale", "serve", "--https=27300", "off"],
	]);
	expect(parseServeStatus("null").occupied.size).toBe(0);
	expect(appInstructions(settings, fake.hostname)).toContain(`Serve on 127.0.0.1, and use app_start with the command and port. Devices reach it at https://${fake.hostname}:PORT-ASSIGNED/; the app must accept the Host name ${fake.hostname} (with the port) and is served over HTTPS.`);
});

test("the HTTPS range refuses reserved, own, reversed and oversized ranges", async () => {
	for (const [startPort, endPort] of [[443, 443], [8440, 8444], [3000, 3010], [3080, 3079], [30000, 30100], [65535, 65536]] as const) {
		expect(() => validateAppSettings({ ...settings, addresses: { mode: "tailscale-serve", startPort, endPort } }, 3005)).toThrow("HTTPS port range");
	}
	const { client, setup } = await fixture();
	const response = await client.request({ type: "apps.settings.set", settings: { ...settings, addresses: { mode: "tailscale-serve", startPort: setup.server.port, endPort: setup.server.port } } });
	expect(response.type).toBe("error");
});

test("parallel publishing skips sockets, Serve mappings and ownership even if that mapping disappeared", async () => {
	const { fake, client, apps, publish, journal, projectFile, localPort, ports } = await fixture();
	fake.mapping(443, loopbackTarget(3000));
	fake.mapping(startPort + 1, loopbackTarget(3001));
	ports([localPort, startPort]);
	await client.request({ type: "apps.settings.set", settings });
	const first = await publish("first");
	expect(first.url).toBe(`https://${fake.hostname}:${startPort + 2}/docs`);
	fake.drop(startPort + 2);
	const [second, third] = await Promise.all([publish("second"), publish("third")]);
	expect([second.url, third.url].sort()).toEqual([`https://${fake.hostname}:${startPort + 3}/docs`, `https://${fake.hostname}:${startPort + 4}/docs`]);
	expect(await publish("full")).toMatchObject({ state: "live", url: null, addressMessage: expect.stringContaining("No HTTPS port is free") });
	expect(await journal.json()).toHaveLength(3);
	const disk = await Bun.file(projectFile).json();
	expect(disk.version).toBe(1);
	expect(disk.apps.records.find((row: { appId: string }) => row.appId === "first")).toMatchObject({ mode: "off", tailscaleServe: true,
		serveMapping: { httpsPort: startPort + 2, target: loopbackTarget(localPort) } });
	await apps.refresh();
	expect((await fake.tailscale.serveStatus()).occupied).toEqual(new Set([443, startPort + 1, startPort + 2, startPort + 3, startPort + 4]));
});

test("reconciliation repairs a missing mapping, keeps a stopped mapping, prunes it, and leaves foreign mappings", async () => {
	const { fake, client, apps, projectId, publish, localPort, ports, advance, warnings } = await fixture();
	fake.mapping(443, loopbackTarget(3000));
	await client.request({ type: "apps.settings.set", settings });
	const first = await publish("first");
	const second = await publish("second");
	const third = await publish("third");
	fake.drop(startPort);
	fake.mapping(startPort + 1, loopbackTarget(3001));
	fake.config.Web[`${fake.hostname}:${startPort + 2}`]!.Handlers["/extra"] = { Proxy: loopbackTarget(3002) };
	await apps.refresh();
	expect((await apps.list(projectId)).find(app => app.appId === first.appId)?.url).toBe(first.url);
	expect((await apps.list(projectId)).filter(app => app.appId !== first.appId).every(app => !app.url && !!app.addressMessage)).toBe(true);
	await apps.unpublish(projectId, second.appId, "owner");
	await apps.reconcile(projectId, async () => app => app.taskId !== third.taskId);
	expect(warnings.filter(line => line.includes("untouched"))).toHaveLength(2);
	ports([]);
	expect((await apps.list(projectId)).find(app => app.appId === first.appId)?.state).toBe("stopped");
	expect((await fake.tailscale.serveStatus()).occupied.has(startPort)).toBe(true);
	advance(86_400_001);
	await apps.refresh();
	expect((await fake.tailscale.serveStatus()).occupied).toEqual(new Set([443, startPort + 1, startPort + 2]));
	expect((await apps.list(projectId))).toHaveLength(0);
	ports([localPort]);
});

test("startup removes a mapping whose journal outlived a crash before the app row was written", async () => {
	const { fake, setup, client, projectId, projectFile, publish, journal } = await fixture();
	await client.request({ type: "apps.settings.set", settings });
	await publish();
	fake.mapping(startPort + 3, loopbackTarget(3000));
	const disk = await Bun.file(projectFile).json();
	delete disk.apps;
	await Bun.write(projectFile, JSON.stringify(disk));
	const restarted = await setup.restart();
	await restarted.manager.apps!.refresh();
	expect(await journal.json()).toEqual([]);
	expect((await fake.tailscale.serveStatus()).occupied).toEqual(new Set([startPort + 3]));
	expect(await restarted.manager.apps!.list(projectId)).toEqual([]);
});

test("switching into Serve refreshes already published apps, and switching away releases their ports", async () => {
	const { fake, client, apps, projectId, publish, journal, localPort } = await fixture();
	await client.request({ type: "apps.settings.set", settings: { policy: "on", addresses: { mode: "template", template: "http://oven.example.test:{port}" } } });
	expect((await publish()).url).toBe(`http://oven.example.test:${localPort}/docs`);
	const written = await client.request({ type: "apps.settings.set", settings });
	expect(written).toMatchObject({ type: "apps.settings.set", settings });
	expect((await apps.list(projectId))[0]?.url).toBe(`https://${fake.hostname}:${startPort}/docs`);
	await client.request({ type: "apps.settings.set", settings: { policy: "on", addresses: { mode: "off" } } });
	expect((await apps.list(projectId))[0]).toMatchObject({ url: null, mode: "off", state: "live" });
	expect(await journal.json()).toEqual([]);
	expect((await fake.tailscale.serveStatus()).occupied.size).toBe(0);
});

test("missing prerequisites and denied writes keep the record but give the agent the exact fix instead of a link", async () => {
	const { fake, client, publish, writes, ports } = await fixture();
	fake.installed.value = false;
	await client.request({ type: "apps.settings.set", settings });
	expect(await client.request({ type: "apps.settings.get" })).toMatchObject({ tailscale: { installed: { ok: false } } });
	const missing = await publish();
	expect(missing).toMatchObject({ state: "live", url: null });
	expect(appPublishReceipt(missing).warning).toContain("Install Tailscale");
	fake.installed.value = true;
	fake.https.value = false;
	expect(appPublishReceipt(await publish()).warning).toContain("Enable HTTPS Certificates");
	fake.https.value = true;
	fake.operator.value = false;
	expect(appPublishReceipt(await publish()).warning).toContain("sudo tailscale set --operator=example-service");
	fake.operator.value = true;
	ports(null);
	expect(appPublishReceipt(await publish()).warning).toContain("iproute2");
	expect(writes()).toEqual([]);
	ports([]);
	fake.writeDenied.value = true;
	expect(appPublishReceipt(await publish()).warning).toContain("sudo tailscale set --operator=example-service");
});
