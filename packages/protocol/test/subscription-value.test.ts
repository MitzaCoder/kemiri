import { expect, it } from "bun:test";
import { Value } from "typebox/value";
import { ClientMessageSchema, HARNESS_FEATURES, LEGACY_HARNESS_FEATURES, ServerMessageSchema } from "../src/index.ts";

it("advertises subscription value without assuming it for legacy servers", () => {
	expect(HARNESS_FEATURES).toContain("subscription-value");
	expect(LEGACY_HARNESS_FEATURES).not.toContain("subscription-value");
});

it("round-trips the month and price requests, including a cleared override", () => {
	for (const request of [
		{ type: "usage.value", id: "month", utcOffsetMinutes: 330 },
		{ type: "usage.value", id: "month", month: "2026-01", utcOffsetMinutes: -300 },
		{ type: "subscriptions.price.set", id: "price", providerId: "synthetic", monthlyPrice: 20.5 },
		{ type: "subscriptions.price.set", id: "price", providerId: "synthetic", monthlyPrice: null },
	]) {
		const decoded: unknown = JSON.parse(JSON.stringify(request));
		expect(Value.Check(ClientMessageSchema, decoded)).toBe(true);
		expect(decoded).toEqual(request);
	}
	for (const invalid of [
		{ type: "usage.value", id: "month", month: "2026-13", utcOffsetMinutes: 0 },
		{ type: "usage.value", id: "month", utcOffsetMinutes: 841 },
		{ type: "subscriptions.price.set", id: "price", providerId: "synthetic", monthlyPrice: 0 },
	]) expect(Value.Check(ClientMessageSchema, invalid)).toBe(false);
});

it("round-trips a value report and the effective price", () => {
	const price = { kind: "default", monthlyPrice: 20, checkedOn: "2026-01-01", source: "https://example.test/pricing" };
	const valuePerPoint = { estimate: 2, low: 1, high: 3 };
	for (const response of [
		{ type: "subscriptions.price.set", id: "price", providerId: "synthetic", price },
		{ type: "usage.value", id: "month", month: "2026-01", assumed: true, approximateMonth: false, ledgerSince: null,
			unpricedRequests: 0, payAsYouGo: [{ providerId: "key", label: "A key", cost: 1, assumed: false }],
			subscriptions: [{ providerId: "synthetic", label: "Example", plan: "Basic", billing: "subscription", price,
				apiValue: 40, realisedRatio: 2, fullUseRatio: 40, planUsed: 0.05, assumed: true,
				windows: [{ windowId: "weekly", label: "Weekly limit", scope: null, binding: true, windowMinutes: 10080,
					windowsPerMonth: 4, kemiriPoints: 20, elsewherePoints: 2, elsewhereShare: 2 / 22, periods: 1, excludedNoisyPeriods: 0,
					valuePerPoint, fullWindowValue: { estimate: 200, low: 100, high: 300 } }],
				models: [{ model: "small", apiValue: 40, scopedWindowId: null, valuePerPoint: null }],
				topTasks: [{ projectId: "orchard", taskId: "T1", title: "Plant trees", apiValue: 35 }],
				coordinatorProjects: [{ projectId: "orchard", apiValue: 5 }],
			}],
		},
	]) {
		const decoded: unknown = JSON.parse(JSON.stringify(response));
		expect(Value.Check(ServerMessageSchema, decoded)).toBe(true);
		expect(decoded).toEqual(response);
	}
});

it("round-trips task usage with a parent-linked tree and separate billing", () => {
	expect(HARNESS_FEATURES).toContain("task-usage");
	expect(LEGACY_HARNESS_FEATURES).not.toContain("task-usage");
	const request = { type: "usage.task", id: "usage", projectId: "orchard", taskId: "T1" };
	const decodedRequest: unknown = JSON.parse(JSON.stringify(request));
	expect(Value.Check(ClientMessageSchema, decodedRequest)).toBe(true);
	expect(decodedRequest).toEqual(request);
	const response = { type: "usage.task", id: "usage", own: { requests: 1, apiValue: 4 }, total: { requests: 3, apiValue: 9 },
		parts: [{ taskId: "T2", parentTaskId: "T1", title: "Label the trees", total: { requests: 2, apiValue: 5 } },
			{ taskId: "T3", parentTaskId: "T2", title: "Count the trees", total: { requests: 1, apiValue: 1 } }],
		subscriptions: [{ providerId: "synthetic", billing: "subscription", label: "Spruce", apiValue: 8, assumed: false,
			bindingWindow: { label: "Weekly limit", windowMinutes: 10_080, share: 0.07 } }],
		payAsYouGo: [{ providerId: "key", label: "A key", cost: 1, assumed: false }],
		conversations: [{ kind: "thread", workerId: null, threadId: "trees", name: "Trees", model: "small", providerId: "synthetic", apiValue: 8 }],
		notes: { unpricedRequests: 0, missingLimitShare: [] },
	};
	const decodedResponse: unknown = JSON.parse(JSON.stringify(response));
	expect(Value.Check(ServerMessageSchema, decodedResponse)).toBe(true);
	expect(decodedResponse).toEqual(response);
});
