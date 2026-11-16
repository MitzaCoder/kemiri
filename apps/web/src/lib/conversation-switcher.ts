import type { ThreadSummary } from '@kemiri/protocol';
import { isMainThread } from '@kemiri/client';
import { projectHref, threadHref } from './backends.js';
import { partitionFinishedJobs } from './threads.js';

export function conversationChoices(threads: readonly ThreadSummary[], backendId: string, projectId: string, currentThreadId: string | undefined, now: number) {
	const grouped = partitionFinishedJobs(threads.filter(thread => !thread.archived), now);
	const row = (thread: ThreadSummary) => ({ title: thread.title || thread.id, href: threadHref(backendId, projectId, thread.id), current: thread.id === currentThreadId, thread });
	return {
		main: { title: 'Main chat', href: projectHref(backendId, projectId), current: isMainThread(currentThreadId) },
		visible: grouped.visible.map(row), finished: grouped.finished.map(row)
	};
}

/** Native links handle Enter; these keys move focus through the menu's actionable rows. */
export function conversationMenuIndex(key: string, index: number, count: number): number | undefined {
	if (!count) return undefined;
	if (key === 'Home') return 0;
	if (key === 'End') return count - 1;
	if (key === 'ArrowDown') return (index + 1 + count) % count;
	if (key === 'ArrowUp') return index < 0 ? count - 1 : (index - 1 + count) % count;
	return undefined;
}
