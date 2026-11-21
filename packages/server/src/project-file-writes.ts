import { MAX_FILE_BYTES, type FileWriteResult } from "@kemiri/protocol";
import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { assertCodeDescriptor, codeFileFlags, isCodePath, pathInsideCodeRoot, resolveCodePath, sameInode, withCodeDirectory } from "./code-path.ts";
import { ServerError } from "./errors.ts";
import { isSensitiveCodePath } from "./project-files.ts";

const hashBytes = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const tempFlags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const invalidPath = () => new ServerError("invalid_path", "Expected a relative project file path without symbolic links or repository metadata");
const changedFile = () => new ServerError("bad_request", "The file changed during save. Refresh the file and try again.");

function sameRevision(before: Stats, after: Stats): boolean {
	return sameInode(before, after) && before.size === after.size && before.mode === after.mode &&
		before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

function writableTarget(info: Stats): void {
	if (info.isSymbolicLink()) throw invalidPath();
	if (!info.isFile()) throw new ServerError("bad_request", "Only existing regular files can be saved");
	if (info.mode & 0o6000) throw new ServerError("permission_denied", "Files with setuid or setgid permissions cannot be saved");
	if (info.size > MAX_FILE_BYTES) throw new ServerError("bad_request", "The file on disk is larger than 1 MiB");
}

async function readCurrent(root: string, canonical: string, path: string, verifyDir: () => Promise<void>) {
	await verifyDir();
	const expected = await lstat(path);
	writableTarget(expected);
	const file = await open(path, codeFileFlags);
	try {
		const info = await file.stat();
		writableTarget(info);
		if (!sameRevision(expected, info)) throw changedFile();
		await assertCodeDescriptor(root, canonical, file, info);
		const bytes = Buffer.alloc(info.size + 1);
		let size = 0;
		while (size < bytes.length) {
			const read = await file.read(bytes, size, bytes.length - size, size);
			if (read.bytesRead === 0) break;
			size += read.bytesRead;
		}
		const after = await file.stat();
		await assertCodeDescriptor(root, canonical, file, after);
		if (size !== info.size || !sameRevision(info, after)) throw changedFile();
		const payload = bytes.subarray(0, size);
		if (!payload.subarray(0, 8192).includes(0)) {
			try { return { info: after, text: utf8.decode(payload), hash: hashBytes(payload) }; }
			catch { /* Not UTF-8 text. */ }
		}
		throw new ServerError("bad_request", "The file on disk is not UTF-8 text");
	} finally { await file.close(); }
}

/** One server-wide queue per checkout path, including writes from different WebSockets. */
export class ProjectFileWrites {
	readonly #pending = new Map<string, Promise<FileWriteResult>>();

	constructor(private readonly replace: typeof rename = rename) {}

	async write(root: string, path: string, text: string, baseHash: string, requireEnabled: () => Promise<void>): Promise<FileWriteResult> {
		if (!isCodePath(path) || !path.split("/").every(part => part && part !== "." && !/^\.(git|jj)[. ]+$/i.test(part)) ||
			Buffer.from(path).toString("utf8") !== path) throw invalidPath();
		if (path.split("/").some(isSensitiveCodePath)) throw new ServerError("permission_denied", "Sensitive file names cannot be saved from the app");
		if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw new ServerError("bad_request", "The new file text must fit within 1 MiB");
		const bytes = Buffer.from(text);
		if (bytes.toString("utf8") !== text || bytes.includes(0)) throw new ServerError("bad_request", "Only valid UTF-8 text without NUL can be saved");
		const target = join(root, path);
		const previous = this.#pending.get(target);
		const save = (previous ?? Promise.resolve()).catch(() => undefined).then(async () => {
			await requireEnabled();
			return this.#save(root, path, bytes, baseHash, requireEnabled);
		});
		this.#pending.set(target, save);
		try { return await save; }
		finally { if (this.#pending.get(target) === save) this.#pending.delete(target); }
	}

	async #save(root: string, path: string, bytes: Buffer, baseHash: string, requireEnabled: () => Promise<void>): Promise<FileWriteResult> {
		try {
			const canonical = await resolveCodePath(root, path);
			if (pathInsideCodeRoot(root, canonical) !== path) throw invalidPath();
			return await withCodeDirectory(root, dirname(canonical), async (directory, directoryFile, verifyDir) => {
				const target = join(directory, basename(canonical));
				const current = await readCurrent(root, canonical, target, verifyDir);
				if (current.hash !== baseHash) return { status: "conflict", current: { text: current.text, hash: current.hash } };
				const tempPath = join(directory, `.kemiri-save-${randomUUID()}.tmp`);
				let temp: FileHandle | undefined;
				let prepared: Stats | undefined;
				let replaced = false;
				try {
					temp = await open(tempPath, tempFlags, 0o600);
					await temp.writeFile(bytes);
					const created = await temp.stat();
					if (created.uid !== current.info.uid || created.gid !== current.info.gid) await temp.chown(current.info.uid, current.info.gid);
					await temp.chmod(current.info.mode & 0o7777);
					await temp.sync();
					prepared = await temp.stat();
					await requireEnabled();
					const latest = await readCurrent(root, canonical, target, verifyDir);
					if (latest.hash !== baseHash) return { status: "conflict", current: { text: latest.text, hash: latest.hash } };
					if (!sameRevision(current.info, latest.info)) throw changedFile();
					await verifyDir();
					if (!sameRevision(prepared, await lstat(tempPath)) || !sameRevision(latest.info, await lstat(target))) throw changedFile();
					await this.replace(tempPath, target);
					replaced = true;
					try { await directoryFile.sync(); }
					catch { throw new ServerError("harness_failed", "The file was replaced, but the directory could not be synced. Refresh before retrying."); }
					return { status: "saved", hash: hashBytes(bytes), size: bytes.length, modifiedAt: prepared.mtime.toISOString() };
				} finally {
					if (temp) {
						try {
							if (!replaced) {
								const leftover = await lstat(tempPath).catch(error => {
									if (error.code !== "ENOENT") throw error;
									return undefined;
								});
								if (leftover && sameInode(leftover, prepared ?? await temp.stat())) await unlink(tempPath);
							}
						} finally { await temp.close(); }
					}
				}
			});
		} catch (error) {
			if (error instanceof ServerError) throw error;
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT" || code === "ENOTDIR") throw new ServerError("not_found", "Only existing files can be saved");
			if (code === "ELOOP") throw invalidPath();
			if (code === "EACCES" || code === "EPERM" || code === "EROFS") throw new ServerError("permission_denied", "The server cannot replace this file");
			throw new ServerError("harness_failed", "Could not save the file");
		}
	}
}
