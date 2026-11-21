/** Where a review comment sits on screen: validated frame rectangles, pin and pop-up placement, text anchors. */
import { isReviewAnchor, REVIEW_PATH, type ReviewComment } from './artifact-review.ts';

export const REVIEW_ANCHORS_TYPE = 'kemiri:artifact-anchors';
/** The live selection's key in a rectangle report; every other key is a stored anchor. */
export const SELECTION_RECT = '*';
export interface ReviewRect { x: number; y: number; width: number; height: number }
export interface ReviewSurface { width: number; height: number }

const RECT = /^(-?\d{1,7}),(-?\d{1,7}),(\d{1,7}),(\d{1,7})$/;

/**
 * Rectangles the sandboxed page reports for its selection and the watched anchors, in its own viewport pixels. Only the
 * mounted frame, a plain two-string object and bounded integers are accepted. A hostile page can misplace its own pins
 * inside the frame's box, nothing else.
 */
export function validateArtifactRects(source: unknown, frameWindow: unknown, input: unknown): Map<string, ReviewRect> | undefined {
	if (frameWindow == null || source !== frameWindow || input === null || typeof input !== 'object') return;
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) return;
	const keys = Reflect.ownKeys(input);
	if (keys.length !== 2 || !keys.includes('type') || !keys.includes('rects')) return;
	for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(input))) if (!('value' in descriptor) || typeof descriptor.value !== 'string') return;
	const fields = input as { type: string; rects: string };
	if (fields.type !== REVIEW_ANCHORS_TYPE || fields.rects.length > 40_000) return;
	const rects = new Map<string, ReviewRect>();
	if (!fields.rects) return rects;
	const entries = fields.rects.split('|');
	if (entries.length > 101) return;
	for (const entry of entries) {
		const at = entry.indexOf('=');
		const key = entry.slice(0, at), match = RECT.exec(entry.slice(at + 1));
		if (at < 1 || !match || (key !== SELECTION_RECT && !REVIEW_PATH.test(key))) return;
		const anchor = key === SELECTION_RECT ? key : `p:${key}`;
		if (rects.has(anchor)) return;
		rects.set(anchor, { x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) });
	}
	return rects;
}

/** The parent-only string asking the page to report these comments' elements; other anchor kinds are not its business. */
export function watchAnchorsMessage(comments: readonly { anchor?: string }[]): string {
	const paths = new Set<string>();
	for (const comment of comments) if (isReviewAnchor(comment.anchor) && comment.anchor.startsWith('p:') && paths.size < 100) paths.add(comment.anchor.slice(2));
	return `kemiri:watch-artifact-anchors:${[...paths].join('|')}`;
}

export interface ReviewPin { anchor: string; rect: ReviewRect; x: number; y: number; comments: number[] }
const PIN_WIDTH = 44, PIN_HEIGHT = 44;

/**
 * One pin for each commented element in view, at its top right corner. HTML pins leave with that edge instead of
 * sticking to the viewport; text pins keep their existing edge placement. Overlapping pins step to the left.
 */
export function reviewPins(comments: readonly ReviewComment[], rects: ReadonlyMap<string, ReviewRect>, surface: ReviewSurface, pinFollowsTopEdge = false): ReviewPin[] {
	const pins = new Map<string, ReviewPin>();
	comments.forEach((comment, index) => {
		const rect = comment.anchor === undefined ? undefined : rects.get(comment.anchor);
		if (!comment.anchor || !rect) return;
		const pin = pins.get(comment.anchor);
		if (pin) { pin.comments.push(index); return; }
		if (rect.y + rect.height <= 0 || rect.y >= surface.height || rect.x + rect.width <= 0 || rect.x >= surface.width) return;
		if (pinFollowsTopEdge && rect.y < 0) return;
		const edge = PIN_WIDTH / 2;
		const y = pinFollowsTopEdge ? rect.y : clamp(rect.y, PIN_HEIGHT / 2, surface.height - PIN_HEIGHT / 2);
		pins.set(comment.anchor, { anchor: comment.anchor, rect, comments: [index], x: clamp(rect.x + rect.width, edge, surface.width - edge), y });
	});
	const placed: ReviewPin[] = [];
	for (const pin of pins.values()) {
		const overlaps = () => placed.some(other => Math.abs(other.x - pin.x) < PIN_WIDTH && Math.abs(other.y - pin.y) < PIN_HEIGHT);
		while (overlaps() && pin.x >= PIN_WIDTH * 1.5) pin.x -= PIN_WIDTH;
		placed.push(pin);
	}
	return placed;
}

function clamp(value: number, low: number, high: number): number { return Math.max(low, Math.min(Math.max(low, high), value)); }

/**
 * A card beside its target: below when it fits, else above, else over the visible part. It never leaves the surface
 * sideways, and a target scrolled out of view leaves the card at the nearest edge.
 */
export function placeReviewCard(target: ReviewRect, surface: ReviewSurface, card: ReviewSurface, gap = 8, margin = 8): { left: number; top: number; side: 'below' | 'above' | 'over' } {
	const top = clamp(target.y, 0, surface.height), bottom = clamp(target.y + target.height, 0, surface.height);
	const left = clamp(target.x, margin, surface.width - card.width - margin);
	if (bottom + gap + card.height + margin <= surface.height) return { left, top: bottom + gap, side: 'below' };
	if (top - gap - card.height - margin >= 0) return { left, top: top - gap - card.height, side: 'above' };
	return { left, top: clamp(bottom + gap, margin, surface.height - card.height - margin), side: 'over' };
}

/** The nearest block-level element holding `node`, as child indexes below `root`. Empty when it is the root itself. */
export function blockPath(root: Element, node: Node): string {
	let element = node instanceof Element ? node : node.parentElement;
	while (element && element !== root && root.contains(element) && getComputedStyle(element).display.startsWith('inline')) element = element.parentElement;
	const parts: number[] = [];
	for (; element && element !== root; element = element.parentElement) {
		const parent: Element | null = element.parentElement;
		if (!parent) return '';
		parts.unshift(Array.prototype.indexOf.call(parent.children, element));
	}
	const path = parts.join('.');
	return element === root && REVIEW_PATH.test(path) ? path : '';
}

/** The character offset of a range's start within the text of `root`. */
export function textOffset(root: Element, range: Range): number {
	const before = document.createRange();
	before.selectNodeContents(root);
	before.setEnd(range.startContainer, range.startOffset);
	return before.toString().length;
}

/** Where a stored Markdown (`m:`) or plain text (`s:`) anchor is now, in viewport pixels. */
export function anchorClientRect(root: Element, kind: 'm' | 's', anchor: string): ReviewRect | undefined {
	if (!isReviewAnchor(anchor) || !anchor.startsWith(`${kind}:`)) return;
	const locator = anchor.slice(2);
	if (kind === 'm') {
		let element: Element | undefined = root;
		for (const index of locator.split('.')) element = element?.children[Number(index)];
		const rect = element?.getBoundingClientRect();
		return rect && (rect.width || rect.height) ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined;
	}
	let remaining = Number(locator);
	const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
		if (remaining < node.data.length) {
			const range = document.createRange();
			range.setStart(node, remaining);
			range.setEnd(node, remaining + 1);
			const line = range.getClientRects()[0] ?? range.getBoundingClientRect(), whole = root.getBoundingClientRect();
			// The pin belongs at the end of the line's row, not after one character.
			return { x: whole.x, y: line.y, width: whole.width, height: line.height };
		}
		remaining -= node.data.length;
	}
}
