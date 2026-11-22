import { execFile, spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "./fs-json.ts";
import { scopeCommand, UserScopeProbe, userScopeEnvironment } from "./user-scopes.ts";
import { childEnvironment } from "./child-environment.ts";

export const MANAGED_APP_CHILD = "--kemiri-managed-app";
export const APP_LOG_LIMIT = 1024 * 1024;
export const APP_LOG_SEGMENT = APP_LOG_LIMIT / 2;
export const APP_START_TIMEOUT_MS = 30_000;
export type ManagedProcess = { pid: number; pgid: number; startTime: string; unit?: string };
export type ManagedApp = { command: string; cwd: string; logPath: string; starting?: true; process?: ManagedProcess };
export type ManagedLaunch = { appId: string; command: string; cwd: string; unit?: string };
export const validManagedAppId = (id: string) => /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/.test(id);
export const managedScopeName = (id: string) => `kemiri-app-${id}.scope`;
const validPid = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 1 && value <= 0x7fffffff;
export const validManagedProcess = (value: unknown, appId: string): value is ManagedProcess => {
	if (!value || typeof value !== "object") return false;
	const p = value as ManagedProcess;
	return validPid(p.pid) && validPid(p.pgid) && typeof p.startTime === "string" && p.startTime.length > 0 && p.startTime.length <= 128 &&
		(p.unit === undefined ? p.pgid === p.pid : p.unit === managedScopeName(appId));
};

export function runUserScopeCommand(command: string[], timeout: number) {
	return new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
		execFile(command[0]!, command.slice(1), { env: userScopeEnvironment(), timeout, maxBuffer: 128 * 1024 }, (error, stdout, stderr) =>
			resolve({ code: error ? 1 : 0, stdout, stderr }));
	});
}

let bootId: Promise<string> | undefined;
export async function processIdentity(pid: number, launchPath: string): Promise<{ pgid: number; startTime: string } | undefined> {
	if (!validPid(pid)) return;
	if (process.platform === "linux") {
		try {
			bootId ??= readFile("/proc/sys/kernel/random/boot_id", "utf8");
			const [boot, stat] = await Promise.all([bootId, readFile(`/proc/${pid}/stat`, "utf8")]);
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
			const pgid = Number(fields[2]);
			if (fields[0] !== "Z" && fields[0] !== "X" && validPid(pgid) && /^\d+$/.test(fields[19] ?? "")) {
				return { pgid, startTime: `${boot.trim()}:${fields[19]}` };
			}
		} catch { /* The process may have already exited. */ }
	} else if (process.platform === "darwin") {
		const found = await runUserScopeCommand(["/bin/ps", "-ww", "-p", String(pid), "-o", "pgid=,lstart=,command="], 1000);
		const match = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/m.exec(found.stdout);
		if (match && match[3]?.endsWith(` ${MANAGED_APP_CHILD} ${launchPath}`) && validPid(Number(match[1]))) {
			return { pgid: Number(match[1]), startTime: match[2]! };
		}
	}
}

export async function inManagedScope(pid: number, unit: string): Promise<boolean> {
	try { return (await readFile(`/proc/${pid}/cgroup`, "utf8")).split("\n").some(line => line.endsWith(`/${unit}`)); }
	catch { return false; }
}

async function fileTail(path: string, bytes: number): Promise<Buffer> {
	let file;
	try {
		file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const stats = await file.stat();
		if (!stats.isFile()) return Buffer.alloc(0);
		const size = Math.min(bytes, stats.size);
		const buffer = Buffer.alloc(size);
		const { bytesRead } = await file.read(buffer, 0, size, stats.size - size);
		return buffer.subarray(0, bytesRead);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0);
		throw error;
	} finally { await file?.close(); }
}

