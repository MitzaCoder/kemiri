import type { BoardAuthor, BoardTask, BoardTaskState, PartsDigest } from "@kemiri/protocol";

type PartLink = Pick<BoardTask, "id" | "parent" | "order">;
type PartState = BoardTaskState["kind"];

export function compareBoardTaskOrder(left: Pick<PartLink, "order" | "id">, right: Pick<PartLink, "order" | "id">): number {
	return left.order - right.order || Number(left.id.slice(1)) - Number(right.id.slice(1));
}

/** Depth-first so nested parts stay underneath their own direct part. */
export function* orderedDescendantIds(requestId: string, children: ReadonlyMap<string, readonly string[]>): Iterable<string> {
	const pending = [...(children.get(requestId) ?? [])].reverse();
	while (pending.length) {
		const partId = pending.pop()!;
		yield partId;
		const nested = children.get(partId) ?? [];
		for (let index = nested.length - 1; index >= 0; index--) pending.push(nested[index]!);
	}
}

/** For on-demand evidence reads, without deriving a board view or loading task histories. */
export function requestPartIds(tasks: readonly PartLink[], taskId: string): string[] {
	const request = tasks.find(task => task.id === taskId);
	if (!request || request.parent != null) return [];
	const children = new Map<string, string[]>();
	for (const task of [...tasks].sort(compareBoardTaskOrder)) {
		if (task.parent == null) continue;
		const siblings = children.get(task.parent);
		if (siblings) siblings.push(task.id);
		else children.set(task.parent, [task.id]);
	}
	return [...orderedDescendantIds(taskId, children)];
}

export function partProgress(states: readonly PartState[]): Omit<PartsDigest, "parts"> {
	let total = 0, done = 0, working = 0, needsOwner = 0;
	for (const kind of states) {
		if (kind === "dropped") continue;
		total++;
		if (kind === "done") done++;
		if (kind === "working") working++;
		if (kind === "failed" || kind === "answer_needed" || kind === "steps_needed" || kind === "review") needsOwner++;
	}
	return { total, done, working, needsOwner };
}

const firstLine = (text: string | undefined) => text?.trim().split(/[\r\n\u2028\u2029]/, 1)[0]?.trim() ?? "";
const dropLineText = (text: string) => text.replace(/\s+/g, " ").trim();

export function digestPart(task: BoardTask, state: PartState, closedBy: BoardAuthor | undefined, dropReason: string | undefined): PartsDigest["parts"][number] {
	const report = task.report;
	const checks = report?.checks ?? [];
	const passed = checks.filter(check => check.result === "passed").length;
	return {
		id: task.id, parentId: task.parent!, title: task.title, state,
		summary: firstLine(report?.summary) || firstLine(report?.results).replace(/^(?:[-*+] |\d+[.)] )/, "").trim(),
		checks: { passed, failed: checks.length - passed, total: checks.length },
		notDoneCount: report?.blocks?.notDone?.length ?? (report?.notDone?.split(/[\r\n\u2028\u2029]+/).filter(line => line.trim()).length ?? 0),
		...(task.settledAt ? { closedAt: task.settledAt } : {}),
		...(closedBy === undefined ? {} : { closedBy }),
		...(dropReason === undefined ? {} : { dropReason }),
	};
}

export function droppedPartLines(parts: readonly PartsDigest["parts"][number][]): NonNullable<BoardTask["derivedNotDone"]> {
	return parts.filter(part => part.state === "dropped").map(part => ({
		partId: part.id,
		text: `${dropLineText(part.title)} was dropped: ${part.dropReason ? dropLineText(part.dropReason) : "No reason recorded."}`,
	}));
}
