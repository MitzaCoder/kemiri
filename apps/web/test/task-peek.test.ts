import { describe, expect, test } from 'bun:test';
import { createServer } from 'vite';
import type { BoardQuestion, BoardTask, WorkerSummary } from '@kemiri/protocol';
import { taskPeekParts, taskPeekResults, taskPeekWorkers } from '../src/lib/task-peek.js';

const since = '2026-01-01T12:00:00Z';
const task = (id: string, status: BoardTask['status'] = 'todo', parent: string | null = null, kind?: NonNullable<BoardTask['state']>['kind']): BoardTask => ({
	id, title: `Synthetic ${id}`, status, parent, order: Number(id.slice(1)), workerIds: [], blockedBy: [], refs: [],
	report: { now: '', results: '', next: '' },
	...(kind ? { state: { kind, group: ['review', 'failed', 'answer_needed'].includes(kind) ? 'needs_you' : kind === 'done' ? 'closed' : 'in_progress', since, refs: [] } } : {})
} as BoardTask);
const question = { id: 'Q1', revision: 2, taskId: 'T1', kind: 'question', status: 'open', text: 'Paper boxes or tins?', options: ['**Paper boxes**', 'Tins'], askedAt: since } as BoardQuestion;

describe('task preview content', () => {
	test('lists only direct working/clarifying/attention parts in task order, with done counted', () => {
		const parent = task('T1');
		const parts = [task('T2', 'done', 'T1', 'done'), task('T3', 'in_progress', 'T1', 'working'), task('T4', 'review', 'T1', 'review'), task('T5', 'blocked', 'T1', 'failed'), task('T6', 'in_progress', 'T1', 'paused'), task('T7', 'waiting', 'T1', 'waiting_outside'), task('T8', 'todo', 'T1', 'clarifying'), task('T9', 'todo', 'T3', 'working'), task('T10', 'dropped', 'T1', 'dropped')];
		const preview = taskPeekParts(parent, parts.toReversed());
		expect(preview.listed.map(part => part.id)).toEqual(['T3', 'T4', 'T5', 'T8']);
		expect(preview.done).toBe(1);
		expect(taskPeekParts({ ...parent, subtaskCount: { done: 5, total: 8 } }, parts).done).toBe(5);
		expect(taskPeekParts({ ...parent, subtaskStates: ['done', 'done', 'working'] }, []).done).toBe(2);
	});

	test('legacy parts use stored status, open questions and derived subtask IDs', () => {
		const parent = { ...task('T1'), subtasks: ['T8'] };
		const parts = [task('T2', 'in_progress', 'T1'), task('T3', 'review', 'T1'), task('T4', 'blocked', 'T1'), task('T5', 'todo', 'T1'), task('T6', 'waiting', 'T1'), task('T7', 'done', 'T1'), task('T8', 'in_progress')];
		expect(taskPeekParts(parent, parts, [{ ...question, taskId: 'T5' }]).listed.map(part => part.id)).toEqual(['T2', 'T3', 'T4', 'T5', 'T8']);
		expect(taskPeekParts(parent, parts, [{ ...question, taskId: 'T5', status: 'answered' }]).listed.map(part => part.id)).not.toContain('T5');
		expect(taskPeekParts(parent, []).listed).toEqual([]);
	});

	test('Results keeps at most three complete bullets, folds continuation lines and strips Markdown', () => {
		expect(taskPeekResults('')).toEqual([]);
		expect(taskPeekResults('- **First** [evidence](https://example.test)\n  continued\n- Second\n- Third\n- Fourth')).toEqual(['First evidence continued', 'Second', 'Third']);
		expect(taskPeekResults('1. First\r\n2) Second\r\n3. Third\r\n4. Fourth')).toEqual(['First', 'Second', 'Third']);
		expect(taskPeekResults('A plain report\ncontinued here.\n\nAnother paragraph.')).toEqual(['A plain report continued here.', 'Another paragraph.']);
	});

	test('worker assignment is authoritative; absent taskId falls back to historical IDs', () => {
		const parent = { ...task('T1'), workerIds: ['legacy', 'moved', 'unassigned'] };
		const workers = [{ id: 'assigned', taskId: 'T1' }, { id: 'legacy' }, { id: 'moved', taskId: 'T2' }, { id: 'unassigned', taskId: null }, { id: 'other' }] as WorkerSummary[];
		expect(taskPeekWorkers(parent, workers).map(worker => worker.id)).toEqual(['assigned', 'legacy']);
		expect(taskPeekWorkers(parent, [])).toEqual([]);
	});
});

