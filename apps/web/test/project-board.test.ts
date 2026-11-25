import { expect, test } from 'bun:test';
import { createServer } from 'vite';
import { HarnessClient, type ClientState, type HarnessWebSocket } from '@kemiri/client';
import type { Board, BoardDeltaEvent, BoardQuestion, BoardTask, ClientMessage, ServerMessage } from '@kemiri/protocol';
import { taskSectionOf } from '../src/lib/tasks.ts';

const at = '2026-11-01T10:00:00Z';
const parent: BoardTask = {
	id: 'T1', title: 'Open the bakery', description: '', acceptance: null, refs: [], revision: 1,
	status: 'in_progress', blockedBy: [], blockedReason: null, writeScopes: [], workerIds: [], scheduleId: null,
	report: { now: '', results: '', next: '', revision: 0, updatedAt: null, updatedBy: null },
	snapshots: 0, order: 1, createdAt: at, updatedAt: at, createdBy: 'user', updatedBy: 'user',
	settledAt: null, archived: false, state: { group: 'in_progress', kind: 'paused', since: at, refs: [] },
	subtaskCount: { done: 1, total: 2 }, subtaskStates: ['done', 'todo'],
};

const ready = (features: readonly string[]): ClientState => ({ status: 'ready', attempt: 0, features });

test('a board opened after hello uses the current capabilities on its first read and refreshes them on reconnect', async () => {
	const vite = await createServer({ root: import.meta.dir + '/..', server: { middlewareMode: true }, logLevel: 'error' });
	try {
		const { ProjectBoard } = await vite.ssrLoadModule('/src/lib/board.svelte.ts');
		let clientState = ready(['board', 'task-state', 'task-part-states', 'task-activity', 'task-freshness', 'question-clarify']);
		let onState: ((state: ClientState) => void) | undefined;
		let snapshot: Board = { tasks: [parent], questions: [] };
		let reads = 0;
		const client: Pick<HarnessClient, 'state' | 'connected' | 'onBoardState' | 'subscribe' | 'readBoard'> = {
			get state() { return clientState; },
			get connected() { return clientState.status === 'ready'; },
			onBoardState: () => () => {},
			// HarnessClient only notifies subscribers on future transitions.
			subscribe: listener => { onState = listener; return () => { onState = undefined; }; },
			readBoard: async () => { reads++; return snapshot; },
		};
		const board = new ProjectBoard(client, 'bakery');
		try {
			await Promise.resolve(); // Let the first board read complete.
			expect(reads).toBe(1);
			expect(taskSectionOf(board.tasks[0], 0)).toBe('in_progress');
			expect(board.tasks[0].subtaskStates).toEqual(['done', 'todo']);
			expect([board.activityEnabled, board.freshnessEnabled, board.clarifyEnabled]).toEqual([true, true, true]);

			clientState = { status: 'reconnecting', attempt: 1 };
			onState?.(clientState);
			expect(reads).toBe(1);
			snapshot = { tasks: [{ ...parent, state: undefined, subtaskStates: undefined }], questions: [] };
			clientState = ready(['board']);
			onState?.(clientState);
			await Promise.resolve();
			expect(reads).toBe(2);
			expect(taskSectionOf(board.tasks[0], 0)).toBe('working');
			expect(board.tasks[0].subtaskStates).toBeUndefined();
			expect([board.stateEnabled, board.partsEnabled, board.activityEnabled, board.freshnessEnabled, board.clarifyEnabled]).toEqual([false, false, false, false, false]);
		} finally { board.stop(); }
	} finally { await vite.close(); }
}, 20000);


