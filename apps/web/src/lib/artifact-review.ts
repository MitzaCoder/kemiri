/** Device-local artifact reviews. Plain text contracts shared with a future native client. */
import { REVIEW_INTENTS, reviewText, type ReviewIntent, type ReviewNote, type ReviewStorage } from './review.js';
export { REVIEW_INTENTS, ReviewSubmission as ArtifactReviewSubmission, reviewThreadId, reviewText, reviewCommentCount } from './review.js';
export type { ReviewIntent, ReviewStorage } from './review.js';
export const REVIEW_BLOCKS = ['chart', 'table row', 'figure', 'image', 'code', 'list item', 'paragraph', 'block'] as const;
export type ReviewBlock = typeof REVIEW_BLOCKS[number];
/**
 * `anchor` only places this device's pin; it never enters the review message. `p:` is an element path in the HTML
 * page, `m:` one in rendered Markdown, `s:` a character offset in plain text or source.
 */
export interface ArtifactSelection { text: string; section?: string; elementId?: string; block?: ReviewBlock; anchor?: string }
export interface ReviewComment extends ArtifactSelection, ReviewNote {}
export interface ArtifactReview { comments: ReviewComment[]; overall: string }
export const REVIEW_SELECTION_TYPE = 'kemiri:artifact-selection';
const ALLOWED_KEYS = ['type', 'text', 'section', 'elementId', 'block', 'anchor'];
/** Child indexes from the document body: at most 40 levels of at most five digits. */
export const REVIEW_PATH = /^\d{1,5}(?:\.\d{1,5}){0,39}$/;
const STORED_ANCHOR = /^(?:[pm]:\d{1,5}(?:\.\d{1,5}){0,39}|s:\d{1,9})$/;
export function isReviewAnchor(anchor: unknown): anchor is string { return typeof anchor === 'string' && STORED_ANCHOR.test(anchor); }

/** Accept only the mounted viewer frame, exact text-only fields and the fixed block vocabulary. */
export function validateArtifactSelection(source: unknown, frameWindow: unknown, input: unknown): ArtifactSelection | undefined {
	if (frameWindow == null || source !== frameWindow || input === null || typeof input !== 'object') return;
	const prototype = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) return;
	const descriptors = Object.getOwnPropertyDescriptors(input);
	if (Reflect.ownKeys(input).some(key => typeof key !== 'string' || !ALLOWED_KEYS.includes(key))) return;
	for (const descriptor of Object.values(descriptors)) if (!('value' in descriptor) || typeof descriptor.value !== 'string') return;
	const fields = input as Record<string, string>;
	if (fields.type !== REVIEW_SELECTION_TYPE || typeof fields.text !== 'string') return;
	if (fields.block !== undefined && !(REVIEW_BLOCKS as readonly string[]).includes(fields.block)) return;
	if (fields.anchor !== undefined && !REVIEW_PATH.test(fields.anchor)) return;
	return { ...(fields.anchor === undefined ? {} : { anchor: `p:${fields.anchor}` }), text: reviewText(fields.text, 4000), ...(fields.section === undefined ? {} : { section: reviewText(fields.section, 300) }), ...(fields.elementId === undefined ? {} : { elementId: reviewText(fields.elementId, 120) }), ...(fields.block === undefined ? {} : { block: fields.block as ReviewBlock }) };
}

export function reviewLocation(comment: ArtifactSelection): string {
	return [reviewText(comment.section ?? '', 300), comment.block ? `(${comment.block})` : ''].filter(Boolean).join(' ');
}

export function formatArtifactReview(artifact: { title: string; id: string; version: number; name: string }, review: ArtifactReview): string {
	const header = `Comments on "${reviewText(artifact.title, 300).replaceAll('"', '′').replace(/\n/g, ' ')}"\n(artifact ${artifact.id.replace(/~\d+$/, '')}~${artifact.version}, ${reviewText(artifact.name, 300).replace(/\n/g, ' ')})`;
	const comments = review.comments.map((comment, index) => {
		const location = reviewLocation(comment);
		const quote = reviewText(comment.text, 4000).split('\n').map(line => (line ? `> ${line}` : '>')).join('\n');
		const note = reviewText(comment.note, 4000);
		return `${index + 1}. ${comment.intent ?? 'Note'}${location ? ` · ${location}` : ''}\n${quote}${note ? `\n\n${note}` : ''}`;
	});
	const overall = reviewText(review.overall, 4000);
	return [header, ...comments, ...(overall ? [`Overall: ${overall}`] : [])].join('\n\n');
}

