import { parseCodeRoot, validFilePath } from './file-location.js';
import { REVIEW_INTENTS, reviewText, type ReviewNote, type ReviewStorage } from '../review.js';

export type CodeReviewSource = { kind: 'task'; taskId: string } | { kind: 'commit'; hash: string } | { kind: 'artifact'; versionId: string } | { kind: 'working'; root: string; name: string } | { kind: 'file'; root: string; path: string; hash: string };
export type CodeSide = 'before' | 'after' | 'file';
export interface CodeAnchor { path: string; side: CodeSide; startLine: number; endLine: number; quotedText: string }
export interface CodeComment extends ReviewNote {
	id: string; source: CodeReviewSource; anchor: CodeAnchor;
	replacement?: string; outdated?: boolean;
}
export type CodeReview = { comments: CodeComment[]; overall: string; editor?: CodeComment };
export const MAX_CODE_COMMENTS = 40;
export const MAX_CODE_QUOTE = 4000;
export const MAX_CODE_REVIEW_CHARS = 96 * 1024;
const REANCHOR_DISTANCE = 100;

export const reviewSourceKey = (source: CodeReviewSource) => source.kind === 'task' ? source.taskId : source.kind === 'commit' ? source.hash : source.kind === 'artifact' ? source.versionId : source.kind === 'working' ? source.root : `${source.root}/${source.path}@${source.hash}`;
export function codeReviewKey(backendId: string, projectId: string, source: CodeReviewSource) {
	return 'kemiri.code-review.v1:' + JSON.stringify([backendId, projectId, source.kind, source.kind === 'file' ? [source.root, source.path] : reviewSourceKey(source)]);
}
export const normalizeCode = (text: string) => text.replace(/\r\n?/g, '\n');
export const codeLocation = ({ path, side, startLine, endLine }: CodeAnchor) => `${path.replace(/[\r\n\t]/g, ' ')} · ${side} ${startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`}`;

export type LineDocument = { lines: number; line(number: number): { from: number; to: number; text: string }; sliceString(from: number, to: number): string };
export function codeLineDocument(text: string): LineDocument {
	const source = normalizeCode(text);
	const starts = [0];
	for (let offset = source.indexOf('\n'); offset !== -1; offset = source.indexOf('\n', offset + 1)) starts.push(offset + 1);
	return { lines: starts.length,
		line(number) { const from = starts[number - 1]!, to = number < starts.length ? starts[number]! - 1 : source.length; return { from, to, text: source.slice(from, to) }; },
		sliceString(from, to) { return source.slice(from, to); },
	};
}
export function anchorCodeLines(doc: LineDocument, path: string, side: CodeSide, startLine: number, endLine: number): CodeAnchor | undefined {
	if (startLine < 1 || endLine < startLine || endLine > doc.lines) return;
	const from = doc.line(startLine).from, to = doc.line(endLine).to;
	if (to - from > MAX_CODE_QUOTE || endLine - startLine >= 100) return;
	return { path, side, startLine, endLine, quotedText: doc.sliceString(from, to) };
}

/** Match complete lines near the old location. Equally close duplicates are ambiguous. */
export function reanchorCodeLines(doc: LineDocument, anchor: CodeAnchor): CodeAnchor | undefined {
	const span = anchor.endLine - anchor.startLine;
	const matches = (at: number) => at >= 1 && at + span <= doc.lines &&
		anchorCodeLines(doc, anchor.path, anchor.side, at, at + span)?.quotedText === anchor.quotedText;
	if (matches(anchor.startLine)) return anchor;
	if (!anchor.quotedText.trim()) return;
	for (let distance = 1; distance <= REANCHOR_DISTANCE; distance++) {
		const left = anchor.startLine - distance, right = anchor.startLine + distance;
		const earlier = matches(left), later = matches(right);
		if (earlier && later) return;
		if (earlier || later) return { ...anchor, startLine: earlier ? left : right, endLine: (earlier ? left : right) + span };
	}
}

// Keep Git-style paths on one line. Quote path bytes that could split a header.
function patchPath(prefix: string, path: string) {
	const value = `${prefix}/${path}`;
	return /[\x00-\x1f\x7f"\\]/.test(value) ? '"' + value.replace(/[\x00-\x1f\x7f"\\]/g, c => c === '"' || c === '\\' ? '\\' + c : '\\' + c.charCodeAt(0).toString(8).padStart(3, '0')) + '"' : value;
}
export function suggestedPatch(anchor: CodeAnchor, replacement: string | undefined): string | undefined {
	if (replacement === undefined || normalizeCode(replacement) === anchor.quotedText) return;
	const oldLines = anchor.quotedText.split('\n');
	const newLines = replacement === '' ? [] : normalizeCode(replacement).split('\n');
	return [`--- ${patchPath('a', anchor.path)}`, `+++ ${patchPath('b', anchor.path)}`,
		`@@ -${anchor.startLine},${oldLines.length} +${newLines.length ? anchor.startLine : anchor.startLine - 1},${newLines.length} @@`,
		...oldLines.map(line => '-' + line), ...newLines.map(line => '+' + line)].join('\n');
}
function fencedDiff(patch: string): string {
	const width = Math.max(2, ...Array.from(patch.matchAll(/`+/g), match => match[0].length)) + 1;
	const fence = '`'.repeat(width);
	return `${fence}diff\n${patch}\n${fence}`;
}
export function formatCodeReview(source: CodeReviewSource, review: CodeReview): string {
	const sourceLabel = (value: CodeReviewSource) => value.kind === 'working'
		? `uncommitted lines in ${reviewText(value.name, 256).replace(/\s+/g, ' ')} (${value.root})` : `${value.kind} ${reviewSourceKey(value)}`;
	const comments = review.comments.map(({ anchor, intent, note, source: commentSource, replacement, outdated }, index) => {
		const origin = sourceLabel(commentSource) === sourceLabel(source) ? '' : ` · ${sourceLabel(commentSource)}`;
		const location = codeLocation(anchor);
		const quote = anchor.quotedText.split('\n').map(line => line ? `> ${line}` : '>').join('\n');
		const cleanNote = reviewText(note, 4000);
		const patch = suggestedPatch(anchor, replacement);
		return `${index + 1}. ${intent ?? 'Note'} · ${location}${origin}${outdated ? ' · Outdated' : ''}\n${quote}${cleanNote ? `\n\n${cleanNote}` : ''}${patch ? `\n\nSuggested edit:\n${fencedDiff(patch)}` : ''}`;
	});
	const overall = reviewText(review.overall, 4000);
	return [`Code review (${sourceLabel(source)})`, ...comments, ...(overall ? [`Overall: ${overall}`] : [])].join('\n\n');
}

