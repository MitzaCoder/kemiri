import type { UsageGroup } from '@kemiri/protocol';
export const USAGE_TABS = ['Overview', 'By role', 'By model', 'Projects & tasks', 'Waste'] as const;
export type UsageTab = (typeof USAGE_TABS)[number] | 'Value';

export function supportsSubscriptionValue(features: readonly string[] | undefined): boolean {
	return features?.includes('subscription-value') === true;
}

export function usageTabs(showValue: boolean): readonly UsageTab[] {
	return showValue ? ['Overview', 'Value', ...USAGE_TABS.slice(1)] : USAGE_TABS;
}
export function usageTabKey(tab: UsageTab): string {
	return tab.toLowerCase().replaceAll(/[^a-z]+/g, '-');
}
export function usageTabAfterKey(tab: UsageTab, key: string, tabs: readonly UsageTab[] = USAGE_TABS): UsageTab | undefined {
	const index = tabs.indexOf(tab);
	if (key === 'Home') return tabs[0];
	if (key === 'End') return tabs.at(-1);
	if (key === 'ArrowRight') return tabs[(index + 1) % tabs.length];
	if (key === 'ArrowLeft') return tabs[(index + tabs.length - 1) % tabs.length];
	return undefined;
}
export function usageTokenTotal(group: UsageGroup): number {
	return group.inputTokens + group.cacheReadTokens + group.cacheWriteTokens + group.outputTokens;
}
export function usageCostShare(group: UsageGroup, total: number): number {
	return total > 0 ? (100 * group.cost) / total : 0;
}
export function promptReuse(group: UsageGroup): number | null {
	const prompt = group.inputTokens + group.cacheReadTokens + group.cacheWriteTokens;
	return prompt > 0 ? (100 * group.cacheReadTokens) / prompt : null;
}
