import { expect, test } from 'bun:test';
import type { CacheStats, SubscriptionUsage, UsageValueResponse } from '@kemiri/protocol';
import { mergeSubscriptions, providerSpend, quietLimits, rankedLimits, spendRows, subscriptionMonths, sumUsage } from '../src/lib/usage-glance.ts';

const studio = { id: 'studio', name: 'Studio' };
const workshop = { id: 'workshop', name: 'Workshop' };
const now = Date.parse('2026-11-21T20:00:00Z');
function subscription(overrides: Partial<SubscriptionUsage> = {}): SubscriptionUsage {
	return {
		providerId: 'example', label: 'Example AI', plan: 'Plus', account: 'example@example.test', source: 'usage_api',
		updatedAt: new Date(now).toISOString(), error: null,
		windows: [96, 58, 30, 24, 14, 8].map((usedPercent, index) => ({
			id: `window-${index}`, label: `Window ${index}`, usedPercent, samples: [], windowMinutes: 300,
			resetsAt: new Date(now + 60 * 60_000).toISOString(),
		})), ...overrides,
	};
}

test('shared accounts use the latest copy of each limit and name both computers without guessing identities', () => {
	const shared = mergeSubscriptions([
		{ computer: studio, subscription: subscription({ updatedAt: new Date(now - 30_000).toISOString() }) },
		{ computer: workshop, subscription: subscription({ account: 'Example@example.test' }) },
	]);
	expect(shared).toHaveLength(1);
	expect(shared[0]?.members.map(member => member.computer.id)).toEqual(['workshop', 'studio']);
	const limits = rankedLimits(shared, now);
	expect(limits.map(limit => limit.window.usedPercent)).toEqual([96, 58, 30, 24, 14, 8]);
	expect(limits[0]?.status).toBe('near');
	expect(quietLimits(limits).map(limit => limit.window.usedPercent)).toEqual([14, 8]);
	expect(mergeSubscriptions([studio, workshop].map(computer => ({ computer, subscription: subscription({ account: null }) })))).toHaveLength(2);
});

test('All adds costs and merges model identities without merging unrelated project or task IDs', () => {
	const report = (cost: number) => ({ recorded: {
		byTask: [sumUsage([], '["garden","T1"]', 'Plant basil'), sumUsage([], '["garden",null]', 'Not tied to a task')],
		byProject: [sumUsage([], 'garden', 'Garden')],
		byModel: [{ ...sumUsage([], '["example","small"]', 'small'), cost }],
		byProviderBilling: [{ ...sumUsage([], '["example","subscription"]', 'example'), cost }],
	} }) as CacheStats;
	const reports = [{ computer: studio, stats: report(4) }, { computer: workshop, stats: report(6) }];
	expect(spendRows(reports, 'model')).toMatchObject([{ label: 'small', cost: 10 }]);
	expect(spendRows(reports, 'project')).toHaveLength(2);
	expect(spendRows(reports, 'task')).toHaveLength(2);
	expect(spendRows(reports.slice(1), 'model')).toMatchObject([{ cost: 6 }]);
	const subscriptions = mergeSubscriptions(reports.map(({ computer }) => ({ computer, subscription: subscription() })));
	expect(providerSpend(reports, subscriptions)).toMatchObject([{ label: 'Example AI', cost: 10 }]);
});

test('a shared plan counts once in the month comparison while recorded work sums on both computers', () => {
	const subscriptions = mergeSubscriptions([studio, workshop].map(computer => ({ computer, subscription: subscription() })));
	const monthlyReport = (apiValue: number) => ({ subscriptions: [{ providerId: 'example', billing: 'subscription', apiValue,
		price: { kind: 'default', monthlyPrice: 20, checkedOn: null, source: null } }] }) as UsageValueResponse;
	const bySubscription = subscriptionMonths([
		{ computer: studio, report: monthlyReport(40) }, { computer: workshop, report: monthlyReport(60) },
	], subscriptions);
	expect([...bySubscription.values()]).toMatchObject([{ cost: 100, price: { monthlyPrice: 20 } }]);
});
