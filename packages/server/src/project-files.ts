import {
	MAX_FILE_BYTES, MAX_FILE_LIST_ENTRIES, MAX_FILE_SEARCH_RESULTS, fuzzyPrepared, prepareFuzzy, searchFold,
	type FileListEntry, type FilesListResponse, type FilesReadResponse, type FilesSearchResponse,
} from "@kemiri/protocol";
import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, mkdtemp, open, opendir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { detectMimeType } from "./artifacts.ts";
import { assertCodeDescriptor, codeFileFlags, isCodePath, isVcsMetadata, pathInsideCodeRoot, resolveCodePath, sameInode, withCodeDirectory } from "./code-path.ts";
import { ServerError } from "./errors.ts";
import { serverSettings } from "./server-settings.ts";
import { gitRepository, runVcsCommand, VcsCommandError } from "./task-changes.ts";

const MAX_SEARCH_PATHS = 20_000;
const MAX_WALK_ENTRIES = 25_000;
const MAX_WALK_DEPTH = 24;
const MAX_DIRECTORY_SCAN = 20_000;
const MAX_GIT_PATH_BYTES = 8 * 1024 * 1024;
const SEARCH_CACHE_MS = 10_000;
const MAX_CACHED_ROOTS = 8;
const sensitiveName = /^(?:\.env.*|id_.*|\.netrc|\.npmrc)$|\.(?:pem|key)$|credentials/i;
const isHidden = (path: string) => path.split("/").some(part => part.startsWith("."));
const compareNames = (a: string, b: string) => a < b ? -1 : a === b ? 0 : 1;

export function projectFilesEnabled(env: Readonly<Record<string, string | undefined>> = serverSettings): boolean {
	return !["off", "0", "false", "no"].includes(env.KEMIRI_PROJECT_FILES?.trim().toLowerCase() ?? "");
}

function metadata(info: Stats) { return { size: info.size, modifiedAt: info.mtime.toISOString() }; }

async function fileOperation<T>(operation: () => Promise<T>): Promise<T> {
	try { return await operation(); }
	catch (error) {
		if (error instanceof ServerError) throw error;
		if (error instanceof VcsCommandError) throw new ServerError("internal", error.message);
		const code = (error as NodeJS.ErrnoException).code;
		if (["ENOENT", "ENOTDIR", "ENAMETOOLONG"].includes(code ?? "")) throw new ServerError("not_found", "No file or directory at this path");
		if (code === "ELOOP" || code === "EACCES" || code === "EPERM") throw new ServerError("permission_denied", "Cannot open this path");
		throw new ServerError("internal", "Could not inspect project files");
	}
}

function* gitPaths(stdout: Buffer): Iterable<string> {
	// Drop an incomplete last path if the output limit stopped Git. POSIX names may contain newlines.
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
	for (let start = 0, end; (end = stdout.indexOf(0, start)) >= 0; start = end + 1) {
		try { yield decoder.decode(stdout.subarray(start, end)); } catch { /* non-UTF-8 path */ }
	}
}

type GitWorktree = (args: string[], options?: { stdin?: string; maxBytes?: number; keepPrefix?: boolean }) => ReturnType<typeof runVcsCommand>;
async function withGitWorktree<T>(root: string, use: (git?: GitWorktree) => Promise<T>): Promise<T> {
	const marker = async (name: string) => lstat(join(root, name)).catch(error => {
		if (error.code !== "ENOENT") throw error;
		return undefined;
	});
	const gitMarker = await marker(".git");
	const git = (prefix: string[] = [], gitIndexFile?: string): GitWorktree => (args, options) =>
		runVcsCommand("git", ["-c", "core.fsmonitor=false", ...prefix, ...args], root, options?.maxBytes, options?.keepPrefix,
			{ stdin: options?.stdin, gitIndexFile });
	if (gitMarker?.isDirectory() || gitMarker?.isFile()) {
		// A repository's core.worktree setting must not redirect these project-scoped commands.
		return use(git([`--git-dir=${join(root, ".git")}`, `--work-tree=${root}`]));
	}
	if (!(await marker(".jj"))?.isDirectory()) return use();
	const gitStore = await gitRepository(root, true);
	if (!gitStore) return use();
	// Non-colocated jj workspaces have no Git index of their own. Seed a private index from the last jj snapshot
	// so a tracked file still counts as tracked after it matches a new ignore rule. Never snapshot or use a shared index.
	const revision = (await runVcsCommand("jj", ["--ignore-working-copy", "--at-op=@", "log", "--no-graph", "-r", "@", "-T", "commit_id"], root, 1024)).stdout.toString();
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new ServerError("internal", "No jj workspace revision");
	const scratch = await mkdtemp(join(tmpdir(), "kemiri-files-index-"));
	try {
		const readGit = git([`--git-dir=${gitStore}`, `--work-tree=${root}`], join(scratch, "index"));
		await readGit(["-c", "core.sparseCheckout=false", "-c", "core.splitIndex=false", "read-tree", revision]);
		return await use(readGit);
	} finally { await rm(scratch, { recursive: true, force: true }); }
}

