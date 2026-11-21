import type { RecordedUsage, RecordedUsageGroup, UsageDetailRequest, UsageSelection } from "@kemiri/protocol";
import type { RecordedUsageRow, RequestLogStore } from "./request-log-store.ts";
import { type TaskLink, valueMonth } from "./subscription-value.ts";
import { usageRoleLabel } from "./usage-analysis.ts";

const DAY_MS = 86_400_000;

export function recordedUsageRange(period: Omit<UsageDetailRequest, "type" | "id" | "selection">, now: number) {
	const utcOffsetMinutes = period.utcOffsetMinutes ?? 0;
	if (period.month !== undefined) {
		const { from, to } = valueMonth({ month: period.month, utcOffsetMinutes }, now);
		return { from, to: Math.max(from, Math.min(now + 1, to)) };
	}
	const offset = utcOffsetMinutes * 60_000;
	return {
		from: period.calendarToday ? Math.floor((now + offset) / DAY_MS) * DAY_MS - offset : now - (period.days ?? 30) * DAY_MS,
		to: now + 1,
	};
}

function grouped(rows: readonly RecordedUsageRow[], identify: (row: RecordedUsageRow) => [string, string]): RecordedUsageGroup[] {
	const groups = new Map<string, RecordedUsageGroup>();
	for (const row of rows) {
		const [key, label] = identify(row);
		let group = groups.get(key);
		if (!group) {
			group = { key, label, cost: 0, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unpricedRequests: 0 };
			groups.set(key, group);
		}
		group.cost += row.cost;
		group.requests += row.requests;
		group.inputTokens += row.inputTokens;
		group.outputTokens += row.outputTokens;
		group.cacheReadTokens += row.cacheReadTokens;
		group.cacheWriteTokens += row.cacheWriteTokens;
		group.unpricedRequests += row.unpriced;
	}
	return [...groups.values()].sort((a, b) => b.cost - a.cost || a.key.localeCompare(b.key));
}

export async function readRecordedUsage(
	store: RequestLogStore,
	query: { from: number; to: number; projectId?: string; selection?: UsageSelection },
	projectNames: ReadonlyMap<string, string>,
	boardTasks?: (projectId: string) => Promise<readonly TaskLink[]>,
): Promise<RecordedUsage> {
	const { rows, approximate } = store.recordedUsage(query);
	const nameOf = (id: string) => id === "backend-maintenance" ? "Backend maintenance" : (projectNames.get(id) ?? id);
	const taskTitles = new Map<string, string>();
	if (boardTasks) {
		const projectIds = new Set(rows.filter(row => row.taskId !== null && projectNames.has(row.projectId)).map(row => row.projectId));
		await Promise.all([...projectIds].map(async projectId => {
			for (const task of await boardTasks(projectId).catch(() => [])) taskTitles.set(JSON.stringify([projectId, task.id]), task.title);
		}));
	}
	return {
		totals: grouped(rows, () => ["all", "All recorded requests"])[0]
			?? { key: "all", label: "All recorded requests", cost: 0, requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, unpricedRequests: 0 },
		byProject: grouped(rows, row => [row.projectId, nameOf(row.projectId)]),
		byTask: grouped(rows, row => {
			const key = JSON.stringify([row.projectId, row.taskId]);
			return [key, row.taskId === null ? "Not tied to a task" : taskTitles.get(key) ?? `${nameOf(row.projectId)} · ${row.taskId}`];
		}),
		byModel: grouped(rows, row => [JSON.stringify([row.provider, row.model]), row.model]),
		byRole: grouped(rows, row => [row.role, usageRoleLabel(row.role)]),
		byProviderBilling: grouped(rows, row => [JSON.stringify([row.provider, row.billing]), row.provider]),
		approximate,
	};
}
