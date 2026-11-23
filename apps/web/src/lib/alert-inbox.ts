import { isNotificationFailure } from '@kemiri/client';
import type { NotificationAlert } from '@kemiri/protocol';
import type { AlertRow } from './alerts.js';

export const INBOX_FILTERS = [
	{ id: 'all', label: 'All' }, { id: 'needs-me', label: 'Needs me' },
	{ id: 'failures', label: 'Failures' }, { id: 'finished', label: 'Finished' },
] as const;
export type InboxFilter = typeof INBOX_FILTERS[number]['id'];
export type InboxDay = 'Today' | 'Yesterday' | 'Earlier';

export function inboxItemId({ backendId, alert }: AlertRow): string {
	return JSON.stringify([backendId, alert.tag]);
}

const byDate = (a: AlertRow, b: AlertRow) => Date.parse(b.alert.at) - Date.parse(a.alert.at);

/** A tag is backend-scoped. Within one epoch its sequence is authoritative, even when clocks changed. */
export function latestInboxRows(rows: readonly AlertRow[]): AlertRow[] {
	const latestInEpoch = new Map<string, AlertRow>();
	for (const row of rows) {
		const id = JSON.stringify([row.backendId, row.alert.backendEpoch, row.alert.tag]);
		const previous = latestInEpoch.get(id);
		if (!previous || row.alert.seq > previous.alert.seq) latestInEpoch.set(id, row);
	}
	const newestFirst = [...latestInEpoch.values()].sort((a, b) => byDate(a, b) || (a.backendId === b.backendId && a.alert.backendEpoch === b.alert.backendEpoch
		? b.alert.seq - a.alert.seq : inboxItemId(a).localeCompare(inboxItemId(b))));
	const included = new Set<string>();
	return newestFirst.filter(row => {
		const id = inboxItemId(row);
		if (included.has(id)) return false;
		included.add(id);
		return true;
	});
}

export function inboxUnreadCount(latest: readonly AlertRow[]): number {
	return latest.reduce((count, row) => count + Number(!row.read), 0);
}

function matchesFilter(row: AlertRow, filter: InboxFilter): boolean {
	switch (filter) {
		case 'all': return true;
		case 'needs-me': return !row.done && (row.alert.level === 'urgent' || row.alert.level === 'important');
		case 'failures': return isNotificationFailure(row.alert.kind);
		case 'finished': return row.alert.kind === 'work_finished' || row.alert.kind === 'thread_finished' || row.alert.kind === 'schedule_done';
	}
}

export function inboxDayGroups(latest: readonly AlertRow[], filter: InboxFilter, now: number): { day: InboxDay; rows: AlertRow[] }[] {
	const date = new Date(now);
	const today = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
	const yesterday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - 1).getTime();
	const groups: Record<InboxDay, AlertRow[]> = { Today: [], Yesterday: [], Earlier: [] };
	for (const row of latest) {
		if (!matchesFilter(row, filter)) continue;
		const at = Date.parse(row.alert.at);
		groups[at >= today ? 'Today' : at >= yesterday ? 'Yesterday' : 'Earlier'].push(row);
	}
	return (['Today', 'Yesterday', 'Earlier'] as const).flatMap(day => groups[day].length ? [{ day, rows: groups[day] }] : []);
}

/** A coordinator name rides along in coordinator-scoped push titles; the source line already shows the project. */
export function inboxCoordinatorLabel(alert: NotificationAlert, projectName: string | undefined): string | undefined {
	if (!alert.coordinatorId || !projectName) return undefined;
	const projectPrefix = `${projectName} · `;
	if (alert.title.startsWith(projectPrefix)) return alert.title.slice(projectPrefix.length) || undefined;
	const failurePrefix = `Coordinator failed · ${projectPrefix}`;
	return alert.title.startsWith(failurePrefix) ? alert.title.slice(failurePrefix.length) || undefined : undefined;
}

export function inboxHeadline(alert: NotificationAlert): string {
	switch (alert.kind) {
		case 'board_question': return alert.body || (alert.warning ? 'There is a warning to check' : 'A question needs an answer');
		case 'task_review': return alert.body ? `“${alert.body.replace(/^T\d+ /, '')}” is ready to check` : 'A task is ready to check';
		case 'reply': return alert.body || 'The coordinator replied';
		case 'worker_failed': return 'A worker stopped before it could report';
		default: return alert.title;
	}
}
