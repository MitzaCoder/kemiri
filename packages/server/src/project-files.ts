import {
	MAX_FILE_BYTES, MAX_FILE_LIST_ENTRIES, MAX_FILE_SEARCH_RESULTS, fuzzyPrepared, prepareFuzzy, searchFold,
	type FileListEntry, type FilesListResponse, type FilesReadResponse, type FilesSearchResponse,
} from "@kemiri/protocol";
import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { detectMimeType } from "./artifacts.ts";
import { assertCodeDescriptor, codeFileFlags, isCodePath, isVcsMetadata, pathInsideCodeRoot, resolveCodePath, sameInode, withCodeDirectory } from "./code-path.ts";
import { ServerError } from "./errors.ts";
import { serverSettings } from "./server-settings.ts";
import { VcsCommandError } from "./task-changes.ts";
import { findGitWorktree, jjCheckoutCommit, withScratchIndex, worktreeGit, type WorktreeGit } from "./git-worktree.ts";

const MAX_SEARCH_PATHS = 20_000;
const MAX_WALK_ENTRIES = 25_000;
const MAX_WALK_DEPTH = 24;
const MAX_DIRECTORY_SCAN = 20_000;
const MAX_GIT_PATH_BYTES = 8 * 1024 * 1024;
const SEARCH_CACHE_MS = 10_000;
const MAX_CACHED_ROOTS = 8;
const sensitiveName = /^(?:\.env.*|id_.*|\.netrc|\.npmrc)$|\.(?:pem|key)$|credentials/i;
export const isSensitiveCodePath = (path: string) => sensitiveName.test(basename(path));
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

async function withGitWorktree<T>(root: string, use: (git?: WorktreeGit) => Promise<T>): Promise<T> {
	const worktree = await findGitWorktree(root);
	if (!worktree) return use();
	if (worktree.colocated) return use(worktreeGit(root, worktree.gitDir));
	// Keep tracked files visible even if they match a new ignore rule. A linked jj workspace has no Git index.
	return withScratchIndex(root, worktree.gitDir, await jjCheckoutCommit(root), use);
}

async function ignoredNames(git: WorktreeGit, directory: string, names: string[]): Promise<Set<string>> {
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

	read(root: string, path: string, reveal = false): Promise<FileReadPayload> {
		return readCodeFile(root, path, { reveal });
	}
}

type FileReadPayload = Omit<FilesReadResponse, "type" | "id">;
type CodeFileReadOptions = { reveal?: boolean; previewBytes?: number; gitHash?: "sha1" | "sha256"; largeHashBudget?: number; rejectLinks?: boolean };

/** The worktree diff and Files use the same contained descriptor and byte limits. The extra metadata is internal. */
export function readCodeFile(root: string, path: string, options: CodeFileReadOptions = {}): Promise<FileReadPayload & { blobHash?: string; preview?: string }> {
	const { reveal = false, previewBytes = 0, gitHash, largeHashBudget = 0, rejectLinks = false } = options;
	return fileOperation(async () => {
		const canonical = await resolveCodePath(root, path);
		if (canonical === root || (rejectLinks && pathInsideCodeRoot(root, canonical) !== path)) {
			throw new ServerError("bad_request", "Only regular files can be read");
		}
		return withCodeDirectory(root, dirname(canonical), async directory => {
			const entry = join(directory, basename(canonical));
			const before = await lstat(entry);
			if (!before.isFile()) throw new ServerError("bad_request", "Only regular files can be read");
			const sensitive = isSensitiveCodePath(path) || isSensitiveCodePath(canonical);
			if (sensitive && !reveal && !gitHash) return { ...metadata(before), sensitive: true };
			const file = await open(entry, codeFileFlags);
			try {
				const info = await file.stat();
				if (!info.isFile() || !sameInode(before, info)) throw new ServerError("bad_request", "The file changed before it could be read");
				await assertCodeDescriptor(root, canonical, file, info);
				const visible = !sensitive || reveal;
				const large = info.size > MAX_FILE_BYTES;
				if (large && !previewBytes && gitHash && info.size <= largeHashBudget) {
					// Compare tracked blobs without loading or returning oversized text. Count these bytes in the scan budget.
					const hash = createHash(gitHash).update(`blob ${info.size}\0`);
					const buffer = Buffer.alloc(64 * 1024);
					let position = 0;
					while (position < info.size) {
						const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, info.size - position), position);
						if (!bytesRead) break;
						hash.update(buffer.subarray(0, bytesRead));
						position += bytesRead;
					}
					const after = await file.stat();
					await assertCodeDescriptor(root, canonical, file, after);
					const matchingRead = position === after.size && after.size === info.size && after.mtimeMs === info.mtimeMs;
					return { ...metadata(after), ...(matchingRead ? { blobHash: hash.digest("hex") } : {}), ...(visible ? { tooLarge: true } : { sensitive: true }) };
				}
				const limit = large ? (visible ? Math.min(previewBytes, MAX_FILE_BYTES) : 0) : Math.min(info.size + 1, MAX_FILE_BYTES + 1);
				if (limit === 0) return { ...metadata(info), ...(visible ? { tooLarge: true } : { sensitive: true }) };
				const bytes = Buffer.alloc(limit);
				let size = 0;
				while (size < limit) {
					const { bytesRead } = await file.read(bytes, size, limit - size, size);
					if (!bytesRead) break;
					size += bytesRead;
				}
				const after = await file.stat();
				await assertCodeDescriptor(root, canonical, file, after);
				const payload = bytes.subarray(0, size);
				const incomplete = large || size > MAX_FILE_BYTES || size < after.size;
				const blobHash = !incomplete && gitHash ? { blobHash: createHash(gitHash).update(`blob ${size}\0`).update(payload).digest("hex") } : {};
				const fileMetadata = { ...metadata(after), size: Math.max(size, after.size) };
				if (!visible) return { ...fileMetadata, ...blobHash, sensitive: true };
				if (incomplete && !previewBytes) return { ...fileMetadata, tooLarge: true };
				const head = payload.subarray(0, 8192);
				if (!head.includes(0)) {
					try {
						const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
						const text = decoder.decode(payload, { stream: incomplete });
						if (incomplete) return { ...fileMetadata, tooLarge: true, preview: text };
						return { ...fileMetadata, ...blobHash, text, hash: createHash("sha256").update(payload).digest("hex") };
					} catch { /* invalid UTF-8 */ }
				}
				const mimeType = detectMimeType(canonical, head);
				return { ...fileMetadata, ...blobHash, binary: true, mimeType: mimeType === "text/plain" ? "application/octet-stream" : mimeType };
			} finally { await file.close(); }
		});
	});
}
