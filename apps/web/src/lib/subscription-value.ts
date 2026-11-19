import type { SubscriptionValue, UsageValueRequest, ValueRangeSchema, WindowValue } from '@kemiri/protocol';
import type { Static } from 'typebox';
import { usageMoney } from './usage-money.js';

type ValueRange = Static<typeof ValueRangeSchema>;
const ratio = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 2 });
const percent = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 0 });

export function valueMoney(amount: number): string {
	return usageMoney(amount);
}

export function realisedValue({ apiValue, price, realisedRatio }: Pick<SubscriptionValue, 'apiValue' | 'price' | 'realisedRatio'>) {
	return realisedRatio === null || price.monthlyPrice === null
		? { headline: `${valueMoney(apiValue)} of work.`, comparison: null, priceAction: 'Add what you pay' }
		: { headline: `${valueMoney(apiValue)} of work for ${valueMoney(price.monthlyPrice)}.`, comparison: `${ratio.format(realisedRatio)}× what this subscription costs.`, priceAction: 'Change price' };
}

export function estimatedMoney(amount: number): string {
	return usageMoney(amount);
}

export function valueRange(range: ValueRange): string {
	return range.high === null ? `range ${estimatedMoney(range.low)} and up` : `range ${estimatedMoney(range.low)}–${estimatedMoney(range.high)}`;
}

export function valuePercent(share: number | null): string {
	return share === null ? 'Not measured' : percent.format(share);
}

export function fullWindowLabel(window: WindowValue): string {
	switch (window.windowMinutes) {
		case 7 * 24 * 60: return 'Full week';
		case 30 * 24 * 60: return 'Full month';
		default: return `Full window · ${window.label}`;
	}
}

export function localValueMonth(date = new Date()): string {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function moveValueMonth(month: string, step: -1 | 1): string {
	const [year, number] = month.split('-').map(Number);
	return localValueMonth(new Date(year ?? 0, (number ?? 1) - 1 + step, 1));
}

export function valueMonthRequest(month: string): Omit<UsageValueRequest, 'id'> {
	const [year, number] = month.split('-').map(Number);
	// Use the browser's offset at this month's local midnight, not today's offset for a past season.
	return { type: 'usage.value', month, utcOffsetMinutes: -new Date(year ?? 0, (number ?? 1) - 1, 1).getTimezoneOffset() || 0 };
}
