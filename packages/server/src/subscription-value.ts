import type { BoardTask, SubscriptionValue, TopTaskValue, UsageValueRequest, UsageValueResponse, WindowValue } from "@kemiri/protocol";
import { matchesModelScope, type MeasuredLimitPeriod } from "./limit-ledger.ts";
import type { MonthlyUsageGroup, RequestBilling, RequestLogStore } from "./request-log-store.ts";
import { subscriptionBilling, type PlanBilling } from "./subscription-terms.ts";

const MINUTE_MS = 60_000;
const MONTH_MINUTES = 30.44 * 24 * 60;
const TOP_TASKS_LIMIT = 5;
export type TaskLink = Pick<BoardTask, "id" | "title" | "parent">;

export function valueMonth(input: Pick<UsageValueRequest, "month" | "utcOffsetMinutes">, now: number) {
	const offset = input.utcOffsetMinutes * MINUTE_MS;
	const month = input.month ?? new Date(now + offset).toISOString().slice(0, 7);
	const first = new Date(`${month}-01T00:00:00Z`);
	const from = first.getTime() - offset;
	first.setUTCMonth(first.getUTCMonth() + 1);
	const to = first.getTime() - offset;
	return { month, from, to, asOf: Math.min(to - 1, now) };
}

function elsewhereShare(kemiri: number, elsewhere: number): number | null {
	return kemiri + elsewhere > 0 ? elsewhere / (kemiri + elsewhere) : null;
}

export function windowValue(periods: MeasuredLimitPeriod[], asOf: number): WindowValue {
	const latest = periods.at(-1)!;
	const observed = periods.filter(period => period.measured_through != null && period.measured_through <= asOf);
	// Periods without activity can describe outside use, but supply no independent evidence for the rate.
	const evidence = observed.filter(period => period.kemiri_points! > 0 && period.observed_api_value! > 0);
	const cleaner = evidence.filter(period => (elsewhereShare(period.kemiri_points!, period.elsewhere_points!) ?? 0) <= 0.1);
	const pooled = cleaner.length >= 3 ? cleaner : evidence;
	const kemiriPoints = pooled.reduce((sum, period) => sum + period.kemiri_points!, 0);
	const apiValue = pooled.reduce((sum, period) => sum + period.observed_api_value!, 0);
	const error = Math.max(1, 0.6 * Math.sqrt(pooled.length));
	const valuePerPoint = kemiriPoints >= 5 ? {
		estimate: apiValue / kemiriPoints, low: apiValue / (kemiriPoints + error),
		high: kemiriPoints > error ? apiValue / (kemiriPoints - error) : null,
	} : null;
	const allKemiriPoints = observed.reduce((sum, period) => sum + period.kemiri_points!, 0);
	const elsewherePoints = observed.reduce((sum, period) => sum + period.elsewhere_points!, 0);
	return {
		windowId: latest.window_id, label: latest.label, scope: latest.scope, windowMinutes: latest.window_minutes,
		binding: false, windowsPerMonth: latest.scope === null && latest.window_minutes ? MONTH_MINUTES / latest.window_minutes : null,
		kemiriPoints, elsewherePoints, elsewhereShare: elsewhereShare(allKemiriPoints, elsewherePoints),
		periods: pooled.length, excludedNoisyPeriods: evidence.length - pooled.length, valuePerPoint,
		fullWindowValue: valuePerPoint && { estimate: valuePerPoint.estimate * 100, low: valuePerPoint.low * 100, high: valuePerPoint.high === null ? null : valuePerPoint.high * 100 },
	};
}

function windowsFor(periods: MeasuredLimitPeriod[], asOf: number): WindowValue[] {
	const byWindow = new Map<string, MeasuredLimitPeriod[]>();
	for (const period of periods) {
		const group = byWindow.get(period.window_id) ?? [];
		group.push(period);
		byWindow.set(period.window_id, group);
	}
	const windows = [...byWindow.values()].map(group => {
		const latest = group.at(-1)!;
		return windowValue(group.filter(period => period.scope === latest.scope), asOf);
	});
	windows.sort((a, b) => Number(a.scope !== null) - Number(b.scope !== null) || (b.windowMinutes ?? 0) - (a.windowMinutes ?? 0) || a.windowId.localeCompare(b.windowId));
	if (windows[0]?.scope === null) windows[0].binding = true;
	return windows;
}

/** Both usage views follow only real parent links, never provenance links. */
export function parentTask(task: TaskLink, tasks: ReadonlyMap<string, TaskLink>): TaskLink | undefined {
	return task.parent ? tasks.get(task.parent) : undefined;
}

/** Only roots get a line. A descendant's usage is counted once, regardless of other links on the board. */
function topTaskTotals(rows: MonthlyUsageGroup[], boards: ReadonlyMap<string, ReadonlyMap<string, TaskLink>>): TopTaskValue[] {
	const totals = new Map<string, Map<string, TopTaskValue>>();
	for (const { project_id: projectId, task_id: taskId, cost } of rows) {
		if (taskId === null) continue;
		const tasks = boards.get(projectId);
		const ownTask = tasks?.get(taskId);
		if (!ownTask) continue;
		let task: TaskLink = ownTask;
		const visited = new Set([task.id]);
		while (task.parent) {
			const parent = tasks && parentTask(task, tasks);
			if (!parent || visited.has(parent.id)) break;
			visited.add(parent.id);
			task = parent;
		}
		const projectTotals = totals.get(projectId) ?? new Map<string, TopTaskValue>();
		const total = projectTotals.get(task.id) ?? { projectId, taskId: task.id, title: task.title, apiValue: 0 };
		total.apiValue += cost;
		projectTotals.set(task.id, total);
		totals.set(projectId, projectTotals);
	}
	return [...totals.values()].flatMap(project => [...project.values()])
		.sort((a, b) => b.apiValue - a.apiValue || a.projectId.localeCompare(b.projectId) || a.taskId.localeCompare(b.taskId))
		.slice(0, TOP_TASKS_LIMIT);
}

