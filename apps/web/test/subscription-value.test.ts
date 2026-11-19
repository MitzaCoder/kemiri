import { beforeAll, expect, test } from 'bun:test';
import { compile } from 'svelte/compiler';
import type { SubscriptionValue } from '@kemiri/protocol';
import { realisedValue, localValueMonth, moveValueMonth, valueMonthRequest, valueRange } from '../src/lib/subscription-value.ts';
import { supportsSubscriptionValue, usageTabs, usageTabAfterKey } from '../src/lib/usage-analysis.ts';

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

test('keyboard order follows only advertised tabs; legacy and unknown backends keep their order', () => {
	for (const features of [undefined, ['subscription-usage', 'usage-breakdown']]) {
		const tabs = usageTabs(supportsSubscriptionValue(features));
		expect(tabs).toEqual(['Overview', 'By role', 'By model', 'Projects & tasks', 'Waste']);
		expect(usageTabAfterKey('Overview', 'ArrowRight', tabs)).toBe('By role');
	}
	const tabs = usageTabs(supportsSubscriptionValue(['subscription-value']));
	expect(usageTabAfterKey('Overview', 'ArrowRight', tabs)).toBe('Value');
	expect(usageTabAfterKey('Value', 'ArrowRight', tabs)).toBe('By role');
	expect(usageTabAfterKey('By role', 'ArrowLeft', tabs)).toBe('Value');
	expect(usageTabAfterKey('Value', 'Home', tabs)).toBe('Overview');
	expect(usageTabAfterKey('Value', 'End', tabs)).toBe('Waste');
});

let renderCard: (subscription: SubscriptionValue) => string;
beforeAll(async () => {
	// Bundle the real server-rendered Svelte component with its shared controls. No DOM or backend needed.
	const card = new URL('../src/lib/components/usage/SubscriptionValueCard.svelte', import.meta.url).pathname;
	const svelteServer = new URL(import.meta.resolve('svelte/server')).pathname;
	const { outputs } = await Bun.build({ entrypoints: ['render-value-card'], target: 'bun', plugins: [{
		name: 'render-value-card',
		setup(build) {
			build.onResolve({ filter: /^render-value-card$/ }, () => ({ path: 'render-value-card', namespace: 'fixture' }));
			build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', resolveDir: import.meta.dir, contents: `
				import Card from ${JSON.stringify(card)};
				import { render } from ${JSON.stringify(svelteServer)};
				export default (subscription) => render(Card, { props: { subscription, editable: true,
					savePrice: async () => {}, taskHref: (_, id) => '?task=' + id, onTaskClick: () => {} } }).body;
			` }));
			build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => ({ loader: 'js', contents: compile(await Bun.file(path).text(), { filename: path, generate: 'server' }).js.code }));
		},
	}] });
	const source = await outputs[0]!.text();
	renderCard = (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)).default;
});

test('the card renders the default price disclosure, estimate range, model wording and task link', () => {
	const html = renderCard(subscription);
	for (const text of ['$1,640 of work for $100.', '16× what this subscription costs.', 'default price', 'Checked 2026-11-19',
		'https://example.test/pricing', 'range $560–$670', 'not measured separately', 'href="?task=T1"']) expect(html).toContain(text);
});

test('the card rounds estimates and range endpoints but keeps small estimates and recorded cents', () => {
	const html = renderCard({ ...subscription, apiValue: 1640.25,
		windows: [{ ...subscription.windows[0]!, windowsPerMonth: 4.34857377,
			fullWindowValue: { estimate: 610, low: 595.12, high: 625.64 } }],
		models: [{ model: 'example-small', apiValue: 1640.25, scopedWindowId: 'weekly',
			valuePerPoint: { estimate: 9.25, low: 8.75, high: 10.51 } }] });
	for (const text of ['At full use · estimated', '$2,653', 'range $595–$626', '≈ $9.25 per point · range $8.75–$11',
		'$1,640.25 of work for $100.']) expect(html).toContain(text);
	for (const text of ['$2,652.63', '$595.12', '$625.64', '$10.51']) expect(html).not.toContain(text);
});

test('missing prices and insufficient evidence do not hide recorded work', () => {
	const html = renderCard({ ...subscription, price: { kind: 'none', monthlyPrice: null, source: null, checkedOn: null },
		realisedRatio: null, planUsed: null, windows: [{ ...subscription.windows[0]!, kemiriPoints: 4, fullWindowValue: null, valuePerPoint: null }] });
	for (const text of ['$1,640 of work.', 'Add what you pay', 'not enough use yet', 'example-small', 'Where it went']) expect(html).toContain(text);
	for (const text of ['what this subscription costs', 'At full use', 'default price']) expect(html).not.toContain(text);
});
