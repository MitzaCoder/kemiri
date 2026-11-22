import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBackendServeRecord } from "../src/backend-tailscale.ts";
import { inspectTailscaleStatus } from "../src/tailscale-status-cli.ts";
import { authPost, authSetup, claimProof, ownerControl } from "./device-auth-test-support.ts";
import { fakeTailscale } from "./fake-tailscale.ts";

const hostname = "vm.example-tailnet.ts.net";
const defaultOrigin = `https://${hostname}`;
const chosenPort = 47325;
const chosenOrigin = `${defaultOrigin}:${chosenPort}`;

async function fixture(options: { ports?: number[]; hosts?: string[]; trustedProxies?: string[]; mode?: "required" | "optional"; webDir?: string } = {}) {
	const fake = fakeTailscale(hostname);
	const s = await authSetup({
		appTailscale: fake.tailscale,
		appListenerSource: { listeners: async () => (options.ports ?? []).map(port => ({ port, address: "*", pids: [] })), cwd: async () => null, workspaces: async () => [] },
		auth: { mode: options.mode ?? "required", backendOrigins: options.hosts ?? [], trustedProxies: options.trustedProxies ?? [] },
		...(options.webDir ? { webDir: options.webDir } : {}),
	});
	const control = async (...args: string[]) => {
		const response = await ownerControl(s, args);
		return { status: response.status, body: await response.json() };
	};
	const enable = (...args: string[]) => control("tailscale", "enable", ...args);
	const disable = () => control("tailscale", "disable");
	const writes = () => fake.commands.filter(command => command[1] === "serve" && command[2] !== "status");
	return { ...fake, s, control, enable, disable, writes };
}

test("a free 443 becomes the default HTTPS address, without changing sign-in mode", async () => {
	const { s, control, enable, disable, tailscale, writes } = await fixture();
	expect(await enable()).toEqual({ status: 200, body: { publicOrigin: defaultOrigin, alreadyEnabled: false } });
	const mapping = await readBackendServeRecord(s.dataDir);
	expect(mapping).toMatchObject({ httpsPort: 443, target: s.server.url, addedHost: true, addedProxy: true, phase: "active" });
	expect(writes()).toEqual([["tailscale", "serve", "--bg", "--yes", "--https=443", s.server.url]]);
	expect((await control("hosts", "list")).body).toMatchObject({ allowed: [defaultOrigin] });
	const status = await inspectTailscaleStatus({ KEMIRI_DATA_DIR: s.dataDir, KEMIRI_PORT: String(s.server.port) }, tailscale);
	expect(status.serve.httpsMappings).toMatchObject([{ ownership: "kemiri", httpsPort: 443 }]);
	expect(status.trustedLoopback.managedOrigin).toBe(defaultOrigin);
	expect(await enable()).toEqual({ status: 200, body: { publicOrigin: defaultOrigin, alreadyEnabled: true } });
	expect(await disable()).toEqual({ status: 200, body: { mapping: "removed" } });
	expect(await disable()).toEqual({ status: 200, body: { mapping: "absent" } });
	expect((await control("hosts", "list")).body).toMatchObject({ allowed: [] });
	expect((await control("status")).body).toMatchObject({ mode: "required" });
	expect(await readBackendServeRecord(s.dataDir)).toBeUndefined();
	expect(writes()).toEqual([
		["tailscale", "serve", "--bg", "--yes", "--https=443", s.server.url], ["tailscale", "serve", "--https=443", "off"],
	]);
});

test("refuses a local or foreign port 443, the backend port and the app range", async () => {
	const local = await fixture({ ports: [443] });
	expect(await local.enable()).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining("local TCP listener already uses port 443. Choose another --port") } } });
	const foreign = await fixture();
	foreign.mapping(443, "http://127.0.0.1:47999");
	expect(await foreign.enable()).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining("Tailscale Serve already uses port 443. Choose another --port") } } });
	expect(await foreign.enable("--port", String(foreign.s.server.port))).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining("own local port") } } });
	expect(await foreign.enable("--port", "47300")).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining("agent-app range") } } });
	expect(await foreign.enable("--port", String(chosenPort))).toEqual({ status: 200, body: { publicOrigin: chosenOrigin, alreadyEnabled: false } });
	await foreign.disable();
	expect(foreign.writes()).toHaveLength(2);
	expect(Object.keys(foreign.config.TCP)).toEqual(["443"]);
	expect(local.writes()).toEqual([]);
});

