import { beforeAll, expect, test } from 'bun:test';
import type { BoardQuestion, BoardTask } from '@kemiri/protocol';
import { JSDOM } from 'jsdom';
import { taskNeedsYou } from '../src/lib/task-details.js';
import { defaultRouteDoor, routeAttention, routeParts, routeStops } from '../src/lib/task-view/route/route.js';
import { loadSvelteSsr } from './svelte-ssr.js';

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

const legacy: BoardTask['report'] = {
	now: '', revision: 0, updatedAt: null, updatedBy: null,
	results: 'The **legacy** paragraph stays intact.', notDone: '- The covered queue was not tested.', next: 'Check the receipt.',
};
const typed: BoardTask['report'] = { ...legacy, blocks: {
	summary: [{ kind: 'outcome', text: 'The desk is **ready**.' }],
	results: [{ kind: 'finding', title: 'The limit held', text: 'The clerk accepted ten reservations.' }],
	notDone: [{ kind: 'risk', title: 'Rainy-day queue', text: 'The covered queue still needs a test.' }],
	next: [{ kind: 'nextAction', text: 'The team will return.' }, { kind: 'nextAction', text: 'The team will reopen.' }],
} };
let ssr: typeof import('./fixtures/route-report-ssr.js');
beforeAll(async () => {
	const dom = new JSDOM('');
	const window = Object.getOwnPropertyDescriptor(globalThis, 'window');
	Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
	try {
		ssr = await loadSvelteSsr(import.meta.dir + '/fixtures/route-report-ssr.ts') as typeof ssr;
	} finally {
		if (window) Object.defineProperty(globalThis, 'window', window);
		else Reflect.deleteProperty(globalThis, 'window');
	}
}, 15_000);

test('Route renders titled blocks or the Markdown fallback, never both', () => {
	const renderResults = (report: BoardTask['report']) => ssr.render(ssr.RouteReportSection, { props: { task: task({ report }), section: 'results' } }).body;
	const blocks = renderResults(typed);
	expect(blocks).toMatch(/<h3[^>]*>The limit held<\/h3>/);
	expect(blocks).toContain('The clerk accepted ten reservations.');
	expect(blocks).not.toContain('legacy');
	const markdown = renderResults(legacy);
	expect(markdown).toContain('The <strong>legacy</strong> paragraph stays intact.');
	expect(markdown).not.toContain('The limit held');
});

test('Route closed doors use typed glance facts and legacy fallbacks', () => {
	const renderGlance = (report: BoardTask['report'], door: 'arrived' | 'ahead', showNext = true) =>
		ssr.render(ssr.RouteReportGlance, { props: { task: task({ report }), door, taskFieldsEnabled: true, showNext } }).body;
	const arrived = renderGlance(typed, 'arrived');
	expect(arrived).toContain('The desk is ready.');
	expect(arrived).toContain('The limit held');
	expect(arrived).not.toContain('accepted ten');
	const ahead = renderGlance(typed, 'ahead');
	expect(ahead).toContain('Rainy-day queue');
	expect(ahead).toContain('The team will return.');
	expect(ahead).not.toContain('The team will reopen.');
	expect(ahead).not.toContain('Check the receipt.');
	expect(renderGlance(legacy, 'arrived')).toContain('The legacy paragraph stays intact.');
	expect(renderGlance(legacy, 'ahead')).toContain('The covered queue was not tested.');
	expect(renderGlance(legacy, 'ahead')).toContain('Check the receipt.');
	expect(renderGlance(legacy, 'ahead', false)).not.toContain('Check the receipt.');
});
