import type { BoardQuestion, BoardTask, ThreadSummary } from '@kemiri/protocol';
import { projectHref, threadHref } from './backends.js';

export const COORDINATOR_COLORS = {
	Slate: '#7e8ca4', Violet: '#9873e1', Blue: '#5087dc', Teal: '#279c8e',
	Amber: '#ba8036', Rose: '#d2688c', Green: '#699747',
} as const;

export function coordinatorColor(thread: ThreadSummary | undefined): string {
	return Object.values<string>(COORDINATOR_COLORS).find(color => color === thread?.color) ?? COORDINATOR_COLORS.Slate;
}

export function coordinatorMark(title: string): string {
	return Array.from(title.trim())[0]?.toLocaleUpperCase() ?? '?';
}

export function coordinatorRoster(threads: readonly ThreadSummary[], enabled = true): ThreadSummary[] {
	if (!enabled) return [];
	return threads.filter(thread => !thread.archived && (thread.main || thread.kind === 'coordinator'))
		.sort((a, b) => Number(b.main) - Number(a.main) || (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
}

export function coordinatorOfThread(threadId: string | null | undefined, threads: readonly ThreadSummary[]): string {
	const thread = threads.find(thread => thread.id === threadId);
	return thread?.kind === 'coordinator' ? thread.id : thread?.parentThreadId ?? 'main';
}

export function coordinatorBadges(thread: ThreadSummary, seen: string | null = null) {
	const attention = thread.attention;
	const needsYou = attention ? attention.questions + attention.warnings + attention.steps + attention.review + attention.failed : thread.openQuestions + Number(thread.status === 'failed');
	const working = thread.status === 'running' || thread.runningWorkers > 0;
	const unread = !!thread.lastReplyAt && (!seen || thread.lastReplyAt > seen);
	const state = thread.status === 'failed' ? 'Failed' : needsYou ? 'Needs you' : thread.held ? 'Paused' : working ? 'Working' : 'Idle';
	return { needsYou, working, unread, paused: thread.held === true, state };
}

export function coordinatorStatus(thread: ThreadSummary): string {
	return [thread.failure || thread.current,
		thread.runningWorkers ? `${thread.runningWorkers} running` : '',
		thread.openTasks !== undefined ? `${thread.openTasks} open tasks` : ''].filter(Boolean).join(' · ');
}

export function coordinatorHref(backendId: string, projectId: string, coordinatorId = 'main'): string {
	return coordinatorId === 'main' ? projectHref(backendId, projectId) : threadHref(backendId, projectId, coordinatorId);
}

export function coordinatorShortcut(event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'code' | 'repeat'>): number | undefined {
	return event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.repeat && /^Digit[1-9]$/.test(event.code) ? Number(event.code.at(-1)) - 1 : undefined;
}

export function taskCoordinator(task: Pick<BoardTask, 'coordinatorId'>): string { return task.coordinatorId ?? 'main'; }
export function ownerThreadId(coordinatorId: string): string | null { return coordinatorId === 'main' ? null : coordinatorId; }

export function scopedTasks(tasks: readonly BoardTask[], coordinatorId?: string, hidden?: ReadonlySet<string>): BoardTask[] {
	return tasks.filter(task => coordinatorId === undefined ? !hidden?.has(taskCoordinator(task)) : taskCoordinator(task) === coordinatorId);
}

export function externalParts(parent: BoardTask, tasks: readonly BoardTask[], shown: ReadonlySet<string>): BoardTask[] {
	return tasks.filter(part => !part.archived && part.parent === parent.id && taskCoordinator(part) !== taskCoordinator(parent) && !shown.has(part.id));
}

export function scopedQuestions(questions: readonly BoardQuestion[], threads: readonly ThreadSummary[], coordinatorId?: string, hidden?: ReadonlySet<string>): BoardQuestion[] {
	return questions.filter(question => {
		const owner = coordinatorOfThread(question.threadId, threads);
		return coordinatorId === undefined ? !hidden?.has(owner) : owner === coordinatorId;
	});
}

export function coordinatorStorageKey(backendId: string, projectId: string, field: string): string {
	return `aiki.coordinators.v1:${encodeURIComponent(backendId)}:${encodeURIComponent(projectId)}:${field}`;
}

export function readCoordinatorPreference(key: string): string | null {
	try { return localStorage.getItem(key); } catch { return null; }
}

export function saveCoordinatorPreference(key: string, value: string): void {
	try { localStorage.setItem(key, value); } catch { /* private/device storage may be unavailable */ }
}

/** Use the preference on project entry links, never as a redirect from General. */
export function projectEntryHref(backendId: string, projectId: string, enabled: boolean, read = readCoordinatorPreference): string {
	const last = enabled ? read(coordinatorStorageKey(backendId, projectId, 'last')) : null;
	return coordinatorHref(backendId, projectId, last || 'main');
}
