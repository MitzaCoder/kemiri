import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { parseAgentBrowserMetadata } from "../../../scripts/pin-agent-browser.ts";
import { AgentBrowserInstaller, agentBrowserBinaryFromTarball, agentBrowserPlatform, type AgentBrowserPin } from "../src/agent-browser-install.ts";
import { agentBrowserPin } from "../src/agent-browser-pin.ts";
import { findBrowserExecutable } from "../src/agent-browser.ts";
import { WorkerBrowserService } from "../src/worker-browser.ts";
import { createSetup } from "./support.ts";

function tarball(binary: string, name = "package/bin/agent-browser", type = "0"): Buffer {
	const bytes = Buffer.from(binary);
	const header = Buffer.alloc(512);
	header.write(name);
	header.write("0000755\0", 100);
	header.write(`${bytes.length.toString(8).padStart(11, "0")}\0`, 124);
	header.write(type, 156);
	header.fill(32, 148, 156);
	const checksum = header.reduce((total, byte) => total + byte, 0);
	header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
	return gzipSync(Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512 + 1024)]));
}
async function registry() {
	let downloads = 0;
	const archive = tarball("#!/bin/sh\necho native-fixture\n");
	const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => { downloads++; return new Response(new Uint8Array(archive)); } });
	const root = await mkdtemp(join(tmpdir(), "ab-install-test-"));
	const pin: AgentBrowserPin = { version: "0.43.0", platforms: { test: { packageName: "fixture", tarball: `${server.url}archive.tgz`, integrity } } };
	return { root, pin, downloads: () => downloads, dispose: async () => { server.stop(true); await rm(root, { recursive: true, force: true }); } };
}

test("registry metadata parser validates version, package, registry origin and sha512", () => {
	for (const entry of Object.values(agentBrowserPin.platforms)) {
		expect(parseAgentBrowserMetadata({ name: entry.packageName, version: "0.43.0", dist: entry }, entry.packageName, "0.43.0")).toEqual(entry);
	}
	const metadata = { name: "fixture", version: "1.0.0", dist: { tarball: "https://example.com/file", integrity: "sha256-invalid" } };
	expect(() => parseAgentBrowserMetadata(metadata, "fixture", "1.0.0")).toThrow();
	expect(() => parseAgentBrowserMetadata(null, "fixture", "1.0.0")).toThrow();
});

test("platform detection distinguishes Linux libc and supported macOS architectures", () => {
	expect(agentBrowserPlatform("linux", "x64", "2.40")).toBe("linux-x64-gnu");
	expect(agentBrowserPlatform("linux", "arm64", "")).toBe("linux-arm64-musl");
	expect(agentBrowserPlatform("darwin", "arm64", "")).toBe("darwin-arm64");
	expect(agentBrowserPlatform("win32", "x64", "")).toContain("unsupported");
});

test("archive reader selects only the exact regular binary member", () => {
	expect(agentBrowserBinaryFromTarball(tarball("binary")).toString()).toBe("binary");
	for (const [name, type] of [["../../agent-browser", "0"], ["package/bin/agent-browser", "2"], ["package/bin/other", "0"]]) {
		expect(() => agentBrowserBinaryFromTarball(tarball("nope", name, type))).toThrow();
	}
});

test("managed install verifies, records, caches and coalesces concurrent downloads", async () => {
	const fixture = await registry();
	try {
		const installer = new AgentBrowserInstaller({ dataDir: fixture.root, pin: fixture.pin, platform: "test" });
		expect(await installer.findInstalled()).toBeNull();
		expect(fixture.downloads()).toBe(0);
		const paths = await Promise.all(Array.from({ length: 12 }, () => installer.ensure()));
		expect(new Set(paths).size).toBe(1);
		expect(fixture.downloads()).toBe(1);
		const binary = paths[0]!;
		expect((await stat(binary)).mode & 0o777).toBe(0o755);
		const marker = JSON.parse(await readFile(join(binary, "../install.json"), "utf8"));
		expect(marker).toEqual({ version: "0.43.0", platform: "test", integrity: fixture.pin.platforms.test!.integrity, sha256: createHash("sha256").update(await readFile(binary)).digest("hex") });
		expect(await installer.ensure()).toBe(binary);
		expect(fixture.downloads()).toBe(1);
		expect(await installer.findInstalled()).toBe(binary);
		await writeFile(binary, "corrupted");
		expect(await installer.findInstalled()).toBeNull();
		expect(await readFile(binary, "utf8")).toBe("corrupted");
		expect(fixture.downloads()).toBe(1);
		expect(await installer.ensure()).toBe(binary);
		expect(fixture.downloads()).toBe(2);
		expect(await readFile(binary, "utf8")).toContain("native-fixture");
		fixture.pin.version = "0.44.0";
		const next = await installer.ensure();
		expect(next).toContain("0.44.0-test");
		expect(fixture.downloads()).toBe(3);
		expect(await readdir(join(fixture.root, "tools/agent-browser"))).toEqual(["0.44.0-test"]);
		const markerPath = join(next, "../install.json");
		const changed = JSON.parse(await readFile(markerPath, "utf8"));
		changed.integrity = "changed";
		await writeFile(markerPath, JSON.stringify(changed));
		await installer.ensure();
		expect(fixture.downloads()).toBe(4);
	} finally { await fixture.dispose(); }
});

