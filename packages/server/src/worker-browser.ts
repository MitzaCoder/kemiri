import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { AgentBrowserInstaller } from "./agent-browser-install.ts";
import { findBrowserExecutable, offerManagedAgentBrowser } from "./agent-browser.ts";
import { childEnvironment } from "./child-environment.ts";
import { serverSettings } from "./server-settings.ts";

export type WorkerBrowserAvailability = { binary: string; chromium: string } | string;
export type WorkerBrowser = { directory: string; launcher: string; session: string; proof: string; socket: string; allowedDomains: string };
const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
export function workerBrowserInstructions(browser: WorkerBrowser | string): string {
	if (typeof browser === "string") return `Browser unavailable: ${browser}`;
	return `Browser: use ${browser.launcher} as ab (the launcher carries isolation and restrictions). Session: ${browser.session}. Proof folder: ${browser.proof}. Allowed domains: ${browser.allowedDomains}. Never use a real profile or auto-connect. The harness closes this browser when the worker ends; proof stays until forget.`;
}
export function workerBrowserLauncher(binary: string, chromium: string, browser: WorkerBrowser): string {
	return `#!/bin/sh\n${Object.entries({ HOME: join(browser.directory, "home"), AGENT_BROWSER_SESSION: browser.session,
		AGENT_BROWSER_SOCKET_DIR: browser.socket, AGENT_BROWSER_EXECUTABLE_PATH: chromium,
		AGENT_BROWSER_NO_VERSION_CHECK: "1", AGENT_BROWSER_ALLOWED_DOMAINS: browser.allowedDomains,
		TMPDIR: join(browser.directory, "tmp"), BROWSER_PROOF_DIR: browser.proof }).map(([key, value]) => `export ${key}=${quote(value)}`).join("\n")}\nexec ${quote(binary)} "$@"\n`;
}

type OwnedProcess = { pid: number; parent: number; identity: string; command: string; environment: string };
async function processList(): Promise<OwnedProcess[]> {
	if (process.platform === "linux") {
		const processes = await Promise.all((await readdir("/proc")).filter(name => /^\d+$/.test(name)).map(async name => {
			try {
				const [stat, command, environment] = await Promise.all([readFile(`/proc/${name}/stat`, "utf8"), readFile(`/proc/${name}/cmdline`, "utf8"), readFile(`/proc/${name}/environ`, "utf8")]);
				const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
				return { pid: Number(name), parent: Number(fields[1]), identity: fields[19]!, command: command.replace(/\0/g, " "), environment };
			} catch { return undefined; }
		}));
		return processes.filter((entry): entry is OwnedProcess => entry !== undefined);
	}
	// macOS has no /proc. lstart guards PID reuse; eww retains inherited session environment.
	const ps = Bun.spawn(["ps", "eww", "-axo", "pid=,ppid=,lstart=,command="], { env: childEnvironment(), stdout: "pipe", stderr: "ignore" });
	const timer = setTimeout(() => ps.kill("SIGKILL"), 1500);
	try {
		return (await new Response(ps.stdout).text()).split("\n").flatMap(line => {
			const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/);
			return match ? [{ pid: Number(match[1]), parent: Number(match[2]), identity: match[3]!, command: match[4]!, environment: match[4]!.replace(/ /g, "\0") + "\0" }] : [];
		});
	} finally { clearTimeout(timer); }
}
function sessionOwned(entry: OwnedProcess, browser: WorkerBrowser): boolean {
	return (entry.environment.includes(`AGENT_BROWSER_SOCKET_DIR=${browser.socket}\0`) &&
		entry.environment.includes(`HOME=${join(browser.directory, "home")}\0`)) ||
		new RegExp(`(?:^| )--user-data-dir(?:=| )${join(browser.directory, "tmp", "agent-browser-chrome-").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^ ]+(?: |$)`).test(entry.command);
}

/** Captures daemon descendants BEFORE close; environment ownership finds reparented Chromium after crashes. */
export async function closeWorkerBrowser(browser: WorkerBrowser): Promise<void> {
	const before = await processList();
	let daemonPid = 0;
	try { daemonPid = Number((await readFile(join(browser.socket, `${browser.session}.pid`), "utf8")).trim()); } catch { /* No daemon yet. */ }
	// Prioritize the known daemon, but a pid file alone never authorizes a signal.
	const roots = before.filter(entry => sessionOwned(entry, browser));
	roots.sort((left, right) => Number(right.pid === daemonPid) - Number(left.pid === daemonPid));
	const owned = new Map(roots.map(entry => [entry.pid, entry]));
	for (const parent of roots) for (const entry of before) {
		if (entry.parent === parent.pid && !owned.has(entry.pid)) { owned.set(entry.pid, entry); roots.push(entry); }
	}
	// Don't run close on an unused session: the CLI may start a daemon just to answer it.
	if (owned.size === 0) return;
	const close = Bun.spawn([browser.launcher, "close"], { env: childEnvironment(), stdout: "ignore", stderr: "ignore" });
	const timer = setTimeout(() => close.kill("SIGKILL"), 1500);
	try { await close.exited; } finally { clearTimeout(timer); }
	for (const entry of await processList()) if (sessionOwned(entry, browser)) owned.set(entry.pid, entry);
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		for (const current of await processList()) {
			const original = owned.get(current.pid);
			if (original && original.identity === current.identity && current.pid !== process.pid) {
				try { process.kill(current.pid, signal); } catch { /* Already gone. */ }
			}
		}
	}
}

