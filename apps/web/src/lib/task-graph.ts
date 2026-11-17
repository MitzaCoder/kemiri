import { graphTaskState, taskStateLabel } from "./task-state.js";
import type { BoardLinkKind, BoardQuestion, BoardTask, ThreadSummary, WorkerSummary } from '@kemiri/protocol';

export type GraphNode = {
	id: string; kind: 'task' | 'worker' | 'thread'; title: string; status: string;
	task?: BoardTask; worker?: WorkerSummary; thread?: ThreadSummary;
	parent: string | null; attention: boolean; radius: number;
};
export type GraphEdge = { id: string; from: string; to: string; kind: BoardLinkKind };
export type TaskGraph = { nodes: GraphNode[]; edges: GraphEdge[]; resting: WorkerSummary[] };

/** No clock: idle/failed crew rest whenever their task is not open and visible. */
export function graphWorkerRests(worker: WorkerSummary, task: BoardTask | undefined, visibleTaskIds: ReadonlySet<string>): boolean {
	return ['idle', 'failed'].includes(worker.status) && (!task || task.archived || ['done', 'dropped'].includes(task.status) || !visibleTaskIds.has(task.id));
}

export function visibleGraphTasks(tasks: readonly BoardTask[], showClosed = false): BoardTask[] {
	return tasks.filter(task => !task.archived && (showClosed || !['done', 'dropped'].includes(task.status)));
}

/** Keep the complete relation model; only presentation filters optional links. */
export function visibleGraphEdges(graph: TaskGraph, focused: string | null = null, allLinks = false): GraphEdge[] {
	const neighborhood = focused ? graphNeighborhood(graph, focused) : new Set<string>();
	return graph.edges.filter(edge => edge.kind === 'parent' || edge.kind === 'blockedBy' || (['foundWhile', 'related'].includes(edge.kind) && (allLinks || neighborhood.has(edge.from) || neighborhood.has(edge.to))));
}
const taskKey = (id: string) => `task:${id}`;
export function buildTaskGraph(tasks: readonly BoardTask[], questions: readonly BoardQuestion[], workers: readonly WorkerSummary[], threads: readonly ThreadSummary[], showClosed = false, showResting = false): TaskGraph {
	const shown = visibleGraphTasks(tasks, showClosed);
	const visibleTaskIds = new Set(shown.map(task => task.id));
	const resting: WorkerSummary[] = [];
	const failedTasks = new Set(workers.filter(worker => worker.status === 'failed' && worker.taskId).map(worker => worker.taskId));
	const attention = new Set(questions.filter(q => q.status === 'open' && q.waitingOn !== 'agent').flatMap(q => q.taskId ? [q.taskId] : []));
	for (const worker of workers) if (worker.status === 'failed' && worker.taskId) attention.add(worker.taskId);
	const nodes: GraphNode[] = shown.map(task => ({ id: taskKey(task.id), kind: 'task', title: task.title, status: !task.state && failedTasks.has(task.id) ? 'failed' : graphTaskState(task), task,
		parent: task.parent ? taskKey(task.parent) : null, attention: task.state ? task.state.group === 'needs_you' : task.status === 'review' || attention.has(task.id), radius: (task.subtaskCount?.total ?? tasks.filter(t => t.parent === task.id).length) > 0 ? 47 : 29 }));
	const edges: GraphEdge[] = [];
	const add = (from: string, to: string, kind: GraphEdge['kind']) => {
		if (from === to) return;
		const id = kind === 'related' ? `${kind}:${[from,to].sort().join(':')}` : `${kind}:${from}:${to}`;
		if (!edges.some(e => e.id === id)) edges.push({id, from, to, kind});
	};
	for (const task of shown) {
		for (const [kind, targets] of [['parent', task.parent ? [task.parent] : []], ['foundWhile', task.foundWhile ? [task.foundWhile] : []], ['blockedBy', task.blockedBy], ['related', task.related ?? []]] as const)
			for (const target of targets) add(taskKey(task.id), taskKey(target), kind);
	}
	for (const thread of threads.filter(t => !t.main && !t.archived && t.status !== 'done')) {
		const parent = thread.taskId && visibleTaskIds.has(thread.taskId) ? thread.taskId : thread.ownedTasks.find(id => visibleTaskIds.has(id));
		nodes.push({id:`thread:${thread.id}`, kind:'thread', title:thread.title, status:thread.status, thread, parent:parent ? taskKey(parent) : null, attention:false, radius:32});

	}
	for (const worker of workers.filter(w => !['done','stopped'].includes(w.status))) {
		const thread = nodes.find(n => n.id === `thread:${worker.threadId}`);
		const taskId = worker.taskId ?? tasks.find(t => t.workerIds.includes(worker.id))?.id;
		const task = tasks.find(t => t.id === taskId);
		if (graphWorkerRests(worker, task, visibleTaskIds)) {
			resting.push(worker);
			if (!showResting) continue;
		}
		if (!task && !thread && worker.status !== 'running' && worker.status !== 'idle' && worker.status !== 'failed') continue;
		nodes.push({id:`worker:${worker.id}`, kind:'worker', title:worker.title, status:worker.status, worker, parent:task && visibleTaskIds.has(task.id) ? taskKey(task.id) : thread?.parent ?? null, attention:false, radius:21});

	}
	const ids = new Set(nodes.map(n => n.id));
	return {nodes, resting, edges:edges.filter(e => ids.has(e.from) && ids.has(e.to))};
}

