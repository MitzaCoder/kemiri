import type { BoardQuestion, BoardReportCheck, BoardTask } from '@kemiri/protocol';
import { hasReportSection, hasTypedNext, type TaskReportSections } from './report-sections.js';
import { isSettled, isWarning, waitingOn } from './tasks.js';

export function taskNeedsYou(task: Pick<BoardTask, 'id' | 'status' | 'blockedReason' | 'state'> & { report?: Pick<BoardTask['report'], 'steps' | 'blocks'> }, questions: readonly BoardQuestion[], hasBlockers: boolean, stepsSupported: boolean) {
	const open = waitingOn(questions, task.id);
	const ownerQuestions = open.filter(question => question.waitingOn !== 'agent' && !question.postponed);
	const laterQuestions = open.filter(question => question.postponed);
	const questionsForAgent = open.filter(question => question.waitingOn === 'agent');
	const working = Boolean(task.state?.liveWorkSince);
	const review = !working && task.status === 'review';
	const blocked = task.status === 'blocked' && (Boolean(task.blockedReason?.trim()) || hasBlockers);
	const showSteps = !working && stepsSupported && !isSettled(task.status);
	const hasSteps = showSteps && task.report !== undefined && hasReportSection(task.report, 'steps');
	return { ownerQuestions, laterQuestions, questionsForAgent, review, blocked, working, hasSteps, show: ownerQuestions.length > 0 || review || blocked || hasSteps };
}

export function taskDetailState(status: BoardTask['status'], needsYou: ReturnType<typeof taskNeedsYou>, kind?: NonNullable<BoardTask['state']>['kind']): string {
	if (kind === 'working' || (kind === undefined && needsYou.working)) return 'Working';
	if (kind === 'paused') return 'Paused';
	if (kind === 'clarifying') return 'Clarifying';
	if (kind === 'blocked_by_task') return 'Blocked by another task';
	if (needsYou.hasSteps && kind === 'steps_needed') return 'Your steps to do';
	if (kind === 'failed' && status !== 'blocked') return 'Failed';
	if (needsYou.ownerQuestions.some(question => !isWarning(question))) return 'Needs your answer';
	if (kind === 'answer_needed') return 'Needs attention';
	if (needsYou.hasSteps) {
		if (kind === undefined && !needsYou.blocked) return 'Your steps to do';
	}
	return {
		todo: 'To do', in_progress: 'Working', review: 'Ready for you to check',
		blocked: 'Blocked', waiting: 'Waiting', done: 'Done', dropped: 'Dropped'
	}[status];
}

export function taskDetailFields(task: Pick<BoardTask, 'goal' | 'report'>, taskFieldsEnabled: boolean) {
	return {
		goal: taskFieldsEnabled ? task.goal?.trim() || undefined : undefined,
		hasSummary: taskFieldsEnabled && hasReportSection(task.report, 'summary'),
		hasNotDone: taskFieldsEnabled && hasReportSection(task.report, 'notDone'),
		checks: taskFieldsEnabled ? task.report.checks ?? [] : []
	};
}

/** In review, only a legacy Next can be shown as instructions for the owner. */
export function taskNextPlacement(report: TaskReportSections, review: boolean): 'review' | 'next' | undefined {
	if (hasReportSection(report, 'next')) return review && !hasTypedNext(report) ? 'review' : 'next';
}

export function failedCheckLine(checks: readonly BoardReportCheck[]): string | undefined {
	const failed = checks.filter(check => check.result === 'failed').map(check => check.name);
	if (failed.length === 0) return undefined;
	return failed.length === 1 ? `One check failed: ${failed[0]}` : `${failed.length} checks failed: ${failed.join(', ')}`;
}

export function questionAnswers(question: Pick<BoardQuestion, 'kind' | 'choices' | 'options'>, taskFieldsEnabled: boolean) {
	if (taskFieldsEnabled && question.kind !== 'warning' && question.choices?.length) {
		return { kind: 'choices', choices: question.choices } as const;
	}
	return { kind: 'options', options: question.kind === 'warning' ? [] : question.options } as const;
}

const recordFoldDefaults = { checks: false, request: true, decided: false, coordinatorMessages: false, activity: false } as const;
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