export async function readSubscriptionValue(options: {
	store: RequestLogStore;
	month: ReturnType<typeof valueMonth>;
	currentBilling: ReadonlyMap<string, RequestBilling | null>;
	billingFor: (providerId: string) => Promise<RequestBilling | null>;
	label: (providerId: string) => string;
	boardTasks: (projectId: string) => Promise<readonly TaskLink[]>;
}): Promise<Omit<UsageValueResponse, "type" | "id">> {
	const { store, month: { month, from, to, asOf }, currentBilling, label } = options;
	const { groups, approximate } = store.monthlyUsage(from, to);
	const billingByProvider = new Map(currentBilling);
	await Promise.all([...new Set(groups.filter(row => row.billing === null).map(row => row.provider))].map(async provider => {
		if (!billingByProvider.has(provider)) billingByProvider.set(provider, await options.billingFor(provider));
	}));
	const subscriptionsByProvider = new Map<string, Map<PlanBilling, MonthlyUsageGroup[]>>();
	function subscriptionRows(provider: string, billing: PlanBilling): MonthlyUsageGroup[] {
		const groups = subscriptionsByProvider.get(provider) ?? new Map<PlanBilling, MonthlyUsageGroup[]>();
		const rows = groups.get(billing) ?? [];
		groups.set(billing, rows);
		subscriptionsByProvider.set(provider, groups);
		return rows;
	}
	const payAsYouGo = new Map<string, UsageValueResponse["payAsYouGo"][number]>();
	const taskProjects = new Set<string>();
	for (const row of groups) {
		const billing = row.billing ?? billingByProvider.get(row.provider) ?? null;
		if (subscriptionBilling(billing)) {
			subscriptionRows(row.provider, billing).push(row);
			if (row.task_id !== null) taskProjects.add(row.project_id);
		} else if (billing === "api_key") {
			const total = payAsYouGo.get(row.provider) ?? { providerId: row.provider, label: label(row.provider), cost: 0, assumed: false };
			total.cost += row.cost;
			total.assumed ||= row.billing === null;
			payAsYouGo.set(row.provider, total);
		}
	}
	for (const term of store.subscriptionTerms.subscriptionsAt(asOf)) subscriptionRows(term.provider, term.credential_type);
	const boards = new Map(await Promise.all([...taskProjects].map(async projectId => [
		projectId, new Map((await options.boardTasks(projectId)).map(task => [task.id, task])),
	] as const)));
	const subscriptions: SubscriptionValue[] = [];
	for (const [providerId, byBilling] of subscriptionsByProvider) {
		for (const [billing, rows] of byBilling) {
			const observedTerm = store.subscriptionTerms.at(providerId, asOf);
			const term = observedTerm?.credential_type === billing ? observedTerm : null;
			const plan = term?.plan ?? null;
			const price = store.subscriptionTerms.price(providerId, term);
			const periods = billing === "agent" || (observedTerm !== null && term === null) ? [] :
				store.ledger.periods(providerId, billing, plan, term?.login_since ?? null, asOf);
			const windows = windowsFor(periods, asOf);
			const binding = windows.find(window => window.binding);
			const fullMonthValue = binding?.fullWindowValue && binding.windowsPerMonth
				? binding.fullWindowValue.estimate * binding.windowsPerMonth : null;
			const apiValue = rows.reduce((total, row) => total + row.cost, 0);
			const models = new Map<string, number>();
			for (const row of rows) models.set(row.model, (models.get(row.model) ?? 0) + row.cost);
			const monthlyPrice = price.monthlyPrice;
			const ratio = (value: number) => {
				const ratio = monthlyPrice !== null ? value / monthlyPrice : NaN;
				return Number.isFinite(ratio) ? ratio : null;
			};
			subscriptions.push({
				providerId, label: label(providerId), billing, plan, price, apiValue, windows,
				realisedRatio: ratio(apiValue), fullUseRatio: fullMonthValue === null ? null : ratio(fullMonthValue),
				planUsed: fullMonthValue ? apiValue / fullMonthValue : null,
				models: [...models].sort(([a, aValue], [b, bValue]) => bValue - aValue || a.localeCompare(b)).map(([model, apiValue]) => {
					const scoped = windows.filter(window => window.scope !== null && matchesModelScope(window.scope, model))
						.sort((a, b) => Number(b.valuePerPoint !== null) - Number(a.valuePerPoint !== null) || b.kemiriPoints - a.kemiriPoints)[0];
					return { model, apiValue, scopedWindowId: scoped?.windowId ?? null, valuePerPoint: scoped?.valuePerPoint ?? null };
				}),
				topTasks: topTaskTotals(rows, boards), assumed: rows.some(row => row.billing === null),
			});
		}
	}
	const ledgerStartedAt = store.ledger.startedAt();
	return {
		month, subscriptions: subscriptions.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.billing.localeCompare(b.billing)),
		payAsYouGo: [...payAsYouGo.values()].sort((a, b) => a.providerId.localeCompare(b.providerId)),
		assumed: groups.some(row => row.billing === null), unpricedRequests: groups.reduce((sum, row) => sum + row.unpriced, 0),
		approximateMonth: approximate, ledgerSince: ledgerStartedAt === null ? null : new Date(ledgerStartedAt).toISOString(),
	};
}
