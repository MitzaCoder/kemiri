/** Synthetic reproduction for storage changes. Uses only a disposable session DB. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardStorageJobs } from "../src/board-storage-jobs.ts";
import { seedBoardReplay } from "../test/fixtures/board-replay.ts";

const deltas = Number(Bun.argv[2] ?? 2000);
if (!Number.isInteger(deltas) || deltas < 64 || deltas > 3000) throw new Error("Pass a revision count from 64 to 3000");
const root = await mkdtemp(join(tmpdir(), "kemiri-board-bench-"));
const path = join(root, "session.sqlite");
const jobs = new BoardStorageJobs();
try {
	const fixture = { taskCount: 419, closedCount: 280, reportBytes: 1600, deltas };
	const { boardId, board } = await seedBoardReplay(path, fixture);
	console.log(JSON.stringify({ fixture }));
	const expected = Bun.hash(JSON.stringify(board));
	async function measure(label: string) {
		const storage = await openNodeSqliteStorage(path);
		try {
			const start = performance.now();
			const heartbeat = Bun.sleep(20).then(() => Math.round(performance.now() - start));
			const stored = await storage.document(boardId, "current", BACKGROUND_CONTEXT);
			const readMs = Math.round(performance.now() - start);
			const heartbeatMs = await heartbeat;
			if (!stored || Bun.hash(JSON.stringify(stored.value)) !== expected) throw new Error("Stored board differs from fixture");
			console.log(JSON.stringify({ label, readMs, heartbeatMs, deltas: stored.deltasSinceBase, diskBytes: (await stat(path)).size }));
		} finally {
			await storage.close(BACKGROUND_CONTEXT);
		}
	}
	await measure("before");
	const started = performance.now();
	const heartbeat = Bun.sleep(20).then(() => Math.round(performance.now() - started));
	const maintenance = await jobs.maintain(path);
	console.log(JSON.stringify({ label: "maintenance", ms: Math.round(performance.now() - started), heartbeatMs: await heartbeat, ...maintenance }));
	await measure("after");
} finally {
	await jobs.close();
	await rm(root, { recursive: true, force: true });
}
