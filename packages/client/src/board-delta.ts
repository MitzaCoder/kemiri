import type { Board, BoardDeltaEvent } from "@kemiri/protocol";

type RowsDelta<Row> = { upsert?: Row[]; remove?: string[]; order?: string[] };

function applyRowsDelta<Row extends { id: string }>(rows: Row[], delta: RowsDelta<Row> | undefined): Row[] {
	if (!delta) return rows;
	const byId = new Map(rows.map(row => [row.id, row]));
	for (const id of delta.remove ?? []) byId.delete(id);
	for (const row of delta.upsert ?? []) byId.set(row.id, row);
	return delta.order ? delta.order.map(id => byId.get(id)!) : [...byId.values()];
}

export function applyBoardDelta(before: Board, delta: BoardDeltaEvent): Board | undefined {
	let tasks = applyRowsDelta(before.tasks, delta.tasks);
	if (delta.taskLive) {
		const liveByTask = new Map(delta.taskLive.map(({ taskId, ...live }) => [taskId, live]));
		tasks = tasks.map(task => {
			const changes = liveByTask.get(task.id);
			if (!changes || !task.live) return task;
			liveByTask.delete(task.id);
			const { lines, ...metadata } = changes;
			return { ...task, live: { ...metadata, lines: applyRowsDelta(task.live.lines, lines) } };
		});
		if (liveByTask.size) return undefined;
	}
	const archivedLinks = applyRowsDelta(before.archivedLinks ?? [], delta.archivedLinks);
	return {
		tasks,
		questions: applyRowsDelta(before.questions, delta.questions),
		decisions: applyRowsDelta(before.decisions, delta.decisions),
		...(archivedLinks.length ? { archivedLinks } : {}),
		updatedAt: delta.updatedAt,
	};
}