export function readCodeReview(storage: ReviewStorage, key: string): CodeReview {
	try {
		const raw = storage.getItem(key);
		if (raw && raw.length <= MAX_CODE_REVIEW_CHARS) {
			const review = JSON.parse(raw);
			if (review && Array.isArray(review.comments)) return {
				comments: review.comments.filter(validCodeComment).slice(0, MAX_CODE_COMMENTS),
				overall: typeof review.overall === 'string' ? review.overall.slice(0, 4000) : '',
				editor: validCodeComment(review.editor) ? review.editor : undefined,
			};
		}
	} catch { /* This device may block storage or carry an invalid draft. */ }
	return { comments: [], overall: '' };
}
function validCodeComment(value: unknown): value is CodeComment {
	if (!value || typeof value !== 'object') return false;
	const { id, anchor, source, intent, note, replacement, outdated } = value as CodeComment;
	if (!source || !(source.kind === 'task' && /^T\d{1,16}$/.test(source.taskId) || source.kind === 'commit' && /^(?:[\da-f]{40}|[\da-f]{64})$/.test(source.hash) ||
		source.kind === 'artifact' && /^[\w-]{1,128}~\d{1,10}$/.test(source.versionId) ||
		source.kind === 'working' && typeof source.root === 'string' && !!parseCodeRoot(source.root) && typeof source.name === 'string' && source.name.length <= 256 ||
		source.kind === 'file' && typeof source.root === 'string' && !!parseCodeRoot(source.root) && typeof source.path === 'string' && validFilePath(source.path) && /^[a-f0-9]{64}$/.test(source.hash))) return false;
	return typeof id === 'string' && id.length <= 100 && !!anchor && typeof anchor.path === 'string' && anchor.path.length > 0 && anchor.path.length <= 4096 &&
		['before', 'after', 'file'].includes(anchor.side) && Number.isSafeInteger(anchor.startLine) && anchor.startLine > 0 && Number.isSafeInteger(anchor.endLine) &&
		anchor.endLine >= anchor.startLine && anchor.endLine - anchor.startLine < 100 && typeof anchor.quotedText === 'string' && anchor.quotedText.length <= MAX_CODE_QUOTE &&
		anchor.quotedText.split('\n').length === anchor.endLine - anchor.startLine + 1 && typeof note === 'string' && note.length <= 4000 &&
		(intent === undefined || REVIEW_INTENTS.includes(intent)) && (replacement === undefined || typeof replacement === 'string' && replacement.length <= MAX_CODE_QUOTE) &&
		(outdated === undefined || typeof outdated === 'boolean');
}
export function writeCodeReview(storage: ReviewStorage, key: string, review: CodeReview): boolean {
	try {
		if (!review.comments.length && !review.overall && !review.editor) storage.removeItem(key);
		else {
			const serialized = JSON.stringify(review);
			if (serialized.length > MAX_CODE_REVIEW_CHARS || review.comments.length > MAX_CODE_COMMENTS) return false;
			storage.setItem(key, serialized);
		}
		return true;
	} catch { return false; }
}