test('real TaskPeek composes list pieces, limits reports and offers no editing or reply controls', async () => {
	// Markdown sanitizing requires a browser; this checks the actual component structure.
	const vite = await createServer({ root: import.meta.dir + '/..', server: { middlewareMode: true }, logLevel: 'error', plugins: [{
		name: 'task-peek-test-plain-markdown', enforce: 'pre',
		load(id) { if (id.endsWith('/markdown/parse.ts')) return 'export const toBlocks = source => [{ kind: "html", key: source, html: source.replaceAll("&", "&amp;").replaceAll("<", "&lt;") }];'; },
	}] });
	try {
		const { default: TaskPeek } = await vite.ssrLoadModule('/src/lib/components/TaskPeek.svelte');
		const { default: BoardQuestionCard } = await vite.ssrLoadModule('/src/lib/components/BoardQuestionCard.svelte');
		const { render } = await vite.ssrLoadModule('svelte/server');
		const callbacks = { onWorker: () => {}, onOpenTask: () => {}, onShowLinked: () => {} };
		const freshness = { writtenAt: since, stale: true, approximate: false, eventsSince: 1, reasons: ['work advanced'] };
		const parent = { ...task('T1', 'in_progress', null, 'working'), subtaskStates: ['done', 'working', 'review'], subtaskCount: { done: 1, total: 3 }, report: { now: 'Testing the preview', results: '- First\n- Second\n- Third\n- Fourth', next: 'The reviewer checks the evidence.', freshness: { results: freshness, next: freshness } } };
		const props = { task: parent, tasks: [parent, task('T2', 'done', 'T1', 'done'), task('T3', 'in_progress', 'T1', 'working'), task('T4', 'review', 'T1', 'review')], questions: [question], workers: [{ id: 'fern', taskId: 'T1', status: 'idle', updatedAt: since }], freshnessEnabled: true, ...callbacks };
		for (const layout of ['card', 'sheet']) {
			const html = render(TaskPeek, { props: { ...props, layout, onAnswer: async () => ({ kind: 'answered', question }) } }).body;
			expect(html).toContain('parts-bar');
			expect(html).toContain('1 of 3 parts done · 1 working · 1 needs you');
			expect(html).toContain('+ 1 done');
			expect(html).toContain('Synthetic T3');
			expect(html).not.toContain('Synthetic T2');
			expect(html).toContain('Third');
			expect(html).not.toContain('Fourth');
			expect(html).toContain('line-clamp-2');
			expect(html).toContain('needs update');
			expect(html).toContain('Show worker fern');
			expect(html).toContain('Open task');
			expect(html).toContain('Show linked');
			expect(html).toContain('Suggested answers');
			expect(html).toContain('Paper boxes');
			expect(html).not.toContain('<textarea');
			expect(html).not.toContain('Ask back');
			expect(html).not.toContain('Expand question');
		}
		const legacy = render(TaskPeek, { props: { task: { ...task('T1', 'in_progress'), report: { now: 'Legacy Now', results: '', next: '' } }, ...callbacks } }).body;
		expect(legacy).toContain('Legacy Now');
		expect(legacy).not.toContain('needs update');
		expect(legacy).not.toContain('parts-bar');
		const activity = render(TaskPeek, { props: { task: { ...task('T1', 'in_progress', null, 'working'), activity: { kind: 'working', text: 'fern is checking', since, refs: [] } }, activityEnabled: true, ...callbacks } }).body;
		expect(activity).toContain('activity-line');
		expect(activity).toContain('fern is checking');
		const fullQuestion = render(BoardQuestionCard, { props: { question, onanswer: async () => ({ kind: 'answered', question }) } }).body;
		expect(fullQuestion).toContain('<textarea');
		expect(fullQuestion).toContain('Expand question Q1');
	} finally { await vite.close(); }
}, 20000);
