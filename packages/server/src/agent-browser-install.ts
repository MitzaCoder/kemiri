import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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
	const tar = gunzipSync(tarball, { maxOutputLength: 256 * 1024 * 1024 });
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
		if (name === "package/bin/agent-browser" && !prefix) {
			if (binary || (header[156] !== 0 && header[156] !== 48) || size === 0) throw new Error("Invalid agent-browser tar member");
			binary = tar.subarray(offset + 512, offset + 512 + size);
		}
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	if (!binary) throw new Error("Missing package/bin/agent-browser in tarball");
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
	async #ensure(): Promise<string> {
		const pin: AgentBrowserPin = this.options.pin ?? agentBrowserPin;
		const platform = this.options.platform ?? agentBrowserPlatform();
		const entry = pin.platforms[platform];
		if (!entry) throw new Error(`Unsupported agent-browser platform: ${platform}`);
		if (!/^[\w.-]+$/.test(pin.version) || !/^[\w-]+$/.test(platform)) throw new Error("Invalid agent-browser pin path");
		const root = join(this.options.dataDir, "tools", "agent-browser");
		const directory = join(root, `${pin.version}-${platform}`);
		const binary = join(directory, "agent-browser");
		try {
			const marker = JSON.parse(await readFile(join(directory, "install.json"), "utf8"));
			if (marker.version === pin.version && marker.platform === platform && marker.integrity === entry.integrity && marker.sha256 === sha256(await readFile(binary))) {
				await chmod(binary, 0o755);
				return binary;
			}
		} catch { /* Missing or invalid marker/binary: remove before attempting download. */ }
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
			await writeFile(join(staging, "install.json"), JSON.stringify({ version: pin.version, platform, integrity: entry.integrity, sha256: sha256(bytes) }), { mode: 0o600 });
			await rename(staging, directory);
			for (const name of await readdir(root)) if (name !== `${pin.version}-${platform}`) await rm(join(root, name), { recursive: true, force: true });
			return binary;
		} finally {
			await rm(staging, { recursive: true, force: true });
		}
	}
}
