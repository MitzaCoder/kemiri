import { MAX_CHANGE_FILES, MAX_CHANGE_PATCH_BYTES, MAX_CHANGE_SIDE_BYTES, type ChangedFile, type ChangeFileSide, type ChangesFileResponse, type ChangesListResponse } from "@kemiri/protocol";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isCodePath } from "./code-path.ts";
import { ServerError } from "./errors.ts";
import { findGitWorktree, gitHashPattern, jjCheckoutCommit, withScratchIndex, worktreeGit, type WorktreeGit } from "./git-worktree.ts";
import { isSensitiveCodePath, readCodeFile } from "./project-files.ts";
import { runVcsCommand, VcsCommandError } from "./task-changes.ts";

const MAX_SCAN_PATHS = 20_000;
const MAX_SCAN_BYTES = 128 * 1024 * 1024;
const MAX_SCAN_MS = 8_000;
const MAX_DIFF_BYTES = 24 * 1024 * 1024;
const PREVIEW_BYTES = MAX_CHANGE_PATCH_BYTES / 2;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const regular = (mode?: string) => mode === "100644" || mode === "100755";
const validPath = (path: string) => isCodePath(path) && path.split("/").every(part => part && part !== "." && !/^\.(?:git|jj)[. ]+$/i.test(part));
const comparePaths = (a: string, b: string) => a < b ? -1 : a === b ? 0 : 1;
const diffSafety = ["--no-ext-diff", "--no-textconv", "--no-color", "--diff-algorithm=myers"];

type IndexSide = { mode: string; hash: string };
type Candidate = { path: string; before?: IndexSide; afterMode?: string };
type WorkingSide = Awaited<ReturnType<typeof readCodeFile>>;
type SidePreview = ChangeFileSide | { tooLarge: true; preview?: string } | { binary: true };
type Delta = { file: ChangedFile; before?: IndexSide; old?: SidePreview; after?: WorkingSide; denied?: string; sensitive: boolean };
type Inventory = { deltas: Delta[]; truncated: boolean };

function* nulFields(bytes: Buffer): Iterable<Buffer> {
	for (let start = 0, end; (end = bytes.indexOf(0, start)) >= 0; start = end + 1) yield bytes.subarray(start, end);
}

function decodePath(bytes: Buffer): string | undefined {
	try { const path = utf8.decode(bytes); return validPath(path) ? path : undefined; } catch { return undefined; }
}

async function readBase(git: WorktreeGit, side: IndexSide, previewBytes = 0): Promise<SidePreview> {
	if (!regular(side.mode)) return { binary: true };
	const size = Number((await git(["cat-file", "-s", side.hash], { maxBytes: 4096 })).stdout.toString());
	const tooLarge = size > MAX_CHANGE_SIDE_BYTES;
	if (tooLarge && !previewBytes) return { tooLarge: true };
	const { stdout } = await git(["cat-file", "blob", side.hash], { maxBytes: tooLarge ? previewBytes : MAX_CHANGE_SIDE_BYTES, keepPrefix: tooLarge });
	if (stdout.subarray(0, 8192).includes(0)) return { binary: true };
	try {
		const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(stdout, { stream: tooLarge });
		return tooLarge ? { tooLarge: true, preview: text } : { text, hash: side.hash };
	} catch { return { binary: true }; }
}

async function baseCommit(git: WorktreeGit, root: string, jj: boolean): Promise<string | null> {
	if (jj) {
		const hash = await jjCheckoutCommit(root, true);
		return /^0+$/.test(hash) ? null : hash;
	}
	try {
		const hash = (await git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { maxBytes: 4096 })).stdout.toString().trim();
		if (gitHashPattern.test(hash)) return hash;
	} catch (error) {
		if (error instanceof VcsCommandError && error.exitCode === 1) return null;
		throw error;
	}
	throw new ServerError("harness_failed", "Could not resolve the checkout base commit");
}