test('board deltas reconstruct the web store and a missing sequence requests a full live board', async () => {
	const vite = await createServer({ root: import.meta.dir + '/..', server: { middlewareMode: true }, logLevel: 'error' });
	const sent: ClientMessage[] = [];
	const push = (message: ServerMessage) => socket.onmessage?.({ data: JSON.stringify(message) });
	const socket: HarnessWebSocket = {
		onopen: null, onmessage: null, onclose: null, onerror: null, close() {},
		send(raw) {
			const request = JSON.parse(String(raw)) as ClientMessage;
			sent.push(request);
			if (request.type === 'hello') push({ type: 'hello', id: request.id, protocolVersion: 1,
				server: { name: 'stub', version: '1' }, features: ['board', 'board-delta', 'task-state', 'task-part-states'] });
		},
	};
	const client = new HarnessClient({ url: 'ws://example.test/ws', clientFeatures: ['board-delta'], reconnect: false,
		webSocketFactory: () => { queueMicrotask(() => socket.onopen?.()); return socket; } });
	try {
		const { ProjectBoard } = await vite.ssrLoadModule('/src/lib/board.svelte.ts');
		client.connect();
		await client.whenReady();
		const projectId = 'bakery';
		const store = new ProjectBoard(client, projectId);
		try {
			await Promise.resolve();
			const before: Board = { tasks: [parent], questions: [], decisions: [], updatedAt: null };
			const read = sent.find(request => request.type === 'board.get')!;
			push({ type: 'board.get', id: read.id, board: before, stream: { projectId, sequence: 1 } });
			const delta = (baseSequence: number, changes: Partial<BoardDeltaEvent>) => push({
				type: 'board.delta', projectId, baseSequence, sequence: baseSequence + 1, updatedAt: at, ...changes,
			});
			const addedTask: BoardTask = { ...parent, id: 'T2', title: 'Bake the first batch', order: 0,
				live: { lines: [], pulse: { label: 'Checking the oven', since: at } } };
			const changedParent = { ...parent, title: 'Open the new bakery', revision: 2 };
			const question: BoardQuestion = { id: 'Q1', revision: 1, text: 'Use sourdough?', options: [],
				taskId: 'T2', status: 'open', answer: null, askedAt: at, answeredAt: null };
			const previousDecision = { id: 'D1', text: 'Use the old register', taskId: null, why: null, at };
			const decision = { ...previousDecision, id: 'D2', text: 'Use the new register' };
			const archivedLink = { id: 'T3', title: 'Find an oven', status: 'done' as const, archived: true };
			delta(1, { tasks: { upsert: [changedParent, addedTask], order: ['T2', 'T1'] },
				questions: { upsert: [question] }, decisions: { upsert: [previousDecision] }, archivedLinks: { upsert: [archivedLink] } });
			expect(store.board?.tasks.map((task: BoardTask) => task.id)).toEqual(['T2', 'T1']);
			const answered: BoardQuestion = { ...question, revision: 2, status: 'answered', answer: 'Yes', answeredAt: at };
			delta(2, { tasks: { remove: ['T1'] }, questions: { upsert: [answered] },
				decisions: { upsert: [decision], remove: ['D1'] }, archivedLinks: { remove: ['T3'] } });
			delta(3, { taskLive: [{ taskId: 'T2' }] }); // Clear a pulse without sending the task again.
			const expected: Board = { tasks: [{ ...addedTask, live: { lines: [] } }], questions: [answered], decisions: [decision], updatedAt: at };
			await Promise.resolve();
			expect(store.board).toEqual(expected);

			delta(5, { tasks: { remove: ['T2'] } });
			delta(6, { questions: { remove: ['Q1'] } });
			expect(store.board).toEqual(expected);
			const reads = sent.filter(request => request.type === 'board.get');
			expect(reads).toHaveLength(2);
			expect(reads[1]).toMatchObject({ projectId });
			expect(reads[1]?.includeArchived).toBeUndefined();
			push({ type: 'board.get', id: reads[1]!.id, board: before, stream: { projectId, sequence: 8 } });
			delta(8, { tasks: { upsert: [changedParent] } });
			expect(store.board).toEqual({ ...before, tasks: [changedParent], updatedAt: at });
		} finally { store.stop(); }
	} finally { client.close(); await vite.close(); }
}, 20000);
