import { dlopen, ptr } from "bun:ffi";
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function isInsideBridgeRoot(root: string, path: string): boolean {
	const name = relative(root, path);
	return name !== ".." && !name.startsWith(`..${sep}`) && !isAbsolute(name);
}

export type BridgeArtifactRoot = { path: string; dev: bigint; ino: bigint };

export async function captureBridgeArtifactRoot(path: string, canonicalOnly = false): Promise<BridgeArtifactRoot> {
	const canonical = await realpath(path);
	const info = await lstat(canonical, { bigint: true });
	if (!info.isDirectory() || (canonicalOnly && path !== canonical)) throw new Error("Invalid artifact root.");
	const { dev, ino } = info;
	return { path: canonical, dev, ino };
}

function loadOpenAt() {
	const library = process.platform === "linux" ? "libc.so.6" : process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : undefined;
	if (!library) throw new Error("Scoped artifact reads are not supported on this platform.");
	// openat needs no variadic mode argument because we never create files.
	return dlopen(library, { openat: { args: ["i32", "ptr", "i32"], returns: "i32" } });
}
let posix: ReturnType<typeof loadOpenAt> | undefined;

/** Resolve symlinks once, then walk the canonical path relative to the pinned root with no further symlink traversal. */
export async function openBridgeArtifactSource(cwd: string, roots: readonly BridgeArtifactRoot[], requested: string, excludedRoot?: string) {
	const outside = "The file must resolve inside this worker's workspace or proof folder.";
	const path = await realpath(resolve(cwd, requested)).catch(() => { throw new Error("The requested file does not exist or cannot be resolved."); });
	const root = roots.find(root => root.path !== path && isInsideBridgeRoot(root.path, path));
	if (!root || (excludedRoot && isInsideBridgeRoot(excludedRoot, path))) throw new Error(outside);
	const walk = relative(root.path, path).split(sep);
	// Node does not export O_CLOEXEC. Do not leak a checked descriptor to any subprocess.
	const closeOnExec = process.platform === "darwin" ? 0x1000000 : 0x80000;
	const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | closeOnExec;
	const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExec;
	posix ??= loadOpenAt();
	let fd = openSync(root.path, dirFlags);
	try {
		const identity = fstatSync(fd, { bigint: true });
		if (identity.dev !== root.dev || identity.ino !== root.ino) throw new Error(outside);
		for (const [index, name] of walk.entries()) {
			const next = posix.symbols.openat(fd, ptr(Buffer.from(`${name}\0`)), index < walk.length - 1 ? dirFlags : fileFlags);
			if (next < 0) throw new Error("The requested file is unreadable or changed while it was being opened.");
			closeSync(fd);
			fd = next;
		}
		if (!fstatSync(fd).isFile()) throw new Error("Only regular files can be saved as artifacts.");
		const sourceFd = fd;
		fd = -1;
		return { path, fd: sourceFd, close: () => closeSync(sourceFd) };
	} finally { if (fd >= 0) closeSync(fd); }
}
