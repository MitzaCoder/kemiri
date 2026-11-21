import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { childEnvironment } from "./child-environment.ts";

export type AppListener = { address: string; port: number; pids: number[] };
export type ListenerCommand = (file: string, args: string[], cwd?: string) => Promise<string | null>;
const runCommand: ListenerCommand = (file, args, cwd) => new Promise(resolve => {
	execFile(file, args, { cwd, env: childEnvironment(), timeout: 2500, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => resolve(error ? null : stdout));
});

/** `ss -ltnpH`: the local endpoint is column four. A PID is optional even on a successful read. */
export function parseAppListeners(output: string): AppListener[] {
	return output.split("\n").flatMap(line => {
		const [state, , , endpoint] = line.trim().split(/\s+/);
		const endpointMatch = endpoint?.match(/^(.*):(\d+)$/);
		if (state !== "LISTEN" || !endpointMatch?.[1]) return [];
		const port = Number(endpointMatch[2]);
		if (port < 1 || port > 65535) return [];
		return [{ address: endpointMatch[1].replace(/^\[|\]$/g, ""), port,
			pids: [...new Set([...line.matchAll(/",pid=(\d+),fd=\d+\)/g)].map(match => Number(match[1])))],
		}];
	});
}

export type AppListenerSource = {
	listeners(): Promise<AppListener[] | null>;
	cwd(pid: number): Promise<string | null>;
	workspaces(projectPath: string): Promise<string[]>;
};

export function linuxAppListenerSource(run = runCommand, platform = process.platform): AppListenerSource {
	return {
		async listeners() {
			if (platform !== "linux") return null;
			const output = await run("ss", ["-ltnpH"]);
			return output === null ? null : parseAppListeners(output);
		},
		async cwd(pid) { return readlink(`/proc/${pid}/cwd`).catch(() => null); },
		async workspaces(projectPath) {
			const [git, jj] = await Promise.all([
				run("git", ["--no-pager", "worktree", "list", "--porcelain", "-z"], projectPath),
				run("jj", ["--no-pager", "--color=never", "--ignore-working-copy", "workspace", "list", "-T", 'root ++ "\\0"'], projectPath),
			]);
			return [...(git ?? "").split("\0").filter(field => field.startsWith("worktree ")).map(field => field.slice(9)),
				...(jj ?? "").split("\0")].filter(isAbsolute);
		},
	};
}

function inside(root: string, cwd: string): boolean {
	const path = relative(root, cwd);
	return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

export function inAppWorkspace(cwd: string, projectPath: string, projectDataDir: string, linkedWorkspaces: readonly string[]): boolean {
	if (!isAbsolute(cwd) || cwd.endsWith(" (deleted)")) return false;
	if (inside(projectPath, cwd) || linkedWorkspaces.some(root => inside(root, cwd))) return true;
	if (inside(join(projectDataDir, "workspaces"), cwd)) return true;
	// Background threads have their own checkout and worker directories under the project's data directory.
	const threads = join(projectDataDir, "threads");
	const [, directory] = relative(threads, cwd).split(sep);
	return inside(threads, cwd) && (directory === "checkout" || directory === "workers");
}

export function isDetectableListener(listener: AppListener, backendPort: number): boolean {
	return listener.port >= 1024 && listener.port !== backendPort &&
		["127.0.0.1", "0.0.0.0", "::", "*"].includes(listener.address);
}
