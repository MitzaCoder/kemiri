import type { TaskConversationUsage, TaskSubscriptionUsage, TaskUsageAmount, TaskUsagePart, UsageTaskResponse } from "@kemiri/protocol";
import { ServerError } from "./errors.ts";
import type { MeasuredLimitPeriod } from "./limit-ledger.ts";
import type { RequestBilling, RequestLogStore, TaskUsageGroup } from "./request-log-store.ts";
import { subscriptionBilling, type PlanBilling } from "./subscription-terms.ts";
import { parentTask, type TaskLink, windowValue } from "./subscription-value.ts";

function emptyAmount(): TaskUsageAmount {
	return { requests: 0, apiValue: 0 };
}

function bindingShare(store: RequestLogStore, providerId: string, billing: PlanBilling, rows: TaskUsageGroup[], now: number) {
	const costsByPeriod = new Map<number | null, number>();
	for (const row of rows) costsByPeriod.set(row.period_id, (costsByPeriod.get(row.period_id) ?? 0) + row.cost);
	const periods = store.ledger.taskPeriods(providerId, [...costsByPeriod.keys()].filter(id => id !== null));
	const binding = periods.at(-1);
	if (!binding) return { bindingWindow: null, missing: true };
	// Different window lengths are not interchangeable. Report in units of the latest binding window used.
	const sameWindow = (period: MeasuredLimitPeriod) => period.window_id === binding.window_id && period.window_minutes === binding.window_minutes && period.scope === null;
	const pooledRates = new Map<string, number | null>();
	let estimatedPeriods = 0;
	let points = 0;
	for (const period of periods.filter(sameWindow)) {
		const { kemiri_points, observed_api_value, measured_through } = period;
		let rate: number | null = null;
		if (measured_through !== null && measured_through <= now && kemiri_points !== null && kemiri_points >= 5 && observed_api_value !== null && observed_api_value > 0) {
			rate = observed_api_value / kemiri_points;
		} else {
			const term = store.subscriptionTerms.at(providerId, period.started_at);
			const plan = term?.plan ?? null;
			const loginSince = term?.login_since ?? null;
			const poolKey = JSON.stringify([plan, loginSince]);
			if (!pooledRates.has(poolKey)) {
				const pool = store.ledger.periods(providerId, billing, plan, loginSince, now).filter(sameWindow);
				pooledRates.set(poolKey, pool.length ? windowValue(pool, now).valuePerPoint?.estimate ?? null : null);
			}
			rate = pooledRates.get(poolKey) ?? null;
		}
		if (rate !== null) {
			points += costsByPeriod.get(period.id)! / rate;
			estimatedPeriods++;
		}
	}
	return {
		bindingWindow: estimatedPeriods ? { label: binding.label, windowMinutes: binding.window_minutes, share: points / 100 } : null,
		missing: estimatedPeriods < costsByPeriod.size,
	};
}