export class WorkerBrowserService {
	readonly ready: Promise<void>;
	readonly #installer: Pick<AgentBrowserInstaller, "ensure">;
	readonly #closing = new Map<string, Promise<void>>();
	readonly #resumed = new Map<string, Promise<void>>();
	readonly #root: string;
	#verified: Exclude<WorkerBrowserAvailability, string> | undefined;
	#ensuring: Promise<WorkerBrowserAvailability> | undefined;
	readonly #preparing = new Map<string, Promise<{ browser: WorkerBrowser | string; key: string }>>();
	constructor(readonly options: { dataDir: string; log: (message: string) => void; installer?: Pick<AgentBrowserInstaller, "ensure">;
		findBrowser?: () => string | null; command?: () => string | undefined; allowedDomains?: string; offer?: (command: string) => void }) {
		this.#installer = options.installer ?? new AgentBrowserInstaller({ dataDir: options.dataDir });
		this.#root = join(options.dataDir, "tools", "browser-workers");
		this.ready = this.#sweep().catch(error => options.log(`agent-browser startup cleanup: ${error}`));
	}
	#key(projectId: string, conversationId: number | string): string { return createHash("sha256").update(JSON.stringify([projectId, conversationId])).digest("hex"); }
	async #read(key: string): Promise<WorkerBrowser | undefined> {
		try {
			const browser: WorkerBrowser = JSON.parse(await readFile(join(this.#root, `${key}.json`), "utf8"));
			// The private index may outlive temp files; never follow a foreign replacement at startup.
			if (dirname(browser.directory) !== tmpdir() || !basename(browser.directory).startsWith("kab-") ||
				browser.launcher !== join(browser.directory, "agent-browser") || browser.socket !== join(browser.directory, "s") ||
				browser.proof !== join(browser.directory, "proof")) return undefined;
			const info = await lstat(browser.directory);
			if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) return undefined;
			return browser;
		} catch { return undefined; }
	}
	async sweep(): Promise<void> { await this.ready; await this.#sweep(); }
	async #sweep(): Promise<void> {
		await mkdir(this.#root, { recursive: true, mode: 0o700 });
		for (const name of await readdir(this.#root)) if (/^[a-f0-9]{64}\.json$/.test(name)) await this.#cleanup(name.slice(0, -5), false);
	}
	/** Call outside durable commits. Success is verified once per backend process; later spawns retry failures. */
	ensureReady(): Promise<WorkerBrowserAvailability> {
		if (this.#verified) return Promise.resolve(this.#verified);
		if (!this.#ensuring) this.#ensuring = this.#ensureReady().finally(() => { this.#ensuring = undefined; });
		return this.#ensuring;
	}
	async #ensureReady(): Promise<WorkerBrowserAvailability> {
		await this.ready;
		const chromium = (this.options.findBrowser ?? findBrowserExecutable)();
		if (!chromium) return "no Chromium or Chrome found; install one or set KEMIRI_BROWSER_EXECUTABLE.";
		try {
			const override = (this.options.command ?? (() => serverSettings.KEMIRI_AGENT_BROWSER_COMMAND?.trim()))();
			const binary = override ? Bun.which(override, { PATH: childEnvironment().PATH ?? "" }) : await this.#installer.ensure();
			if (!binary) throw new Error("KEMIRI_AGENT_BROWSER_COMMAND is not executable");
			(this.options.offer ?? offerManagedAgentBrowser)(binary);
			return this.#verified = { binary, chromium };
		} catch (error) { return this.#setupFailure(error); }
	}
	#setupFailure(error: unknown): string {
		const reason = `agent-browser setup failed: ${error instanceof Error ? error.message : error}`;
		this.options.log(reason);
		return reason;
	}
	/** Only settled readiness and quick local files here: never await discovery, installation, hashing or a sweep. */
	async prepare(projectId: string, conversationId: number, availability: WorkerBrowserAvailability, creationId: string = String(conversationId)): Promise<WorkerBrowser | string> {
		if (typeof availability === "string") return availability;
		const key = this.#key(projectId, conversationId);
		// A commit retry can allocate a different conversation ID. Reuse the spawn call's directory and rebind its index.
		const creationKey = this.#key(projectId, creationId);
		const pending = this.#preparing.get(creationKey);
		const preparation = (async () => {
			const previous = await pending;
			if (previous && typeof previous.browser !== "string" && await this.#read(previous.key)) {
				if (previous.key !== key) {
					await writeFile(join(this.#root, `${key}.json`), JSON.stringify(previous.browser), { mode: 0o600 });
					await rm(join(this.#root, `${previous.key}.json`), { force: true });
					this.#resumed.delete(previous.key);
				}
				this.#resumed.set(key, Promise.resolve());
				return { browser: previous.browser, key };
			}
			return { browser: await this.#prepare(key, availability), key };
		})().catch(error => ({ browser: this.#setupFailure(error), key }));
		this.#preparing.set(creationKey, preparation);
		return (await preparation).browser;
	}
	async #prepare(key: string, { binary, chromium }: Exclude<WorkerBrowserAvailability, string>): Promise<WorkerBrowser | string> {
		try {
			const existing = await this.#read(key);
			if (existing) return existing;
			const directory = await mkdtemp(join(tmpdir(), "kab-"));
			const browser: WorkerBrowser = { directory, launcher: join(directory, "agent-browser"), session: `w-${key.slice(0, 16)}`,
				socket: join(directory, "s"), proof: join(directory, "proof"),
				allowedDomains: this.options.allowedDomains ?? (serverSettings.KEMIRI_BROWSER_ALLOWED_DOMAINS?.trim() || "localhost,127.0.0.1,[::1],::1") };
			try {
				for (const name of ["home", "s", "proof", "tmp"]) await mkdir(join(directory, name), { mode: 0o700 });
				await writeFile(browser.launcher, workerBrowserLauncher(binary, chromium, browser), { mode: 0o700 });
				await writeFile(join(this.#root, `${key}.json`), JSON.stringify(browser), { mode: 0o600 });
			} catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
			this.#resumed.set(key, Promise.resolve());
			return browser;
		} catch (error) { return this.#setupFailure(error); }
	}
	async wait(projectId: string, conversationId: number): Promise<void> {
		const key = this.#key(projectId, conversationId);
		await this.ready;
		await this.#closing.get(key);
		// A resumed durable worker keeps its launcher path/instructions, but not an obsolete release's binary.
		let resumed = this.#resumed.get(key);
		if (!resumed) {
			resumed = this.#resume(key);
			this.#resumed.set(key, resumed);
		}
		await resumed;
	}
	async #resume(key: string): Promise<void> {
		const browser = await this.#read(key);
		if (!browser) return;
		const availability = await this.ensureReady(); // Called from run boundaries, never from a durable commit.
		if (typeof availability === "string") {
			const reason = workerBrowserInstructions(availability);
			this.options.log(`agent-browser resume: ${reason}`);
			// Fail closed rather than running the preceding release's pin. Retry at a later spawn/restart, not each prompt.
			await writeFile(browser.launcher, `#!/bin/sh\nprintf '%s\\n' ${quote(reason)} >&2\nexit 1\n`, { mode: 0o700 }).catch(() => undefined);
		} else {
			await writeFile(browser.launcher, workerBrowserLauncher(availability.binary, availability.chromium, browser), { mode: 0o700 })
				.catch(error => this.options.log(`agent-browser resume: ${error}`));
		}
	}
	cleanup(projectId: string, conversationId: number, forget = false): Promise<void> {
		return this.#cleanup(this.#key(projectId, conversationId), forget);
	}
	#cleanup(key: string, forget: boolean): Promise<void> {
		const pending = this.#closing.get(key) ?? Promise.resolve();
		const cleanup = pending.then(async () => {
			const browser = await this.#read(key);
			if (browser) {
				let timer: ReturnType<typeof setTimeout> | undefined;
				try {
					await Promise.race([closeWorkerBrowser(browser), new Promise<never>((_, reject) => {
						timer = setTimeout(() => reject(new Error("worker browser cleanup timed out (6s); retained directory for retry")), 6000);
					})]);
				} finally { clearTimeout(timer); }
				await rm(join(browser.directory, "tmp"), { recursive: true, force: true });
				await mkdir(join(browser.directory, "tmp"), { mode: 0o700 });
				if (forget) await rm(browser.directory, { recursive: true, force: true });
			}
			if (forget) await rm(join(this.#root, `${key}.json`), { force: true });
		}).catch(error => this.options.log(`agent-browser cleanup: ${error}`));
		this.#closing.set(key, cleanup);
		void cleanup.finally(() => { if (this.#closing.get(key) === cleanup) this.#closing.delete(key); });
		return cleanup;
	}
}
