import { expect, test } from 'bun:test';
import { createServer } from 'vite';
import type { BoardQuestion, BoardTask } from '@kemiri/protocol';
import { askAgainText, canClarifyQuestion, highlightAskBack, questionClarifySupported, questionNeedsAnswer } from '../src/lib/question-clarify.ts';
import { agentWaitingForUser } from '../src/lib/agent-activity.ts';
import { itemsWaitingLabel, taskSections, waitingOn } from '../src/lib/tasks.ts';
import { needsYouCount, kanbanColumns } from '../src/lib/kanban.ts';
import { graphLabel, buildTaskGraph } from '../src/lib/task-graph.ts';
import { buildGraphModel } from '../src/lib/task-graph-model.ts';
import { taskRowActivity } from '../src/lib/task-activity.ts';
import { taskStateLabel } from '../src/lib/task-state.ts';

const at = '2026-11-01T10:00:00Z';
const user = { author: 'user', threadId: null, workerId: null } as const;
const agent = { author: 'coordinator', threadId: 'main', workerId: null } as const;
const question: BoardQuestion = { id: 'Q1', revision: 1, text: 'Paper or tins?', options: ['Paper', 'Tins'], taskId: 'T1', threadId: 'main', kind: 'question', status: 'open', answer: null, askedAt: at, answeredAt: null };
const task = { id: 'T1', revision: 1, title: 'Choose packaging', status: 'in_progress', order: 0, blockedBy: [], workerIds: [], report: { now: '', next: '', results: '', revision: 1, updatedAt: null, updatedBy: null }, createdAt: at, updatedAt: at, archived: false, state: { kind: 'clarifying', group: 'in_progress', since: at, refs: ['Q1'] } } as BoardTask;
const waiting: BoardQuestion = { ...question, waitingOn: 'agent', exchanges: [{ author: user, text: 'How much?', at }] };

test('Ask back requires the explicit capability and an open non-approval card', () => {
	expect(questionClarifySupported(undefined)).toBe(false);
	expect(questionClarifySupported(['board'])).toBe(false);
	expect(questionClarifySupported(['question-clarify'])).toBe(true);
	expect(canClarifyQuestion(question, false)).toBe(false);
	expect(canClarifyQuestion(question, true)).toBe(true);
	expect(canClarifyQuestion({ ...question, mcpApproval: true }, true)).toBe(false);
	for (const status of ['answered', 'withdrawn'] as const) expect(canClarifyQuestion({ ...question, status }, true)).toBe(false);
	expect(canClarifyQuestion({ ...question, kind: 'warning' }, true)).toBe(true);
	expect(canClarifyQuestion(waiting, true)).toBe(true);
	for (const text of ['Why?', 'Why? \n']) expect(highlightAskBack(text, true)).toBe(true);
	for (const text of ['', 'Use paper', 'Why? Use paper']) expect(highlightAskBack(text, true)).toBe(false);
	expect(highlightAskBack('Why?', false)).toBe(false);
	expect(askAgainText({ ...waiting, exchanges: [...waiting.exchanges!, { author: agent, text: 'Two coins.', at }] })).toBe('How much?');
	expect(askAgainText(question)).toBeUndefined();
});

test('agent-waiting cards remain answerable but leave attention counts, mascot and graph attention', () => {
	expect(questionNeedsAnswer(question)).toBe(true);
	expect(questionNeedsAnswer(waiting)).toBe(false);
	expect(questionNeedsAnswer({ ...waiting, waitingOn: 'user', noReplyYet: true })).toBe(true);
	expect(waitingOn([waiting], 'T1')).toEqual([waiting]);
	expect(agentWaitingForUser([waiting])).toBe(false);
	expect(itemsWaitingLabel([waiting])).toBe('Waiting for the agent');
	const board = { tasks: [task], questions: [waiting, { ...waiting, id: 'Q2', taskId: null }] };
	expect(needsYouCount(board)).toBe(0);
	expect(taskSections(board)[0]?.id).toBe('in_progress');
	expect(kanbanColumns(board, { stateEnabled: true, onlyNeedsYou: true }).flatMap(c => c.cards)).toEqual([]);
	expect(buildTaskGraph(board.tasks, board.questions, [], []).nodes[0]?.attention).toBe(false);
	expect(buildGraphModel(board.tasks, board.questions, [], [], Date.parse(at)).details.get('T1')?.reasons).toEqual([]);
	expect(taskStateLabel(task)).toBe('Clarifying');
	expect(taskRowActivity(task, true)?.text).toBe('Clarifying');
	expect(graphLabel(buildTaskGraph([task], [waiting], [], []).nodes[0]!)).toContain('Clarifying');
});