export class ManagedAppProcesses {
	readonly #scope = new UserScopeProbe(userScopeEnvironment, runUserScopeCommand);
	constructor(readonly dataDir: string, readonly scopeBinary: () => Promise<string | undefined> = () => this.#scope.binary()) {}

	directory(appId: string) {
		if (!validManagedAppId(appId)) throw new Error("Invalid managed app ID");
		return join(this.dataDir, "managed-apps", appId);
	}
	launchPath(appId: string) { return join(this.directory(appId), "launch.json"); }
	logPath(appId: string) { return join(this.directory(appId), "app.log"); }

	async identity(appId: string): Promise<ManagedProcess | undefined> {
		const saved = await readJsonFile(join(this.directory(appId), "process.json"));
		return validManagedProcess(saved, appId) ? saved : undefined;
	}

	async alive(appId: string, owned: ManagedProcess): Promise<boolean> {
		if (!validManagedProcess(owned, appId)) return false;
		const current = await processIdentity(owned.pid, this.launchPath(appId));
		return current?.startTime === owned.startTime && current.pgid === owned.pgid && (!owned.unit || await inManagedScope(owned.pid, owned.unit));
	}

	async launch(appId: string, command: string, cwd: string): Promise<ManagedProcess> {
		await mkdir(this.directory(appId), { recursive: true, mode: 0o700 });
		const binary = await this.scopeBinary();
		const launchPath = this.launchPath(appId);
		const compiled = Bun.main.startsWith("/$bunfs/") || Bun.main.startsWith("B:/~BUN/");
		const childArgs = [process.execPath, ...(compiled ? [] : ["--no-env-file", join(import.meta.dir, "managed-app-child.ts")]), MANAGED_APP_CHILD, launchPath];
		let failure = "The managed app runner did not start.";
		for (const scope of binary ? [binary, undefined] : [undefined]) {
			const unit = scope ? managedScopeName(appId) : undefined;
			await writeJsonFile(launchPath, { appId, command, cwd, ...(unit ? { unit } : {}) } satisfies ManagedLaunch);
			const [file, ...args] = scope ? scopeCommand(scope, childArgs, { unit, description: "Kemiri managed app" }) : childArgs;
			let exited = false;
			const supervisor = spawn(file!, args, { cwd, detached: true, stdio: "ignore", env: childEnvironment(userScopeEnvironment()) });
			supervisor.once("exit", () => { exited = true; });
			supervisor.once("error", error => { exited = true; failure = error.message; });
			supervisor.unref();
			const deadline = Date.now() + 5000;
			while (true) {
				const owned = await this.identity(appId);
				if (owned) return owned; // No fallback after the command has potentially executed.
				if (exited) break;
				if (Date.now() >= deadline) {
					// ChildProcess uses its own handle rather than a persisted PID here. Do not retry an ambiguous start.
					supervisor.kill("SIGKILL");
					throw new Error(failure);
				}
				await Bun.sleep(30);
			}
		}
		throw new Error(failure);
	}

	async stop(appId: string, owned: ManagedProcess): Promise<void> {
		if (!await this.alive(appId, owned)) return;
		if (owned.unit) {
			const result = await runUserScopeCommand(["systemctl", "--user", "stop", owned.unit], 5000);
			if (result.code !== 0 && await this.alive(appId, owned)) throw new Error("Could not stop the managed app’s user scope.");
			return;
		}
		function signal(signal: NodeJS.Signals) {
			try { process.kill(-owned.pgid, signal); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
		}
		signal("SIGTERM");
		for (let n = 0; n < 20; n++) {
			await Bun.sleep(50);
			if (!await this.alive(appId, owned)) return;
		}
		signal("SIGKILL");
		for (let n = 0; n < 20; n++) {
			await Bun.sleep(25);
			if (!await this.alive(appId, owned)) return;
		}
		throw new Error("The managed app process group did not stop.");
	}

	async tail(appId: string, bytes: number): Promise<string> {
		const path = this.logPath(appId);
		const current = await fileTail(path, bytes);
		const previous = current.length < bytes ? await fileTail(`${path}.1`, bytes - current.length) : Buffer.alloc(0);
		return Buffer.concat([previous, current]).toString("utf8");
	}

	async remove(appId: string) { await rm(this.directory(appId), { recursive: true, force: true }); }
}
