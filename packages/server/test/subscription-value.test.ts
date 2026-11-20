import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravityDefinition } from "../src/official-agents/antigravity.ts";
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

it("recovers retained Antigravity value for the month, model and parent task without double counting", async () => {
	const at = Date.UTC(2026, 10, 20);
	const dir = mkdtempSync(join(tmpdir(), "retained-value-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const file = join(dir, "log.sqlite");
	const { id: provider, modelRates } = antigravityDefinition(dir);
	const catalogPricing = { provider, modelRates: modelRates! };
	const old = RequestLogStore.open(file);
	try {
		old.subscriptionTerms.observe(provider, "Pro", "subscription", at);
		old.subscriptionTerms.setPrice(provider, 20, at);
		const tracker = new ConversationRequests({ projectId: "library", conversationId: 4,
			identity: { kind: "worker", threadId: "main", taskId: "leaf", workerId: "example", scheduleId: null } });
		const row = tracker.request({ provider, model: "gemini-4-neon-high", timestamp: at + MINUTE,
			usage: { input: 1_000_000, output: 1_000_000, cacheRead: 2_000_000 },
		}, { wake: "brief", retention: null, changes: null, source: "live" });
		old.insertMany([
			{ ...row, billing: "subscription", priced: false },
			{ ...row, billing: "subscription", priced: true, cost: 2 },
			{ ...row, billing: "subscription", priced: false, model: "gemini-pro-orchestrator-neon" },
			{ ...row, billing: "subscription", priced: false, model: "gemini-4-neon", input: 0, output: 0, cacheRead: 0 },
		]);
	} finally { old.close(); }
	for (let open = 0; open < 2; open++) {
		const store = RequestLogStore.open(file, { catalogPricing });
		try {
			const [recovered, alreadyPriced, unknown, noTokens] = store.rows({ from: 0, to: at + DAY });
			expect(recovered).toMatchObject({ priced: true, cost: 18.3, costInput: 3, costOutput: 15, costCacheRead: 0.3 });
			expect(alreadyPriced).toMatchObject({ priced: true, cost: 2 });
			expect(unknown).toMatchObject({ priced: false, cost: 0 });
			expect(noTokens).toMatchObject({ priced: true, cost: 0 });
			if (open === 1) store.prune(at + 120 * DAY);
			const value = await readSubscriptionValue({ store, month: valueMonth({ utcOffsetMinutes: 0 }, at + DAY),
				currentBilling: new Map(), label: id => id, billingFor: async () => null,
				boardTasks: async () => [{ id: "root", title: "Root", parent: null }, { id: "leaf", title: "Leaf", parent: "root" }],
			});
			expect(value.unpricedRequests).toBe(1);
			expect(value.subscriptions[0]).toMatchObject({ apiValue: 20.3, realisedRatio: 20.3 / 20,
				models: [{ model: "gemini-4-neon-high", apiValue: 20.3 }, { apiValue: 0 }, { apiValue: 0 }],
				topTasks: [{ taskId: "root", apiValue: 20.3 }],
			});
			expect(store.taskUsage("library", ["leaf"]).reduce((n, row) => n + row.requests, 0)).toBe(4);
		} finally { store.close(); }
	}
});

it("uses announced Gemini 4 standard rates on either side of the introductory cutoff", () => {
	const rates = antigravityDefinition("unused").modelRates!;
	const cutoff = Date.UTC(2026, 11, 1);
	for (const model of ["gemini-4-argon", "gemini-4-carbon-high"]) {
		expect(rates(model, cutoff - 1)).toEqual({ input: 2, output: 10, cacheRead: 0.10, cacheWrite: 0 });
		expect(rates(model, cutoff)).toEqual({ input: 4, output: 20, cacheRead: 0.20, cacheWrite: 0 });
	}
	expect(rates("gemini-4-hydrogen-high", cutoff)).toEqual({ input: 1.5, output: 7.5, cacheRead: 0.075, cacheWrite: 0 });
});

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

it("keeps only task-less coordinator API value per project and subscription after pruning", async () => {
	const f = fixture();
	const coordinator = { kind: "main", workerId: null } as const;
	f.request({ ...coordinator, cost: 6 });
	f.request({ ...coordinator, cost: 2, model: "other-model" });
	f.request({ ...coordinator, projectId: "bakery", cost: 5 });
	f.request({ ...coordinator, billing: "agent", cost: 4 });
	f.request({ ...coordinator, billing: "api_key", cost: 3 });
	f.request({ ...coordinator, taskId: "root", cost: 9 });
	f.request({ ...coordinator, source: "keepWarm", cost: 7 });
	f.request({ ...coordinator, at: START - 3 * DAY, cost: 11 });
	f.request({ cost: 90 }); // Task-less worker, otherwise the same roll-up dimensions.
	f.request({ taskId: "root", cost: 1 });
	f.request({ kind: "other", workerId: null, purpose: "compaction", cost: 30 });
	f.request({ kind: "other", workerId: null, purpose: "memory_extraction", cost: 20 });
	expect(f.store.prune(START + 150 * DAY)).toBe(12);

	const report = await f.report({ boardTasks: async () => [{ id: "root", title: "Root" }] });
	expect(report.subscriptions).toMatchObject([
		{ billing: "agent", coordinatorProjects: [{ projectId: "orchard", apiValue: 4 }], topTasks: [] },
		{ billing: "subscription", coordinatorProjects: [
			{ projectId: "orchard", apiValue: 8 }, { projectId: "bakery", apiValue: 5 },
		], topTasks: [{ projectId: "orchard", taskId: "root", apiValue: 1 }] },
	]);
	expect(report.payAsYouGo).toMatchObject([{ cost: 3 }]);
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
