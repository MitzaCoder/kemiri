/**
 * The little jj the harness needs itself: workspace isolation for workers. Everything else (merging, reviewing,
 * resolving conflicts) is the coordinator's work through the usual tools.
 */
import { childEnvironment } from "./child-environment.ts";
import { execFile } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";

// Parallel worker tools may mutate the same Git-backed jj repository. jj's packed-ref
// export can race even when the workspace names differ; keep our mutations in order.
const workspaceMutations = new Map<string, Promise<unknown>>();

async function serializeWorkspaceMutation<T>(repo: string, work: () => Promise<T>): Promise<T> {
	const previous = workspaceMutations.get(repo) ?? Promise.resolve();
	const result = previous.then(work);
	const settled = result.catch(() => undefined);
	workspaceMutations.set(repo, settled);
	try {
		return await result;
	} finally {
		if (workspaceMutations.get(repo) === settled) workspaceMutations.delete(repo);
	}
}

export class JjError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "JjError";
	}
}

function run(args: readonly string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(
			"jj",
			["--no-pager", "--color=never", ...args],
			{ cwd, env: childEnvironment(), timeout: 60_000, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" },
			(error, stdout, stderr) => {
				if (error === null) {
					resolve({ stdout, stderr });
					return;
				}
				const code = (error as NodeJS.ErrnoException).code;
				if (code === "ENOENT") {
					reject(new JjError("jj is not installed on this machine, so workspace isolation is unavailable"));
					return;
				}
				const detail = stderr.trim() || stdout.trim() || error.message;
				reject(new JjError(`jj ${args.join(" ")} failed in ${cwd}: ${detail}`));
			},
		);
	});
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(
		() => true,
		() => false,
	);
}

/** The repository's root, or undefined when `path` is not inside a jj repository. */
export async function jjRoot(path: string): Promise<string | undefined> {
	try {
		const { stdout } = await run(["root"], path);
		return stdout.trim().length > 0 ? stdout.trim() : undefined;
	} catch (error) {
		if (error instanceof JjError) return undefined;
		throw error;
	}
}

/** Create the workspace unless it is already registered and checked out, so a rerun after a crash is harmless. */
export async function ensureJjWorkspace(options: {
	repo: string;
	/** Workspace name inside the repository; unique per repository. */
	name: string;
	/** Absolute directory of the new working copy, outside the repository. */
	path: string;
	/** Where the new working copy starts; `@` is the checkout the coordinator sees, uncommitted edits included. */
	revision?: string;
}): Promise<void> {
	return serializeWorkspaceMutation(options.repo, () => createWorkspace(options));
}

async function createWorkspace(options: { repo: string; name: string; path: string; revision?: string }): Promise<void> {
	const { repo, name, path } = options;
	const listed = await run(["workspace", "list"], repo);
	const registered = listed.stdout
		.split("\n")
		.some((line) => line.startsWith(`${name}:`));

	if (registered) {
		if (await exists(path)) return;
		// Registered but its directory is gone: drop the stale name and recreate it.
		await run(["workspace", "forget", name], repo);
	} else if (await exists(path)) {
		await rm(path, { recursive: true, force: true });
	}

	await run(["workspace", "add", path, "--name", name, "--revision", options.revision ?? "@"], repo);
}

/** The revision a newly created workspace branched from, without snapshotting or changing its checkout. */
export async function jjWorkspaceRevision(path: string): Promise<string> {
	return (await run(["log", "--ignore-working-copy", "--no-graph", "-r", "@-", "-T", "commit_id"], path)).stdout.trim();
}

/**
 * Check once at a worker turn boundary, when none of its tools is running. A normal jj read snapshots edits;
 * if stale, update-stale snapshots at the old operation, then may leave that snapshot in a different version
 * of the change instead of the checkout. Never silently call that a clean recovery: name those commits.
 * An unavailable old operation is deliberately not auto-recovered: we cannot account for its snapshot safely.
 */
export async function keepJjWorkspaceCurrent(options: {
	repo: string;
	path: string;
	/** Persist recovery coordinates BEFORE a mutating attempt, so a restart cannot hide them or retry blindly. */
	beforeUpdate?: (recovery: { change: string; operation: string }) => Promise<void>;
}): Promise<string | undefined> {
	// Projects can point at a subdirectory; use the same root key as workspace creation/removal, without
	// snapshotting the coordinator's checkout as a side effect of a worker check.
	const repo = (await run(["root", "--ignore-working-copy"], options.repo)).stdout.trim();
	return serializeWorkspaceMutation(repo, async () => {
		const { path } = options;
		let stale: RegExpMatchArray | null;
		try {
			await run(["log", "--no-graph", "-r", "@", "-T", "commit_id"], path);
			return undefined;
		} catch (error) {
			stale = error instanceof JjError ? error.message.match(/working copy is stale \(not updated since operation ([0-9a-f]+)\)/i) : null;
			if (stale === null) throw error;
		}
		const operation = stale[1]!;
		// Resolve the OLD change, not the latest @: abandoning/squashing can replace the workspace's change ID.
		const change = (await run(["log", "--at-op", operation, "--no-graph", "-r", "@", "-T", "change_id"], path)).stdout.trim();
		if (!/^[k-z]+$/.test(change)) throw new JjError("Cannot identify the stale workspace's change; no update attempted.");
		await options.beforeUpdate?.({ change, operation });
		let output = "";
		try {
			const updated = await run(["workspace", "update-stale"], path);
			output = `${updated.stdout}${updated.stderr}`.trim();
			const checkout = (await run(["log", "--ignore-working-copy", "--no-graph", "-r", "@", "-T", "commit_id"], path)).stdout.trim();
			const versions = (await run([
				"log", "--ignore-working-copy", "--no-graph", "-r", `change_id(${change})`, "-T", 'commit_id ++ "\\n"',
			], path)).stdout.trim().split("\n").filter((id) => id.length > 0 && id !== checkout);
			const recovery = versions.length === 0 ? "" :
				` Other versions of your old change may contain your uncommitted edits, NOT in the working copy: ${versions.join(", ")}. Inspect them with \`jj show <commit-id>\` and restore the edits you need before continuing; the harness has not chosen or abandoned a version.`;
			const diagnostic = /warning|error|recovery/i.test(output) || (/divergent/i.test(output) && versions.length === 0)
				? ` jj reported: ${output}` : "";
			return `The harness ran \`jj workspace update-stale\` for your stale workspace.${recovery}${diagnostic}`;
		} catch (error) {
			throw new JjError(`${error instanceof Error ? error.message : String(error)}\n${output}\nWorkspace recovery was attempted once. Edits may be in another version of ${change}; inspect \`jj log -r 'change_id(${change})'\`. The old workspace operation was ${operation}. Do not assume the checkout contains all your edits.`);
		}
	});
}

/** Forget the workspace in the repository and delete its directory. Missing pieces are fine. */
export async function removeJjWorkspace(options: { repo: string; name: string; path: string }): Promise<void> {
	return serializeWorkspaceMutation(options.repo, () => removeWorkspace(options));
}

async function removeWorkspace(options: { repo: string; name: string; path: string }): Promise<void> {
	const { repo, name, path } = options;
	const listed = await run(["workspace", "list"], repo).catch(() => undefined);
	const registered =
		listed !== undefined && listed.stdout.split("\n").some((line) => line.startsWith(`${name}:`));
	if (registered) await run(["workspace", "forget", name], repo);
	await rm(path, { recursive: true, force: true });
}

/** The default directory of a project's worker workspaces, kept out of the repository. */
export function workspacePath(workspacesDir: string, workerId: string): string {
	return join(workspacesDir, workerId);
}
