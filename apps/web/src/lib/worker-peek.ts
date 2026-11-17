import type { BoardTask, BoardTaskActivity, WorkerIsolation, WorkerSummary } from '@kemiri/protocol';

export type WorkerDoingNow =
	| { source: 'activity'; text: string; activity: BoardTaskActivity }
	| { source: 'report'; text: string };

/** A name alone is not identity: workers can recur in different threads/conversations. */
export function workerDoingNow(
	worker: Pick<WorkerSummary, 'id' | 'conversationId' | 'threadId' | 'taskId' | 'lastReport'>,
	task: Pick<BoardTask, 'id' | 'activity'> | null | undefined,
	activityEnabled = false,
): WorkerDoingNow | undefined {
	const activity = activityEnabled && task?.id === worker.taskId ? task?.activity : undefined;
	const actor = activity?.actor;
	if (activity?.text.trim() && actor?.kind === 'worker' && actor.name === worker.id
		&& actor.conversationId === worker.conversationId && actor.threadId === (worker.threadId ?? 'main')) {
		return { source: 'activity', text: activity.text, activity };
	}
	const text = worker.lastReport?.trim();
	return text ? { source: 'report', text } : undefined;
}

/** Describe isolation without exposing a machine-local path or implying a removed workspace still exists. */
export function workerRunsIn(isolation: WorkerIsolation): string {
	return isolation === 'shared' ? 'shared checkout' : 'its own workspace';
}

/** Main has no thread segment; a background job's worker must keep its thread in the transcript route. */
export function workerTranscriptThread(worker: Pick<WorkerSummary, 'threadId'>): string | undefined {
	return worker.threadId && worker.threadId !== 'main' ? worker.threadId : undefined;
}