async function candidates(git: WorktreeGit): Promise<{ paths: Candidate[]; truncated: boolean }> {
	const [tracked, untracked] = await Promise.allSettled([
		git(["diff-files", "--raw", "-z", "--no-abbrev", "--no-renames", "--ignore-submodules=all", ...diffSafety, "--"], { keepPrefix: true }),
		git(["ls-files", "--others", "--exclude-standard", "--exclude=.git/", "--exclude=.jj/", "-z"], { keepPrefix: true }),
	]);
	// Wait for both Git children before the scope owning their index removes it.
	if (tracked.status === "rejected") throw tracked.reason;
	if (untracked.status === "rejected") throw untracked.reason;
	const paths = new Map<string, Candidate>();
	const fields = nulFields(tracked.value.stdout)[Symbol.iterator]();
	let truncated = tracked.value.truncated || untracked.value.truncated;
	for (let header = fields.next(); !header.done; header = fields.next()) {
		const match = /^:(\d{6}) (\d{6}) ([a-f0-9]+) [a-f0-9]+ [A-Z]$/.exec(header.value.toString("ascii"));
		const name = fields.next();
		if (name.done && tracked.value.truncated) break;
		if (!match || !gitHashPattern.test(match[3]!) || name.done) throw new ServerError("harness_failed", "Invalid Git working change record");
		const path = decodePath(name.value);
		if (!path) continue;
		if (paths.size >= MAX_SCAN_PATHS) { truncated = true; break; }
		paths.set(path, { path, before: { mode: match[1]!, hash: match[3]! }, ...(match[2] === "000000" ? {} : { afterMode: match[2]! }) });
	}
	for (const bytes of nulFields(untracked.value.stdout)) {
		const path = decodePath(bytes);
		if (!path) continue;
		if (paths.size >= MAX_SCAN_PATHS) { truncated = true; break; }
		if (!paths.has(path)) paths.set(path, { path, afterMode: "100644" });
	}
	return { paths: [...paths.values()].sort((a, b) => comparePaths(a.path, b.path)), truncated };
}

async function collectWorkingChanges(git: WorktreeGit, scratch: string, root: string): Promise<Inventory> {
	const scan = await candidates(git);
	const deltas: Delta[] = [];
	const deadline = performance.now() + MAX_SCAN_MS;
	let readBytes = 0;
	let diffBytes = 0;
	for (const { path, before, afterMode } of scan.paths) {
		if (readBytes >= MAX_SCAN_BYTES || deltas.length >= MAX_CHANGE_FILES * 2 || performance.now() >= deadline) { scan.truncated = true; break; }
		let after: WorkingSide | undefined;
		let denied: string | undefined;
		if (afterMode) {
			try {
				after = await readCodeFile(root, path, { rejectLinks: true, ...(before && regular(before.mode) ? {
					gitHash: before.hash.length === 40 ? "sha1" : "sha256", largeHashBudget: MAX_SCAN_BYTES - readBytes,
				} : {}) });
			}
			catch (error) {
				if (!(error instanceof ServerError) || !["invalid_path", "bad_request", "permission_denied", "not_found"].includes(error.code)) throw error;
				denied = error.code;
			}
		}
		readBytes += Math.min(after?.size ?? 0, after?.blobHash ? MAX_SCAN_BYTES : MAX_CHANGE_SIDE_BYTES);
		if (before && after?.blobHash === before.hash && before.mode === afterMode) continue;
		const sensitive = isSensitiveCodePath(path) || after?.sensitive === true;
		const old = before && !sensitive && !denied ? await readBase(git, before) : undefined;
		if (old && "text" in old) readBytes += Buffer.byteLength(old.text);
		const file: ChangedFile = { path, status: !before ? "added" : afterMode ? "modified" : "deleted", additions: 0, deletions: 0,
			binary: !!denied || after?.binary === true || (!!old && "binary" in old) };
		const delta: Delta = { file, before, after, old, denied, sensitive };
		const bytes = (old && "text" in old ? Buffer.byteLength(old.text) : 0) + (after?.text === undefined ? 0 : Buffer.byteLength(after.text));
		if (diffBytes + bytes > MAX_DIFF_BYTES) { scan.truncated = true; break; }
		diffBytes += bytes;
		deltas.push(delta);
	}
	const mergedDeletes = await addStatsAndRenames(scratch, deltas);
	return { deltas: deltas.filter(delta => !mergedDeletes.has(delta)), truncated: scan.truncated };
}

async function scratchDiff(scratch: string, args: string[], maxBytes?: number, keepOutputPrefix = false) {
	return runVcsCommand("git", ["diff", "--no-index", ...diffSafety, ...args], scratch, maxBytes, keepOutputPrefix, { acceptExitCode: 1 });
}

