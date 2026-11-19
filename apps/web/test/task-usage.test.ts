import { expect, it } from 'bun:test';
import type { TaskConversationUsage, UsageTaskResponse } from '@kemiri/protocol';
import { bindingShareText, taskUsagePresentation } from '../src/lib/task-usage.js';

const worker: TaskConversationUsage = { kind: 'worker', threadId: 'main', workerId: 'fern', name: 'fern', providerId: 'synthetic', model: 'spruce', apiValue: 20 };
const usage: UsageTaskResponse = {
	type: 'usage.task', id: 'example', own: { apiValue: 20, requests: 1 }, total: { apiValue: 41.8, requests: 6 },
	parts: [
		{ taskId: 'T2', parentTaskId: 'T1', title: 'Draw maps', total: { apiValue: 21.8, requests: 5 } },
		{ taskId: 'T3', parentTaskId: 'T2', title: 'Check the maps', total: { apiValue: 5, requests: 2 } },
	],
	subscriptions: [{ providerId: 'synthetic', label: 'Orchard', billing: 'subscription', apiValue: 41.18, assumed: false,
		bindingWindow: { label: 'Weekly limit', windowMinutes: 10_080, share: 0.07 } }],
	payAsYouGo: [{ providerId: 'metered', label: 'Metered', cost: 0.62, assumed: false }],
	conversations: [worker, { ...worker, model: 'clover' }, { ...worker, workerId: 'bud' }, { ...worker, workerId: 'pip' }],
	notes: { unpricedRequests: 1, missingLimitShare: ['Orchard'] },
};

it('summarizes API value, estimated share and distinct workers and descendants', () => {
	expect(taskUsagePresentation(usage, 'T1')?.headline).toBe('$41.80 at API prices · ≈ 7% of an Orchard week · 3 workers, 2 subtasks');
});

it('keeps real payments separate and shows nested totals and evidence notes', () => {
	expect(taskUsagePresentation(usage, 'T1')).toMatchObject({ ownCost: '$20.00', subtaskCost: '$21.80', paidAtApiPrices: '$0.62',
		parts: [{ taskId: 'T2', depth: 0 }, { taskId: 'T3', depth: 1 }],
		notes: ['1 unpriced request not included in dollar amounts.', 'Limit share unavailable for some or all requests on Orchard.'],
	});
	expect(bindingShareText({ ...usage.subscriptions[0]!, bindingWindow: null })).toBeNull();
});

it('hides the entire line with no recorded requests, but not an unpriced zero', () => {
	expect(taskUsagePresentation(undefined, 'T1')).toBeNull();
	expect(taskUsagePresentation({ ...usage, total: { requests: 0, apiValue: 0 } }, 'T1')).toBeNull();
	expect(taskUsagePresentation({ ...usage, total: { requests: 1, apiValue: 0 }, subscriptions: [], conversations: [], parts: [] }, 'T1')?.headline).toBe('$0.00 at API prices');
});

it('shows pay-as-you-go-only work without a subscription estimate', () => {
	expect(taskUsagePresentation({ ...usage, total: { requests: 1, apiValue: 0.62 }, own: { requests: 1, apiValue: 0.62 },
		parts: [], conversations: [worker], subscriptions: [], notes: { unpricedRequests: 0, missingLimitShare: [] } }, 'T1')).toMatchObject({
		headline: '$0.62 at API prices · 1 worker', paidAtApiPrices: '$0.62',
	});
});
