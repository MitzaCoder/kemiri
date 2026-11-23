import { expect, test } from 'bun:test';
import type { NotificationAlert, NotificationRecentEntry } from '@kemiri/protocol';
import {
	ALERT_CATCH_UP_WINDOW_MS, DEFAULT_ALERT_POPUPS, alertDuration, alertPopupDecision, alertPopupSetting, alertSourceLabel, alertTimeRemaining,
	applyAlertEntry, canAnswerAlert, catchUpPresentation, mergesAlertBurst, reconcileAlertEntries,
	type AlertContext, type AlertPopupSetting, type AlertRow,
} from '../src/lib/alerts.js';
import fixture from './fixtures/in-app-alert-policy-cases.json';

const now = Date.parse('2026-01-01T12:00:00Z');
const context: AlertContext = { backendId: 'workshop', setting: DEFAULT_ALERT_POPUPS, visible: true, soundAllowed: true };
function alert(overrides: Partial<NotificationAlert> = {}): NotificationAlert {
	return { seq: 1, backendEpoch: 'epoch-a', key: 'question-one', tag: 'q1', kind: 'board_question', level: 'urgent',
		projectId: 'recipes', questionId: 'Q1', questionRevision: 1, choices: [{ label: 'Grams', recommended: true }],
		backendKey: 'server-identity', title: 'Recipe API', body: 'Which units?', at: new Date(now).toISOString(),
		workerId: null, scheduleId: null, ...overrides };
}
function row(overrides: Partial<NotificationAlert> = {}): AlertRow {
	return { backendId: 'workshop', alert: alert(overrides), read: false, done: false, shown: false, dismissed: false };
}

const policies = fixture as { name: string; alert: Parameters<typeof alertPopupDecision>[0]; context: AlertContext;
	burst?: { now: number; previousProjectArrivals: number[] }; expected: { pop: boolean; silent: boolean; merge: boolean } }[];
for (const { name, alert, context, burst, expected } of policies) {
	test(name, () => {
		const decision = alertPopupDecision(alert, context);
		const merge = decision.pop && alert.projectId !== null && !!burst && mergesAlertBurst(burst.previousProjectArrivals, burst.now);
		expect({ ...decision, merge }).toEqual(expected);
	});
}

const matrix: Record<AlertPopupSetting, boolean[]> = {
	everything: [true, true, true, false], 'needs-me': [true, true, false, false], urgent: [true, false, false, false], off: [false, false, false, false],
};
for (const [setting, pops] of Object.entries(matrix)) {
	test(`pop-up level policy with ${setting}`, () => {
		const levels = ['urgent', 'important', 'info', 'inbox'] as const;
		expect(levels.map(level => alertPopupDecision(alert({ level }), { ...context, setting: alertPopupSetting(setting) }).pop)).toEqual(pops);
	});
}

test('alert source qualifies a project only when multiple backends are connected', () => {
	expect(alertSourceLabel('Recipe API', 'Lab', 2)).toBe('Recipe API · Lab');
	expect(alertSourceLabel('Recipe API', 'Lab', 1)).toBe('Recipe API');
	expect(alertSourceLabel(undefined, 'Lab', 2)).toBe('Lab');
});

test('invalid and missing settings default to needs-me', () => {
	expect(alertPopupSetting(undefined)).toBe('needs-me');
	expect(alertPopupSetting('bogus')).toBe('needs-me');
});

test('catch-up presents nothing on first connect or after an epoch change', () => {
	const existing = [row()];
	expect(catchUpPresentation(undefined, 'epoch-a', existing, now)).toBe('none');
	expect(catchUpPresentation({ backendEpoch: 'epoch-b', seq: 30 }, 'epoch-a', existing, now)).toBe('none');
});