async function ignoredNames(git: GitWorktree, directory: string, names: string[]): Promise<Set<string>> {
	if (!names.length) return new Set();
	const prefix = directory ? `./${directory}/` : "./";
	try {
		const { stdout } = await git(["check-ignore", "--stdin", "-z"], {
			stdin: names.map(name => `${prefix}${name}\0`).join(""),
			maxBytes: MAX_GIT_PATH_BYTES,
		});
		const ignored = new Set<string>();
		for (const path of gitPaths(stdout)) if (path.startsWith(prefix)) ignored.add(path.slice(prefix.length));
		return ignored;
	} catch (error) {
		if (error instanceof VcsCommandError && error.exitCode === 1) return new Set();
		throw error;
	}
}

function fileKind(entry: Stats | Dirent): FileListEntry["kind"] | undefined {
	return entry.isDirectory() ? "dir" : entry.isSymbolicLink() ? "link" : entry.isFile() ? "file" : undefined;
}

async function walkSearchPaths(root: string): Promise<string[]> {
	const paths: string[] = [];
	let scanned = 0;
	async function walk(path: string, depth: number): Promise<void> {
		await withCodeDirectory(root, join(root, path), async directory => {
			for await (const entry of await opendir(directory)) {
				if (scanned++ >= MAX_WALK_ENTRIES || paths.length >= MAX_SEARCH_PATHS) break;
				if (entry.name.startsWith(".")) continue;
				const child = path ? `${path}/${entry.name}` : entry.name;
				if (!isCodePath(child)) continue;
				if (entry.isFile() || entry.isSymbolicLink()) paths.push(child);
				else if (entry.isDirectory() && depth < MAX_WALK_DEPTH) {
					const pathsBefore = paths.length;
					try { await walk(child, depth + 1); }
					catch (error) {
						// Discard names from a directory whose descriptor did not pass the final validation.
						paths.length = pathsBefore;
						if (!(error instanceof ServerError) && !["ENOENT", "ENOTDIR", "ELOOP", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
					}
				}
			}
		});
	}
	await walk("", 1);
	return paths;
}

/** One short-lived inventory per canonical checkout, shared by requests rather than built on every keystroke. */
export class ProjectFiles {
	readonly #searchCache = new Map<string, { paths: Promise<string[]>; expiresAt: number }>();

	list(root: string, path: string, showHidden = false): Promise<Omit<FilesListResponse, "type" | "id">> {
		return fileOperation(async () => {
			const canonical = await resolveCodePath(root, path);
			const relativeDirectory = pathInsideCodeRoot(root, canonical);
			return withCodeDirectory(root, canonical, async directory => {
				const candidates: { name: string; kind: FileListEntry["kind"] }[] = [];
				let scanned = 0;
				let truncated = false;
				let candidateBytes = 0;
				for await (const entry of await opendir(directory)) {
					if (scanned++ >= MAX_DIRECTORY_SCAN) { truncated = true; break; }
					const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
					if (isVcsMetadata(entry.name) || !isCodePath(relativePath) || (!showHidden && entry.name.startsWith("."))) continue;
					const kind = fileKind(entry);
					if (!kind) continue;
					candidateBytes += Buffer.byteLength(relativePath) + 3; // ./ and NUL in check-ignore input
					if (candidateBytes > MAX_GIT_PATH_BYTES) { truncated = true; break; }
					candidates.push({ name: entry.name, kind });
				}
				const ignored = showHidden || candidates.length === 0 ? new Set<string>() : await withGitWorktree(root,
					git => git ? ignoredNames(git, relativeDirectory, candidates.map(({ name }) => name)) : Promise.resolve(new Set<string>()));
				candidates.sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || compareNames(a.name, b.name));
				const entries: FileListEntry[] = [];
				for (const entry of candidates) {
					if (ignored.has(entry.name)) continue;
					if (entries.length === MAX_FILE_LIST_ENTRIES) { truncated = true; break; }
					const info = await lstat(join(directory, entry.name)).catch(error => {
						if (error.code !== "ENOENT") throw error;
						return undefined;
					});
					if (info && fileKind(info) === entry.kind) entries.push({ ...entry, ...metadata(info) });
				}
				return { entries, truncated };
			});
		});
	}

	#searchPaths(root: string): Promise<string[]> {
		const start = Date.now();
		const cached = this.#searchCache.get(root);
		if (cached && cached.expiresAt > start) return cached.paths;
		this.#searchCache.delete(root);
		if (this.#searchCache.size >= MAX_CACHED_ROOTS) this.#searchCache.delete(this.#searchCache.keys().next().value!);
		const paths = withGitWorktree(root, async git => {
			if (!git) return walkSearchPaths(root);
			const { stdout } = await git(["ls-files", "-co", "--exclude-standard", "-z"], { maxBytes: MAX_GIT_PATH_BYTES, keepPrefix: true });
			const unique = new Set<string>();
			for (const path of gitPaths(stdout)) {
				if (path && isCodePath(path) && !isHidden(path)) unique.add(path);
				if (unique.size >= MAX_SEARCH_PATHS) break;
			}
			return [...unique];
		});
		const entry = { paths, expiresAt: Infinity };
		this.#searchCache.set(root, entry);
		void paths.then(() => { entry.expiresAt = Date.now() + SEARCH_CACHE_MS; }, () => {
			if (this.#searchCache.get(root) === entry) this.#searchCache.delete(root);
		});
		return paths;
	}

	search(root: string, query: string): Promise<Omit<FilesSearchResponse, "type" | "id">> {
		return fileOperation(async () => {
			const needle = searchFold(query).replace(/\s/g, "");
			if (!needle) return { paths: [] };
			const matches: { path: string; score: number }[] = [];
			const letters = needle.split("");
			for (const path of await this.#searchPaths(root)) {
				const folded = searchFold(path);
				let position = -1;
				if (!letters.every(letter => (position = folded.indexOf(letter, position + 1)) >= 0)) continue;
				const match = fuzzyPrepared(prepareFuzzy(path), needle, false);
				if (match) matches.push({ path, score: match.score });
			}
			matches.sort((a, b) => b.score - a.score || compareNames(a.path, b.path));
			return { paths: matches.slice(0, MAX_FILE_SEARCH_RESULTS).map(match => match.path) };
		});
	}

	read(root: string, path: string, reveal = false): Promise<Omit<FilesReadResponse, "type" | "id">> {
		return fileOperation(async () => {
			const canonical = await resolveCodePath(root, path);
			if (canonical === root) throw new ServerError("bad_request", "Only regular files can be read");
			return withCodeDirectory(root, dirname(canonical), async directory => {
				const entry = join(directory, basename(canonical));
				const before = await lstat(entry);
				if (!before.isFile()) throw new ServerError("bad_request", "Only regular files can be read");
				if (!reveal && (sensitiveName.test(basename(path)) || sensitiveName.test(basename(canonical)))) {
					return { ...metadata(before), sensitive: true };
				}
				const file = await open(entry, codeFileFlags);
				try {
					const info = await file.stat();
					if (!info.isFile() || !sameInode(before, info)) throw new ServerError("bad_request", "The file changed before it could be read");
					await assertCodeDescriptor(root, canonical, file, info);
					if (info.size > MAX_FILE_BYTES) return { ...metadata(info), tooLarge: true };
					const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
					let size = 0;
					while (size < bytes.length) {
						const { bytesRead } = await file.read(bytes, size, bytes.length - size, size);
						if (!bytesRead) break;
						size += bytesRead;
					}
					const after = await file.stat();
					await assertCodeDescriptor(root, canonical, file, after);
					if (size > MAX_FILE_BYTES || after.size > MAX_FILE_BYTES) return { ...metadata(after), size: Math.max(size, after.size), tooLarge: true };
					const payload = bytes.subarray(0, size);
					const head = payload.subarray(0, 8192);
					const fileMetadata = { ...metadata(after), size };
					if (!head.includes(0)) {
						let text: string | undefined;
						try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload); } catch { /* invalid UTF-8 */ }
						if (text !== undefined) return { ...fileMetadata, text, hash: createHash("sha256").update(payload).digest("hex") };
					}
					const mimeType = detectMimeType(canonical, head);
					return { ...fileMetadata, binary: true, mimeType: mimeType === "text/plain" ? "application/octet-stream" : mimeType };
				} finally { await file.close(); }
			});
		});
	}
}
