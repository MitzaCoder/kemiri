import { loadDraft, saveDraft, type Draft } from './drafts.ts';

export const REVIEW_DRAFT_EVENT = 'kemiri:append-review-draft';
export interface ReviewDraftAppend { key: string; text: string; taskId?: string; handled: boolean }
export function appendReviewDraft(draft: Draft, text: string, taskId?: string): Draft {
	return { ...draft, text: [draft.text, text].filter(part => part.length > 0).join('\n\n'), ...(taskId ? { taskId } : {}) };
}
/** Mounted composers consume this synchronously; other chats restore the same local draft on navigation. */
export function moveReviewToDraft(storage: Storage, target: Window, key: string, text: string, taskId?: string): void {
	const request: ReviewDraftAppend = { key, text, taskId, handled: false };
	target.dispatchEvent(new CustomEvent(REVIEW_DRAFT_EVENT, { detail: request }));
	if (request.handled) return;
	const appended = appendReviewDraft(loadDraft(storage, key), text, taskId);
	saveDraft(storage, key, appended);
	if (loadDraft(storage, key).text !== appended.text) throw new Error('Could not save the chat draft. Your comments are still here.');
}
