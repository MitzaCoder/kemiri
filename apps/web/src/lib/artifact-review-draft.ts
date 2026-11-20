import { attachDiscussion } from './artifact-discuss.ts';
import { loadDraft, saveDraft, type Draft } from './drafts.ts';

export const REVIEW_DRAFT_EVENT = 'kemiri:append-review-draft';
export interface ReviewDraftAppend { key: string; text: string; taskId?: string; handled: boolean; discussion?: boolean }
export function appendReviewDraft(draft: Draft, text: string, taskId?: string, discussion = false): Draft {
	if (discussion) return attachDiscussion(draft, text, taskId);
	return { ...draft, text: [draft.text, text].filter(part => part.length > 0).join('\n\n'), ...(taskId ? { taskId } : {}) };
}
/** Mounted composers consume this synchronously; other chats restore the same local draft on navigation. */
export function moveReviewToDraft(storage: Storage, target: Window, key: string, text: string, taskId?: string, discussion = false): void {
	const request: ReviewDraftAppend = { key, text, taskId, handled: false, discussion };
	target.dispatchEvent(new CustomEvent(REVIEW_DRAFT_EVENT, { detail: request }));
	if (request.handled) return;
	const appended = appendReviewDraft(loadDraft(storage, key), text, taskId, discussion);
	saveDraft(storage, key, appended);
	if (loadDraft(storage, key).text !== appended.text) throw new Error(discussion ? 'Could not save the chat draft.' : 'Could not save the chat draft. Your comments are still here.');
}