/** Family to any depth, plus blockers in either direction. No unrelated found-while expansion. */
export function graphNeighborhood(graph: TaskGraph, id: string | null): Set<string> {
	if (!id) return new Set(graph.nodes.map(n => n.id));
	const family = new Set([id]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const edge of graph.edges.filter(e => e.kind === 'parent')) {
			if (family.has(edge.from) || family.has(edge.to)) for (const key of [edge.from, edge.to]) if (!family.has(key)) { family.add(key); changed = true; }
		}
	}
	const highlighted = new Set(family);
	for (const edge of graph.edges) if (edge.kind === 'blockedBy' && (family.has(edge.from) || family.has(edge.to))) { highlighted.add(edge.from); highlighted.add(edge.to); }
	for (const node of graph.nodes) if (node.kind !== 'task' && node.parent && highlighted.has(node.parent)) highlighted.add(node.id);
	return highlighted;
}
export function graphLabel(node: GraphNode): string {
	return `${node.kind === 'task' ? node.task?.id : node.kind}: ${node.title}, ${node.task ? taskStateLabel(node.task) ?? node.status.replaceAll('_',' ') : node.status.replaceAll('_',' ')}${node.attention ? ', needs attention' : ''}${node.task?.subtaskCount ? `, ${node.task.subtaskCount.done} of ${node.task.subtaskCount.total} subtasks done` : ''}`;
}

export type GraphPosition = { x:number; y:number; anchorX:number; anchorY:number; vx:number; vy:number; radius:number; parentId:string | null };
function seed(id: string): number {
	let hash = 2166136261;
	for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
	return (hash >>> 0) / 4294967296;
}

