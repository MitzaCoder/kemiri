import { MAX_FILE_PATH_BYTES } from "@kemiri/protocol";
import { constants, type Stats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { ServerError } from "./errors.ts";

const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
export const codeFileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
export const isCodeSaveTemp = (name: string) => /^\.kemiri-save-[0-9a-f-]{36}\.tmp$/.test(name);
export const isVcsMetadata = (name: string) => /^\.(git|jj)$/i.test(name);
const invalidPath = () => new ServerError("invalid_path", "The path must stay inside the code root and outside repository metadata");

export function isCodePath(path: string): boolean {
	return Buffer.byteLength(path) <= MAX_FILE_PATH_BYTES && !/^[a-z]:/i.test(path) && !path.startsWith("/") &&
		!/[\\\0]/.test(path) && !path.split("/").some(part => part === ".." || isVcsMetadata(part) || isCodeSaveTemp(part));
}

export function pathInsideCodeRoot(root: string, target: string): string {
	const path = relative(root, target).split(sep).join("/");
	if (isAbsolute(path) || !isCodePath(path)) throw invalidPath();
	return path;
}

export async function resolveCodePath(root: string, path: string): Promise<string> {
	if (!isCodePath(path)) throw invalidPath();
	const target = await realpath(`${root}/${path}`);
	pathInsideCodeRoot(root, target);
	return target;
}

export function sameInode(left: Stats, right: Stats): boolean { return left.ino === right.ino && left.dev === right.dev; }

/** On Linux, verify the opened descriptor and use it for subsequent directory-relative operations. */
export async function assertCodeDescriptor(root: string, canonical: string, file: FileHandle, info: Stats): Promise<void> {
	const descriptorPath = process.platform === "linux" ? `/proc/self/fd/${file.fd}` : canonical;
	const actual = await realpath(descriptorPath);
	pathInsideCodeRoot(root, actual);
	if (actual !== canonical || !sameInode(info, await lstat(canonical))) throw invalidPath();
}

export async function withCodeDirectory<T>(root: string, directory: string, work: (directoryPath: string, descriptor: FileHandle, verify: () => Promise<void>) => Promise<T>): Promise<T> {
	const file = await open(directory, directoryFlags);
	try {
		const info = await file.stat();
		const verify = () => assertCodeDescriptor(root, directory, file, info);
		await verify();
		const answer = await work(process.platform === "linux" ? `/proc/self/fd/${file.fd}` : directory, file, verify);
		await verify();
		return answer;
	} finally { await file.close(); }
}
