import { afterEach, expect, it } from "bun:test";
import { ConversationRequests } from "../src/request-log.ts";
import { RequestLogStore, type RequestRow } from "../src/request-log-store.ts";
import { readSubscriptionValue, valueMonth } from "../src/subscription-value.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const START = Date.parse("2026-01-02T12:00:00Z");
const PROVIDER = "synthetic";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function fixture(provider = PROVIDER) {
	const store = RequestLogStore.open(":memory:", { now: START });
	cleanups.push(() => store.close());
	function request(overrides: Partial<RequestRow> = {}) {
		store.insert({
			...new ConversationRequests({ projectId: "orchard", conversationId: 3,
				identity: { kind: "worker", threadId: "main", taskId: null, workerId: "gardener", scheduleId: null },
			}).request({ provider, model: "small-v2", timestamp: START,
				usage: { input: 2, cost: { total: 10 } },
			}, { wake: "user", retention: "short", changes: null, source: "live" }),
			billing: "subscription", priced: true, ...overrides,
		});
	}
	function period(at: number, kemiri: number, elsewhere: number, cost: number, scope?: string) {
		const read = (time: number, usedPercent: number) => store.ledger.reading(provider, {
			id: scope ?? "weekly", label: scope ?? "Weekly limit", windowMinutes: 10_080,
			usedPercent, resetsAt: new Date(at + DAY).toISOString(), source: "usage_api", ...(scope === undefined ? {} : { scope }),
		}, time);
		read(at, elsewhere);
		if (scope === undefined) request({ at, durationMs: MINUTE, cost });
		read(at + 2 * MINUTE, elsewhere + kemiri);
		read(at + 3 * MINUTE, 0);
	}
	return { store, request, period, report: (overrides: Partial<Parameters<typeof readSubscriptionValue>[0]> = {}) =>
		readSubscriptionValue({ store, month: valueMonth({ utcOffsetMinutes: 0, month: "2026-01" }, START + 35 * DAY),
			currentBilling: new Map([[provider, "subscription"]]), label: id => id, billingFor: async () => null,
			boardTasks: async () => [], ...overrides }) };
}

it.each([4, 5, 10])("requires five pooled points and reports a range with %i points", async points => {
	const f = fixture();
	f.period(START, points, 0, 10);
	const [line] = (await f.report()).subscriptions;
	const [weekly] = line!.windows;
	expect(weekly).toMatchObject({ kemiriPoints: points, periods: 1, binding: true });
	if (points < 5) expect(weekly!.valuePerPoint).toBeNull();
	else {
		expect(weekly!.valuePerPoint).toEqual({ estimate: 10 / points, low: 10 / (points + 1), high: 10 / (points - 1) });
		expect(weekly!.windowsPerMonth).toBeCloseTo(30.44 / 7);
		expect(line!.planUsed).toBeCloseTo(10 / (10 / points * 100 * 30.44 / 7));
	}
});

it.each([2, 3])("excludes noisy periods only with at least three cleaner ones (has %i)", async clean => {
	const f = fixture();
	for (let i = 0; i < clean; i++) f.period(START + i * DAY, 9, 1, 18);
	f.period(START + 5 * DAY, 20, 11, 20);
	const window = (await f.report()).subscriptions[0]!.windows[0]!;
	expect(window.excludedNoisyPeriods).toBe(clean === 3 ? 1 : 0);
	expect(window.elsewherePoints).toBe(clean + 11);
	expect(window.valuePerPoint?.estimate).toBeCloseTo(clean === 3 ? 2 : 56 / 38);
	if (clean === 3) expect(window.valuePerPoint?.low).toBeCloseTo(54 / (27 + 0.6 * Math.sqrt(3)));
});

it("limits the binding and metered estimates to the current plan and measures only scoped models separately", async () => {
	const f = fixture();
	f.store.subscriptionTerms.observe(PROVIDER, "Plan A", "subscription", START);
	f.period(START, 10, 0, 20);
	const later = START + DAY;
	f.store.subscriptionTerms.observe(PROVIDER, "Plan B", "subscription", later);
	f.store.subscriptionTerms.setPrice(PROVIDER, 20, later);
	f.period(later, 5, 0, 20);
	f.period(later, 10, 0, 20, "small");
	f.request({ at: later, durationMs: MINUTE, cost: 3, model: "not-smaller" });
	const [line] = (await f.report()).subscriptions;
	expect(line).toMatchObject({ plan: "Plan B", apiValue: 43, realisedRatio: 43 / 20 });
	expect(line!.fullUseRatio).toBeCloseTo(400 * 30.44 / 7 / 20);
	expect(line!.windows).toMatchObject([{ binding: true, kemiriPoints: 5, periods: 1 }, { scope: "small", binding: false, windowsPerMonth: null }]);
	expect(line!.models).toMatchObject([
		{ model: "small-v2", apiValue: 40, scopedWindowId: "small", valuePerPoint: { estimate: 2 } },
		{ model: "not-smaller", apiValue: 3, scopedWindowId: null, valuePerPoint: null },
	]);
});