export async function readTaskUsage(options: {
	store: RequestLogStore;
	projectId: string;
	taskId: string;
	tasks: readonly TaskLink[];
	billingFor: (providerId: string) => Promise<RequestBilling | null>;
	label: (providerId: string) => string;
	threadNames: () => Promise<ReadonlyMap<string, string>>;
	now: number;
}): Promise<Omit<UsageTaskResponse, "type" | "id">> {
	const { store, projectId, taskId, tasks, label, now } = options;
	const byId = new Map(tasks.map(task => [task.id, task]));
	if (!byId.has(taskId)) throw new ServerError("unknown_task", `No task "${taskId}" on the board`, { taskId });
	const children = new Map<string, TaskLink[]>();
	for (const task of tasks) {
		const parent = parentTask(task, byId);
		if (!parent) continue;
		const siblings = children.get(parent.id) ?? [];
		siblings.push(task);
		children.set(parent.id, siblings);
	}
	const visited = new Set([taskId]);
	const parts: TaskUsagePart[] = [];
	const pending = [...(children.get(taskId) ?? [])].reverse();
	while (pending.length) {
		const task = pending.pop()!;
		if (visited.has(task.id)) continue;
		visited.add(task.id);
		parts.push({ taskId: task.id, parentTaskId: task.parent!, title: task.title, total: emptyAmount() });
		const subtasks = children.get(task.id) ?? [];
		for (let i = subtasks.length - 1; i >= 0; i--) pending.push(subtasks[i]!);
	}
	const own = emptyAmount();
	const totals = new Map([[taskId, emptyAmount()], ...parts.map(part => [part.taskId, part.total] as const)]);
	const rows = store.taskUsage(projectId, [...visited]);
	const assumedBilling = new Map(await Promise.all([...new Set(rows.filter(row => row.billing === null).map(row => row.provider))]
		.map(async provider => [provider, await options.billingFor(provider)] as const)));
	const threadNames = rows.some(row => row.thread_id !== null && row.worker_id === null) ? await options.threadNames() : new Map();
	const subscriptions = new Map<string, { providerId: string; billing: PlanBilling; rows: TaskUsageGroup[] }>();
	const payAsYouGo = new Map<string, UsageTaskResponse["payAsYouGo"][number]>();
	const conversations = new Map<string, TaskConversationUsage>();
	let unpricedRequests = 0;
	for (const row of rows) {
		const amount = totals.get(row.task_id)!;
		amount.requests += row.requests;
		amount.apiValue += row.cost;
		unpricedRequests += row.unpriced;
		const billing = row.billing ?? assumedBilling.get(row.provider) ?? null;
		if (subscriptionBilling(billing)) {
			const key = JSON.stringify([row.provider, billing]);
			const subscription = subscriptions.get(key) ?? { providerId: row.provider, billing, rows: [] };
			subscription.rows.push(row);
			subscriptions.set(key, subscription);
		} else if (billing === "api_key") {
			const payment = payAsYouGo.get(row.provider) ?? { providerId: row.provider, label: label(row.provider), cost: 0, assumed: false };
			payment.cost += row.cost;
			payment.assumed ||= row.billing === null;
			payAsYouGo.set(row.provider, payment);
		}
		if (row.worker_id !== null || row.thread_id !== null) {
			const key = JSON.stringify([row.thread_id, row.worker_id, row.provider, row.model]);
			const conversation = conversations.get(key) ?? {
				kind: row.worker_id !== null ? "worker" : "thread", threadId: row.thread_id, workerId: row.worker_id,
				name: row.worker_id ?? threadNames.get(row.thread_id!) ?? row.thread_id!, providerId: row.provider, model: row.model, apiValue: 0,
			};
			conversation.apiValue += row.cost;
			conversations.set(key, conversation);
		}
	}
	const total = totals.get(taskId)!;
	Object.assign(own, total);
	for (let i = parts.length - 1; i >= 0; i--) {
		const part = parts[i]!;
		const parentTotal = totals.get(part.parentTaskId)!;
		parentTotal.requests += part.total.requests;
		parentTotal.apiValue += part.total.apiValue;
	}
	const missingLimitShare = new Set<string>();
	const subscriptionUsage: TaskSubscriptionUsage[] = [];
	for (const { providerId, billing, rows } of subscriptions.values()) {
		const { bindingWindow, missing } = bindingShare(store, providerId, billing, rows, now);
		const name = label(providerId);
		if (missing) missingLimitShare.add(name);
		subscriptionUsage.push({ providerId, label: name, billing, bindingWindow,
			apiValue: rows.reduce((sum, row) => sum + row.cost, 0), assumed: rows.some(row => row.billing === null) });
	}
	return { own, total, parts, subscriptions: subscriptionUsage, payAsYouGo: [...payAsYouGo.values()],
		conversations: [...conversations.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.model.localeCompare(b.model)),
		notes: { unpricedRequests, missingLimitShare: [...missingLimitShare] } };
}
