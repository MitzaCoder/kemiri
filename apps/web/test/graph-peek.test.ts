import { describe, expect, test } from 'bun:test';
import { GRAPH_PEEK_HOVER_MS, GRAPH_PEEK_LEAVE_MS, graphPeekDragged, graphPeekTaskId, graphPeekUsesSheet, graphPeekWorkerFolds, placeGraphPeek } from '../src/lib/graph-peek.js';

import { liveTaskGraph } from '../src/lib/task-graph-live.js';
import type { GraphFold, GraphFoldKind } from '../src/lib/task-graph-live.js';
import type { TaskGraph } from '../src/lib/task-graph.js';

const viewport = { width: 1200, height: 900 };
const stage = { left: 240, top: 100, width: 960, height: 800 };

describe('graph preview interaction', () => {
	test('only task anchors open a task preview, including nested glyph/caption targets', () => {
		expect(graphPeekTaskId('task:T18')).toBe('T18');
		for (const id of [null, undefined, '', 'task:', 'worker:fern', 'thread:garden', 'fold:todo', 'fold:waiting']) expect(graphPeekTaskId(id)).toBeUndefined();
	});
	test('worker selection opens its folded task and prerequisite chips before rendering its mascot', () => {
		const graph = { nodes: [
			{ id: 'task:T1', kind: 'task', task: { id: 'T1', status: 'todo' }, parent: null },
			{ id: 'task:T2', kind: 'task', task: { id: 'T2', status: 'waiting' }, parent: null },
			{ id: 'worker:idle', kind: 'worker', status: 'idle', worker: { id: 'idle', status: 'idle' }, parent: 'task:T1' },
		], edges: [{ from: 'task:T1', to: 'task:T2', kind: 'blockedBy' }], resting: [] } as unknown as TaskGraph;
		const folds: GraphFold[] = [{ kind: 'todo', label: 'To do', taskIds: ['T1'] }, { kind: 'waiting', label: 'Waiting', taskIds: ['T2'] }];
		const expanded = new Set<GraphFoldKind>();
		expect(liveTaskGraph(graph, folds, 'live', expanded).nodes).toHaveLength(0);
		const revealed = graphPeekWorkerFolds(graph, folds, expanded, 'idle');
		expect([...revealed].sort()).toEqual(['todo', 'waiting']);
		expect(liveTaskGraph(graph, folds, 'live', revealed).nodes.map(node => node.id)).toEqual(['task:T1', 'task:T2', 'worker:idle']);
		expect(expanded.size).toBe(0);
		expect([...graphPeekWorkerFolds(graph, folds, expanded, 'missing')]).toEqual([]);
	});
	test('hover has intent and leaving allows travel to the card', () => {
		expect(GRAPH_PEEK_HOVER_MS).toBe(250);
		expect(GRAPH_PEEK_LEAVE_MS).toBeGreaterThan(100);
	});
	test('actual touch and touch-only displays use sheets; pointer-less desktop mouse input does not', () => {
		expect(graphPeekUsesSheet('touch', false, 0)).toBe(true);
		expect(graphPeekUsesSheet('mouse', true, 5)).toBe(true);
		expect(graphPeekUsesSheet('pen', true, 1)).toBe(true);
		expect(graphPeekUsesSheet('mouse', false, 5)).toBe(false);
		expect(graphPeekUsesSheet('mouse', true, 0)).toBe(false);
		expect(graphPeekUsesSheet(undefined, false, 0)).toBe(false);
	});
	test('four CSS pixels distinguish taps from drag/pan gestures in any direction', () => {
		const start = { x: 100, y: 100 };
		expect(graphPeekDragged(start, start)).toBe(false);
		expect(graphPeekDragged(start, { x: 102, y: 102 })).toBe(false);
		expect(graphPeekDragged(start, { x: 104, y: 100 })).toBe(true);
		expect(graphPeekDragged(start, { x: 97, y: 97 })).toBe(true);
	});
});

describe('graph preview placement', () => {
	test('places below the bubble in stage-local coordinates', () => {
		const placed = placeGraphPeek({ left: 500, top: 200, width: 40, height: 40 }, stage, { width: 360, height: 300 }, viewport);
		expect(placed).toEqual({ left: 260, top: 146, width: 360, maxHeight: 784, outside: false });
	});
	test('flips above near the bottom and clamps against the right stage edge', () => {
		const placed = placeGraphPeek({ left: 1140, top: 780, width: 40, height: 40 }, stage, { width: 360, height: 300 }, viewport);
		expect(placed.left).toBe(592);
		expect(placed.top).toBe(374);
	});
	test('caps oversized cards and narrow stages, keeping all four edges inside', () => {
		const small = { left: 20, top: 40, width: 280, height: 220 };
		const placed = placeGraphPeek({ left: 200, top: 120, width: 40, height: 40 }, small, { width: 360, height: 1000 }, viewport);
		expect(placed.width).toBe(264);
		expect(placed.maxHeight).toBe(204);
		expect(placed.left).toBe(8);
		expect(placed.top).toBe(8);
	});
	test('clips partially offscreen stages to the viewport and detects gone/offscreen anchors', () => {
		const clipped = { left: -40, top: -20, width: 800, height: 700 };
		const placed = placeGraphPeek({ left: 0, top: 0, width: 40, height: 40 }, clipped, { width: 360, height: 300 }, viewport);
		expect(placed.left).toBe(48);
		expect(placed.top).toBe(66);
		expect(placed.outside).toBe(false);
		expect(placeGraphPeek({ left: -100, top: 100, width: 40, height: 40 }, stage, { width: 360, height: 300 }, viewport).outside).toBe(true);
		expect(placeGraphPeek({ left: 500, top: 200, width: 40, height: 40 }, { ...stage, height: 0 }, { width: 360, height: 300 }, viewport).outside).toBe(true);
	});
});
