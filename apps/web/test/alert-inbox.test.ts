import { expect, test } from 'bun:test';
import type { NotificationAlert } from '@kemiri/protocol';
import type { AlertRow } from '../src/lib/alerts.js';
import { inboxCoordinatorLabel, inboxDayGroups, inboxHeadline, inboxUnreadCount, latestInboxRows } from '../src/lib/alert-inbox.js';

const now = new Date(2026, 0, 9, 12);
const localDate = (day: number, hour = 0) => new Date(2026, 0, day, hour).toISOString();
function row(alert: Partial<NotificationAlert> = {}, marks: Partial<Omit<AlertRow, 'alert'>> = {}): AlertRow {
	return { backendId: 'lab', read: false, shown: false, done: false, dismissed: false, ...marks,
		alert: { seq: 1, backendEpoch: 'initial-epoch', key: 'question', tag: 'question', level: 'urgent', kind: 'board_question',
			at: localDate(9, 8), title: 'Recipe API · Planner', body: 'Which units should the import use?', projectId: 'recipes',
			backendKey: 'server-key', coordinatorId: 'planner', workerId: null, scheduleId: null, ...alert } };
}

test('one item per backend and tag keeps the most recent wording and read/done state', () => {
	const old = row({}, { read: true });
	const latest = row({ seq: 2, key: 'question-revised', body: 'Which volume?', at: localDate(9, 7) }, { done: true });
	const other = row({ at: localDate(9, 10) }, { backendId: 'studio', read: true });
	const rows = latestInboxRows([old, other, latest]);
	expect(rows).toEqual([other, latest]);
	expect(inboxUnreadCount(rows)).toBe(1);
});

test('an epoch change compares the newest row from each epoch by time, not sequence', () => {
	const older = row({ seq: 100, at: localDate(7) });
	const restarted = row({ seq: 1, backendEpoch: 'new-epoch', at: localDate(8) });
	expect(latestInboxRows([restarted, older])).toEqual([restarted]);
});

test('groups newest first into local calendar days including the midnight boundaries', () => {
	const today = row({ tag: 'today', at: localDate(9) });
	const yesterday = row({ tag: 'yesterday', at: localDate(8) });
	const earlier = row({ tag: 'earlier', at: localDate(7, 23) });
	expect(inboxDayGroups(latestInboxRows([yesterday, earlier, today]), 'all', now.getTime())).toEqual([
		{ day: 'Today', rows: [today] }, { day: 'Yesterday', rows: [yesterday] }, { day: 'Earlier', rows: [earlier] },
	]);
});

test('filtering keeps unresolved urgent and important items, failures, and known finished kinds', () => {
	const question = row();
	const done = row({ kind: 'task_review', level: 'important', tag: 'review' }, { done: true });
	const failure = row({ kind: 'worker_failed', level: 'important', tag: 'failure' });
	const maintenance = row({ kind: 'maintenance_failed', level: 'info', tag: 'maintenance' });
	const finished = row({ kind: 'thread_finished', level: 'info', tag: 'done' });
	const rows = latestInboxRows([question, failure, done, maintenance, finished]);
	const matches = (filter: 'needs-me' | 'failures' | 'finished') => new Set(inboxDayGroups(rows, filter, now.getTime()).flatMap(group => group.rows));
	expect(matches('needs-me')).toEqual(new Set([question, failure]));
	expect(matches('failures')).toEqual(new Set([failure, maintenance]));
	expect(matches('finished')).toEqual(new Set([finished]));
});

test('headline and source metadata put the actual question first', () => {
	const { alert } = row();
	expect(inboxHeadline(alert)).toBe('Which units should the import use?');
	expect(inboxCoordinatorLabel(alert, 'Recipe API')).toBe('Planner');
	expect(inboxCoordinatorLabel({ ...alert, title: 'Question · Recipe API' }, 'Recipe API')).toBeUndefined();
});
