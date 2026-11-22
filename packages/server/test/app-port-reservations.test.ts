import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { APP_PORT_SETUP_COMMAND, DEFAULT_APP_SETTINGS } from "@kemiri/protocol";
import { readAppSettings } from "../src/app-addresses.ts";
import { listenAppForwarder } from "../src/app-forwarders.ts";
import { appForwarderPort } from "../src/app-port-reservations.ts";
import { AppPortSetup } from "../src/app-port-setup.ts";
import { fakeTailscale } from "./fake-tailscale.ts";
import { createSetup, TestClient } from "./support.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

test("loopback forwarder carries HTTP requests and websocket upgrades without changing their Host or path", async () => {
	const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0,
		fetch(request, server) {
			if (server.upgrade(request)) return;
			return new Response(`${request.headers.get("host")} ${new URL(request.url).pathname}`);
		},
		websocket: { message(socket, message) { socket.send(message); } },
	});
	cleanups.push(() => upstream.stop(true));
	const forwarder = await listenAppForwarder(0, upstream.port!);
	cleanups.push(() => forwarder.close());
	const host = "oven.example-tailnet.ts.net:47300";
	expect(await (await fetch(`http://127.0.0.1:${forwarder.port}/orders`, { headers: { Host: host } })).text()).toBe(`${host} /orders`);
	const ws = new WebSocket(`ws://127.0.0.1:${forwarder.port}/live`);
	cleanups.push(() => ws.close());
	const echoed = new Promise<string>((resolve, reject) => {
		ws.addEventListener("open", () => ws.send("order updated"), { once: true });
		ws.addEventListener("error", reject, { once: true });
		ws.addEventListener("message", event => resolve(event.data), { once: true });
	});
	expect(await echoed).toBe("order updated");
	const closed = new Promise<void>(resolve => ws.addEventListener("close", () => resolve(), { once: true }));
	cleanups.splice(cleanups.length - 2, 1); // Close the forwarder now instead of closing it again in cleanup.
	forwarder.close();
	await closed;
	await expect(fetch(`http://127.0.0.1:${forwarder.port}/`)).rejects.toThrow();
});

test("owner CLI reserves exact targets idempotently and refuses foreign mappings", async () => {
	const home = await mkdtemp(join(tmpdir(), "kemiri-app-ports-cli-"));
	cleanups.push(() => rm(home, { recursive: true, force: true }));
	const dataDir = join(home, "data");
	await mkdir(dataDir);
	const hostname = "oven.example-tailnet.ts.net";
	const cliLog = join(home, "writes.jsonl");
	const configPath = join(home, "serve.json");
	await writeFile(join(home, "ss"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	// Fake sudo removes the elevation step but still exercises the CLI's non-operator path.
	await writeFile(join(home, "sudo"), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o755 });
	await writeFile(join(home, "tailscale"), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
const [command, ...args] = process.argv.slice(2);
const hostname = ${JSON.stringify(hostname)};
const file = ${JSON.stringify(configPath)};
if (command === 'status') console.log(JSON.stringify({BackendState: 'Running', Self: {DNSName: hostname + '.'}, CertDomains: [hostname]}));
else if (command === 'debug') console.log(JSON.stringify({OperatorUser: ''}));
else if (command === 'serve') {
  const config = await Bun.file(file).json();
  if (args[0] === 'status') console.log(JSON.stringify(config));
  else {
    const port = args.find(arg => arg.startsWith('--https=')).slice(8);
    const authority = hostname + ':' + port;
    appendFileSync(${JSON.stringify(cliLog)}, JSON.stringify(args) + '\\n');
    if (args.at(-1) === 'off') { delete config.TCP[port]; delete config.Web[authority]; }
    else { config.TCP[port] = { HTTPS: true }; config.Web[authority] = { Handlers: { '/': { Proxy: args.at(-1) } } }; }
    await Bun.write(file, JSON.stringify(config));
  }
} else process.exit(1);
`, { mode: 0o755 });
	const env = { HOME: home, USER: userInfo().username, PATH: home, KEMIRI_DATA_DIR: dataDir, KEMIRI_PORT: "7317" };
	async function cli(...args: string[]) {
		const command = Bun.spawn([process.execPath, "--no-env-file", new URL("../src/main.ts", import.meta.url).pathname, "tailscale", ...args],
			{ env, cwd: home, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(command.stdout).text(), new Response(command.stderr).text(), command.exited]);
		return { code, output: stdout + stderr };
	}
	const foreign = { TCP: { "443": { HTTPS: true }, "47301": { HTTPS: true } }, Web: {
		[`${hostname}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } },
		[`${hostname}:47301`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:57301" } } },
	} };
	await Bun.write(configPath, JSON.stringify(foreign));
	expect(await cli("enable", "--apps")).toMatchObject({ code: 1, output: expect.stringContaining("Serve already uses port 47301") });
	for (const range of ["443-443", "8442-8444", "7316-7318", "55535-55536"]) {
		expect(await cli("enable", "--apps", "--ports", range)).toMatchObject({ code: 1, output: expect.stringContaining("Use 1–100 HTTPS ports") });
	}
	expect(await Bun.file(cliLog).exists()).toBe(false);
	const enable = ["enable", "--apps", "--ports", "47302-47303"];
	expect(await cli(...enable)).toMatchObject({ code: 0, output: expect.stringContaining("47302–47303 reserved") });
	expect((await cli("enable", "--apps")).code).toBe(0);
	expect(await Bun.file(cliLog).text()).toBe([
		["--bg", "--yes", "--https=47302", "http://127.0.0.1:57302"], ["--bg", "--yes", "--https=47303", "http://127.0.0.1:57303"],
	].map(args => JSON.stringify(args) + "\n").join(""));
	expect(await cli("status")).toMatchObject({ code: 0, output: expect.stringContaining("Reserved HTTPS ports: 47302–47303") });
	const changed = await Bun.file(configPath).json();
	changed.Web[`${hostname}:47303`].Handlers["/foreign"] = { Text: "keep me" };
	await Bun.write(configPath, JSON.stringify(changed));
	expect(await cli("disable", "--apps")).toMatchObject({ code: 0, output: expect.stringContaining("Removed 1") });
	expect(await cli("disable", "--apps")).toMatchObject({ code: 0, output: expect.stringContaining("Removed 0") });
	delete changed.TCP[47302];
	delete changed.Web[`${hostname}:47302`];
	expect(await Bun.file(configPath).json()).toEqual(changed);
}, 20_000);

