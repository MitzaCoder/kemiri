import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type Storage } from "@earendil-works/pi-durable";
import type {
	Artifact, ArtifactComment, ArtifactsLibraryRequest, ArtifactsLibraryResponse,
	ArtifactsTrailResponse, ArtifactTaskFacts,
} from "@kemiri/protocol";
import { existsSync } from "node:fs";
import { type ArtifactStore, withVersions } from "./artifacts.ts";
import { isArchivedAt, type BoardState, type TaskHistoryState } from "./board.ts";
import type { ProjectStore } from "./projects.ts";
import { openStorageReadOnly } from "./request-backfill.ts";
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

function artifactTaskIds(artifact: Artifact): string[] {
	return [...(artifact.taskId === null ? [] : [artifact.taskId]), ...(artifact.laterTaskIds ?? [])];
}

function taskFacts(projectId: string, task: BoardState["tasks"][number], now: number): ArtifactTaskFacts {
	return {
		projectId, id: task.id, title: task.title, status: task.status,
		archived: task.archived === true || isArchivedAt(task, now), settledAt: task.settledAt ?? null,
		...(task.report?.summary ? { summary: task.report.summary } : {}),
	};
}

export async function artifactLibrary(
	projects: ProjectStore, store: ArtifactStore, request: ArtifactsLibraryRequest, now: number,
): Promise<Omit<ArtifactsLibraryResponse, "id" | "type">> {
	const selected = request.projectIds === undefined ? undefined : new Set(request.projectIds);
	const matchingProjects = (await projects.list()).filter((project) => selected === undefined || selected.has(project.id));
	const rows = (await Promise.all(matchingProjects.map((project) => store.libraryRows(project.id)))).flat();
	const before = request.before;
	const matching = rows.filter((row) => before === undefined || Date.parse(row.createdAt) < Date.parse(before))
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.projectId.localeCompare(right.projectId) || right.id.localeCompare(left.id));
	let end = Math.min(request.limit ?? 300, matching.length);
	// Timestamp-only cursors cannot split same-millisecond saves without dropping rows.
	while (end < matching.length && matching[end - 1]!.createdAt === matching[end]!.createdAt) end++;
	const artifacts = matching.slice(0, end).map(withVersions);
	const pageTaskIds = new Map<string, Set<string>>();
	for (const artifact of artifacts) {
		const ids = pageTaskIds.get(artifact.projectId) ?? new Set<string>();
		for (const id of artifactTaskIds(artifact)) ids.add(id);
		pageTaskIds.set(artifact.projectId, ids);
	}
	const pageProjects = matchingProjects.filter((project) => pageTaskIds.has(project.id));
	const tasks = (await Promise.all(pageProjects.map(async (project) => {
		const ids = pageTaskIds.get(project.id)!;
		return ids.size === 0 ? [] : readBoard(projects.sessionPath(project.id), (board) => (board?.tasks ?? [])
			.filter((task) => ids.has(task.id)).map((task) => taskFacts(project.id, task, now)));
	}))).flat();
	return {
		artifacts, tasks,
		projects: pageProjects.map(({ id, name, archived }) => ({ id, name, archived: archived === true })),
		nextBefore: end < matching.length ? artifacts.at(-1)!.createdAt : null,
	};
}

export async function artifactTrail(
	projects: ProjectStore, store: ArtifactStore, projectId: string, artifactId: string, now: number,
): Promise<Omit<ArtifactsTrailResponse, "id" | "type">> {
	await projects.require(projectId);
	const artifact = await store.require(projectId, artifactId.replace(/~[1-9]\d*$/, ""));
	const rootId = artifact.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const reference = new RegExp(`\\(artifact ${rootId}(?:~([1-9]\\d*))?(?![a-zA-Z0-9~-])`);
	return readBoard(projects.sessionPath(projectId), async (board, storage) => {
		if (board === undefined || storage === undefined) return { artifact, tasks: [], comments: [] };
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
		return { artifact, tasks, comments };
	});
}
