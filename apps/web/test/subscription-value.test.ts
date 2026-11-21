import { expect, test } from 'bun:test';
import type { SubscriptionValue } from '@kemiri/protocol';
import { realisedValue, localValueMonth, moveValueMonth, valueMonthRequest, valueRange } from '../src/lib/subscription-value.ts';

const subscription: SubscriptionValue = {
	providerId: 'example', label: 'Meadow AI', billing: 'subscription', plan: 'Field',
	price: { kind: 'default', monthlyPrice: 100, checkedOn: '2026-11-19', source: 'https://example.test/pricing' },
	apiValue: 1640, realisedRatio: 16.4, fullUseRatio: 26.5, planUsed: 0.62, assumed: false,
	windows: [{ windowId: 'weekly', label: 'Weekly limit', scope: null, windowMinutes: 10_080,
		binding: true, windowsPerMonth: 4.35, kemiriPoints: 20, elsewherePoints: 2, elsewhereShare: 0.09,
		periods: 1, excludedNoisyPeriods: 0, valuePerPoint: { estimate: 6.1, low: 5.6, high: 6.7 },
		fullWindowValue: { estimate: 610, low: 560, high: 670 } }],
	models: [{ model: 'example-small', apiValue: 1640, valuePerPoint: null, scopedWindowId: null }],
	topTasks: [{ projectId: 'bakery', taskId: 'T1', title: 'Publish the menu', apiValue: 1000 }],
};

test('the headline compares recorded work with the monthly price, not the full-use estimate', () => {
	expect(realisedValue(subscription)).toEqual({ headline: '$1,640 of work for $100.', comparison: '16× what this subscription costs.', priceAction: 'Change price' });
});

test('estimate ranges retain an unbounded upper end', () => {
	expect(valueRange({ estimate: 610, low: 560, high: 670 })).toBe('range $560–$670');
	expect(valueRange({ estimate: 610, low: 560, high: null })).toBe('range $560 and up');
});

test('calendar month navigation wraps the year and sends the browser offset east of UTC', () => {
	expect(localValueMonth(new Date(2026, 0, 2))).toBe('2026-01');
	expect(moveValueMonth('2026-01', -1)).toBe('2025-12');
	expect(moveValueMonth('2026-12', 1)).toBe('2027-01');
	expect(valueMonthRequest('2026-07')).toEqual({ type: 'usage.value', month: '2026-07', utcOffsetMinutes: -new Date(2026, 6, 1).getTimezoneOffset() || 0 });
});

test('money shows whole dollars from $100 and always two decimals below', async () => {
	const { usageMoney } = await import('../src/lib/usage-money.ts');
	expect([982.5, 42.5, 35, 8.5, 99.99, 99.996, 100, 1640.25, 0, 0.004, 0.01].map(usageMoney)).toEqual(
		['$983', '$42.50', '$35.00', '$8.50', '$99.99', '$100', '$100', '$1,640', '$0.00', '< $0.01', '$0.01']);
});
