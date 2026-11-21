import { MAIN_THREAD_ID, type CodeRoot } from "@kemiri/protocol";
import { lstat, realpath, stat } from "node:fs/promises";
import { sameInode } from "./code-path.ts";
import { ServerError } from "./errors.ts";
import type { ProjectManager } from "./runtime.ts";

/** Resolve only server-owned checkout records. Never revive a removed checkout or accept a client path. */
export async function resolveCodeRoot(manager: Pick<ProjectManager, "store" | "open">, projectId: string, root: CodeRoot): Promise<string> {
	let checkout: string | null | undefined;
	if (root.kind === "project") {
		checkout = (await manager.store.require(projectId)).path;
	} else {
		const { runtime } = await manager.open(projectId);
		if (root.kind === "worker") {
			const { workers } = await runtime.workers.list();
			const matches = workers.filter(worker => worker.id === root.workerId);
			// IDs are coordinator-local. Do not silently choose a checkout if two threads used the same ID.
			if (matches.length === 1 && matches[0]?.isolation === "workspace") checkout = matches[0].workspacePath;
		} else if (root.threadId !== MAIN_THREAD_ID) {
			checkout = (await runtime.threads.record(root.threadId))?.checkout;
		}
	}
	if (checkout) {
		const recorded = await lstat(checkout).catch(() => undefined);
		if (recorded?.isDirectory()) {
			const resolved = await realpath(checkout).catch(() => undefined);
			const canonical = resolved && await stat(resolved).catch(() => undefined);
			if (resolved && canonical && sameInode(recorded, canonical)) return resolved;
		}
	}
	throw new ServerError("not_found", "No checkout for this code root");
}
