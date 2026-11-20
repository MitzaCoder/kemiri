import { expect, test } from 'bun:test';
import type { BoardQuestion, BoardTask } from '@kemiri/protocol';
import { taskNeedsYou } from '../src/lib/task-details.js';
import { defaultRouteDoor, routeAttention, routeParts, routeStops } from '../src/lib/task-view/route/route.js';
import { reportExcerptLines } from '../src/lib/task-view/route/report.js';

const at = '2026-01-04T12:00:00Z';
const task = (fields: Partial<BoardTask> = {}) => ({
	id: 'T1', title: 'Example task', status: 'in_progress', report: {}, createdAt: at, blockedBy: [],
	...fields,
}) as BoardTask;
const question = { id: 'Q1', taskId: 'T1', kind: 'question', status: 'open', options: ['First choice'] } as BoardQuestion;

function attentionFor(current: BoardTask, questions: BoardQuestion[] = []) {
	return routeAttention(current, taskNeedsYou(current, questions, false, true));
}

test('a live plan takes priority over parts and inserts one owner interchange', () => {
	const current = task({ live: { lines: [], plan: [
		{ text: 'Draft the menu', status: 'done' }, { text: 'Check the prices', status: 'doing' }, { text: 'Print proof', status: 'todo' },
	] } });
	const parts = [task({ id: 'T2', title: 'Order paper', parent: 'T1' })];
	const stops = routeStops(current, parts, attentionFor(current, [question]), at);
	expect(stops.map(stop => [stop.label, stop.state])).toEqual([
		['Asked', 'done'], ['Draft the menu', 'done'], ['Check the prices', 'now'], ['Your stop', 'waits'],
		['Print proof', 'ahead'], ['You check', 'ahead'], ['Done', 'ahead'],
	]);
	expect(stops[2]?.at).toBe(at);
	expect(routeStops(current, parts, attentionFor(current, [{ ...question, status: 'answered' }])).some(stop => stop.state === 'waits')).toBe(false);
});

test('parts use task order and link back to the corresponding task', () => {
	const current = task();
	const parts = routeParts(current, [
		task({ id: 'T3', parent: 'T1', order: 2 }), task({ id: 'T2', status: 'done', parent: 'T1', order: 1 }), task({ id: 'T4', parent: 'T3', order: 3 }),
	]);
	const stops = routeStops(current, parts, attentionFor(current));
	expect(stops.filter(stop => stop.taskId).map(stop => [stop.taskId, stop.state])).toEqual([['T2', 'done'], ['T3', 'now']]);
});

test('minimal route shows the state, or a review interchange, and closes at Done', () => {
	for (const [status, labels, states] of [
		['todo', ['Asked', 'To do', 'You check', 'Done'], ['done', 'now', 'ahead', 'ahead']],
		['waiting', ['Asked', 'Waiting', 'You check', 'Done'], ['done', 'now', 'ahead', 'ahead']],
		['review', ['Asked', 'You check', 'Done'], ['done', 'waits', 'ahead']],
		['blocked', ['Asked', 'Blocked', 'Your stop', 'You check', 'Done'], ['done', 'now', 'waits', 'ahead', 'ahead']],
		['done', ['Asked', 'You check', 'Done'], ['done', 'done', 'done']],
	] as const) {
		const current = task({ status });
		const stops = routeStops(current, [], attentionFor(current));
		expect(stops.map(stop => stop.label)).toEqual([...labels]);
		expect(stops.map(stop => stop.state)).toEqual([...states]);
	}
});

test('Arrived is the default unless something waits for the owner', () => {
	const current = task();
	expect(defaultRouteDoor(attentionFor(current).count)).toBe('got');
	expect(defaultRouteDoor(attentionFor(current, [question]).count)).toBe('you');
	expect(defaultRouteDoor(attentionFor(current, [{ ...question, waitingOn: 'agent' }]).count)).toBe('got');
	expect(defaultRouteDoor(attentionFor(task({ report: { ...current.report, steps: '1. Try the page.' } })).count)).toBe('you');
});

test('closed doors show bounded excerpts without Markdown markers or code fences', () => {
	expect(reportExcerptLines('# Rehearsal\n\n- **Slot limit held.**\n- [Receipt](https://example.test) arrived.\n```sh\nprintf hello\n```\n- Queue moved.\n- Fourth result.', 3)).toEqual(['Slot limit held.', 'Receipt arrived.', 'Queue moved.']);
	expect(reportExcerptLines('1. Check the receipt.\n2. Review the slot picker.', 1)).toEqual(['Check the receipt.']);
	expect(reportExcerptLines('', 3)).toEqual([]);
});
