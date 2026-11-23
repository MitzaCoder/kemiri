import { expect, test } from 'bun:test';
import type { NotificationAlert } from '@kemiri/protocol';
import type { AlertRow } from '../src/lib/alerts.js';
import { attentionBadge, attentionTabTitle } from '../src/lib/attention-badge.js';
import { needsYouTotal } from '../src/lib/sidebar-attention.js';

const needsYou = [{ count: 1 }, { count: 3 }];
const urgent: AlertRow = { backendId: 'lab', read: true, done: false, dismissed: true, shown: true,
	alert: { level: 'urgent' } as NotificationAlert };

test('title and installed app count match Needs you, not unread inbox rows', () => {
	const base = 'Bakery site · Kemiri';
	const { count } = attentionBadge(needsYou, []);
	expect(count).toBe(needsYouTotal(needsYou));
	expect(attentionTabTitle(base, count)).toBe('(4) Bakery site · Kemiri');
	expect(attentionTabTitle(base, attentionBadge([], [urgent]).count)).toBe(base);
});

test('the dot is about unresolved urgency, independently of read or dismissed marks', () => {
	expect(attentionBadge([], [urgent])).toEqual({ count: 0, urgent: true });
	expect(attentionBadge(needsYou, [{ ...urgent, done: true }])).toEqual({ count: 4, urgent: false });
	expect(attentionBadge(needsYou, [{ ...urgent, alert: { ...urgent.alert, level: 'important' } }])).toEqual({ count: 4, urgent: false });
	expect(attentionBadge(needsYou, [urgent], false)).toEqual({ count: 0, urgent: false });
});
