import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUN_VERSION, launcherDefinition } from "../../../scripts/aiki.ts";
import { DeviceAuth } from "../src/device-auth.ts";
import { formatTailscaleStatus, inspectTailscaleStatus } from "../src/tailscale-status-cli.ts";
import { fakeTailscale } from "./fake-tailscale.ts";

const fixtureDirs: string[] = [];
async function fixture() {
	const dir = await mkdtemp(join(tmpdir(), "kemiri-tailscale-status-"));
	fixtureDirs.push(dir);
	const dataDir = join(dir, "data");
	return { dir, dataDir, env: { KEMIRI_DATA_DIR: dataDir }, ...fakeTailscale("vm.example-tailnet.ts.net") };
}
afterEach(async () => {
	for (const dir of fixtureDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

test("reports a missing executable without initializing Kemiri state", async () => {
	const { dir, env, installed, commands, tailscale } = await fixture();
	installed.value = false;
	const report = await inspectTailscaleStatus(env, tailscale);
	expect(report.installed).toEqual({ status: "missing", message: expect.stringContaining("https://tailscale.com/download") });
	expect(report.magicDns.hostname).toBeNull();
	expect(report.serve.check.status).toBe("warning");
	expect(commands).toEqual([["tailscale", "status", "--json"]]);
	expect(await readdir(dir)).toEqual([]);
});

test("reports a logged-out daemon without treating empty checks as success", async () => {
	const { env, running, commands, tailscale } = await fixture();
	running.value = false;
	const report = await inspectTailscaleStatus(env, tailscale);
	expect(report.running.status).toBe("missing");
	expect(report.running.message).toContain("tailscale up");
	expect(report.backendOrigins.candidates).toEqual([]);
	expect(report.https.status).toBe("warning");
	expect(commands).toEqual([["tailscale", "status", "--json"]]);
});

test("reports the exact operator and HTTPS fixes with only read commands", async () => {
	const { env, https, hostname, operator, commands, tailscale } = await fixture();
	operator.value = false;
	https.value = false;
	const report = await inspectTailscaleStatus(env, tailscale);
	expect(report.magicDns.hostname).toBe(hostname);
	expect(report.operator.check.status).toBe("missing");
	expect(report.operator.check.message).toContain("sudo tailscale set --operator=example-service");
	expect(report.operator.check.message).toContain('services.tailscale.extraSetFlags = [ "--operator=example-service" ]');
	expect(report.https.status).toBe("missing");
	expect(report.https.message).toContain("admin console under DNS");
	expect(commands).toEqual([["tailscale", "status", "--json"], ["tailscale", "debug", "prefs"], ["tailscale", "serve", "status", "--json"]]);
});

test("reports exact ownership, foreign conflicts and allowed vs missing origins in versioned JSON", async () => {
	const { dataDir, env, hostname, mapping, config, tailscale } = await fixture();
	const journal = [{ projectId: "example-project", appId: "example-app", hostname, httpsPort: 47300, target: "http://127.0.0.1:47800" },
		{ projectId: "example-project", appId: "old-example-app", hostname, httpsPort: 47301, target: "http://127.0.0.1:47801" }];
	const auth = new DeviceAuth(dataDir, { backendOrigins: [`https://${hostname}`, `https://${hostname}:444`] });
	auth.db.close();
	const authFile = join(dataDir, "auth.sqlite");
	const before = await readFile(authFile);
	await writeFile(join(dataDir, "app-serve-ownership.json"), JSON.stringify(journal));
	await writeFile(join(dataDir, "user-settings.json"), JSON.stringify({ userName: "", apps: {
		addresses: { mode: "tailscale-serve", startPort: 47300, endPort: 47319 }, policy: "on",
	} }));
	mapping(443, "http://127.0.0.1:47100");
	mapping(444, "http://127.0.0.1:7317");
	mapping(47300, journal[0]!.target);
	mapping(47301, "http://127.0.0.1:47809");
	config.TCP[47302] = { TCPForward: "127.0.0.1:47802" };
	const report = await inspectTailscaleStatus({ ...env, KEMIRI_TRUSTED_PROXIES: "127.0.0.1" }, tailscale);
	expect(report.serve.rangeConflicts.ports).toEqual([47301, 47302]);
	expect(formatTailscaleStatus(report)).toContain(`${hostname}:443/ → http://127.0.0.1:47100 (foreign)`);
	expect(formatTailscaleStatus(report)).toContain(`${hostname}:47300/ → http://127.0.0.1:47800 (Kemiri)`);
	expect(report.backendOrigins.candidates.map(({ check }) => check.status)).toEqual(["ok", "ok", "missing"]);
	expect(JSON.parse(JSON.stringify(report))).toMatchSnapshot();
	expect(await readFile(authFile)).toEqual(before);
});

test("standalone and installed entry points preserve a legacy settings file and exit zero with missing items", async () => {
	const { dir, dataDir } = await fixture();
	const configDir = join(dir, "config");
	const envFile = join(configDir, "server.env");
	const source = "AIKI_PORT=7137\nAIKI_TRUSTED_PROXIES=127.0.0.1\nKEMIRI_PORT=7340\n";
	await mkdir(configDir);
	await writeFile(envFile, source);
	await writeFile(join(dir, ".aiki-managed"), "aiki-installer-v1");
	await writeFile(join(dir, ".aiki-install.json"), JSON.stringify({ data: dataDir, config: configDir, root: dir, version: "ref-test", launcher: join(dir, "kemiri") }));
	const workspace = new URL("../../../", import.meta.url).pathname;
	await symlink(workspace, join(dir, "current"));
	const runtime = join(dir, "runtime", `bun-${BUN_VERSION}`, "bin");
	await mkdir(runtime, { recursive: true });
	await symlink(process.execPath, join(runtime, "bun"));
	await mkdir(join(dir, "bin"));
	const launcher = join(dir, "bin", "kemiri");
	await writeFile(launcher, launcherDefinition(dir), { mode: 0o755 });
	const cache = join(dir, "cache");
	await mkdir(cache);
	const env = { HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: cache, PATH: dir };
	for (const [command, settings] of [
		[[process.execPath, "--no-env-file", join(workspace, "packages/server/src/binary-main.ts")],
			{ KEMIRI_ENV_FILE: envFile, KEMIRI_DATA_DIR: dataDir, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }],
		[[launcher], {}],
	] as const) {
		const result = Bun.spawnSync([...command, "tailscale", "status", "--json"], {
			cwd: dir, env: { ...env, ...settings }, timeout: 10_000,
		});
		expect(result.stderr.toString()).toBe("");
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.stdout.toString())).toMatchObject({ backendPort: 7340, installed: { status: "missing" }, trustedLoopback: { ipv4: true } });
	}
	const cachedFiles = (await readdir(cache, { recursive: true, withFileTypes: true })).filter(entry => !entry.isDirectory());
	expect(cachedFiles).toEqual([]);
	expect(await readdir(configDir)).toEqual(["server.env"]);
	expect(await readFile(envFile, "utf8")).toBe(source);
	expect(await Bun.file(join(dataDir, "auth.sqlite")).exists()).toBe(false);
});
