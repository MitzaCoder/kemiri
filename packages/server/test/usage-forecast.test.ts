import { expect, test } from "bun:test";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ConversationRequests } from "../src/request-log.ts";
import type { RequestBilling } from "../src/request-log-store.ts";
import { createSetup, TestClient } from "./support.ts";

const minute = 60_000;

test("Usage snapshots and pushes carry the live monitor pace and ranked local spenders", async () => {
	const start = Date.now() - 4 * minute;
	let now = start;
	let usedPercent = 72;
	const login = "opencode-go";
	const resetsAt = new Date(start + 236 * minute).toISOString();
	const subscription = fauxProvider({ provider: login });
	const setup = await createSetup({
		now: () => now,
		configureModels: models => models.setProvider({ ...subscription.provider,
			auth: { apiKey: { name: "Synthetic plan", resolve: async () => ({ auth: { apiKey: "example-key" } }) } },
		}),
		subscriptionUsage: { fetch: Object.assign(async () => Response.json({ usage: {
			rolling: { percent: usedPercent, resetsAt }, weekly: { percent: 10, resetsAt },
		} }), { preconnect: fetch.preconnect }) },
	});
	await setup.credentials.modify(login, async () => ({ type: "api_key", key: "example-key" }));
	const client = await TestClient.open(setup.server);
	try {
		await client.hello();
		const store = setup.server.requestLog!.store;
		function request(workerId: string, provider: string, billing: RequestBilling, at: number, cost: number) {
			const requests = new ConversationRequests({ projectId: "example-project", conversationId: 1,
				identity: { kind: "worker", taskId: null, workerId, threadId: "main", scheduleId: null } });
			store.insert({ ...requests.request({ provider, model: "example-reader", timestamp: at,
				usage: { input: 1_000, cost: { total: cost } } },
			{ wake: "user", retention: "short", changes: null, source: "live" }), billing });
		}
		const refresh = () => client.request({ type: "subscriptions.usage", refresh: true });
		const first = await refresh();
		expect(first.type === "subscriptions.usage" && first.subscriptions[0]?.windows[0]?.forecast).toBeUndefined();
		now = start + 4 * minute;
		usedPercent = 74;
		request("review-menu", login, "plan_key", now - 2 * minute, 3);
		request("check-recipes", login, "plan_key", now - 4 * minute, 2);
		request("print-cards", login, "plan_key", now - 7 * minute, 1);
		request("order-boxes", login, "plan_key", now - 8 * minute, 0.5);
		request("older-run", login, "plan_key", now - 11 * minute, 50);
		request("api-run", login, "api_key", now - minute, 5.5);
		request("older-api-run", login, "api_key", now - 61 * minute, 60);
		const answer = await refresh();
		if (answer.type !== "subscriptions.usage") throw Error(JSON.stringify(answer));
		const [rolling, weekly] = answer.subscriptions[0]!.windows;
		expect(rolling?.forecast).toEqual({ minutesLeft: 52, minutesToReset: 232,
			validUntil: new Date(now + 6 * minute).toISOString(), spenders: [
				{ label: "review-menu", model: "example-reader", apiValue: 3 },
				{ label: "check-recipes", model: "example-reader", apiValue: 2 },
				{ label: "print-cards", model: "example-reader", apiValue: 1 },
			] });
		expect(weekly?.forecast).toBeUndefined();
		const push = await client.waitFor(message => message.type === "subscriptions.usage.changed" && message.subscriptions[0]?.windows[0]?.forecast !== undefined);
		expect(push.type === "subscriptions.usage.changed" && push.subscriptions[0]?.windows[0]?.forecast).toEqual(rolling?.forecast);
		const stats = await client.request({ type: "cache.stats", days: 7, recorded: true });
		expect(stats.type === "cache.stats" && stats.stats.apiKeySpendRates).toEqual([{ providerId: login, apiValuePerHour: 5.5 }]);
		now += 7 * minute;
		const stale = await client.request({ type: "subscriptions.usage" });
		expect(stale.type === "subscriptions.usage" && stale.subscriptions[0]?.windows[0]?.forecast).toBeUndefined();
	} finally { client.close(); }
});
