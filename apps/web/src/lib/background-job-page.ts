import { isMainThread } from '@kemiri/client';
import { threadState, type ThreadSummary } from '@kemiri/protocol';
import { relativeTime } from './relative-time.js';

export function backgroundJobBandText(thread: ThreadSummary, now: number, scheduleName?: string, parentTitle = 'Main chat'): { origin: string; outcome: string; canStop: boolean } {
	const starter = thread.startedBy === 'schedule' ? (scheduleName ? `schedule ${scheduleName}` : 'a schedule') : thread.startedBy === 'user' ? 'you' : parentTitle;
	const state = thread.state ?? threadState(thread);
	const ended = relativeTime(thread.finishedAt ?? thread.updatedAt, now);
	const outcome = state === 'finished' ? `Finished ${ended} · its report is in ${parentTitle}`
		: state === 'stopped' ? `Stopped ${ended} · ${parentTitle} keeps what it reported so far`
		: state === 'failed' ? `Failed ${ended} · send a message to retry`
		: 'reports back there when it finishes';
	return { origin: `started by ${starter} ${relativeTime(thread.createdAt, now)}`, outcome, canStop: state !== 'finished' && state !== 'stopped' };
}

export function openBackgroundJobLabel(threadId: string | undefined, threads: readonly ThreadSummary[]): string | undefined {
	if (isMainThread(threadId)) return undefined;
	return `Open: ${threads.find(thread => thread.id === threadId)?.title || threadId}`;
}
