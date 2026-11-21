import { windowPace } from '@kemiri/client';
import type { CacheStats, RecordedUsageGroup, SubscriptionPrice, SubscriptionUsage, SubscriptionValue, UsageValueResponse, UsageDetailRequest, UsageSelection, UsageWindow } from '@kemiri/protocol';
import { isStale } from './subscription-usage.ts';

export const USAGE_BACKEND_KEY = 'aiki.usage.backend.v1';
export const USAGE_PERIODS = [['today', 'Today'], ['week', '7 days'], ['rolling', '30 days'], ['month', 'This month']] as const;
export type UsagePeriod = typeof USAGE_PERIODS[number][0];
export const SPEND_DIMENSIONS = [['task', 'Tasks'], ['project', 'Projects'], ['model', 'Models'], ['role', 'Who called']] as const;
export type SpendDimension = typeof SPEND_DIMENSIONS[number][0];

export function usagePeriodRequest(period: UsagePeriod, month: string, date: Date): Omit<UsageDetailRequest, 'type' | 'id' | 'selection'> {
	if (period === 'month') return { month, utcOffsetMinutes: -new Date(`${month}-01T00:00:00`).getTimezoneOffset() };
	return { days: period === 'today' ? 1 : period === 'week' ? 7 : 30,
		...(period === 'today' ? { calendarToday: true } : {}), utcOffsetMinutes: -date.getTimezoneOffset() };
}

export type UsageComputer = { id: string; name: string };
export type SubscriptionOnComputer = { computer: UsageComputer; subscription: SubscriptionUsage };
export type GlanceSubscription = { key: string; members: SubscriptionOnComputer[]; reading: SubscriptionUsage; windows: UsageWindow[] };

function readingTime(subscription: SubscriptionUsage): number {
	return subscription.updatedAt === null ? 0 : Date.parse(subscription.updatedAt) || 0;
}

/** A shared account is one subscription; a missing account is not evidence that two logins match. */
export function mergeSubscriptions(entries: readonly SubscriptionOnComputer[]): GlanceSubscription[] {
	const accounts = new Map<string, SubscriptionOnComputer[]>();
	for (const entry of entries) {
		const { account, providerId, plan } = entry.subscription;
		const identity = account?.trim().toLowerCase();
		const key = JSON.stringify(identity ? [providerId, 'account', identity, plan] : [providerId, 'computer', entry.computer.id]);
		const members = accounts.get(key) ?? [];
		members.push(entry);
		accounts.set(key, members);
	}
	return [...accounts].map(([key, members]) => {
		members.sort((left, right) => readingTime(right.subscription) - readingTime(left.subscription));
		const reading = members[0]!.subscription;
		const windows = new Map<string, UsageWindow>();
		for (const { subscription } of members) for (const window of subscription.windows) {
			if (!windows.has(window.id)) windows.set(window.id, window);
		}
		return { key, members, reading, windows: [...windows.values()] };
	});
}

export const LIMIT_LABELS = { near: 'Nearly out', hot: 'Running hot', room: 'Room to spare', unknown: 'Not measured' } as const;
export function rankedLimits(subscriptions: readonly GlanceSubscription[], now: number) {
	return subscriptions.flatMap(subscription => subscription.windows.map(window => {
		const pace = windowPace(window, now);
		const measured = window.usedPercent !== null;
		const stale = isStale(subscription.reading.updatedAt, now) || (pace.resetsAt !== null && now >= pace.resetsAt);
		const status = !measured || stale ? 'unknown' : window.usedPercent! >= 90 ? 'near'
			: pace.kind === 'ahead' && !pace.early ? 'hot' : 'room';
		return { key: JSON.stringify([subscription.key, window.id]), subscription, window, pace, status, stale } as const;
	})).sort((a, b) => (b.window.usedPercent ?? -1) - (a.window.usedPercent ?? -1)
		|| (a.pace.resetsAt ?? Infinity) - (b.pace.resetsAt ?? Infinity));
}
export type GlanceLimit = ReturnType<typeof rankedLimits>[number];

export function quietLimits(limits: readonly GlanceLimit[]): GlanceLimit[] {
	return limits.filter((limit, index) => index >= 4 && limit.status === 'room' && limit.window.usedPercent! < 45);
}

export type SpendPortion = { computer: UsageComputer; group: RecordedUsageGroup; selection: UsageSelection | null };
export type SpendRow = { key: string; label: string; cost: number; portions: SpendPortion[]; subscriptionKey?: string; provider?: string };
export type UsageOnComputer = { computer: UsageComputer; stats: CacheStats };

