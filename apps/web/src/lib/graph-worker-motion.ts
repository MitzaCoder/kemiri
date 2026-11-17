import type { BoardQuestion, BoardTask, ThreadSummary, WorkerSummary } from '@kemiri/protocol';
import type { GraphNode, GraphPosition, TaskGraph } from './task-graph.js';
import type { GraphCamera } from './task-graph-camera.js';
import { interpolateGraphPositions } from './task-graph-layout.js';
import { workerMotion, type WorkerMotion } from './worker-motion.js';

export const crewHandoffMs = 650;
export const crewFinishMs = 1700;

export function graphCrewMotion(node: GraphNode, tasks: readonly BoardTask[], questions: readonly BoardQuestion[]): WorkerMotion {
	const taskId = node.parent?.startsWith('task:') ? node.parent.slice(5) : node.worker?.taskId ?? node.thread?.taskId;
	return workerMotion(node.worker ?? node.thread ?? { status: 'idle' }, tasks.find(task => task.id === taskId), questions);
}

/** Include the full padded mascot/badge bounds, not only its anchor. No offscreen timers. */
export function graphCrewInView(position: GraphPosition | undefined, camera: GraphCamera, width: number, height: number): boolean {
	if (!position || width <= 0 || height <= 0) return false;
	const radius = Math.max(45, position.radius);
	return Math.abs(position.x - camera.x) <= width / camera.zoom / 2 + radius
		&& Math.abs(position.y - camera.y) <= height / camera.zoom / 2 + radius;
}

/** Only true completion/removal departs with a hop, never a View filter or moving to Resting. */
export function departingGraphCrew(previous: TaskGraph, next: TaskGraph, workers: readonly WorkerSummary[], threads: readonly ThreadSummary[]): GraphNode[] {
	const retained = new Set(next.nodes.map(node => node.id));
	return previous.nodes.filter(node => node.kind !== 'task' && !retained.has(node.id)).flatMap(node => {
		const live = node.kind === 'worker' ? workers.find(worker => worker.id === node.worker?.id) : threads.find(thread => thread.id === node.thread?.id);
		if (live && live.status !== 'done' && live.status !== 'stopped') return [];
		return [{ ...node, status: live?.status ?? 'done', worker: node.kind === 'worker' ? live as WorkerSummary | undefined : undefined,
			thread: node.kind === 'thread' ? live as ThreadSummary | undefined : undefined }];
	});
}

/** Existing ease-out timing, with a bounded upward arc only on an actual change of task rim. */
export function interpolateCrewHandoff(from: Map<string, GraphPosition>, to: Map<string, GraphPosition>, progress: number): Map<string, GraphPosition> {
	const positions = interpolateGraphPositions(from, to, progress);
	const amount = 1 - Math.pow(1 - Math.max(0, Math.min(1, progress)), 3);
	for (const [id, position] of positions) {
		const start = from.get(id), end = to.get(id)!;
		if (!start || id.startsWith('task:') || start.parentId === end.parentId) continue;
		const lift = Math.min(96, Math.hypot(end.x - start.x, end.y - start.y) * .25);
		position.y -= 4 * amount * (1 - amount) * lift;
	}
	return positions;
}

export type GraphReportCue = { id: string; workerId: string; taskId: string };
/** Seed the seen map from history; only a changed nonempty report emits, once, onto its own task. */
export function graphReportCues(previous: ReadonlyMap<string, string | null>, workers: readonly WorkerSummary[], graph: TaskGraph): GraphReportCue[] {
	return workers.flatMap(worker => {
		const node = graph.nodes.find(node => node.worker?.id === worker.id);
		return previous.has(worker.id) && worker.lastReport?.trim() && previous.get(worker.id) !== worker.lastReport
			&& node?.parent?.startsWith('task:') ? [{ id: `${worker.id}:${worker.updatedAt}:${worker.lastReport}`, workerId: node.id, taskId: node.parent }] : [];
	});
}