async function addStatsAndRenames(scratch: string, deltas: Delta[]): Promise<Set<Delta>> {
	const mergedDeletes = new Set<Delta>();
	await mkdir(join(scratch, "before"));
	await mkdir(join(scratch, "after"));
	for (const [index, { file, old, after, sensitive }] of deltas.entries()) {
		if (sensitive || file.binary || old && !("text" in old) || after && after.text === undefined) continue;
		if (old) await writeFile(join(scratch, "before", String(index)), old.text);
		if (after?.text !== undefined) await writeFile(join(scratch, "after", String(index)), after.text);
	}
	const { stdout } = await scratchDiff(scratch, ["-M", "-l1000", "--numstat", "-z", "--", "before", "after"]);
	const fields = nulFields(stdout)[Symbol.iterator]();
	for (let stat = fields.next(); !stat.done; stat = fields.next()) {
		const [additions, deletions] = stat.value.toString("ascii").split("\t");
		const oldLabel = fields.next().value?.toString("ascii");
		const newLabel = fields.next().value?.toString("ascii");
		const oldIndex = /^before\/(\d+)$/.exec(oldLabel ?? "")?.[1];
		const newIndex = /^after\/(\d+)$/.exec(newLabel ?? "")?.[1];
		const before = oldIndex === undefined ? undefined : deltas[Number(oldIndex)];
		const after = newIndex === undefined ? undefined : deltas[Number(newIndex)];
		const delta = after ?? before;
		if (!delta) throw new ServerError("harness_failed", "Invalid Git scratch diff statistics");
		if (before && after && before !== after && before.file.status === "deleted" && after.file.status === "added") {
			after.file.status = "renamed";
			after.file.previousPath = before.file.path;
			after.before = before.before;
			after.old = before.old;
			mergedDeletes.add(before);
		}
		delta.file.binary = additions === "-" || deletions === "-";
		delta.file.additions = delta.file.binary ? 0 : Number(additions);
		delta.file.deletions = delta.file.binary ? 0 : Number(deletions);
	}
	return mergedDeletes;
}

export class WorkingChanges {
	constructor(readonly root: string) {}

	async #scan<T>(use: (git: WorktreeGit, snapshot: Inventory, scratch: string, base: string | null, readAt: string) => Promise<T>): Promise<T> {
		const readAt = new Date().toISOString();
		try {
			const worktree = await findGitWorktree(this.root);
			if (!worktree) throw new ServerError("not_found", "This checkout has no Git worktree");
			const base = await baseCommit(worktreeGit(this.root, worktree.gitDir), this.root, worktree.jj);
			return await withScratchIndex(this.root, worktree.gitDir, base, async (git, scratch) =>
				use(git, await collectWorkingChanges(git, scratch, this.root), scratch, base, readAt));
		} catch (error) {
			if (error instanceof ServerError) throw error;
			throw new ServerError("harness_failed", error instanceof VcsCommandError && error.reason === "timeout" ? "Working change read timed out" : "Could not read working changes");
		}
	}

	list(): Promise<Omit<ChangesListResponse, "type" | "id">> {
		return this.#scan(async (_git, { deltas, truncated }, _scratch, baseCommit, readAt) => ({
			commits: [], files: deltas.slice(0, MAX_CHANGE_FILES).map(({ file }) => file), truncated: truncated || deltas.length > MAX_CHANGE_FILES, baseCommit, readAt,
		}));
	}

	file(path: string, reveal = false): Promise<Omit<ChangesFileResponse, "type" | "id">> {
		if (!validPath(path)) throw new ServerError("invalid_path", "Expected a relative working file path");
		return this.#scan(async (git, { deltas }, scratch) => {
			const delta = deltas.find(delta => delta.file.path === path);
			if (!delta) throw new ServerError("not_found", "No working change at that path");
			if (delta.denied === "invalid_path") throw new ServerError("invalid_path", "The path must stay inside the code root");
			if (delta.sensitive && !reveal) return { sensitive: true };
			if (delta.denied || delta.file.binary) return { binary: true };
			const before = delta.old && !("tooLarge" in delta.old) ? delta.old : delta.before && await readBase(git, delta.before, PREVIEW_BYTES);
			const after = delta.after?.text !== undefined ? delta.after : delta.after && await readCodeFile(this.root, path, { reveal, previewBytes: PREVIEW_BYTES, rejectLinks: true });
			if (before && "binary" in before || after?.binary) return { binary: true };
			if (after?.sensitive) return { sensitive: true };
			if (before && "tooLarge" in before || after?.tooLarge) {
				await mkdir(join(scratch, "preview"));
				const old = before && ("text" in before ? before.text : "preview" in before ? before.preview : undefined);
				const next = after?.text ?? after?.preview;
				if (old !== undefined) await writeFile(join(scratch, "preview", "before"), old);
				if (next !== undefined) await writeFile(join(scratch, "preview", "after"), next);
				const { stdout, truncated } = await scratchDiff(scratch, ["--no-renames", "--", old === undefined ? "/dev/null" : "preview/before", next === undefined ? "/dev/null" : "preview/after"], MAX_CHANGE_PATCH_BYTES, true);
				const patch = utf8.decode(truncated ? stdout.subarray(0, stdout.lastIndexOf(10) + 1) : stdout);
				return { tooLarge: true, ...(patch ? { patch } : {}), patchTruncated: true };
			}
			return { ...(before && "text" in before ? { before } : {}), ...(after?.text !== undefined && after.hash ? { after: { text: after.text, hash: after.hash } } : {}) };
		});
	}
}
