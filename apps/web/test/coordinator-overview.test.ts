import { expect, test } from 'bun:test';
import { createServer } from 'vite';
import type { ClientState } from '@kemiri/client';
import type { Board, BoardTask, Overview, OverviewGetRequest, OverviewGetResponse } from '@kemiri/protocol';
import { overviewAge, overviewFlightRows, overviewOpeningLine, overviewRosterLine, overviewWaitHref, overviewWaitingRows } from '../src/lib/coordinator-overview.js';
import { loadTasksViewMode } from '../src/lib/kanban.js';

const now = Date.parse('2026-05-14T12:00:00Z');
const askedAt = '2026-05-14T10:12:00Z';
const counts = { open: 4, running: 1, waitingOnOwner: 1, oldestWaitSince: askedAt };

test('the overview age comes from the device clock and the opening sentence follows scope', () => {
	expect(overviewAge(askedAt, now + 60_000)).toBe('1 h 49 min');
	expect(overviewOpeningLine(counts, now, 2)).toBe('4 requests are open across 2 coordinators, and 1 thing waits on you for up to 1 h 48 min.');
	expect(overviewOpeningLine({ open: 1, running: 0, waitingOnOwner: 0 }, now)).toBe('1 request is open, and nothing waits on you.');
	expect(overviewRosterLine(counts)).toBe('4 requests open · 1 waits on you');
	expect(overviewRosterLine(undefined)).toBeUndefined();
});

test('waits are oldest first and open the originating question or steps, not the entire request', () => {
	const question: Overview['waiting'][number] = { kind: 'question', taskId: 'T2', requestId: 'T1', questionId: 'Q3', since: askedAt, holdsParts: 1 };
	const steps: Overview['waiting'][number] = { kind: 'steps', taskId: 'T1', requestId: 'T1', since: '2026-05-14T09:00:00Z', holdsParts: 0 };
	const taskHref = (id: string) => `/project?task=${id}`;
	const questionHref = (id: string) => `/project?question=${id}`;
	expect(overviewWaitingRows([question, steps])).toEqual([steps, question]);
	expect(overviewWaitHref(question, taskHref, questionHref)).toBe('/project?task=T2#task-question-Q3');
	expect(overviewWaitHref(steps, taskHref, questionHref)).toBe('/project?task=T1#task-steps');
	expect(overviewWaitHref({ ...question, taskId: null, requestId: null }, taskHref, questionHref)).toBe('/project?question=Q3');
});

test('failed and paused requests rise without changing the order of the other requests', () => {
	const board = { tasks: [{ id: 'T4', state: { kind: 'failed' } }, { id: 'T2', state: { kind: 'paused' } }] as BoardTask[] } as Board;
	const flight = ['T1', 'T2', 'T3', 'T4'].map(requestId => ({ requestId, heldUp: false }));
	expect(overviewFlightRows(flight, board).map(row => row.requestId)).toEqual(['T4', 'T2', 'T1', 'T3']);
	expect(loadTasksViewMode({ getItem: () => 'overview' }, 'demo:bakery')).toBe('overview');
});


test('a shared reader keeps the last snapshot on reconnect and only follows the visible scope', async () => {
	const vite = await createServer({ root: import.meta.dir + '/..', server: { middlewareMode: true, ws: false }, logLevel: 'error' });
	try {
		const { ProjectOverview } = await vite.ssrLoadModule('/src/lib/coordinator-overview.svelte.ts');
		let state: ClientState = { status: 'ready', attempt: 0, features: ['coordinator-overview'] };
		let onState: ((state: ClientState) => void) | undefined;
		let onOverview: ((snapshot: Overview) => void) | undefined;
		const pending: { request: OverviewGetRequest; resolve: (reply: OverviewGetResponse) => void }[] = [];
		const client = {
			get state() { return state; },
			subscribe(listener: typeof onState) { onState = listener; return () => {}; },
			onOverview(listener: typeof onOverview) { onOverview = listener; return () => {}; },
			request: (request: OverviewGetRequest) => new Promise<OverviewGetResponse>(resolve => pending.push({ request, resolve })),
		};
		const snapshot = (coordinatorId: string | null, open: number): OverviewGetResponse => ({
			type: 'overview', id: 'request', asOf: askedAt, scope: { projectId: 'bakery', coordinatorId }, counts: { ...counts, open },
			waiting: [], inFlight: [], week: { requests: 0, parts: 0, perDay: [], sentBack: 0, reopened: 0 },
			more: { heldUpTodayMs: 0, statusTimes: [], runs: { started: 0, failed: 0, stopped: 0, tasksWithMultipleRuns: 0, workerMs: 0 }, questions: { asked: 0, answered: 0 }, checks: { passed: 0, failed: 0 }, runningJobs: [] },
			estimateInputs: { completed: [] },
		});
		const reader = new ProjectOverview(client, 'bakery');
		try {
			const releaseMain = reader.follow('main');
			releaseMain();
			const releaseAll = reader.follow(null);
			pending[0]!.resolve(snapshot('main', 2));
			pending[1]!.resolve(snapshot(null, 7));
			await Promise.resolve();
			expect(pending.map(call => call.request.subscribe)).toEqual([true, true]);
			expect(reader.read('main')).toBeUndefined();
			expect(reader.read(null)?.counts.open).toBe(7);
			state = { status: 'reconnecting', attempt: 1 };
			onState?.(state);
			expect(reader.read(null)?.counts.open).toBe(7);
			state = { status: 'ready', attempt: 0, features: ['coordinator-overview'] };
			onState?.(state);
			expect(pending[2]?.request).toMatchObject({ coordinatorId: null, subscribe: true });
			onOverview?.(snapshot('main', 8));
			onOverview?.(snapshot(null, 9));
			expect(reader.read('main')).toBeUndefined();
			expect(reader.read(null)?.counts.open).toBe(9);
			releaseAll();
			await Promise.resolve();
			expect(pending[3]?.request.subscribe).toBe(false);
		} finally { reader.stop(); }
	} finally { await vite.close(); }
}, 20_000);