it("keeps the historical price and rolls up archived or nested subtasks by parent only", async () => {
	const provider = "openai-codex";
	const f = fixture(provider);
	const terms = f.store.subscriptionTerms;
	terms.observe(provider, "Plus", "subscription", START);
	expect(terms.price(provider, terms.at(provider, START))).toMatchObject({ kind: "default", monthlyPrice: 20, checkedOn: "2026-11-19" });
	expect(terms.setPrice(provider, 25, START + 1)).toMatchObject({ kind: "owner", monthlyPrice: 25 });
	f.request({ taskId: "leaf" });
	f.request({ taskId: "separate", cost: 5 });
	f.request({ taskId: null, cost: 4 });
	f.request({ taskId: "part", cost: 3 });
	const boards = [ { id: "root", title: "Root" }, { id: "part", title: "Part", parent: "root", archivedAt: "2026-01-15" },
		{ id: "leaf", title: "Leaf", parent: "part" }, { id: "separate", title: "Separate", foundWhile: "root" } ];
	const february = START + 32 * DAY;
	expect(terms.setPrice(provider, null, february)).toMatchObject({ kind: "default", monthlyPrice: 20 });
	const [line] = (await f.report({ boardTasks: async () => boards })).subscriptions;
	expect(line).toMatchObject({ apiValue: 22, realisedRatio: 22 / 25, windows: [], fullUseRatio: null,
		price: { kind: "owner", monthlyPrice: 25 }, topTasks: [
			{ projectId: "orchard", taskId: "root", apiValue: 13 }, { projectId: "orchard", taskId: "separate", apiValue: 5 },
		] });
	const [cleared] = (await f.report({ month: valueMonth({ utcOffsetMinutes: 0 }, february) })).subscriptions;
	expect(cleared?.price).toMatchObject({ kind: "default", monthlyPrice: 20 });
});

it("separates key payments, flags assumed billing, and leaves an unknown plan unpriced", async () => {
	const f = fixture();
	f.request({ billing: null, cost: 3 });
	f.request({ billing: "api_key", cost: 12 });
	f.request({ provider: "ambient", billing: null, cost: 7, priced: false });
	const report = await f.report({ billingFor: async () => "api_key" });
	expect(report).toMatchObject({ assumed: true, unpricedRequests: 1, subscriptions: [{ assumed: true, apiValue: 3,
		price: { kind: "none", monthlyPrice: null }, realisedRatio: null, windows: [] }],
		payAsYouGo: [{ providerId: "ambient", assumed: true, cost: 7 }, { providerId: PROVIDER, assumed: false, cost: 12 }],
	});
	expect(report.payAsYouGo[0]).not.toHaveProperty("realisedRatio");
});

it("uses local month boundaries even after raw requests are pruned", async () => {
	const f = fixture();
	const boundary = Date.parse("2026-01-31T18:30:00Z");
	f.request({ at: boundary - 1, cost: 5 });
	f.request({ at: boundary, cost: 7 });
	f.store.prune(START + 150 * DAY);
	const answer = await f.report({ month: valueMonth({ month: "2026-02", utcOffsetMinutes: 330 }, START + 150 * DAY) });
	expect(answer.subscriptions[0]?.apiValue).toBe(7);
	expect(answer.approximateMonth).toBe(false);
});

it("reports an unbounded upper range when the rounded points can be zero", async () => {
	const f = fixture();
	for (let i = 0; i < 80; i++) f.period(START + i * 60 * MINUTE, 0.0625, 0, 1);
	const window = (await f.report()).subscriptions[0]!.windows[0]!;
	expect(window.kemiriPoints).toBeCloseTo(5);
	expect(window.valuePerPoint).toMatchObject({ low: expect.any(Number), high: null });
});
