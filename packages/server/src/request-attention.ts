import type { BoardQuestion, BoardTask, BoardTaskState } from "@kemiri/protocol";

/** Follow only required-part links. Broken or cyclic ancestry has no request. */
export function topRequest<Task extends Pick<BoardTask, "id" | "parent">>(task: Task, tasksById: ReadonlyMap<string, Task>): Task | undefined {
	const visited = new Set<string>();
	let current: Task | undefined = task;
	while (current && !visited.has(current.id)) {
		if (current.parent == null) return current;
		visited.add(current.id);
		current = tasksById.get(current.parent);
	}
	return undefined;
}

type RequestNeed = { rank: number; task: BoardTask; state: BoardTaskState };
const closed = (task: BoardTask) => task.status === "done" || task.status === "dropped";

/** Lift only owner attention. Parts still use their own activity, blocking and pause rules. */
export function requestAttention(tasks: readonly BoardTask[], questions: readonly BoardQuestion[]) {
	const tasksById = new Map(tasks.map(task => [task.id, task]));
	const requestsByPart = new Map<string, BoardTask>();
	const needsByRequest = new Map<string, RequestNeed>();
	const ownerQuestions = new Map<string, BoardQuestion[]>();
	for (const question of questions) {
		if (question.taskId == null || question.status !== "open" || question.waitingOn === "agent") continue;
		const onTask = ownerQuestions.get(question.taskId) ?? [];
		onTask.push(question);
		ownerQuestions.set(question.taskId, onTask);
	}
	for (const task of tasks) {
		const request = task.parent == null ? task : topRequest(task, tasksById);
		if (!request) continue;
		if (task !== request) requestsByPart.set(task.id, request);
		if (closed(request) || request.archived) continue;
		const need = taskNeed(task, ownerQuestions.get(task.id) ?? [], !request.state?.liveWorkSince);
		if (!need) continue;
		const previous = needsByRequest.get(request.id);
		if (!previous || need.rank > previous.rank || (need.rank === previous.rank && (
			task === request || (previous.task !== request && need.state.since < previous.state.since)
		))) needsByRequest.set(request.id, need);
	}
	return { requestsByPart, needsByRequest };
}

function taskNeed(task: BoardTask, questions: readonly BoardQuestion[], includeSteps: boolean): RequestNeed | undefined {
	const state = task.state;
	if (!closed(task) && !task.archived) {
		if (state?.kind === "failed") return { rank: 5, task, state };
		if (state?.kind === "answer_needed") return { rank: 4, task, state };
		if (includeSteps && state?.kind === "steps_needed") return { rank: 3, task, state };
	}
	if (state && questions.length) {
		const ordered = [...questions].sort((a, b) => a.askedAt.localeCompare(b.askedAt) || a.id.localeCompare(b.id));
		const blocking = ordered.filter(question => question.blocksWork ?? question.kind !== "warning");
		const needed = blocking.length ? blocking : ordered;
		const first = needed[0]!;
		const refs = needed.map(question => question.id);
		const since = first.askedAt;
		const text = `${first.kind === "warning" ? "Warning" : "Answer needed"}: ${first.text.replace(/\s+/g, " ").trim().slice(0, 160)}${needed.length > 1 ? ` and ${needed.length - 1} more` : ""}`;
		return { rank: blocking.length ? 4 : 2, task, state: { kind: "answer_needed", group: "needs_you", since, refs, sentence: { kind: "question", since, refs, text, ageFormat: "none" } } };
	}
	if (task.parent == null && (state ? state.kind === "review" : task.status === "review")) {
		return { rank: 1, task, state: state ?? { kind: "review", group: "needs_you", since: task.updatedAt, refs: [] } };
	}
	return undefined;
}
