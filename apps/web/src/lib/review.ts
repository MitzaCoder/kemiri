import { quoteFromSelection } from './chat/quotes.ts';

export const REVIEW_INTENTS = ['Clarify', 'Change', 'Show differently', 'Cut', 'Keep'] as const;
export type ReviewIntent = typeof REVIEW_INTENTS[number];
/** Task replies always go to main, matching TaskReply; other reviews stay in their source chat. */
export function reviewThreadId(taskId: string | null | undefined, sourceThreadId?: string): string | undefined {
	return taskId ? undefined : sourceThreadId;
}

/** Preserve idempotency through uncertain failures, but never reuse an accepted review's request ID. */
export class ReviewSubmission {
	#attempted?: { text: string; requestId: string };
	constructor(private readonly createId: () => string = () => `review-${crypto.randomUUID()}`) {}
	requestIdFor(text: string): string {
		if (this.#attempted?.text !== text) this.#attempted = { text, requestId: this.createId() };
		return this.#attempted.requestId;
	}
	accepted(): void { this.#attempted = undefined; }
}
export function reviewText(text: string, limit: number): string {
	const clean = quoteFromSelection(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '').trim();
	return clean.length > limit ? clean.slice(0, limit - 1) + '…' : clean;
}

export interface ReviewStorage { getItem(key: string): string | null; setItem(key: string, text: string): void; removeItem(key: string): void }
export function reviewCommentCount(count: number): string { return `${count} ${count === 1 ? 'comment' : 'comments'}`; }

export interface ReviewNote { intent?: ReviewIntent; note: string }

export function reviewSubmitOptions(taskId: string | null | undefined, threadId: string | undefined, requestId: string) {
	return { whenBusy: 'steer' as const, taskId: taskId ?? undefined, threadId: reviewThreadId(taskId, threadId), keepDraft: true, requestId };
}