export function sumUsage(groups: readonly RecordedUsageGroup[], key = '', label = ''): RecordedUsageGroup {
	const total: RecordedUsageGroup = { key, label, cost: 0, requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, unpricedRequests: 0 };
	for (const group of groups) {
		for (const field of ['cost', 'requests', 'inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'unpricedRequests'] as const) total[field] += group[field];
	}
	return total;
}

export function spendRows(reports: readonly UsageOnComputer[], dimension: SpendDimension): SpendRow[] {
	const rows = new Map<string, SpendRow>();
	const byDimension = { task: 'byTask', project: 'byProject', model: 'byModel', role: 'byRole' } as const;
	for (const { computer, stats } of reports) {
		const groups = stats.recorded?.[byDimension[dimension]] ?? stats.usage?.[byDimension[dimension]] ?? [];
		for (const group of groups) {
			const stableKey = dimension === 'task' || dimension === 'project' ? JSON.stringify([computer.id, group.key]) : group.key;
			let selection: UsageSelection | null;
			if (dimension === 'project') selection = { kind: 'project', projectId: group.key };
			else if (dimension === 'role') selection = { kind: 'role', role: group.key };
			else if (dimension === 'model') {
				const [provider, model] = JSON.parse(group.key) as [string, string];
				selection = { kind: 'model', provider, model };
			} else {
				const [projectId, taskId] = JSON.parse(group.key) as [string, string | null];
				if (taskId === null) continue; // The project drill-down shows work that is not tied to a task.
				selection = { kind: 'task', projectId, taskId };
			}
			const label = selection.kind === 'model' ? selection.model : group.label;
			const row = rows.get(stableKey) ?? { key: stableKey, label, cost: 0, portions: [] };
			row.cost += group.cost;
			row.portions.push({ computer, group: { unpricedRequests: 0, ...group }, selection });
			rows.set(stableKey, row);
		}
	}
	return [...rows.values()].sort((a, b) => b.cost - a.cost || a.key.localeCompare(b.key));
}

export function providerSpend(reports: readonly UsageOnComputer[], subscriptions: readonly GlanceSubscription[]): SpendRow[] {
	const rows = new Map<string, SpendRow>();
	for (const { computer, stats } of reports) for (const group of stats.recorded?.byProviderBilling ?? []) {
		const [provider, billing] = JSON.parse(group.key) as [string, Extract<UsageSelection, { kind: 'providerBilling' }>['billing']];
		const matching = subscriptions.find(subscription => subscription.reading.providerId === provider && subscription.members.some(member => member.computer.id === computer.id));
		const subscription = billing === 'subscription' || billing === 'plan_key' ? matching : undefined;
		const key = subscription?.key ?? group.key;
		const name = matching?.reading.label ?? provider;
		const label = subscription ? name : `${name} · ${billing === 'api_key' ? 'API key' : billing === null ? 'billing unknown' : billing === 'agent' ? 'external agent' : 'subscription'}`;
		const row: SpendRow = rows.get(key) ?? { key, label, provider, cost: 0, portions: [], ...(subscription ? { subscriptionKey: subscription.key } : {}) };
		row.cost += group.cost;
		row.portions.push({ computer, group, selection: { kind: 'providerBilling', provider, billing } });
		rows.set(key, row);
	}
	return [...rows.values()].sort((a, b) => b.cost - a.cost || a.key.localeCompare(b.key));
}

export function computerNames(computers: readonly UsageComputer[]): string {
	return [...new Map(computers.map(computer => [computer.id, computer.name])).values()].join(' · ');
}

export type SubscriptionMonth = {
	portions: { computer: UsageComputer; value: SubscriptionValue }[];
	price: SubscriptionPrice | undefined;
	priceConflict: boolean;
	cost: number;
};

export function subscriptionMonths(reports: readonly { computer: UsageComputer; report: UsageValueResponse }[], subscriptions: readonly GlanceSubscription[]) {
	const months = new Map<string, SubscriptionMonth>();
	for (const { computer, report } of reports) for (const value of report.subscriptions) {
		if (value.billing === 'agent') continue;
		const subscription = subscriptions.find(subscription => subscription.reading.providerId === value.providerId
			&& subscription.members.some(member => member.computer.id === computer.id));
		const key = subscription?.key ?? JSON.stringify([computer.id, value.providerId, value.billing]);
		const month = months.get(key) ?? { portions: [], price: undefined, priceConflict: false, cost: 0 };
		month.portions.push({ computer, value });
		month.cost += value.apiValue;
		months.set(key, month);
	}
	for (const month of months.values()) {
		const prices = month.portions.map(({ value }) => value.price).filter(price => price.monthlyPrice !== null);
		const ownerPrices = prices.filter(price => price.kind === 'owner');
		month.price = (ownerPrices.length ? ownerPrices : prices).sort((a, b) => b.monthlyPrice! - a.monthlyPrice!)[0];
		month.priceConflict = new Set(prices.map(price => price.monthlyPrice)).size > 1;
	}
	return months;
}
