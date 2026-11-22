import { existsSync } from "node:fs";
import { childEnvironment } from "./child-environment.ts";

export function userRuntimeDirectory(configured?: string): string | undefined {
	if (configured) return configured;
	const uid = process.getuid?.();
	if (uid === undefined) return undefined;
	const directory = `/run/user/${uid}`;
	return existsSync(directory) ? directory : undefined;
}

export function userScopeEnvironment(): Record<string, string | undefined> {
	const env = childEnvironment();
	const runtime = userRuntimeDirectory(env.XDG_RUNTIME_DIR);
	if (runtime) {
		env.XDG_RUNTIME_DIR = runtime;
		env.DBUS_SESSION_BUS_ADDRESS ??= `unix:path=${runtime}/bus`;
	}
	return env;
}

export function scopeCommand(binary: string, command: string[], options?: { unit?: string; description?: string }): string[] {
	return [binary, "--user", "--scope", "--quiet", "--collect",
		...(options?.unit ? [`--unit=${options.unit}`] : []),
		...(options?.description ? [`--description=${options.description}`] : []), "--", ...command];
}

/** Both terminal and app launchers probe the actual user-manager scope operation, not just its binary. */
export class UserScopeProbe {
	#cached: { at: number; result: Promise<string | undefined> } | undefined;
	constructor(readonly env: () => Record<string, string | undefined>, readonly run: (command: string[], timeout: number) => Promise<{ code: number; stderr: string }>,
		readonly unavailable?: (reason: string) => void) {}

	binary(): Promise<string | undefined> {
		const now = Date.now();
		if (this.#cached && now - this.#cached.at < 60_000) return this.#cached.result;
		const result = this.#probe();
		this.#cached = { at: now, result };
		return result;
	}

	async #probe(): Promise<string | undefined> {
		const env = this.env();
		const binary = Bun.which("systemd-run", { PATH: env.PATH ?? "" });
		if (!binary || !userRuntimeDirectory(env.XDG_RUNTIME_DIR)) return;
		const probe = await this.run(scopeCommand(binary, ["true"]), 5000);
		if (probe.code === 0) return binary;
		this.unavailable?.(probe.stderr.trim().slice(0, 160));
	}
}
