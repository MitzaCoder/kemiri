import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type DocumentId, type StorageWrite } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { BoardDoc, emptyBoardState, normalizeBoard, saveTask } from "../../src/board.ts";

const START = "2026-01-01T00:00:00.000Z";
const OTHER_KIND = "fixture.task-history";

export function syntheticBoard(taskCount: number, closedCount: number, reportBytes: number) {
	const board = emptyBoardState();
	for (let index = 0; index < taskCount; index++) {
		saveTask(board, { author: "user", now: START, task: {
			title: `Synthetic project task ${index + 1}`, status: index < closedCount ? "done" : "todo",
			description: "A task in the synthetic print shop.", acceptance: null, blockedBy: [], blockedReason: null, writeScopes: [],
		} });
		board.tasks[index]!.report.results = "The revised guide is ready for printing. ".repeat(Math.ceil(reportBytes / 40)).slice(0, reportBytes);
	}
	return normalizeBoard(board);
}

export async function seedBoardReplay(path: string, options: { taskCount: number; closedCount: number; reportBytes: number; deltas: number }) {
	const board = syntheticBoard(options.taskCount, options.closedCount, options.reportBytes);
	const storage = await openNodeSqliteStorage(path);
	const boardId = await storage.mintId<DocumentId>();
	const otherId = await storage.mintId<DocumentId>();
	const scope = { kind: "conversation", conversationId: ROOT_CONVERSATION_ID } as const;
	const closedTasks = board.tasks.slice(0, options.closedCount);
	async function commit(batches: StorageWrite[][]) {
		const receipt = await storage.commit(batches, () => {}, BACKGROUND_CONTEXT);
		if (receipt.stored !== batches.length) throw receipt.refused ?? new Error("Could not seed board revisions");
	}
	try {
		await commit([[
			{ type: "conversation", value: { id: ROOT_CONVERSATION_ID } },
			{ type: "document.create", record: { id: boardId, kind: BoardDoc.definition.kind, scope, history: "latest", fork: "initial" },
				content: { kind: "base", version: 1, value: board } },
			{ type: "document.create", record: { id: otherId, kind: OTHER_KIND, scope, history: "rewindable", fork: "asOf" },
				content: { kind: "base", version: 1, value: { feedback: "Keep this history" } } },
		]]);
		for (let index = 0; index < options.deltas;) {
			const batches: StorageWrite[][] = [];
			while (batches.length < 8 && index < options.deltas) {
				const updatedAt = new Date(Date.parse(START) + ++index * 1000).toISOString();
				batches.push([{ type: "document.change", id: boardId,
					content: { kind: "delta", version: 1, ops: [["p", ["tasks"], 0, options.closedCount, closedTasks], ["s", ["updatedAt"], updatedAt]] } }]);
			}
			await commit(batches);
		}
		board.updatedAt = new Date(Date.parse(START) + options.deltas * 1000).toISOString();
		return { boardId, otherId, board };
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
}
