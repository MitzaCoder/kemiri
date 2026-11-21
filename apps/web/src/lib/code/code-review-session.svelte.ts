import type { HarnessClient } from '@kemiri/client';
import { draftKey } from '../drafts.js';
import { moveReviewToDraft } from '../artifact-review-draft.js';
import { ReviewSubmission, reviewSubmitOptions, reviewThreadId, reviewText } from '../review.js';
import { codeReviewKey, formatCodeReview, MAX_CODE_COMMENTS, MAX_CODE_REVIEW_CHARS, readCodeReview, reanchorCodeLines, reviewSourceKey,
	suggestedPatch, writeCodeReview, type CodeAnchor, type CodeComment, type CodeReviewSource, type CodeSide, type LineDocument } from './code-review.js';

export class CodeReviewSession {
	comments = $state<CodeComment[]>([]);
	overall = $state('');
	editor = $state<CodeComment>();
	trayOpen = $state(false);
	busy = $state(false);
	problem = $state('');
	status = $state('');
	stored = $state(true);
	private readonly key: string;
	private readonly submission = new ReviewSubmission();
	private returnFocus?: () => void;
	readonly recipient?: string;

	constructor(readonly source: CodeReviewSource, readonly backendId: string, readonly projectId: string,
		private readonly client: HarnessClient, readonly taskId?: string, sourceThreadId?: string) {
		this.key = codeReviewKey(backendId, projectId, source);
		this.recipient = reviewThreadId(taskId, sourceThreadId);
		const previous = readCodeReview(localStorage, this.key);
		this.comments = previous.comments;
		this.overall = previous.overall;
		this.editor = previous.editor;
	}

	persist(): void {
		this.stored = writeCodeReview(localStorage, this.key, { comments: this.comments, overall: this.overall, editor: this.editor });
	}

	start(source: CodeReviewSource, anchor: CodeAnchor, focus: () => void): void {
		if (this.busy) return;
		if (this.editor) { this.openTray(); return; }
		if (this.comments.length >= MAX_CODE_COMMENTS) { this.problem = `A review can hold ${MAX_CODE_COMMENTS} comments. Send or remove some first.`; this.openTray(); return; }
		this.problem = '';
		this.returnFocus = focus;
		this.editor = { id: crypto.randomUUID(), source, anchor, note: '' };
	}

	edit(comment: CodeComment): void {
		if (this.busy || this.editor) return;
		const opener = document.activeElement as HTMLElement | null;
		this.returnFocus = () => { if (opener?.isConnected) opener.focus(); };
		this.editor = { ...comment };
	}

	cancel(): void {
		this.editor = undefined;
		const focus = this.returnFocus;
		this.returnFocus = undefined;
		requestAnimationFrame(() => focus?.());
	}

	add(): void {
		const draft = this.editor;
		if (!draft || this.busy || !(draft.intent || draft.note.trim() || suggestedPatch(draft.anchor, draft.replacement))) return;
		const comment = { ...draft, note: reviewText(draft.note, 4000) };
		let comments = this.comments.map(row => row.id === draft.id ? comment : row);
		if (!comments.some(row => row.id === draft.id)) comments = [...comments, comment];
		if (JSON.stringify({ comments, overall: this.overall }).length > MAX_CODE_REVIEW_CHARS - 5000) {
			this.problem = 'This review is full. Send or remove saved comments before adding more.';
			return;
		}
		this.comments = comments;
		this.cancel();
	}

	remove(id: string): void { if (!this.busy && this.editor?.id !== id) this.comments = this.comments.filter(comment => comment.id !== id); }
	openTray(): void { this.trayOpen = true; }
	matching(source: CodeReviewSource, path: string, side?: CodeSide): CodeComment[] {
		return this.comments.filter(comment => sameReviewSource(comment.source, source) && comment.anchor.path === path && (!side || comment.anchor.side === side));
	}

	reconcile(source: CodeReviewSource, path: string, side: CodeSide, doc: LineDocument | undefined, fromPath?: string): void {
		const update = (comment: CodeComment) => {
			if (!sameReviewSource(comment.source, source) || (comment.anchor.path !== path && comment.anchor.path !== fromPath) || comment.anchor.side !== side) return comment;
			const candidate = doc ? reanchorCodeLines(doc, comment.anchor) : undefined;
			if (!candidate) return comment.outdated ? comment : { ...comment, outdated: true };
			if (candidate === comment.anchor && !comment.outdated && candidate.path === path) return comment;
			return { ...comment, anchor: { ...candidate, path }, outdated: undefined };
		};
		const comments = this.comments.map(update);
		if (comments.some((comment, at) => comment !== this.comments[at])) this.comments = comments;
		if (this.editor) {
			const updated = update(this.editor);
			if (updated !== this.editor) this.editor = updated;
		}
	}

	private clear(): void {
		this.submission.accepted();
		this.comments = [];
		this.overall = '';
		this.editor = undefined;
	}

	async send(recheck?: () => Promise<void>): Promise<void> {
		if (this.busy || !this.comments.length || this.editor) return;
		this.busy = true;
		this.problem = '';
		this.status = '';
		try {
			await recheck?.();
			const text = formatCodeReview(this.source, this);
			await this.client.submit(this.projectId, text, reviewSubmitOptions(this.taskId, this.recipient, this.submission.requestIdFor(text)));
			this.clear();
			this.status = this.taskId ? `Sent to ${this.taskId}. It appears under Your notes.` : 'Sent to chat.';
		} catch (error) {
			this.problem = `${error instanceof Error ? error.message : 'Could not send the review.'} The comments are kept.`;
		} finally { this.busy = false; }
	}

	toDraft(): boolean {
		if (this.busy || !this.comments.length || this.editor) return false;
		try {
			moveReviewToDraft(localStorage, window, draftKey(this.backendId, this.projectId, this.recipient), formatCodeReview(this.source, this), this.taskId);
			this.clear();
			return true;
		} catch (error) { this.problem = error instanceof Error ? error.message : 'Could not add to chat draft.'; return false; }
	}
}

export const sameReviewSource = (a: CodeReviewSource, b: CodeReviewSource) => a.kind === b.kind && reviewSourceKey(a) === reviewSourceKey(b);