export function artifactReviewKey(backend: string, project: string, id: string, version: number): string {
	return 'kemiri.artifact-review.v1:' + JSON.stringify([backend, project, id.replace(/~\d+$/, ''), version]);
}
export function loadArtifactReview(storage: ReviewStorage, key: string): ArtifactReview {
	try {
		const saved = JSON.parse(storage.getItem(key) ?? 'null');
		if (!saved || !Array.isArray(saved.comments) || typeof saved.overall !== 'string') return { comments: [], overall: '' };
		const comments: ReviewComment[] = [];
		for (const comment of saved.comments.slice(0, 100)) {
			if (!comment || typeof comment.note !== 'string' || (comment.intent !== undefined && !REVIEW_INTENTS.includes(comment.intent))) continue;
			const { intent, note, anchor, ...selection } = comment;
			const validated = validateArtifactSelection(storage, storage, { type: REVIEW_SELECTION_TYPE, ...selection });
			if (validated?.text && (intent || note.trim())) comments.push({ ...validated, ...(isReviewAnchor(anchor) ? { anchor } : {}), intent, note: reviewText(note, 4000) });
		}
		return { comments, overall: reviewText(saved.overall, 4000) };
	} catch { return { comments: [], overall: '' }; }
}
/** False means storage is unavailable: tell the reader their review lasts only for this visit. */
export function saveArtifactReview(storage: ReviewStorage, key: string, review: ArtifactReview): boolean {
	try {
		if (!review.comments.length && !review.overall.trim()) storage.removeItem(key);
		else storage.setItem(key, JSON.stringify(review));
		return true;
	} catch { return false; }
}

/** The nearest heading before the selected node, not the next heading in its section. */
export function precedingArtifactHeading(scope: Element, node: Node): string {
	let heading = '';
	for (const candidate of scope.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
		if (candidate.contains(node) || candidate.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) heading = candidate.textContent ?? '';
		else break;
	}
	return reviewText(heading, 300);
}

/** An unfinished editor is local to this version and separate from the review that can be sent. */
export interface ArtifactCommentDraft { selection: ArtifactSelection; intent?: ReviewIntent; note: string; index?: number }
export function loadArtifactCommentDraft(storage: ReviewStorage, key: string): ArtifactCommentDraft | undefined {
	try {
		const draft = JSON.parse(storage.getItem(`${key}:editor`) ?? 'null');
		if (!draft?.selection || typeof draft.note !== 'string' || (!draft.intent && !draft.note) ||
			(draft.intent !== undefined && !REVIEW_INTENTS.includes(draft.intent)) ||
			(draft.index !== undefined && (!Number.isInteger(draft.index) || draft.index < 0 || draft.index >= 100))) return;
		const { anchor, text, section, elementId, block } = draft.selection;
		const selection = validateArtifactSelection(storage, storage, {
			type: REVIEW_SELECTION_TYPE, text,
			...(section === undefined ? {} : { section }),
			...(elementId === undefined ? {} : { elementId }),
			...(block === undefined ? {} : { block }),
		});
		if (!selection?.text) return;
		return { selection: { ...selection, ...(isReviewAnchor(anchor) ? { anchor } : {}) }, intent: draft.intent, note: draft.note.slice(0, 4000), index: draft.index };
	} catch { return; }
}
export function saveArtifactCommentDraft(storage: ReviewStorage, key: string, draft?: ArtifactCommentDraft): boolean {
	try {
		if (draft && (draft.note || draft.intent)) storage.setItem(`${key}:editor`, JSON.stringify(draft));
		else storage.removeItem(`${key}:editor`);
		return true;
	} catch { return false; }
}
