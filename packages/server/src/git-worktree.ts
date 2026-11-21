import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerError } from "./errors.ts";
import { gitRepository, runVcsCommand } from "./task-changes.ts";

export const gitHashPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export type WorktreeGit = (args: string[], options?: { stdin?: string; maxBytes?: number; keepPrefix?: boolean }) => ReturnType<typeof runVcsCommand>;

export async function findGitWorktree(root: string): Promise<{ gitDir: string; jj: boolean; colocated: boolean } | undefined> {
	const marker = async (name: string) => lstat(join(root, name)).catch(error => {
		if (error.code !== "ENOENT") throw error;
		return undefined;
	});
	const git = await marker(".git");
	const jj = (await marker(".jj"))?.isDirectory() === true;
	if (git?.isDirectory() || git?.isFile()) return { gitDir: join(root, ".git"), jj, colocated: true };
	const gitDir = jj ? await gitRepository(root, true) : undefined;
	return gitDir ? { gitDir, jj, colocated: false } : undefined;
}

export function worktreeGit(root: string, gitDir: string, gitIndexFile?: string): WorktreeGit {
	// Do not honor core.worktree (may point elsewhere) or invoke a configured filesystem monitor.
	return (args, options) => runVcsCommand("git", ["-c", "core.fsmonitor=false", `--git-dir=${gitDir}`, `--work-tree=${root}`, ...args],
		root, options?.maxBytes, options?.keepPrefix, { stdin: options?.stdin, gitIndexFile });
}

export async function jjCheckoutCommit(root: string, parent = false): Promise<string> {
	// Pin the current operation and never take a working-copy snapshot, even if the workspace is stale.
	const template = parent ? 'parents.map(|p| p.commit_id()).join("\\n")' : "commit_id";
	const output = (await runVcsCommand("jj", ["--ignore-working-copy", "--at-op=@", "log", "--no-graph", "-r", "@", "-T", template],
		root, 4096)).stdout.toString();
	const hash = output.split("\n")[0];
	if (!hash || !gitHashPattern.test(hash)) throw new ServerError("internal", "No jj workspace revision");
	return hash;
}

/** Any index locks and diff inputs live solely in a private, per-request temp directory. */
export async function withScratchIndex<T>(root: string, gitDir: string, base: string | null,
	use: (git: WorktreeGit, scratch: string) => Promise<T>): Promise<T> {
	const scratch = await mkdtemp(join(tmpdir(), "kemiri-code-index-"));
	try {
		const git = worktreeGit(root, gitDir, join(scratch, "index"));
		await git(["-c", "core.sparseCheckout=false", "-c", "core.splitIndex=false", "-c", "core.untrackedCache=false", "read-tree", base ?? "--empty"]);
		return await use(git, scratch);
	} finally { await rm(scratch, { recursive: true, force: true }); }
}