test("disable preserves preexisting hosts and proxy trust and leaves a changed mapping untouched", async () => {
	const { s, enable, disable, mapping, writes, config } = await fixture({ hosts: [chosenOrigin, "https://other.example.test"], trustedProxies: ["127.0.0.1"] });
	expect((await enable("--port", String(chosenPort))).status).toBe(200);
	expect(await readBackendServeRecord(s.dataDir)).toMatchObject({ addedHost: false, addedProxy: false });
	mapping(chosenPort, "http://127.0.0.1:47999");
	expect(await disable()).toEqual({ status: 200, body: { mapping: "unchanged" } });
	expect(writes()).toHaveLength(1);
	expect(config.TCP[chosenPort]).toEqual({ HTTPS: true });
	expect(s.server.auth.hosts).toEqual([chosenOrigin, "https://other.example.test"]);
	expect(await readBackendServeRecord(s.dataDir)).toBeUndefined();
});

test("reports unmet prerequisites and never turns optional device sign-in into remote access", async () => {
	const unsupported = await fixture({ mode: "optional" });
	expect(await unsupported.enable()).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining("kemiri auth mode required") } } });
	expect(unsupported.s.server.auth.mode).toBe("optional");
	expect(unsupported.writes()).toEqual([]);
	const { operator, control, enable, writes } = await fixture();
	expect(await control("pair", "--tailscale")).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining(`MagicDNS: ${hostname}. Run kemiri tailscale enable first.`) } } });
	operator.value = false;
	expect(await enable()).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining("sudo tailscale set --operator=example-service") } } });
	expect(writes()).toEqual([]);
});

test("an interrupted write remains cleanable without touching foreign Serve ports", async () => {
	const { s, mapping, config, enable, disable, writeDenied } = await fixture();
	mapping(443, "http://127.0.0.1:47999");
	writeDenied.value = true;
	expect(await enable("--port", String(chosenPort))).toMatchObject({ status: 400, body: { error: { message: expect.stringContaining("kemiri tailscale disable") } } });
	expect(await readBackendServeRecord(s.dataDir)).toMatchObject({ phase: "enabling" });
	writeDenied.value = false;
	expect(await disable()).toEqual({ status: 200, body: { mapping: "absent" } });
	expect(Object.keys(config.TCP)).toEqual(["443"]);
});

test("tailnet pairing uses the public origin while Serve can never redeem a local-only grant", async () => {
	const webDir = await mkdtemp(join(tmpdir(), "kemiri-tailnet-web-"));
	afterEach(() => rm(webDir, { recursive: true, force: true }));
	await writeFile(join(webDir, "index.html"), "<!doctype html><title>Synthetic Kemiri shell</title>");
	const { s, enable, disable } = await fixture({ webDir });
	const headers = {
		host: `${hostname}:${chosenPort}`,
		"x-forwarded-host": `${hostname}:${chosenPort}`,
		"x-forwarded-for": "192.0.2.10",
		"x-forwarded-proto": "https",
		origin: chosenOrigin,
	};
	expect((await fetch(`${s.server.url}/aiki-local.json`, { headers })).status).toBe(403);
	expect((await enable("--port", String(chosenPort))).status).toBe(200);
	expect(await (await fetch(`${s.server.url}/aiki-local.json`, { headers })).json()).toEqual({ local: true });
	const grant = s.server.auth.bootstrap(true);
	const blocked = await authPost(s, "/auth/bootstrap/redeem", { requestId: "local", code: grant.secret, ...claimProof() }, headers);
	expect(blocked.status).toBe(401);
	const direct = await authPost(s, "/auth/bootstrap/redeem", { requestId: "local", code: grant.secret, ...claimProof() });
	expect(direct.status).toBe(200);
	const cli = Bun.spawn([process.execPath, "--no-env-file", "packages/server/src/binary-main.ts", "pair", "--tailscale"], {
		env: { PATH: process.env.PATH, HOME: s.root, XDG_CONFIG_HOME: s.configDir, KEMIRI_DATA_DIR: s.dataDir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
		stdout: "pipe", stderr: "pipe", timeout: 8000,
	});
	const [stdout, stderr, exitCode] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited]);
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	const link = new URL(stdout.match(/^Pairing link: (.*)$/m)![1]!);
	expect(link.origin).toBe(chosenOrigin);
	const bundle = JSON.parse(Buffer.from(link.hash.slice("#bootstrap=v1.".length), "base64url").toString());
	expect(bundle.slice(0, 2)).toEqual([s.server.auth.backendId, chosenOrigin]);
	expect(stdout).toContain("▀");
	const remote = await authPost(s, "/auth/bootstrap/redeem", { requestId: bundle[2], code: stdout.match(/^Code: (.*)$/m)![1], ...claimProof() }, headers);
	expect(remote.status).toBe(200);
	await disable();
	expect((await fetch(`${s.server.url}/aiki-local.json`, { headers })).status).toBe(403);
});
