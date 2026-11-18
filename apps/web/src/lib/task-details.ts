import type { BoardQuestion, BoardTask } from '@kemiri/protocol';
import { isSettled, isWarning, waitingOn } from './tasks.js';

export function taskNeedsYou(task: Pick<BoardTask, 'id' | 'status' | 'blockedReason'> & { report?: Pick<BoardTask['report'], 'steps'> }, questions: readonly BoardQuestion[], hasBlockers: boolean, stepsSupported: boolean) {
	const open = waitingOn(questions, task.id);
	const ownerQuestions = open.filter(question => question.waitingOn !== 'agent');
	const questionsForAgent = open.filter(question => question.waitingOn === 'agent');
	const review = task.status === 'review';
	const blocked = task.status === 'blocked' && (Boolean(task.blockedReason?.trim()) || hasBlockers);
	const steps = stepsSupported && !isSettled(task.status) ? task.report?.steps : undefined;
	const stepsMarkdown = steps?.trim() ? steps : undefined;
	return { ownerQuestions, questionsForAgent, review, blocked, stepsMarkdown, show: ownerQuestions.length > 0 || review || blocked || stepsMarkdown !== undefined };
}

export function taskDetailState(status: BoardTask['status'], needsYou: ReturnType<typeof taskNeedsYou>, kind?: NonNullable<BoardTask['state']>['kind']): string {
	if (needsYou.stepsMarkdown && kind === 'steps_needed') return 'Your steps to do';
	if (needsYou.ownerQuestions.some(question => !isWarning(question))) return 'Needs your answer';
	if (needsYou.stepsMarkdown) {
		if (kind === 'failed' && status !== 'blocked') return 'Failed';
		if (kind === undefined && !needsYou.blocked) return 'Your steps to do';
	}
	return {
		todo: 'To do', in_progress: 'Working', review: 'Ready for you to check',
		blocked: 'Blocked', waiting: 'Waiting', done: 'Done', dropped: 'Dropped'
	}[status];
}

const recordFoldDefaults = { request: true, decided: false, activity: false } as const;
export type TaskRecordRow = keyof typeof recordFoldDefaults;

type FoldStorage = Pick<Storage, 'getItem' | 'setItem'>;
const foldKey = (row: TaskRecordRow) => `aiki.task-record.v1:${row}`;

export function readTaskRecordFold(row: TaskRecordRow, storage?: FoldStorage): boolean {
	try {
		const saved = (storage ?? globalThis.localStorage)?.getItem(foldKey(row));
		if (saved === 'open' || saved === 'closed') return saved === 'open';
	} catch { /* Storage may be unavailable. */ }
	return recordFoldDefaults[row];
}

export function saveTaskRecordFold(row: TaskRecordRow, open: boolean, storage?: FoldStorage): void {
	try {
		(storage ?? globalThis.localStorage)?.setItem(foldKey(row), open ? 'open' : 'closed');
	} catch { /* The fold still works in this view. */ }
}

/** Use a list for flat criteria separated by semicolons or newlines; preserve existing Markdown blocks. */
export function acceptanceMarkdown(acceptance: string): string {
	const text = acceptance.trim();
	if (/\n[ \t]*\n|^(?:\s*(?:[-+*]|\d+[.)])\s|\s*(?:#{1,6}\s|>|```|~~~|\||<)| {4}|\t)/m.test(text)) return text;
	// Don't split a separator inside inline code, a Markdown link/destination, a URL or an escape.
	const pieces: string[] = [];
	let start = 0;
	for (const token of text.matchAll(/(`+)[^\n]*?\1|\[[^\]\n]*\]\([^\n)]*\)|https?:\/\/[^\s]+?(?=;\s|\s|$)|\\.|&(?:#\d+|#x[\da-f]+|[a-z]+);|[;\n]/gi)) {
		if (token[0] !== ';' && token[0] !== '\n') continue;
		pieces.push(text.slice(start, token.index).trim());
		start = token.index + 1;
	}
	pieces.push(text.slice(start).trim());
	const criteria = pieces.filter(Boolean);
	return criteria.length > 1 ? criteria.map(criterion => `- ${criterion}`).join('\n') : text;
}
