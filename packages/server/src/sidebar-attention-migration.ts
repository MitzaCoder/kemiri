import { stateKind } from "./state-identity.ts";
/** One-time upgrade of pre-attention projects, before the server accepts connections. No Harness or agent starts. */
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { boardView, type BoardState } from "./board.ts";
import { workerSummary, type WorkersState } from "./workers.ts";
import { isThreadArchived, type StoredThreadsState } from "./threads.ts";
import { actionableFailures, boardAttention, projectFailureAttention, EMPTY_ATTENTION } from "./sidebar-attention.ts";
import { MAIN_THREAD_ID, type ProjectAttention, type ProjectActivity } from "@kemiri/protocol";

export async function readStoredAttention(file: string, now = Date.now(), activity?: ProjectActivity): Promise<ProjectAttention> {
	if (!(await Bun.file(file).exists())) return { ...EMPTY_ATTENTION };
	const storage = await openNodeSqliteStorage(file);
	try {
		const conversations = await storage.scanConversations({ order: "ascending" }, 1, undefined, BACKGROUND_CONTEXT);
		const main = conversations.items[0];
		if (main === undefined) return { ...EMPTY_ATTENTION };
		async function doc<T>(conversationId: ConversationId, kind: string): Promise<T | undefined> {
			const record = await storage.findDocument({ kind, scope: { kind: "conversation", conversationId } }, "current", BACKGROUND_CONTEXT);
			return record === undefined ? undefined : (await storage.document(record.id, "current", BACKGROUND_CONTEXT))?.value as T | undefined;
		}
		const board = await doc<BoardState>(main.id, stateKind("board"));
		const view = board === undefined ? undefined : boardView(board, now, false);
		const state = await doc<StoredThreadsState>(main.id, stateKind("threads"));
		const threads = Object.values(state?.threads ?? {});
		const workers = [];
		for (const thread of [{ id: MAIN_THREAD_ID, conversationId: main.id }, ...threads]) {
			const stored = await doc<WorkersState>(thread.conversationId as ConversationId, stateKind("workers"));
			workers.push(...Object.values(stored?.workers ?? {}).map(worker => workerSummary(worker, thread.id)));
		}
		const failureThreads = threads.map(thread => ({ ...thread, archived: isThreadArchived(thread, now),
			updatedAt: thread.failureEntryId === undefined ? thread.updatedAt : String(thread.failureEntryId) }));
		const mainFailure = activity?.coordinator === "failed" && activity.failureEntryId !== undefined ? [{
			id: MAIN_THREAD_ID, title: state?.main?.title ?? "General", conversationId: main.id as number,
			status: "failed" as const, kind: "coordinator" as const, archived: false, updatedAt: String(activity.failureEntryId),
		}] : [];
		return {
			...EMPTY_ATTENTION,
			...(view === undefined ? {} : boardAttention(view)),
			...projectFailureAttention(workers, actionableFailures(view?.tasks ?? [], workers, [...failureThreads, ...mainFailure], state?.acknowledgedFailures)),
			runningWorkers: 0, // Never trust an in-flight status left by a dead process.
		};
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
}
