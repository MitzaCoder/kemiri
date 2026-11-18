import { expect, test } from 'bun:test';
import { createServer } from 'vite';
import type { ClientState, HarnessClient } from '@kemiri/client';
import type { Board, BoardTask } from '@kemiri/protocol';
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