test('actual question card renders waiting, revision history, folded exchanges and retry; approvals and old backends hide Ask back', async () => {
	// Card structure is SSR-tested; Markdown sanitizing needs a DOM and has its own real-Chromium suite.
	const vite = await createServer({ root: import.meta.dir + '/..', server: { middlewareMode: true }, logLevel: 'error', plugins: [{
		name: 'question-test-plain-markdown', enforce: 'pre',
		load(id) { if (id.endsWith('/markdown/parse.ts')) return 'export const toBlocks = source => [{ kind: "html", key: source, html: source.replaceAll("&", "&amp;").replaceAll("<", "&lt;") }];'; },
	}] });
	try {
		const { default: Card } = await vite.ssrLoadModule('/src/lib/components/BoardQuestionCard.svelte');
		const { render } = await vite.ssrLoadModule('svelte/server');
		const props = { question, onanswer: async () => ({ kind: 'answered', question }), onclarify: async () => ({ kind: 'clarified', question: waiting }) };
		const html = (q: BoardQuestion, enabled = true) => render(Card, { props: { ...props, question: q, onclarify: enabled ? props.onclarify : undefined } }).body as string;
		expect(html(question)).toContain('Ask back');
		expect(html(question, false)).not.toContain('Ask back');
		expect(html({ ...question, mcpApproval: true })).not.toContain('Ask back');
		expect(html(waiting)).toContain('Waiting for the agent');
		expect(html(waiting)).toContain('Send the answer to Q1');
		const revised: BoardQuestion = { ...waiting, waitingOn: 'user', noReplyYet: true, exchanges: [...waiting.exchanges!, { author: agent, text: 'Paper costs less.', at, previousWording: { revision: 1, text: 'Earlier question', options: ['Old option'] }, previousAnswer: { text: 'Earlier answer?', at } }, { author: user, text: 'Can we recycle it?', at }] };
		for (const text of ['Revised', 'Earlier question', 'Old option', 'Earlier answer?', 'Earlier (1)', 'You', 'Paper costs less.', 'No reply yet', 'Ask again', 'datetime=']) expect(html(revised)).toContain(text);
		expect(html({ ...question, kind: 'warning' })).toContain('Ask back');
		expect(html({ ...question, kind: 'warning' })).toContain('Acknowledge');

		const { ProjectBoard } = await vite.ssrLoadModule('/src/lib/board.svelte.ts');
		let response: unknown = { type: 'board.question.clarify', question: waiting };
		const calls: unknown[] = [];
		const client = { state: { status: 'ready', attempt: 0, features: ['task-state', 'question-clarify'] }, connected: true, onBoardState: () => () => {}, subscribe: () => () => {}, request: async (request: unknown) => { calls.push(request); return response; }, readBoard: async () => ({ tasks: [task], questions: [waiting] }) };
		const board = new ProjectBoard(client, 'bakery');
		await Promise.resolve(); // Let the first board read complete before setting up the question.
		board.board = { tasks: [task], questions: [question] };
		expect(board.clarifyEnabled).toBe(true);
		expect((await board.clarify('Q1', 1, 'How much?')).kind).toBe('clarified');
		expect(calls[0]).toEqual({ type: 'board.question.clarify', projectId: 'bakery', questionId: 'Q1', expectedRevision: 1, text: 'How much?' });
		expect(board.question('Q1')).toEqual(waiting);
		expect(board.openQuestionCount).toBe(0);
		board.board = { tasks: [task], questions: [{ ...waiting, revision: 3, waitingOn: 'user' }] };
		await board.clarify('Q1', 1, 'How much?');
		expect(board.question('Q1')?.revision).toBe(3);
		response = { type: 'error', error: { code: 'board_conflict', message: 'Revision changed' } };
		expect(await board.clarify('Q1', 1, 'How much?')).toEqual({ kind: 'conflict', newer: waiting });
		response = { type: 'error', error: { code: 'bad_request', message: 'Refused' } };
		expect(await board.clarify('Q1', 1, 'How much?')).toEqual({ kind: 'failed', message: 'Refused' });
		board.clarifyEnabled = false;
		const count = calls.length;
		expect((await board.clarify('Q1', 1, 'How much?')).kind).toBe('failed');
		expect(calls.length).toBe(count);
		board.stop();
	} finally { await vite.close(); }
}, 20000);
