import type { GraphNode, GraphPosition, TaskGraph } from './task-graph.js';
import { graphWorkerRests } from './task-graph.js';
import { taskSectionOf, waitingOn } from './tasks.js';
import { questionNeedsAnswer } from './question-clarify.js';
import type { BoardQuestion } from '@kemiri/protocol';

export type GraphMode = 'live' | 'all';
export type GraphFoldKind = 'todo' | 'waiting';
export type GraphFold = { kind: GraphFoldKind; label: string; taskIds: string[] };
export const GRAPH_MODE_KEY = 'task-graph.mode.v1:';
export function loadGraphMode(scope: string, storage?: Pick<Storage, 'getItem'>): GraphMode {
	try { return storage?.getItem(GRAPH_MODE_KEY + encodeURIComponent(scope)) === 'all' ? 'all' : 'live'; }
	catch { return 'live'; }
}
export function saveGraphMode(scope: string, mode: GraphMode, storage?: Pick<Storage, 'setItem'>): void {
	try { storage?.setItem(GRAPH_MODE_KEY + encodeURIComponent(scope), mode); } catch { /* Optional device preference. */ }
}

/** Only quiet singles fold. Families, nonquiet tasks and recursive prerequisites stay visible. */
export function graphFoldGroups(graph: TaskGraph, questions: readonly BoardQuestion[] = []): GraphFold[] {
	const tasks = graph.nodes.filter(node => node.kind === 'task');
	const candidates = new Map<string, GraphFoldKind>();
	const family = new Set(graph.edges.filter(edge => edge.kind === 'parent').flatMap(edge => [edge.from, edge.to]));
	const busyTasks = new Set(graph.nodes.filter(node => node.kind !== 'task' && (node.status === 'running' || node.status === 'failed')).flatMap(node => node.parent ? [node.parent] : []));
	for (const node of tasks) {
		const task = node.task!;
		const section = taskSectionOf(task, waitingOn(questions, task.id).filter(questionNeedsAnswer).length);
		if (family.has(node.id) || task.parent || (task.subtaskCount?.total ?? 0) > 0 || busyTasks.has(node.id) || node.attention ||
			['needs_you', 'review', 'blocked', 'working', 'in_progress', 'closed'].includes(section)) continue;
		if (node.status === 'todo') candidates.set(node.id, 'todo');
		if (node.status === 'waiting_outside' || (!task.state && node.status === 'waiting')) candidates.set(node.id, 'waiting');
	}
	const shown = new Set(tasks.filter(node => !candidates.has(node.id)).map(node => node.id));
	// Prerequisites can themselves have prerequisites. Do not expand unrelated reverse blockers.
	let changed = true;
	while (changed) {
		changed = false;
		for (const edge of graph.edges) if (edge.kind === 'blockedBy' && shown.has(edge.from) && !shown.has(edge.to)) {
			shown.add(edge.to); changed = true;
		}
	}
	return (['todo', 'waiting'] as const).map(kind => ({ kind, label: kind === 'todo' ? 'To do' : 'Waiting',
		taskIds: tasks.filter(node => candidates.get(node.id) === kind && !shown.has(node.id)).map(node => node.task!.id),
	})).filter(group => group.taskIds.length > 0);
}

/** Selection opens the entire chip, rather than making an uncounted exception. */
export function revealGraphTask(groups: readonly GraphFold[], expanded: ReadonlySet<GraphFoldKind>, taskId: string | null): Set<GraphFoldKind> {
	return new Set([...expanded, ...groups.filter(group => taskId !== null && group.taskIds.includes(taskId)).map(group => group.kind)]);
}

/** Opening a group also opens any prerequisite group; closing one closes dependent groups. */
export function graphFoldExpansion(graph: TaskGraph, groups: readonly GraphFold[], expanded: ReadonlySet<GraphFoldKind>, closing: GraphFoldKind | null = null): Set<GraphFoldKind> {
	const groupOfTask = new Map<string, GraphFoldKind>(groups.flatMap(group => group.taskIds.map(id => [`task:${id}`, group.kind] as const)));
	const next = new Set(expanded);
	if (closing) next.delete(closing);
	let changed = true;
	while (changed) {
		changed = false;
		for (const edge of graph.edges) if (edge.kind === 'blockedBy') {
			const dependent = groupOfTask.get(edge.from), prerequisite = groupOfTask.get(edge.to);
			if (!dependent || !prerequisite || dependent === prerequisite) continue;
			if (next.has(dependent) && !next.has(prerequisite)) {
				if (closing) next.delete(dependent); else next.add(prerequisite);
				changed = true;
			}
		}
	}
	return next;
}

export function liveTaskGraph(graph: TaskGraph, groups: readonly GraphFold[], mode: GraphMode, expanded: ReadonlySet<GraphFoldKind>, showResting = false): TaskGraph {
	if (mode === 'all') return graph;
	const revealed = graphFoldExpansion(graph, groups, expanded);
	const hidden = new Set(groups.filter(group => !revealed.has(group.kind)).flatMap(group => group.taskIds.map(id => `task:${id}`)));
	const visibleTaskIds = new Set(graph.nodes.filter(node => node.kind === 'task' && !hidden.has(node.id)).map(node => node.task!.id));
	const resting = new Map(graph.resting.map(worker => [worker.id, worker]));
	const nodes = graph.nodes.filter(node => {
		if (node.kind === 'task') return !hidden.has(node.id);
		if (node.worker && node.parent && hidden.has(node.parent) && graphWorkerRests(node.worker, graph.nodes.find(task => task.id === node.parent)?.task, visibleTaskIds)) {
			resting.set(node.worker.id, node.worker);
			return showResting;
		}
		return true;
	}).map(node => node.parent && hidden.has(node.parent) ? { ...node, parent: null } : node);
	const ids = new Set(nodes.map(node => node.id));
	return { nodes, resting: [...resting.values()], edges: graph.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)) };
}

/** Only visible crew consume motion budget; a completion hop cannot outlive its shown task. */
export function renderedGraphNodes(shownGraph: TaskGraph, departures: readonly GraphNode[]): GraphNode[] {
	const ids = new Set(shownGraph.nodes.map(node => node.id));
	return [...shownGraph.nodes, ...departures.filter(node => !ids.has(node.id)
		&& node.kind !== 'task' && (!node.parent?.startsWith('task:') || ids.has(node.parent)))];
}

/** Solve the full All graph elsewhere, including hidden slots. Chips never enter the task collision solve. */
export function graphFoldPosition(positions: ReadonlyMap<string, GraphPosition>, previous: GraphPosition | null = null): GraphPosition | null {
	const tasks = [...positions].filter(([id]) => id.startsWith('task:')).map(([,position]) => position);
	if (!tasks.length) return null;
	const x = previous?.x ?? (Math.min(...tasks.map(position => position.x)) + Math.max(...tasks.map(position => position.x))) / 2;
	const y = Math.max(previous?.y ?? -Infinity, Math.max(...tasks.map(position => position.y + position.radius)) + 150);
	return { x, y, anchorX: x, anchorY: y, radius: 90, parentId: null, vx: 0, vy: 0 };
}