test("reserved mode picks free forwarders, restores assignments, and shows safe fallbacks without changing Serve", async () => {
	const fake = fakeTailscale();
	const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("Orders") });
	cleanups.push(() => upstream.stop(true));
	const setup = await createSetup({ terminals: false, appTailscale: fake.tailscale, appListenerSource: {
		listeners: async () => [{ address: "127.0.0.1", port: upstream.port!, pids: [] }], cwd: async () => null, workspaces: async () => [],
	} });
	const client = await TestClient.open(setup.server);
	cleanups.push(() => client.close());
	await client.hello();
	const project = await client.request({ type: "projects.add", path: setup.projectDir });
	if (project.type !== "projects.add") throw new Error("Could not create the fixture project");
	const projectId = project.project.id;
	const apps = setup.server.manager.apps!;
	const dataDir = apps.options.store.dataDir;
	const appPorts = new AppPortSetup(dataDir, setup.server.port, fake.tailscale, async () => new Set([upstream.port!]));
	const startPort = 48140;
	const range = { startPort, endPort: startPort + 2 };
	await client.request({ type: "apps.settings.set", settings: { ...DEFAULT_APP_SETTINGS, policy: "on" } });
	const publish = (name: string) => apps.publish(projectId, { port: upstream.port!, name, path: "/orders" }, { publisher: {
		kind: "coordinator", id: "main", threadId: "main", conversationId: 1,
	} }, async () => () => true);
	const first = await publish("Order form");
	expect(first).toMatchObject({ state: "live", url: null, addressMessage: expect.stringContaining(APP_PORT_SETUP_COMMAND) });
	const legacyTarget = `http://127.0.0.1:${upstream.port}`;
	fake.mapping(startPort, legacyTarget);
	await Bun.write(join(dataDir, "app-serve-ownership.json"), JSON.stringify([
		{ hostname: fake.hostname, httpsPort: startPort, target: legacyTarget, projectId, appId: first.appId },
	]));
	await apps.refresh();
	expect((await fake.tailscale.serveStatus()).occupied.has(startPort)).toBe(true);
	expect(fake.commands.filter(args => args[1] === "serve" && args[2] !== "status")).toEqual([]);
	await appPorts.enable(range);
	expect(await Bun.file(join(dataDir, "app-serve-ownership.json")).json()).toEqual([]);
	fake.commands.length = 0;
	fake.operator.value = false;
	fake.writeDenied.value = true;
	const occupied = Bun.listen({ hostname: "127.0.0.1", port: appForwarderPort(startPort), socket: { data() {} } });
	cleanups.push(() => occupied.stop(true));
	const second = await publish("Kitchen view");
	expect(second.url).toBe(`https://${fake.hostname}:${startPort + 1}/orders`);
	await expect(fetch(`http://127.0.0.1:${appForwarderPort(startPort + 1)}/orders`).then(response => response.text())).resolves.toBe("Orders");
	const [third, fourth] = await Promise.all([publish("Receipts"), publish("Sandwich menu")]);
	expect([third, fourth].filter(app => app.url)).toHaveLength(1);
	expect([third, fourth].find(app => !app.url)?.addressMessage).toContain("No reserved HTTPS port is free");
	const restarted = (await setup.restart()).manager.apps!;
	expect((await restarted.list(projectId)).find(row => row.appId === second.appId)?.url).toBe(second.url);
	await restarted.unpublish(projectId, second.appId, "owner");
	await expect(fetch(`http://127.0.0.1:${appForwarderPort(startPort + 1)}/orders`)).rejects.toThrow();
	fake.drop(startPort);
	expect((await restarted.list(projectId)).find(row => row.appId === first.appId)).toMatchObject({ url: null, addressMessage: expect.stringContaining(APP_PORT_SETUP_COMMAND) });
	const restartedClient = await TestClient.open(setup.server);
	cleanups.push(() => restartedClient.close());
	await restartedClient.hello();
	await restartedClient.request({ type: "apps.settings.set", settings: { policy: "on", addresses: { mode: "template", template: `http://${fake.hostname}:{port}` } } });
	expect((await restarted.list(projectId)).find(row => row.appId === first.appId)?.url).toBe(`http://${fake.hostname}:${upstream.port}/orders`);
	expect(fake.commands.filter(args => args[1] === "serve" && args[2] !== "status")).toEqual([]);
});

test("legacy automatic Serve settings migrate without granting runtime rights; explicit modes remain", () => {
	const operator = { addresses: { mode: "tailscale-serve", startPort: 47300, endPort: 47319 }, policy: "on" } as const;
	expect(readAppSettings(operator)).toEqual({ addresses: { mode: "tailscale-reserved" }, policy: "on" });
	expect(readAppSettings(operator, true)).toEqual(operator);
	for (const addresses of [{ mode: "off" }, { mode: "template", template: "http://oven.example.test:{port}" }] as const) {
		expect(readAppSettings({ addresses, policy: "ask" })).toEqual({ addresses, policy: "ask" });
	}
});
