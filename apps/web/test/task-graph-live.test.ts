import { describe, expect, it } from 'bun:test';
import type { BoardQuestion, BoardTask, BoardTaskState, WorkerSummary } from '@kemiri/protocol';
import { buildTaskGraph, type TaskGraph } from '../src/lib/task-graph.ts';
import { graphReportCues } from '../src/lib/graph-worker-motion.ts';
import { settledGraphPositions } from '../src/lib/task-graph-layout.ts';
import { graphFoldGroups, graphFoldExpansion, graphFoldPosition, liveTaskGraph, renderedGraphNodes, revealGraphTask, loadGraphMode, saveGraphMode, GRAPH_MODE_KEY } from '../src/lib/task-graph-live.ts';

function task(id: string, extra: Partial<BoardTask> = {}): BoardTask {
	return { id, revision: 1, title: `Sample ${id}`, description: '', acceptance: null, refs: [], status: 'todo', blockedBy: [], blockedReason: null, writeScopes: [], workerIds: [], scheduleId: null,
		report: { now: '', results: '', next: '', revision: 0, updatedAt: null, updatedBy: null }, snapshots: 0, order: Number(id.slice(1)), createdBy: 'coordinator', updatedBy: 'coordinator', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', settledAt: null, archived: false, ...extra };
}
const state = (kind: BoardTaskState['kind'], group: BoardTaskState['group']): BoardTaskState => ({ kind, group, refs: [], since: '2026-01-01T00:00:00Z' });
const build = (tasks: BoardTask[], questions: BoardQuestion[] = []) => buildTaskGraph(tasks, questions, [], []);
const ids = (graph: TaskGraph) => graph.nodes.filter(node => node.kind === 'task').map(node => node.task!.id);
const empty = new Set<'todo' | 'waiting'>();
const question = (taskId: string, extra: Partial<BoardQuestion> = {}) => ({ taskId, status: 'open', kind: 'question', ...extra }) as BoardQuestion;

describe('Live task folding', () => {
	it('folds only todo/waiting-outside singles; preserves every other derived kind and closed option', () => {
		const kinds: BoardTaskState['kind'][] = ['failed', 'answer_needed', 'review', 'working', 'clarifying', 'paused', 'blocked_by_task', 'todo', 'waiting_outside', 'done', 'dropped'];
		const graph = build(kinds.map((kind, i) => task(`T${i + 1}`, { state: state(kind, ['failed', 'answer_needed', 'review'].includes(kind) ? 'needs_you' : kind === 'todo' ? 'todo' : 'waiting') })));
		expect(graphFoldGroups(graph).map(group => [group.kind, group.taskIds])).toEqual([['todo', ['T8']], ['waiting', ['T9']]]);
		expect(ids(liveTaskGraph(graph, graphFoldGroups(graph), 'live', empty))).toEqual(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T10', 'T11']);
		expect(liveTaskGraph(graph, graphFoldGroups(graph), 'all', empty)).toBe(graph);
	});
	it('uses list sections for old backends, question waiting direction, review and blocked states', () => {
		const tasks = [task('T1'), task('T2', { status: 'waiting' }), task('T3', { status: 'review' }), task('T4', { status: 'blocked' }), task('T5', { status: 'in_progress' }), task('T6')];
		const questions = [question('T1'), question('T6', { waitingOn: 'agent' })];
		const graph = build(tasks, questions);
		expect(graphFoldGroups(graph, questions).map(group => group.taskIds)).toEqual([['T6'], ['T2']]);
		// A stale quiet state must not override the list's authoritative attention group.
		expect(graphFoldGroups(build([task('T7', { state: state('todo', 'needs_you') })]))).toEqual([]);
	});
	it('retains nested families including quiet siblings, quiet-only families and reported hidden parts', () => {
		const graph = build([task('T1'), task('T2', { parent: 'T1', status: 'in_progress' }), task('T3', { parent: 'T1' }), task('T4', { parent: 'T3' }), task('T5'), task('T6', { parent: 'T5' }), task('T7', { subtaskCount: { done: 1, total: 1 } }), task('T8')]);
		expect(graphFoldGroups(graph)[0]?.taskIds).toEqual(['T8']);
	});
	it('retains recursive blockers of shown tasks, but not reverse dependents or found/related neighbours', () => {
		const graph = build([task('T1', { status: 'in_progress', blockedBy: ['T2'] }), task('T2', { blockedBy: ['T3'] }), task('T3'), task('T4', { blockedBy: ['T1'] }), task('T5', { foundWhile: 'T1', related: ['T2'] })]);
		expect(graphFoldGroups(graph)[0]?.taskIds).toEqual(['T4', 'T5']);
	});
	it('groups chips in fixed todo/waiting order, selection opens the whole group and can close again', () => {
		const graph = build([task('T1', { status: 'waiting' }), task('T2'), task('T3')]);
		const groups = graphFoldGroups(graph);
		expect(groups.map(group => group.label)).toEqual(['To do', 'Waiting']);
		const expanded = revealGraphTask(groups, empty, 'T3');
		expect([...expanded]).toEqual(['todo']);
		expect(ids(liveTaskGraph(graph, groups, 'live', expanded))).toEqual(['T2', 'T3']);
		expect(ids(liveTaskGraph(graph, groups, 'live', empty))).toEqual([]);
		expect([...revealGraphTask(groups, expanded, 'missing')]).toEqual(['todo']);
		expect(empty.size).toBe(0);
	});
	it('opens prerequisite groups with an unfolded task and closes dependents with their blocker chip', () => {
		const graph = build([task('T1', { blockedBy: ['T2'] }), task('T2', { status: 'waiting' })]);
		const groups = graphFoldGroups(graph);
		const expanded = graphFoldExpansion(graph, groups, new Set(['todo']));
		expect(expanded).toEqual(new Set(['todo', 'waiting']));
		expect(ids(liveTaskGraph(graph, groups, 'live', new Set(['todo'])))).toEqual(['T1', 'T2']);
		expect(graphFoldExpansion(graph, groups, expanded, 'waiting')).toEqual(empty);
	});
	it('never folds working or failed crew assignments; idle crew on folded tasks join Resting', () => {
		const graph = build([task('T1'), task('T2'), task('T3')]);
		for (const [id, status] of [['T1', 'running'], ['T2', 'idle'], ['T3', 'failed']] as const) graph.nodes.push({ id: `worker:${id}`, kind: 'worker', title: id, status, worker: { id, status } as WorkerSummary, parent: `task:${id}`, radius: 21, attention: false });
		const groups = graphFoldGroups(graph);
		expect(groups[0]?.taskIds).toEqual(['T2']);
		const live = liveTaskGraph(graph, groups, 'live', empty);
		expect(live.resting.map(worker => worker.id)).toEqual(['T2']);
		expect(live.nodes.some(node => node.id === 'worker:T2')).toBe(false);
		expect(liveTaskGraph(graph, groups, 'live', empty, true).nodes.find(node => node.id === 'worker:T2')?.parent).toBeNull();
		expect(liveTaskGraph(graph, groups, 'live', new Set(['todo'])).resting).toEqual([]);
		expect(graph.resting).toEqual([]);
	});
});

it('renders and budgets only shown mascots, including finish hops, without hidden report cues', () => {
	const graph = build([task('T1', { status: 'in_progress' }), task('T2')]);
	const hiddenCrew = { id: 'worker:quiet', kind: 'worker' as const, title: 'Quiet worker', status: 'idle', parent: 'task:T2', radius: 21, attention: false, worker: { id: 'quiet', status: 'idle' } as WorkerSummary };
	graph.nodes.push(hiddenCrew);
	const shown = liveTaskGraph(graph, graphFoldGroups(graph), 'live', empty);
	const visibleFinish = { ...hiddenCrew, id: 'worker:finished', parent: 'task:T1', status: 'done' };
	const rendered = renderedGraphNodes(shown, [hiddenCrew, visibleFinish]);
	expect(rendered.map(node => node.id)).toEqual(['task:T1', 'worker:finished']);
	const unfolded = liveTaskGraph(graph, graphFoldGroups(graph), 'live', new Set(['todo']));
	expect(renderedGraphNodes(unfolded, [hiddenCrew]).filter(node => node.id === hiddenCrew.id)).toHaveLength(1);
	expect(graphReportCues(new Map([['quiet', null]]), [{ ...hiddenCrew.worker, lastReport: 'Synthetic report', updatedAt: '2026-01-01T00:00:00Z' }], shown)).toEqual([]);
	expect(graph.nodes).toHaveLength(3);
});

describe('retained All slots and fold anchors', () => {
	it('keeps every task position across Live, All, unfold and close without a second solve', () => {
		const graph = build([task('T1', { status: 'in_progress' }), task('T2'), task('T3', { status: 'waiting' })]);
		const positions = settledGraphPositions(graph), before = structuredClone(positions);
		const groups = graphFoldGroups(graph), chips = graphFoldPosition(positions);
		for (const mode of ['live', 'all', 'live'] as const) for (const expanded of [empty, new Set<'todo' | 'waiting'>(['todo']), empty]) {
			const shown = liveTaskGraph(graph, groups, mode, expanded);
			for (const node of shown.nodes) expect(positions.get(node.id)).toEqual(before.get(node.id));
			expect(graphFoldPosition(positions, chips)).toEqual(chips);
		}
	});
	it('keeps the chip row below arriving lower families without moving existing bubbles', () => {
		const graph = build([task('T1'), task('T2')]);
		const positions = settledGraphPositions(graph), chip = graphFoldPosition(positions)!;
		const lower = new Map(positions).set('task:T3', { ...positions.get('task:T1')!, y: chip.y + 500 });
		const nextChip = graphFoldPosition(lower, chip)!;
		expect(nextChip.x).toBe(chip.x);
		expect(nextChip.y).toBeGreaterThan(chip.y + 500);
		for (const [id, position] of positions) expect(lower.get(id)).toEqual(position);
	});
	it('reserves new quiet arrivals while folded, changes counts only, and never shifts old slots or chips', () => {
		const graph = build([task('T1', { status: 'in_progress' }), task('T2')]);
		const positions = settledGraphPositions(graph), chips = graphFoldPosition(positions);
		const next = build([task('T1', { status: 'in_progress' }), task('T2'), task('T3')]);
		const nextPositions = settledGraphPositions(next, positions), groups = graphFoldGroups(next);
		expect(groups[0]?.taskIds).toEqual(['T2', 'T3']);
		expect(ids(liveTaskGraph(next, groups, 'live', empty))).toEqual(['T1']);
		for (const [id, position] of positions) expect(nextPositions.get(id)).toEqual(position);
		expect(nextPositions.has('task:T3')).toBe(true);
		expect(graphFoldPosition(nextPositions, chips)).toEqual(chips);
	});
});

it('remembers Live/All by encoded project scope and defaults safely to Live', () => {
	const stored = new Map<string, string>();
	const storage = { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } };
	expect(loadGraphMode('demo:one', storage)).toBe('live');
	saveGraphMode('demo:one', 'all', storage);
	expect(stored.get(GRAPH_MODE_KEY + 'demo%3Aone')).toBe('all');
	expect(loadGraphMode('demo:one', storage)).toBe('all');
	expect(loadGraphMode('demo:two', storage)).toBe('live');
	expect(loadGraphMode('demo:one', { getItem: () => { throw new Error('Storage unavailable'); } })).toBe('live');
	stored.set(GRAPH_MODE_KEY + 'demo%3Aone', 'invalid');
	expect(loadGraphMode('demo:one', storage)).toBe('live');
});
