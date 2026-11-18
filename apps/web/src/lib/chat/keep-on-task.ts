import type { HarnessClient } from '@kemiri/client';
import type { BoardKeepOnTaskResponse, BoardTask } from '@kemiri/protocol';
import { replyTaskIds } from '#lib/markdown/parse.js';
import { isSettled } from '#lib/tasks.js';
import type { CommittedReply, TurnPart } from '#lib/transcript.js';

export type ReplyTaskMentions = { reply: CommittedReply; taskIds: string[] };

/** Attach one set of cards to the last text part of each committed assistant entry, not to the whole turn. */
export function replyTasksByPart(parts: readonly TurnPart[]): Map<string, ReplyTaskMentions> {
	const replies = new Map<string, { key: string; reply: CommittedReply; taskIds: Set<string> }>();
	for (const part of parts) {
		if (part.type !== 'text' || !part.reply) continue;
		const reply = part.reply;
		if (![reply.conversationId, reply.entryId].every(id => Number.isSafeInteger(id) && id > 0)) continue;
		const id = `${reply.conversationId}:${reply.entryId}`;
		const mention = replies.get(id) ?? { key: part.key, reply, taskIds: new Set<string>() };
		mention.key = part.key;
		for (const taskId of replyTaskIds(part.text)) mention.taskIds.add(taskId);
		replies.set(id, mention);
	}
	return new Map([...replies.values()].filter(entry => entry.taskIds.size).map(({ key, reply, taskIds }) => [key, { reply, taskIds: [...taskIds] }]));
}

export function canKeepOnTask(supported: boolean, task: Pick<BoardTask, 'status' | 'archived'>): boolean {
	return supported && !task.archived && !isSettled(task.status);
}

const keepErrors: Record<string, string> = {
	unknown_request: 'This backend does not support Keep on task.',
	unknown_project: 'This project is no longer available.',
	unknown_task: 'This task is no longer available.',
	no_coordinator_model: 'Set a coordinator model before keeping this reply on the task.',
	bad_request: 'This reply can no longer be kept on the task. The task may have closed.',
};

export async function keepOnTask(client: Pick<HarnessClient, 'request'>, projectId: string, taskId: string, reply: CommittedReply): Promise<string> {
	let response;
	try {
		response = await client.request<BoardKeepOnTaskResponse>({ type: 'board.keepOnTask', projectId, taskId, ...reply });
	} catch {
		throw new Error('Could not reach the backend. Try again.');
	}
	if (response.type === 'error') throw new Error(keepErrors[response.error.code] ?? 'Could not keep this reply on the task. Try again.');
	if (response.type !== 'board.keepOnTask') throw new Error('Could not keep this reply on the task. Try again.');
	return response.feedbackId;
}

export function taskFeedbackAnchor(feedbackId: string): string {
	return `task-feedback-${feedbackId}`;
}

export function feedbackFromHash(hash: string): string | undefined {
	return /^#task-feedback-(F[1-9]\d*)$/.exec(hash)?.[1];
}
