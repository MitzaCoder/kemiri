import type { GraphPosition, TaskGraph } from './task-graph.js';

/** Counts always read the full source, never Live-filtered membership. */
export function graphCounts(graph: TaskGraph): { open: number; working: number; attention: number } {
	const open = graph.nodes.filter(n => n.kind === 'task' && !['done', 'dropped'].includes(n.task!.status));
	return { open: open.length, working: open.filter(n => ['working', 'in_progress', 'clarifying'].includes(n.status)).length, attention: open.filter(n => n.attention).length };
}
/** Task IDs are visible at every zoom, independently of title eligibility. */
export function graphCaptionScale(zoom: number): number { return Math.max(1, .85 / zoom); }
export function graphEdgeSegment(a: GraphPosition, b: GraphPosition): { x1:number; y1:number; x2:number; y2:number } {
	const dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||1;
	return {x1:a.x+dx/d*(a.radius+5),y1:a.y+dy/d*(a.radius+5),x2:b.x-dx/d*(b.radius+9),y2:b.y-dy/d*(b.radius+9)};
}