test('catch-up shows up to three recent alerts and summarizes a larger or older backlog', () => {
	const cursor = { backendEpoch: 'epoch-a', seq: 1 };
	const missed = [row({ seq: 2 }), row({ seq: 3 }), row({ seq: 4 })];
	expect(catchUpPresentation(cursor, 'epoch-a', [], now)).toBe('none');
	expect(catchUpPresentation(cursor, 'epoch-a', missed, now)).toBe('individual');
	expect(catchUpPresentation(cursor, 'epoch-a', [...missed, row({ seq: 5 })], now)).toBe('summary');
	expect(catchUpPresentation(cursor, 'epoch-a', [row({ at: new Date(now - ALERT_CATCH_UP_WINDOW_MS).toISOString() })], now)).toBe('summary');
});

test('live events buffered at connect reconcile by sequence and keep the history resolved flag', () => {
	const existing = { type: 'alert', alert: alert(), resolved: true } satisfies NotificationRecentEntry;
	const live = { type: 'alert', alert: alert({ seq: 3, key: 'new', tag: 'q2' }), resolved: false } satisfies NotificationRecentEntry;
	const resolution = { type: 'resolved', seq: 2, backendEpoch: 'epoch-a', tags: ['q1'], at: existing.alert.at } satisfies NotificationRecentEntry;
	expect(reconcileAlertEntries([resolution, existing], [live, { ...existing, resolved: false }])).toEqual([existing, resolution, live]);
});

test('resolved history and resolution events mark done, scoped to backend, tag and sequence', () => {
	const otherBackend = { ...row(), backendId: 'studio' };
	const newer = row({ seq: 3, key: 'updated' });
	const differentTag = row({ seq: 1, key: 'q2', tag: 'q2' });
	const resolved = applyAlertEntry([row(), otherBackend, newer, differentTag], 'workshop', {
		type: 'resolved', tags: ['q1'], seq: 2, backendEpoch: 'epoch-a', at: alert().at,
	});
	expect(resolved.map(row => row.done)).toEqual([true, false, false, false]);
	const historical = applyAlertEntry([], 'workshop', { type: 'alert', alert: alert(), resolved: true });
	expect(historical[0]?.done).toBe(true);
});

test('a replacement retires the prior tag without borrowing its browser marks', () => {
	const old = { ...row(), read: true, shown: true, dismissed: true };
	const replacement = alert({ seq: 2, key: 'replacement', questionRevision: 2 });
	const rows = applyAlertEntry([old], 'workshop', { type: 'alert', alert: replacement, resolved: false });
	expect(rows).toEqual([row(replacement), { ...old, done: true }]);
	expect(applyAlertEntry(rows, 'workshop', { type: 'alert', alert: old.alert, resolved: false })[0]?.done).toBe(true);
});

test('two-tap choices require a short set on a revisioned question, not a warning or approval', () => {
	const choice = { label: 'a'.repeat(24), recommended: true };
	expect(canAnswerAlert(alert({ choices: [choice, { ...choice, label: 'Cups' }, { ...choice, label: 'Ounces' }] }))).toBe(true);
	for (const change of [{ kind: 'reply' as const }, { warning: true }, { approval: true }, { projectId: null },
		{ questionRevision: undefined }, { choices: [] }, { choices: [{ ...choice, label: 'a'.repeat(25) }] },
		{ choices: [choice, choice] }, { choices: [choice, choice, choice, choice] }]) {
		expect(canAnswerAlert(alert(change))).toBe(false);
	}
});

test('time passes only in an actual visible slot, without hover or keyboard focus', () => {
	expect(alertDuration('urgent')).toBe(600_000);
	expect(alertDuration('important', true)).toBe(600_000);
	expect(alertDuration('important')).toBe(10_000);
	expect(alertDuration('info')).toBe(6_000);
	expect(alertDuration('inbox')).toBe(0);
	let remaining = alertDuration('important');
	remaining = alertTimeRemaining(remaining, 2_000, true, false);
	remaining = alertTimeRemaining(remaining, 40_000, false, false);
	remaining = alertTimeRemaining(remaining, 15_000, true, true);
	expect(remaining).toBe(8_000);
	expect(alertTimeRemaining(remaining, 9_000, true, false)).toBe(0);
});
