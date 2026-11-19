import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { regularTarMember } from "./agent-browser-install.ts";
import { antigravityPin } from "./antigravity-pin.ts";
import { OfficialAgentAuthError } from "./official-agents/auth-error.ts";

// The unpacked Linux x64 1.5.12 tar is over 256 MiB. Keep a separate bound from agent-browser.
const MAX_ANTIGRAVITY_TAR_BYTES = 384 * 1024 * 1024;

type AntigravityPin = { version: string; platforms: Readonly<Record<string, { url: string; sha512: string }>> };

function platformName(): string {
	const arch = process.arch === "x64" ? "amd64" : process.arch;
	const libc = process.platform === "linux" && !(process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header?.glibcVersionRuntime ? "_musl" : "";
	return `${process.platform}_${arch}${libc}`;
}

export class AntigravityInstaller {
	#installing: Promise<string> | undefined;
	constructor(readonly options: { dataDir: string; pin?: AntigravityPin; platform?: string; fetch?: typeof fetch }) {}
	get pin(): AntigravityPin { return this.options.pin ?? antigravityPin; }
	get platform(): string { return this.options.platform ?? platformName(); }
	get directory(): string { return join(this.options.dataDir, "tools", "antigravity", `${this.pin.version}-${this.platform}`); }

	async installedVersion(): Promise<string | null> {
		try {
			const marker = JSON.parse(await readFile(join(this.directory, "install.json"), "utf8"));
			return marker.sha512 === this.pin.platforms[this.platform]?.sha512 ? this.pin.version : null;
		} catch { return null; }
	}

	ensure(): Promise<string> {
		return this.#installing ??= this.#install().finally(() => { this.#installing = undefined; });
	}

	async #install(): Promise<string> {
		const release = this.pin.platforms[this.platform];
		if (!release) throw new OfficialAgentAuthError("Antigravity does not provide a pinned build for this backend's platform.");
		const root = join(this.options.dataDir, "tools", "antigravity");
		const binary = join(this.directory, "agy");
		try {
			const marker = JSON.parse(await readFile(join(this.directory, "install.json"), "utf8"));
			if (marker.sha512 === release.sha512 && marker.binarySha256 === createHash("sha256").update(await readFile(binary)).digest("hex")) {
				await chmod(binary, 0o755);
				return binary;
			}
		} catch { /* Missing or damaged install. */ }
		await mkdir(root, { recursive: true, mode: 0o700 });
		const staging = await mkdtemp(join(root, ".install-"));
		try {
			let archive: Uint8Array;
			try {
				const response = await (this.options.fetch ?? fetch)(release.url, { signal: AbortSignal.timeout(60_000) });
				if (!response.ok) throw new OfficialAgentAuthError(`Antigravity download returned HTTP ${response.status}.`);
				archive = new Uint8Array(await response.arrayBuffer());
			} catch (error) {
				if (error instanceof OfficialAgentAuthError) throw error;
				throw new OfficialAgentAuthError("Antigravity download failed. Check the backend's connection to Google and try again.");
			}
			if (createHash("sha512").update(archive).digest("hex") !== release.sha512) throw new OfficialAgentAuthError("Antigravity archive SHA-512 mismatch. The download was not installed.");
			let bytes: Buffer;
			try {
				bytes = regularTarMember(archive, "antigravity", MAX_ANTIGRAVITY_TAR_BYTES);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
					throw new OfficialAgentAuthError("The unpacked Antigravity archive exceeds the installer's 384 MiB limit.");
				}
				throw new OfficialAgentAuthError("The verified Antigravity archive did not contain a usable executable.");
			}
			await writeFile(join(staging, "agy"), bytes, { mode: 0o755 });
			await writeFile(join(staging, "install.json"), JSON.stringify({ sha512: release.sha512, binarySha256: createHash("sha256").update(bytes).digest("hex") }), { mode: 0o600 });
			await rm(this.directory, { recursive: true, force: true });
			await rename(staging, this.directory);
			return binary;
		} finally { await rm(staging, { recursive: true, force: true }); }
	}
}
