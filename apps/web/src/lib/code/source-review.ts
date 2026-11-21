import { quoteFromSelection, selectionInWholeWords } from '../chat/quotes.js';
import { reviewText, type ArtifactSelection } from '../artifact-review.js';
import type { ReviewRect } from '../artifact-review-anchors.js';

export interface SourceReview {
	selection(): ArtifactSelection | undefined;
	rect(anchor?: string): ReviewRect | undefined;
	reveal(anchor: string): void;
	clearSelection(): void;
}

/** CodeMirror normalizes CRLF. Keep `s:` anchors in the original UTF-16 offset space used by the plain preview. */
export function sourceOffsets(source: string) {
	const crlf = Array.from(source.matchAll(/\r\n/g), (match, index) => match.index - index);
	const originalOffset = (position: number) => position + countBefore(crlf, position);
	const normalizedOffset = (position: number) => {
		let low = 0, high = crlf.length;
		while (low < high) {
			const mid = (low + high) >>> 1;
			if (crlf[mid]! + mid < position) low = mid + 1;
			else high = mid;
		}
		return position - low;
	};
	return { originalOffset, normalizedOffset };
}

function countBefore(positions: number[], position: number): number {
	let low = 0, high = positions.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (positions[mid]! < position) low = mid + 1;
		else high = mid;
	}
	return low;
}

export function sourceSelection(doc: { length: number; sliceString(from: number, to: number): string }, from: number, to: number, originalOffset: (position: number) => number): ArtifactSelection | undefined {
	if (from < 0 || to > doc.length || from >= to) return;
	const excerptEnd = Math.min(to, from + 4100);
	const excerpt = doc.sliceString(from, excerptEnd);
	const left = doc.sliceString(Math.max(0, from - 1), from);
	const right = doc.sliceString(excerptEnd, Math.min(excerptEnd + 1, doc.length));
	const text = reviewText(quoteFromSelection(selectionInWholeWords(excerpt,
		{ text: left + excerpt, offset: left.length }, { text: excerpt + right, offset: excerpt.length })), 4000);
	return text ? { text, section: '', anchor: `s:${originalOffset(from)}` } : undefined;
}
