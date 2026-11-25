import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { agentBrowserPin } from "./agent-browser-pin.ts";

export type AgentBrowserPin = { version: string; platforms: Record<string, { packageName: string; tarball: string; integrity: string }> };
export function agentBrowserPlatform(platform = process.platform, arch = process.arch, glibc = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } })?.header?.glibcVersionRuntime): string {
	if ((arch !== "x64" && arch !== "arm64") || (platform !== "linux" && platform !== "darwin")) return `${platform}-${arch}-unsupported`;
	return `${platform}-${arch}${platform === "linux" ? glibc ? "-gnu" : "-musl" : ""}`;
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Read one regular member, never extracting names/links from an archive into the filesystem. */
export function agentBrowserBinaryFromTarball(tarball: Uint8Array): Buffer {
	return regularTarMember(tarball, "package/bin/agent-browser");
}

export function regularTarMember(tarball: Uint8Array, member: string, maxOutputLength = 256 * 1024 * 1024): Buffer {
	const tar = gunzipSync(tarball, { maxOutputLength });
	let binary: Buffer | undefined;
	for (let offset = 0; offset + 512 <= tar.length;) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every(byte => byte === 0)) break;
		const name = header.subarray(0, 100).toString().split("\0")[0];
		const prefix = header.subarray(345, 500).toString().split("\0")[0];
		const sizeText = header.subarray(124, 136).toString().replace(/\0/g, "").trim();
		if (!/^[0-7]+$/.test(sizeText)) throw new Error("Invalid tar member size");
		const size = Number.parseInt(sizeText, 8);
		if (offset + 512 + size > tar.length) throw new Error("Truncated tar member");
		if (name === member && !prefix) {
			if (binary || (header[156] !== 0 && header[156] !== 48) || size === 0) throw new Error(`Invalid ${member} tar member`);
			binary = tar.subarray(offset + 512, offset + 512 + size);
		}
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	if (!binary) throw new Error(`Missing ${member} in tarball`);
	return binary;
}

/** One instance per backend; retry failures only when a later worker requests ensure(). */
export class AgentBrowserInstaller {
	#pending: Promise<string> | undefined;
	constructor(readonly options: { dataDir: string; pin?: AgentBrowserPin; platform?: string; fetch?: typeof fetch }) {}
	ensure(): Promise<string> {
		if (!this.#pending) this.#pending = this.#ensure().finally(() => { this.#pending = undefined; });
		return this.#pending;
	}
	#installation() {
		const pin: AgentBrowserPin = this.options.pin ?? agentBrowserPin;
		const platform = this.options.platform ?? agentBrowserPlatform();
		const entry = pin.platforms[platform];
		if (!entry) throw new Error(`Unsupported agent-browser platform: ${platform}`);
		if (!/^[\w.-]+$/.test(pin.version) || !/^[\w-]+$/.test(platform)) throw new Error("Invalid agent-browser pin path");
		const root = join(this.options.dataDir, "tools", "agent-browser");
		const versionDir = `${pin.version}-${platform}`;
		const directory = join(root, versionDir);
		const binary = join(directory, "agent-browser");
		return { entry, root, directory, binary, versionDir,
			expectedMarker: { version: pin.version, platform, integrity: entry.integrity } };
	}
	async #matchesInstallMarker(directory: string, binary: string, expected: { version: string; platform: string; integrity: string }): Promise<boolean> {
		try {
			const marker = JSON.parse(await readFile(join(directory, "install.json"), "utf8"));
			return marker.version === expected.version && marker.platform === expected.platform && marker.integrity === expected.integrity &&
				marker.sha256 === sha256(await readFile(binary));
		} catch { return false; }
	}
	/** Read-only startup discovery: never download, repair or remove an install here. */
	async findInstalled(): Promise<string | null> {
		try {
			const { directory, binary, expectedMarker } = this.#installation();
			await access(binary, constants.X_OK);
			return await this.#matchesInstallMarker(directory, binary, expectedMarker) ? binary : null;
		} catch { return null; }
	}
	async #ensure(): Promise<string> {
		const { entry, root, directory, binary, versionDir, expectedMarker } = this.#installation();
		if (await this.#matchesInstallMarker(directory, binary, expectedMarker)) {
			try {
				await chmod(binary, 0o755);
				return binary;
			} catch { /* An unusable copy must be replaced before use. */ }
		}
		await rm(directory, { recursive: true, force: true });
		await mkdir(root, { recursive: true, mode: 0o700 });
		const staging = await mkdtemp(join(root, ".install-"));
		try {
			const response = await (this.options.fetch ?? fetch)(entry.tarball, { signal: AbortSignal.timeout(60_000) });
			if (!response.ok) throw new Error(`agent-browser download HTTP ${response.status}`);
			const tarball = new Uint8Array(await response.arrayBuffer());
			const digest = createHash("sha512").update(tarball).digest();
			const expected = Buffer.from(entry.integrity.replace(/^sha512-/, ""), "base64");
			if (!entry.integrity.startsWith("sha512-") || expected.length !== digest.length || !timingSafeEqual(digest, expected)) throw new Error("agent-browser sha512 integrity mismatch");
			const bytes = agentBrowserBinaryFromTarball(tarball);
			await writeFile(join(staging, "agent-browser"), bytes, { mode: 0o755 });
			await writeFile(join(staging, "install.json"), JSON.stringify({ ...expectedMarker, sha256: sha256(bytes) }), { mode: 0o600 });
			await rename(staging, directory);
			for (const name of await readdir(root)) if (name !== versionDir) await rm(join(root, name), { recursive: true, force: true });
			return binary;
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	}
}
