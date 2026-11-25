import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type Storage } from "@earendil-works/pi-durable";
import type {
	Artifact, ArtifactComment,
	ArtifactsTrailResponse, ArtifactTaskFacts,
} from "@kemiri/protocol";
import { existsSync } from "node:fs";
import { boardView, isArchivedAt, type BoardState, type TaskHistoryState } from "./board.ts";
import { openStorageReadOnly } from "./request-backfill.ts";
import { requestPartIds } from "./request-digest.ts";
import { stateKind } from "./state-identity.ts";

const scope = { kind: "conversation", conversationId: ROOT_CONVERSATION_ID } as const;

async function readBoard<T>(path: string, read: (board: BoardState | undefined, storage?: Storage) => T | Promise<T>): Promise<T> {
	// Browsing files must not open a Harness or resume archived project work.
	if (!existsSync(path)) return read(undefined);
	const storage = await openStorageReadOnly(path);
	try {
		return await read(await readDocument<BoardState>(storage, stateKind("board")), storage);
	} finally {
		await storage.close(BACKGROUND_CONTEXT);
	}
}

async function readDocument<T>(storage: Storage, kind: string, key?: string): Promise<T | undefined> {
	const record = await storage.findDocument({ scope, kind, ...(key === undefined ? {} : { key }) }, "current", BACKGROUND_CONTEXT);
	return record === undefined ? undefined : (await storage.document(record.id, "current", BACKGROUND_CONTEXT))?.value as T | undefined;
}

export function readRequestPartIds(path: string, taskId: string): Promise<string[]> {
	return readBoard(path, board => requestPartIds(board?.tasks ?? [], taskId));
}

export function artifactTaskIds(artifact: Artifact): string[] {
	return [...(artifact.taskId === null ? [] : [artifact.taskId]), ...(artifact.laterTaskIds ?? [])];
}

function taskFacts(projectId: string, task: BoardState["tasks"][number], now: number): ArtifactTaskFacts {
	return {
		projectId, id: task.id, title: task.title, status: task.status,
		...(task.state ? { state: task.state } : {}),
		archived: task.archived === true || isArchivedAt(task, now), settledAt: task.settledAt ?? null,
		...(task.report?.summary ? { summary: task.report.summary } : {}),
	};
}

export function artifactBoardFacts(board: Readonly<BoardState> | undefined, projectId: string, ids: ReadonlySet<string>, now: number): ArtifactTaskFacts[] {
	return (board ? boardView(board, now, true, undefined, true).tasks : []).filter(task => ids.has(task.id)).map(task => taskFacts(projectId, task, now));
}

export function readArtifactBoardFacts(path: string, projectId: string, ids: readonly string[], now: number): Promise<ArtifactTaskFacts[]> {
	return readBoard(path, board => artifactBoardFacts(board, projectId, new Set(ids), now));
}

export async function readArtifactTrail(path: string, projectId: string, artifact: Artifact, now: number): Promise<Omit<ArtifactsTrailResponse, "id" | "type" | "artifact">> {
	const rootId = artifact.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const reference = new RegExp(`\\(artifact ${rootId}(?:~([1-9]\\d*))?(?![a-zA-Z0-9~-])`);
	return readBoard(path, async (board, storage) => {
		if (board === undefined || storage === undefined) return { tasks: [], comments: [] };
		const taskById = new Map(board.tasks.map((task) => [task.id, task]));
		const tasks = artifactTaskIds(artifact).flatMap((id) => {
			const task = taskById.get(id);
			return task === undefined ? [] : [{
				...taskFacts(projectId, task, now),
				decisions: board.decisions.filter((decision) => decision.taskId === id)
					.map(({ id, text, why, at }) => ({ id, text, why, at }))
					.sort((left, right) => right.at.localeCompare(left.at)),
			}];
		});
		const comments: ArtifactComment[] = [];
		// Histories are stored separately from the board, including feedback on unrelated tasks.
		for (const task of board.tasks) {
			const history = await readDocument<TaskHistoryState>(storage, stateKind("board-history"), task.id);
			for (const { id, text, at, state, note } of history?.feedback ?? []) {
				const match = reference.exec(text);
				if (match === null) continue;
				const version = Number(match[1]);
				comments.push({ taskId: task.id, feedbackId: id, version: Number.isSafeInteger(version) ? version : null, text, at, state, note });
			}
		}
		comments.sort((left, right) => left.at.localeCompare(right.at));
		return { tasks, comments };
	});
}
