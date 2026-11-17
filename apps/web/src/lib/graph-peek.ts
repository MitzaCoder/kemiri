import { placeCard, visiblePart, type Box } from './ref-card.js';
import { graphFoldExpansion, revealGraphTask, type GraphFold, type GraphFoldKind } from './task-graph-live.js';
import type { TaskGraph } from './task-graph.js';

export const GRAPH_PEEK_HOVER_MS = 250;
export const GRAPH_PEEK_LEAVE_MS = 180;

/** Captions and glyphs are inside the SVG link; only its task identity opens a task preview. */
export function graphPeekTaskId(nodeId: string | null | undefined): string | undefined {
	return nodeId?.startsWith('task:') && nodeId.length > 5 ? nodeId.slice(5) : undefined;
}

/** Open a worker's complete task group (and prerequisites) before focusing its retained All-view slot. */
export function graphPeekWorkerFolds(graph: TaskGraph, folds: readonly GraphFold[], expanded: ReadonlySet<GraphFoldKind>, workerId: string): Set<GraphFoldKind> {
	const parent = graph.nodes.find(node => node.worker?.id === workerId)?.parent;
	return graphFoldExpansion(graph, folds, revealGraphTask(folds, expanded, graphPeekTaskId(parent) ?? null));
}

/** Actual touch always wins. A pointer-less display can report hover:none even when driven by a mouse. */
export function graphPeekUsesSheet(pointerType: string | undefined, touchOnlyMedia: boolean, touchPoints: number): boolean {
	return pointerType === 'touch' || (touchOnlyMedia && touchPoints > 0);
}

/** Pointer travel must not turn a pan, node drag or pinch into a sheet-opening tap. */
export function graphPeekDragged(start: { x: number; y: number }, point: { x: number; y: number }): boolean {
	return Math.hypot(point.x - start.x, point.y - start.y) >= 4;
}

/** Measure in viewport pixels, then return stage-local coordinates, clipped to both stage and viewport. */
export function placeGraphPeek(anchor: Box, stage: Box, card: { width: number; height: number }, viewport: { width: number; height: number }) {
	const bounds = visiblePart(stage, viewport);
	const width = Math.max(0, Math.min(360, bounds.width - 16));
	const maxHeight = Math.max(0, bounds.height - 16);
	const outside = anchor.left + anchor.width < bounds.left || anchor.left > bounds.left + bounds.width ||
		anchor.top + anchor.height < bounds.top || anchor.top > bounds.top + bounds.height || !bounds.width || !bounds.height;
	const target = placeCard(anchor, { width, height: Math.min(card.height, maxHeight) }, bounds);
	return { left: target.left - stage.left, top: target.top - stage.top, width, maxHeight, outside: !!outside };
}
