import { expect, test } from 'bun:test';
import type { BoardQuestion, BoardTask, WorkerSummary } from '@kemiri/protocol';
import type { GraphNode, GraphPosition, TaskGraph } from '../src/lib/task-graph.js';
import { crewHandoffMs, crewFinishMs, departingGraphCrew, graphCrewInView, graphCrewMotion, graphReportCues, interpolateCrewHandoff } from '../src/lib/graph-worker-motion.js';

const worker = (status: WorkerSummary['status'] = 'running', extra: Partial<WorkerSummary> = {}) => ({ id: 'w', taskId: 'T1', status, lastReport: null, updatedAt: 'one', ...extra } as WorkerSummary);
const node = (status: WorkerSummary['status'] = 'running'): GraphNode => ({ id: 'worker:w', kind: 'worker', title: 'Synthetic worker', status, parent: 'task:T1', radius: 21, attention: false, worker: worker(status) });
const graph = (...nodes: GraphNode[]): TaskGraph => ({ nodes, edges: [], resting: [] });
const position = (x: number, y: number, parentId = 'task:T1'): GraphPosition => ({ x, y, parentId, anchorX: x, anchorY: y, vx: 0, vy: 0, radius: 21 });

test('crew motion resolves the perched task including thread-owned-task fallback', () => {
	const tasks = [{ id: 'T1', status: 'review' }] as BoardTask[];
	expect(graphCrewMotion(node('idle'), tasks, [])).toBe('waiting');
	const thread = { ...node('idle'), id: 'thread:studio', kind: 'thread' as const, worker: undefined, thread: { status: 'idle', taskId: 'missing' } as GraphNode['thread'] };
	expect(graphCrewMotion(thread, tasks, [])).toBe('waiting');
	expect(graphCrewMotion(node(), tasks, [])).toBe('working');
	expect(graphCrewMotion(node('failed'), tasks, [])).toBe('failed');
	expect(graphCrewMotion(node('idle'), [{ id: 'T1', status: 'todo' }] as BoardTask[], [{ taskId: 'T1', status: 'open' }] as BoardQuestion[])).toBe('waiting');
});

test('viewport intersection includes padded badges/rings and respects camera pan/zoom', () => {
	const camera = { x: 100, y: 200, zoom: 2 };
	expect(graphCrewInView(position(194, 200), camera, 200, 100)).toBe(true);
	expect(graphCrewInView(position(196, 200), camera, 200, 100)).toBe(false);
	expect(graphCrewInView(position(100, 271), camera, 200, 100)).toBe(false);
	expect(graphCrewInView(undefined, camera, 200, 100)).toBe(false);
	expect(graphCrewInView(position(100, 200), camera, 0, 100)).toBe(false);
});

test('departures celebrate completion/removal but not filters, Resting or stopped runs', () => {
	const before = graph(node());
	expect(departingGraphCrew(before, graph(), [worker('idle')], [])).toEqual([]);
	expect(departingGraphCrew(before, graph(), [worker('running')], [])).toEqual([]);
	expect(departingGraphCrew(before, before, [worker('done')], [])).toEqual([]);
	expect(departingGraphCrew(before, graph(), [worker('done')], [])[0]?.status).toBe('done');
	expect(departingGraphCrew(before, graph(), [worker('stopped')], [])[0]?.status).toBe('stopped');
	expect(departingGraphCrew(before, graph(), [], [])[0]?.status).toBe('done');
	expect(crewFinishMs).toBe(1300 + 400);
});

test('650 ms reassignment follows a bounded upward arc and lands exactly on the new rim', () => {
	const from = new Map([['worker:w', position(0, 0)], ['task:T1', position(0, 0)]]);
	const to = new Map([['worker:w', position(400, 0, 'task:T2')], ['task:T1', position(400, 0)]]);
	expect(crewHandoffMs).toBe(650);
	expect(interpolateCrewHandoff(from, to, 0).get('worker:w')).toMatchObject({ x: 0, y: 0 });
	const middle = interpolateCrewHandoff(from, to, .5);
	expect(middle.get('worker:w')!.y).toBeLessThan(0);
	expect(middle.get('worker:w')!.y).toBeGreaterThanOrEqual(-96);
	expect(middle.get('task:T1')!.y).toBe(0);
	expect(interpolateCrewHandoff(from, to, 1)).toEqual(to);
	expect(interpolateCrewHandoff(from, to, 2)).toEqual(to);
	const unchangedParent = new Map([['worker:w', position(400, 0)]]);
	expect(interpolateCrewHandoff(from, unchangedParent, .5).get('worker:w')!.y).toBe(0);
});

test('reports emit once for changed nonempty reports, never initial history, clears or hidden workers', () => {
	const crew = graph(node());
	const report = worker('running', { lastReport: 'Checked the synthetic lens' });
	expect(graphReportCues(new Map(), [report], crew)).toEqual([]);
	const seen = new Map<string, string | null>([['w', null]]);
	expect(graphReportCues(seen, [report], crew)).toMatchObject([{ workerId: 'worker:w', taskId: 'task:T1' }]);
	seen.set('w', report.lastReport);
	expect(graphReportCues(seen, [report], crew)).toEqual([]);
	expect(graphReportCues(seen, [worker('running', { lastReport: '' })], crew)).toEqual([]);
	expect(graphReportCues(seen, [worker('running', { lastReport: ' ' })], crew)).toEqual([]);
	expect(graphReportCues(seen, [worker('running', { lastReport: 'Next result' })], graph())).toEqual([]);
});