test("the built prompt keeps its skills list across a backend restart with an installed browser", async () => {
	const fixture = await registry();
	try {
		const setup = await createSetup({ createBrowsers: dataDir => new WorkerBrowserService({
			dataDir, log: () => {}, findBrowser: () => "/opt/fixture/chromium", command: () => undefined,
			installer: new AgentBrowserInstaller({ dataDir, pin: fixture.pin, platform: "test" }),
		}) });
		const { id } = await setup.server.manager.add(setup.projectDir);
		const browserSkill = "<name>agent-browser</name>";
		const skillsSection = async () => {
			const context = await setup.server.manager.context(id);
			return context.systemPrompt.match(/<skills>[\s\S]*?<\/skills>/)?.[0];
		};
		expect(await skillsSection()).not.toContain(browserSkill);
		expect(fixture.downloads()).toBe(0);
		// First use can still install the pin. The next backend must discover it without a worker asking for it.
		const availability = await setup.server.manager.browsers.ensureReady();
		expect(typeof availability).toBe("object");
		const before = await skillsSection();
		expect(before).toContain(browserSkill);
		expect(fixture.downloads()).toBe(1);

		await setup.restart();
		expect(await skillsSection()).toBe(before);
		expect((await setup.server.manager.projectSkills(id)).some(skill => skill.name === "agent-browser")).toBe(true);
		expect(fixture.downloads()).toBe(1);
	} finally { await fixture.dispose(); }
});

test("integrity mismatch removes invalid copy, leaves nothing runnable and retries later", async () => {
	const fixture = await registry();
	try {
		const installer = new AgentBrowserInstaller({ dataDir: fixture.root, pin: fixture.pin, platform: "test" });
		const binary = await installer.ensure();
		fixture.pin.platforms.test!.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
		await expect(installer.ensure()).rejects.toThrow("integrity mismatch");
		expect(await Bun.file(binary).exists()).toBe(false);
		expect(await readdir(join(fixture.root, "tools/agent-browser"))).toEqual([]);
		await expect(installer.ensure()).rejects.toThrow("integrity mismatch");
		expect(fixture.downloads()).toBe(3);
	} finally { await fixture.dispose(); }
});

test("unsupported platforms fail before downloading; offline failures can retry", async () => {
	const fixture = await registry();
	try {
		await expect(new AgentBrowserInstaller({ dataDir: fixture.root, pin: fixture.pin, platform: "unsupported" }).ensure()).rejects.toThrow("Unsupported");
		expect(fixture.downloads()).toBe(0);
		let online = false;
		const installer = new AgentBrowserInstaller({ dataDir: fixture.root, pin: fixture.pin, platform: "test", fetch: (async (...args: Parameters<typeof fetch>) => {
			if (!online) throw new Error("offline");
			return fetch(...args);
		}) as typeof fetch });
		await expect(installer.ensure()).rejects.toThrow("offline");
		online = true;
		expect(await Bun.file(await installer.ensure()).exists()).toBe(true);
	} finally { await fixture.dispose(); }
});

test("browser discovery honors explicit executable and child PATH", async () => {
	const root = await mkdtemp(join(tmpdir(), "ab-discovery-test-"));
	try {
		const binary = join(root, "chromium");
		await writeFile(binary, "#!/bin/sh\n", { mode: 0o755 });
		expect(findBrowserExecutable(undefined, root)).toBe(binary);
		expect(findBrowserExecutable(binary, "")).toBe(binary);
		expect(findBrowserExecutable("missing", root)).toBeNull();
	} finally { await rm(root, { recursive: true, force: true }); }
});
