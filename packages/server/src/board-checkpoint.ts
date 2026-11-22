import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { apply, type Op } from "@earendil-works/chord/delta";
import { ROOT_CONVERSATION_ID, type JsonObject } from "@earendil-works/pi-durable";
import { SqliteStorage, type SqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { MAX_BOARD_DELTAS } from "./board-checkpoint-policy.ts";
import { serverSettings } from "./server-settings.ts";
import { stateKind } from "./state-identity.ts";

const BOARD_DELTA_READS_PER_PAGE = 16;
const MAX_BOARD_DELTA_BYTES = 32 * 2 ** 20;
const MIN_RECLAIM_BYTES = 128 * 2 ** 20;

export type BoardMaintenance = { removedDeltas: number; reclaimedBytes: number; vacuumDeferred?: string };

/** Reserve enough for SQLite's temporary copy plus the rollback journal or WAL. */
export function hasVacuumSpace(availableBytes: bigint, databaseBytes: bigint): boolean {
	return availableBytes >= 2n * databaseBytes + BigInt(MIN_RECLAIM_BYTES);
}

/** Read the same pi-durable SQLite revision chain in pages, not one multi-gigabyte result set. */
async function readOversizedBoard(database: SqliteDatabase, documentId: number) {
	return database.transaction(async (tx) => {
		const position = await tx.get<{ seq: number; version: number }>(
			"SELECT seq, version FROM document_revisions WHERE document_id = ? AND kind = 'base' ORDER BY seq DESC LIMIT 1",
			documentId,
		);
		if (!position) throw new Error("Board is missing its stored base");
		const largeTail = await tx.get<{ seq: number }>(
			"SELECT seq FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq LIMIT 1 OFFSET ?",
			documentId, position.seq, MAX_BOARD_DELTAS - 1,
		);
		if (!largeTail) {
			const tail = await tx.get<{ bytes: number }>(
				"SELECT coalesce(sum(length(CAST(content AS BLOB))), 0) AS bytes FROM document_revisions WHERE document_id = ? AND seq > ?",
				documentId, position.seq,
			);
			if (!tail || tail.bytes < MAX_BOARD_DELTA_BYTES) return;
		}
		const base = await tx.get<{ content: string }>(
			"SELECT content FROM document_revisions WHERE document_id = ? AND seq = ?", documentId, position.seq,
		);
		if (!base) throw new Error("Board is missing its stored base content");
		let value = JSON.parse(base.content) as JsonObject;
		let cursor = position.seq;
		let deltas = 0;
		for (;;) {
			const page = await tx.all<{ seq: number; version: number; kind: string; content: string }>(
				"SELECT seq, version, kind, content FROM document_revisions WHERE document_id = ? AND seq > ? ORDER BY seq LIMIT ?",
				documentId, cursor, BOARD_DELTA_READS_PER_PAGE,
			);
			for (const revision of page) {
				if (revision.kind !== "delta" || revision.version !== position.version) throw new Error("Invalid board revision chain");
				value = apply(value, JSON.parse(revision.content) as Op[]);
				cursor = revision.seq;
				deltas++;
			}
			if (page.length < BOARD_DELTA_READS_PER_PAGE) return { value, version: position.version, deltas };
		}
	});
}

/** Run before the project's Harness opens. The manager gives this job exclusive write access to the session store. */
export async function maintainBoardStorage(path: string, minimumReclaimBytes = MIN_RECLAIM_BYTES): Promise<BoardMaintenance> {
	const result: BoardMaintenance = { removedDeltas: 0, reclaimedBytes: 0 };
	const database = await openNodeSqliteDatabase(path);
	try {
		const storage = await SqliteStorage.open(database);
		const board = await storage.findDocument({ kind: stateKind("board"), scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID } }, "current", BACKGROUND_CONTEXT);
		if (!board || board.scope.kind !== "conversation" || board.history !== "latest") return result;
		const oversized = await readOversizedBoard(database, board.id);
		if (oversized) {
			// The storage API atomically saves the same value and version, deletes the latest-only tail, and advances
			// metadata. The previous release reads this base unchanged. No other documents are pruned.
			const receipt = await storage.commit([[{
				type: "document.change", id: board.id,
				content: { kind: "base", version: oversized.version, value: oversized.value },
			}]], () => {}, BACKGROUND_CONTEXT);
			if (receipt.stored !== 1) throw receipt.refused ?? new Error("Board checkpoint was not stored");
			result.removedDeltas = oversized.deltas;
		}
		// SQLite reuses freed pages but does not release their disk space automatically. Checking the freelist also
		// retries a vacuum skipped for low disk or interrupted by shutdown, even if the board is already checkpointed.
		const pageSize = (await database.get<{ page_size: number }>("PRAGMA page_size"))!.page_size;
		const freePages = (await database.get<{ freelist_count: number }>("PRAGMA freelist_count"))!.freelist_count;
		if (freePages * pageSize < minimumReclaimBytes || freePages === 0) return result;
		try {
			const before = (await database.get<{ page_count: number }>("PRAGMA page_count"))!.page_count;
			const databaseBytes = BigInt(before) * BigInt(pageSize);
			const [fs, tempFs] = await Promise.all([statfs(path, { bigint: true }),
				statfs(serverSettings.SQLITE_TMPDIR || tmpdir(), { bigint: true })]);
			if (!hasVacuumSpace(fs.bavail * fs.bsize, databaseBytes) || tempFs.bavail * tempFs.bsize < databaseBytes) {
				result.vacuumDeferred = "not enough free disk space for SQLite VACUUM";
				return result;
			}
			await database.exec("VACUUM");
			const after = (await database.get<{ page_count: number }>("PRAGMA page_count"))!.page_count;
			const wal = await database.get<{ busy: number }>("PRAGMA wal_checkpoint(TRUNCATE)");
			if (wal?.busy) result.vacuumDeferred = "the compacted database is waiting for a WAL checkpoint";
			result.reclaimedBytes = Math.max(0, before - after) * pageSize;
		} catch (error) {
			// A refused VACUUM is atomic; the smaller replay chain is already durable.
			result.vacuumDeferred = error instanceof Error ? error.message : String(error);
		}
		return result;
	} finally {
		await database.close();
	}
}
