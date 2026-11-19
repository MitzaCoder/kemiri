import type { TaskSubscriptionUsage, UsageTaskResponse } from '@kemiri/protocol';

const dollars = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const usageDollars = (amount: number) => dollars.format(amount);
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;

export function bindingShareText({ label, bindingWindow }: TaskSubscriptionUsage): string | null {
	if (!bindingWindow) return null;
	const { share, windowMinutes } = bindingWindow;
	const percent = share > 0 && share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`;
	const unit = windowMinutes === 10_080 ? 'week' : windowMinutes === 1440 ? 'day'
		: windowMinutes === 300 ? '5-hour window' : null;
	const article = /^[aeiou]/i.test(label) ? 'an' : 'a';
	return `≈ ${percent} of ${unit ? `${article} ${label} ${unit}` : `the ${label} ${bindingWindow.label.toLowerCase()}`}`;
}

export function taskUsagePresentation(usage: UsageTaskResponse | undefined, taskId: string) {
	if (!usage?.total.requests) return null;
	const headlineSubscription = usage.subscriptions.filter(subscription => subscription.bindingWindow !== null)
		.sort((a, b) => b.apiValue - a.apiValue)[0];
	const workers = new Set(usage.conversations.filter(row => row.kind === 'worker')
		.map(row => JSON.stringify([row.threadId, row.workerId]))).size;
	const threads = new Set(usage.conversations.filter(row => row.kind === 'thread').map(row => row.threadId)).size;
	const counts = [workers ? count(workers, 'worker') : '', threads ? count(threads, 'thread') : '',
		usage.parts.length ? count(usage.parts.length, 'subtask') : ''].filter(Boolean).join(', ');
	const depths = new Map([[taskId, -1]]);
	const parts = usage.parts.map(part => {
		const depth = (depths.get(part.parentTaskId) ?? -1) + 1;
		depths.set(part.taskId, depth);
		return { ...part, depth };
	});
	return {
		headline: [`${usageDollars(usage.total.apiValue)} at API prices`, headlineSubscription && bindingShareText(headlineSubscription), counts].filter(Boolean).join(' · '),
		ownCost: usageDollars(usage.own.apiValue),
		subtaskCost: usageDollars(usage.total.apiValue - usage.own.apiValue),
		parts,
		paidAtApiPrices: usage.payAsYouGo.length ? usageDollars(usage.payAsYouGo.reduce((sum, payment) => sum + payment.cost, 0)) : null,
		notes: [
			...(usage.notes.unpricedRequests ? [`${count(usage.notes.unpricedRequests, 'unpriced request')} not included in dollar amounts.`] : []),
			...(usage.notes.missingLimitShare.length ? [`Limit share unavailable for some or all requests on ${usage.notes.missingLimitShare.join(', ')}.`] : []),
			...(usage.subscriptions.some(row => row.assumed) || usage.payAsYouGo.some(row => row.assumed) ? ['Some older requests use assumed billing.'] : []),
		],
	};
}
