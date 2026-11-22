import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { track } from "@earendil-works/chord/delta";
import { defineDoc, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BoardDoc, type BoardState, normalizeBoard, openBoard } from "../src/board.ts";
import { MAX_BOARD_DELTAS } from "../src/board-checkpoint-policy.ts";
import { hasVacuumSpace, maintainBoardStorage } from "../src/board-checkpoint.ts";
import { seedBoardReplay, syntheticBoard } from "./fixtures/board-replay.ts";
import { createSetup } from "./support.ts";

const fixtureOptions = { taskCount: 30, closedCount: 20, reportBytes: 300, deltas: MAX_BOARD_DELTAS + 9 };

function boardRevisions(path: string): number {
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return Number(db.prepare(`SELECT count(*) AS n FROM document_revisions r JOIN documents d ON d.id=r.document_id WHERE d.kind=?`).get(JSON.stringify(BoardDoc.definition.kind))?.n);
	} finally {
		db.close();
	}
}

test("only a real legacy normalization change makes patches, including for closed tasks and a quiet outbox", () => {
	const board = syntheticBoard(12, 8, 80);
	const closed = board.tasks[0]!;
	closed.status = "dropped";
	closed.report.freshness!.results.stale = true;
	closed.report.freshness!.results.reasons = ["legacy stale reason"];
	board.reportTracking![closed.id]!.invalidated.results = { seq: 2, reason: "legacy" };
	board.reportOutbox = [
		{ key: "old", owner: "main", content: "Recheck", admissions: [{ taskId: closed.id, burst: 1, sections: {} }] },
		{ key: "keep", owner: "main", content: "Review", admissions: [{ taskId: board.tasks[11]!.id, burst: 2, sections: {} }] },
	];
	const tracker = track(board);
	const legacy = tracker.beginChange();
	normalizeBoard(legacy.state);
	const cleaned = legacy.prepare();
	expect(cleaned.ops.length).toBeGreaterThan(0);
	expect(cleaned.value.reportOutbox?.map(batch => batch.key)).toEqual(["keep"]);
	expect(cleaned.value.tasks[0]?.report.freshness?.results).toMatchObject({ stale: false, reasons: [] });
	tracker.adopt(cleaned);
	for (let repeat = 0; repeat < 2; repeat++) {
		const unchanged = tracker.beginChange();
		normalizeBoard(unchanged.state);
		expect(unchanged.prepare().ops).toEqual([]);
		unchanged.abort();
	}
});

test("checkpoint shrinks the database and leaves the board and unrelated history readable by the old storage", async () => {
	const root = await mkdtemp(join(tmpdir(), "board-checkpoint-"));
	const path = join(root, "session.sqlite");
	try {
		const { boardId, otherId, board } = await seedBoardReplay(path, fixtureOptions);
		const before = (await stat(path)).size;
		expect(boardRevisions(path)).toBe(fixtureOptions.deltas + 1);
		const result = await maintainBoardStorage(path, 1);
		expect(result.removedDeltas).toBe(fixtureOptions.deltas);
		expect(result.reclaimedBytes).toBeGreaterThan(0);
		expect(result.vacuumDeferred).toBeUndefined();
		expect((await stat(path)).size).toBeLessThan(before / 2);
		expect(boardRevisions(path)).toBe(1);
		expect(await maintainBoardStorage(path, 1)).toEqual({ removedDeltas: 0, reclaimedBytes: 0 });
		const storage = await openNodeSqliteStorage(path);
		try {
			expect(await storage.document(boardId, "current", BACKGROUND_CONTEXT)).toMatchObject({ version: 1, deltasSinceBase: 0, value: board });
			expect(await storage.document(otherId, "current", BACKGROUND_CONTEXT)).toMatchObject({ version: 1, value: { feedback: "Keep this history" } });
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("server startup checkpoints unopened boards and live writes bound the next replay tail", async () => {
	const setup = await createSetup({ terminals: false, now: () => Date.parse("2026-01-01T00:03:00Z") });
	const project = await setup.server.manager.store.add(setup.projectDir);
	const path = setup.server.manager.store.sessionPath(project.id);
	await mkdir(join(path, ".."), { recursive: true });
	const { boardId, board } = await seedBoardReplay(path, fixtureOptions);
	const server = await setup.restart();
	for (let attempt = 0; attempt < 80 && boardRevisions(path) !== 1; attempt++) await Bun.sleep(20);
	expect(boardRevisions(path)).toBe(1);
	const { runtime } = await server.manager.open(project.id);
	const oldBoardDoc = defineDoc<BoardState>({ ...BoardDoc.definition, scope: "conversation", history: "latest", fork: "initial", checkpointWhen: () => false });
	const reopened = await runtime.harness.snapshot(oldBoardDoc, ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT);
	expect(reopened?.tasks).toEqual(board.tasks);
	const countBefore = boardRevisions(path);
	await runtime.harness.commit(async tx => { await openBoard(tx, ROOT_CONVERSATION_ID); }, BACKGROUND_CONTEXT);
	expect(boardRevisions(path)).toBe(countBefore);
	for (let revision = 1; revision <= MAX_BOARD_DELTAS + 3; revision++) {
		await runtime.harness.commit(async tx => {
			const state = await tx.doc(BoardDoc, ROOT_CONVERSATION_ID);
			state.tasks[0]!.title = `Updated title ${revision}`;
		}, BACKGROUND_CONTEXT);
	}
	expect(boardRevisions(path)).toBeLessThan(MAX_BOARD_DELTAS);
	const storage = await openNodeSqliteStorage(path);
	try {
		expect(await storage.document(boardId, "current", BACKGROUND_CONTEXT)).toMatchObject({
			version: 1, value: { tasks: expect.arrayContaining([expect.objectContaining({ title: `Updated title ${MAX_BOARD_DELTAS + 3}` })]) },
		});
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
});

test("vacuum refuses to use the disk reserve if two database copies no longer fit", () => {
	const database = 3n * 2n ** 30n;
	expect(hasVacuumSpace(2n * database, database)).toBe(false);
	expect(hasVacuumSpace(2n * database + 128n * 2n ** 20n, database)).toBe(true);
});