/** Retained by ID, independent of board array order. Existing anchors never move on a watch update. */
export function reconcileGraphPositions(graph: TaskGraph, previous = new Map<string, GraphPosition>(), aspect = 1): Map<string, GraphPosition> {
	const positions = new Map<string, GraphPosition>();
	const roots = graph.nodes.filter(n => n.kind === 'task' && !graph.nodes.some(p => p.id === n.parent));
	const families = roots.filter(n => graph.nodes.some(child => child.kind === 'task' && child.parent === n.id));
	const singles = roots.filter(n => !families.includes(n));
	const columns = aspect < 1 ? 1 : Math.max(2,Math.min(5,Math.ceil(Math.sqrt(families.length*aspect*.8))));
	const familyRows = Math.ceil(families.length/columns);
	const singleColumns = aspect < 1 ? 3 : 6;
	for (const node of graph.nodes) {
		const retained = previous.get(node.id);
		if (retained && (node.kind === 'task' || retained.parentId === node.parent)) positions.set(node.id, {...retained, radius:node.radius});
	}
	const place = (node: GraphNode, visited = new Set<string>()): GraphPosition => {
		const retained = positions.get(node.id); if (retained) return retained;
		visited.add(node.id);
		const parent = graph.nodes.find(n => n.id === node.parent && !visited.has(n.id));
		let x: number, y:number;
		if (parent) {
			const center = place(parent, visited);
			const siblings = graph.nodes.filter(n => n.parent === parent.id && (node.kind === 'task' ? n.kind === 'task' : n.kind !== 'task')).sort((a,b) => a.id.localeCompare(b.id));
			const angle = node.kind !== 'task' ? -Math.PI / 2 + (siblings.indexOf(node) - (siblings.length - 1) / 2) * 1.1 : parent.parent ? -Math.PI*0.8 : siblings.indexOf(node) / Math.max(1, siblings.length) * Math.PI*2 - Math.PI/2;
			const distance = node.kind === 'task' ? (parent.parent ? 200 : 220) : parent.radius + node.radius * .55;
			x = center.x + Math.cos(angle)*distance; y = center.y + Math.sin(angle)*distance;
		} else if (families.includes(node)) {
			const index = families.indexOf(node); x = 300 + index%columns*680; y = 280 + Math.floor(index/columns)*540;
		} else {
			const index = Math.max(0, singles.indexOf(node)); x = 135 + index%singleColumns*220; y = familyRows*540 + 180 + Math.floor(index/singleColumns)*175;
			if (node.kind !== 'task') { const free = graph.nodes.filter(n => n.kind !== 'task' && !n.parent).indexOf(node) + singles.length; x = 135 + free % singleColumns * 220; y = familyRows * 540 + 180 + Math.floor(free / singleColumns) * 175; }
		}
		const angle = seed(node.id + ':position')*Math.PI*2;
		const position = {x:x+Math.cos(angle)*18,y:y+Math.sin(angle)*18,anchorX:x,anchorY:y,vx:0,vy:0,radius:node.radius,parentId:node.parent};
		positions.set(node.id, position); return position;
	};
	for (const node of graph.nodes) place(node);
	placeGraphCrewOnRims(graph, positions);
	return positions;
}

/** Crew use their task's rim, including after relaxation or task dragging. */
export function placeGraphCrewOnRims(graph: TaskGraph, positions: Map<string, GraphPosition>): void {
	for (const node of graph.nodes.filter(n => n.kind !== 'task' && n.parent)) {
		const parent = positions.get(node.parent!), position = positions.get(node.id);
		if (!parent || !position) continue;
		const siblings = graph.nodes.filter(n => n.kind !== 'task' && n.parent === node.parent).sort((a,b) => a.id.localeCompare(b.id));
		const angle = -Math.PI / 2 + (siblings.indexOf(node) - (siblings.length - 1) / 2) * 1.1;
		const distance = parent.radius + node.radius * .55;
		position.x = position.anchorX = parent.x + Math.cos(angle) * distance;
		position.y = position.anchorY = parent.y + Math.sin(angle) * distance;
		position.vx = position.vy = 0;
	}
}

/** Bounded O(n²) collision relaxation. Dormant after settling; no perpetual force timer. */
export function stepGraphLayout(positions: Map<string, GraphPosition>, pinned: string | ReadonlySet<string> | null = null): number {
	const entries = [...positions.entries()];
	for (let i=0;i<entries.length;i++) for(let j=i+1;j<entries.length;j++) {
		const [,a] = entries[i]!, [,b] = entries[j]!;
		const dx = b.x-a.x || 0.01, dy=b.y-a.y || 0.01, distance=Math.hypot(dx,dy);
		// Attached crew are projected onto the rim after the task-only solve.
		if ((a.parentId && !entries[i]![0].startsWith('task:')) || (b.parentId && !entries[j]![0].startsWith('task:'))) continue;
		const minimum = a.radius+b.radius+110;
		if(distance >= minimum) continue;
		const force=(minimum-distance)*0.09;
		a.vx-=dx/distance*force; a.vy-=dy/distance*force; b.vx+=dx/distance*force; b.vy+=dy/distance*force;
	}
	let energy=0;
	for(const [id,p] of entries) {
		if(id===pinned || (typeof pinned === 'object' && pinned?.has(id))) {p.vx=0;p.vy=0;continue;}
		p.vx=(p.vx+(p.anchorX-p.x)*0.025)*0.72; p.vy=(p.vy+(p.anchorY-p.y)*0.025)*0.72;
		p.x+=p.vx; p.y+=p.vy; energy+=Math.abs(p.vx)+Math.abs(p.vy);
	}
	return energy;
}
