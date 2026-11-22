import { constants } from "node:fs";
import { open, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { childEnvironment } from "./child-environment.ts";
import { APP_LOG_SEGMENT, inManagedScope, MANAGED_APP_CHILD, managedScopeName, processIdentity, runUserScopeCommand, validManagedAppId, type ManagedLaunch } from "./managed-app-process.ts";
import { readJsonFile, writeJsonFile } from "./fs-json.ts";

class RollingAppLog {
	#bytes = 0;
	#tail: Promise<void> = Promise.resolve();
	constructor(readonly file: string) {}
	write(chunk: Uint8Array): Promise<void> {
		const write = this.#tail.then(async () => {
			let offset = 0;
			while (offset < chunk.length) {
				if (this.#bytes === APP_LOG_SEGMENT) {
					await rename(this.file, `${this.file}.1`);
					this.#bytes = 0;
				}
				const length = Math.min(APP_LOG_SEGMENT - this.#bytes, chunk.length - offset);
				const file = await open(this.file, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
				try {
					const buffer = chunk.subarray(offset, offset + length);
					await file.writeFile(buffer);
				} finally { await file.close(); }
				offset += length;
				this.#bytes += length;
			}
		});
		this.#tail = write;
		return write;
	}
}

/** Runs in the app's scope, not in the backend. Keeps its PID anchored until group cleanup. */
export async function runManagedAppChild(args: string[]): Promise<void> {
	const [flag, launch] = args;
	if (flag !== MANAGED_APP_CHILD || !launch || args.length !== 2) throw new Error("Invalid app launch");
	const spec = await readJsonFile(launch) as ManagedLaunch | undefined;
	if (!spec || !validManagedAppId(spec.appId) || dirname(launch).split("/").at(-1) !== spec.appId ||
		typeof spec.command !== "string" || typeof spec.cwd !== "string" || (spec.unit && spec.unit !== managedScopeName(spec.appId))) throw new Error("Invalid app launch");
	const identity = await processIdentity(process.pid, launch);
	if (!identity || (spec.unit ? !await inManagedScope(process.pid, spec.unit) : identity.pgid !== process.pid)) throw new Error("Could not verify the app process group");
	const directory = dirname(launch);
	const log = new RollingAppLog(join(directory, "app.log"));
	// Group TERM also reaches the shell and its children. Keep the leader alive to make escalation safe.
	process.on("SIGTERM", () => {});
	process.on("SIGINT", () => {});
	await writeJsonFile(join(directory, "process.json"), { pid: process.pid, ...identity, ...(spec.unit ? { unit: spec.unit } : {}) });
	const text = (message: string) => log.write(Buffer.from(message));
	try {
		await text("[Kemiri] Starting managed app.\n");
		const child = Bun.spawn(["/bin/sh", "-c", spec.command], { cwd: spec.cwd, env: childEnvironment(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const pump = async (stream: ReadableStream<Uint8Array>) => { for await (const chunk of stream) await log.write(chunk); };
		const output = Promise.all([pump(child.stdout), pump(child.stderr)]).catch(() => undefined);
		const code = await child.exited;
		await Promise.race([output, Bun.sleep(250)]); // Background descendants may hold the pipes; do not wait forever.
		await text(`\n[Kemiri] Command exited (${code}).\n`);
	} catch (error) { await text(`\n[Kemiri] ${error instanceof Error ? error.message : String(error)}\n`).catch(() => undefined); }
	finally {
		if (spec.unit) await runUserScopeCommand(["systemctl", "--user", "stop", "--no-block", spec.unit], 2000);
		// A shell that exits after backgrounding children must not leave the group behind.
		if (identity.pgid === process.pid) process.kill(-identity.pgid, "SIGKILL");
	}
}

if (import.meta.main) await runManagedAppChild(process.argv.slice(2));
