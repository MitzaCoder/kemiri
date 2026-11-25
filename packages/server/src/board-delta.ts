import type { Board, BoardDeltaEvent, BoardTask } from "@kemiri/protocol";

type BoardChanges = Omit<BoardDeltaEvent, "type" | "projectId" | "baseSequence" | "sequence" | "updatedAt">;

function rowsDelta<Row extends { id: string }>(
	before: readonly Row[], after: readonly Row[], changed = (old: Row, row: Row) => !Bun.deepEquals(old, row),
): { upsert?: Row[]; remove?: string[]; order?: string[] } | undefined {
	if (before === after) return undefined;
	const beforeById = new Map(before.map(row => [row.id, row]));
	const afterIds = new Set(after.map(row => row.id));
	const remove = before.flatMap(row => afterIds.has(row.id) ? [] : [row.id]);
	const upsert = after.filter(row => {
		const old = beforeById.get(row.id);
		return old === undefined || changed(old, row);
	});
	const implicitOrder = [...before.filter(row => afterIds.has(row.id)), ...upsert.filter(row => !beforeById.has(row.id))];
	const reordered = after.some((row, index) => row.id !== implicitOrder[index]?.id);
	if (!upsert.length && !remove.length && !reordered) return undefined;
	return {
		...(upsert.length ? { upsert } : {}),
		...(remove.length ? { remove } : {}),
		...(reordered ? { order: after.map(row => row.id) } : {}),
	};
}

export function boardChanges(before: Board, after: Board): BoardChanges | undefined {
	const taskLive: NonNullable<BoardDeltaEvent["taskLive"]> = [];
	const tasks = rowsDelta(before.tasks, after.tasks, (old: BoardTask, row: BoardTask) => {
		if (Bun.deepEquals(old, row)) return false;
		const { live: oldLive, ...oldTask } = old;
		const { live, ...task } = row;
		if (!oldLive || !live || !Bun.deepEquals(oldTask, task)) return true;
		const { lines, ...metadata } = live;
		const lineChanges = rowsDelta(oldLive.lines, lines);
		taskLive.push({ taskId: row.id, ...metadata, ...(lineChanges ? { lines: lineChanges } : {}) });
		return false;
	});
	const questions = rowsDelta(before.questions, after.questions);
	const decisions = rowsDelta(before.decisions, after.decisions);
	const archivedLinks = rowsDelta(before.archivedLinks ?? [], after.archivedLinks ?? []);
	if (!tasks && !questions && !decisions && !archivedLinks && !taskLive.length && before.updatedAt === after.updatedAt) return undefined;
	return {
		...(tasks ? { tasks } : {}),
		...(questions ? { questions } : {}),
		...(decisions ? { decisions } : {}),
		...(archivedLinks ? { archivedLinks } : {}),
		...(taskLive.length ? { taskLive } : {}),
	};
}
