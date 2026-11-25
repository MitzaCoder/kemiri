import { afterEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { usageAnalysis, usageRole } from "../src/usage-analysis.ts";
import { ConversationRequests, RequestLog } from "../src/request-log.ts";
import { RequestLogStore, type RequestRow } from "../src/request-log-store.ts";
import { readCacheStats } from "../src/cache-stats.ts";
import { createSetup, TestClient } from "./support.ts";
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function row(overrides: Partial<RequestRow> = {}): RequestRow {
	const requests = new ConversationRequests({
		projectId: "garden",
		conversationId: 1,
		identity: { kind: "main", threadId: "main", taskId: null, workerId: null, scheduleId: null },
	});
	return {
		...requests.request(
			{
				provider: "synthetic",
				model: "small",
				timestamp: 100,
				stopReason: "stop",
				usage: { input: 10, cacheRead: 20, cacheWrite: 30, output: 40, cost: { total: 2 } },
			},
			{ wake: "user", retention: "short", changes: null, source: "live" },
		),
		...overrides,
	};
}
it("attributes ordinary historic roles without migration guesses and keeps schedule/maintenance mutually exclusive", () => {
	expect(usageRole(row())).toBe("coordinator");
	expect(usageRole(row({ kind: "worker" }))).toBe("worker");
	expect(usageRole(row({ kind: "thread" }))).toBe("thread");
	expect(usageRole(row({ kind: "worker", scheduleId: "nightly" }))).toBe("scheduled");
	expect(usageRole(row({ source: "keepWarm", scheduleId: "nightly" }))).toBe("keep_warm");
	expect(usageRole(row({ purpose: "compaction" }))).toBe("compaction");
	expect(usageRole(row({ kind: "other" }))).toBe("unknown");
});
it("reconciles every token and catalog cost across roles, model roles and projects, including warm-up", () => {
	const rows = [
		row(),
		row({
			kind: "worker",
			taskId: "T2",
			workerId: "writer",
			projectId: "library",
			model: "large",
			stopReason: "aborted",
		}),
		row({ source: "keepWarm", wake: "check_in" }),
		row({ purpose: "compaction", conversationId: 0, wake: null }),
	];
	const analysis = usageAnalysis(rows, new Map([["garden", "Garden"]]), 500);
	expect(analysis.totals).toMatchObject({
		requests: 4,
		inputTokens: 40,
		cacheReadTokens: 80,
		cacheWriteTokens: 120,
		outputTokens: 160,
		cost: 8,
		maxPromptTokens: 60,
	});
	for (const groups of [analysis.byRole, analysis.byModel, analysis.byModelRole, analysis.byProject])
		expect(groups.reduce((sum, g) => sum + g.cost, 0)).toBe(8);
	expect(analysis.byTask).toMatchObject([{ label: "library · T2", cost: 2 }]);
	expect(analysis.failed.requests).toBe(1);
	expect(analysis.checkIns.requests).toBe(0);
	expect(analysis.internalSince).toBe(new Date(500).toISOString());
	expect(analysis.conversations.every((c) => !c.label.includes("conversation 0"))).toBe(true);
});
it("keeps all ordinary usage, zero-cost calls and empty ranges; caps task and conversation rankings", () => {
	const rows = Array.from({ length: 40 }, (_, i) =>
		row({ conversationId: i + 1, taskId: `T${i}`, cost: i, wake: i === 0 ? "check_in" : "retry" }),
	);
	const analysis = usageAnalysis(rows, new Map(), null);
	expect(analysis.byTask).toHaveLength(30);
	expect(analysis.conversations).toHaveLength(30);
	expect(analysis.checkIns.requests).toBe(1);
	expect(analysis.retries.requests).toBe(39);
	expect(usageAnalysis([], new Map(), null).totals.cost).toBe(0);
});
it("migrates a legacy log losslessly and still opens it read-only before migration", async () => {
	const dir = await mkdtemp(join(tmpdir(), "usage-migration-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	const path = join(dir, "log.sqlite");
	let store = RequestLogStore.open(path, { now: 100 });
	store.insert(row());
	store.close();
	const db = new Database(path);
	db.exec(
		`ALTER TABLE requests DROP COLUMN purpose; ALTER TABLE requests DROP COLUMN billing;
		ALTER TABLE requests DROP COLUMN period_id; ALTER TABLE requests DROP COLUMN priced;
		DROP TABLE usage_rollup; DROP TABLE limit_samples; DROP TABLE limit_periods; DROP TABLE subscription_terms;
		UPDATE meta SET value='1' WHERE key='schema_version'; DELETE FROM meta WHERE key='internal_since'`,
	);
	db.close();
	store = RequestLogStore.open(path, { readonly: true });
	expect(store.rows({ from: 0, to: 1000 })[0]?.purpose).toBeNull();
	expect(store.internalSince()).toBeNull();
	store.close();
	store = RequestLogStore.open(path, { now: 200 });
	expect(store.rows({ from: 0, to: 1000 })[0]?.cost).toBe(2);
	expect(store.internalSince()).toBe(200);
	store.insert(row({ purpose: "compaction" }));
	expect(store.rows({ from: 0, to: 1000 })[1]?.purpose).toBe("compaction");
	store.close();
});
it("records internal completeSimple results once without changing replies or joining a cache-miss chain", async () => {
	const store = RequestLogStore.open(":memory:");
	const log = new RequestLog({ store });
	cleanups.push(() => log.close());
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([() => fauxAssistantMessage("A synthetic summary.")]);
	const observed = log.observeInternalModels(models, "garden", "compaction");
	const response = await observed.completeSimple(observed.getModel("faux", "faux-1")!, {
		messages: [{ role: "user", content: "Summarize synthetic fixture", timestamp: 100 }],
	});
	expect(response.stopReason).toBe("stop");
	await log.flush();
	expect(store.rows({ from: 0, to: Date.now() + 1 })).toMatchObject([
		{ purpose: "compaction", projectId: "garden", conversationId: 0, kind: "other", missTokens: 0, retention: "none" },
	]);
});
it("keeps analysis and reset mutations behind negotiated feature names", async () => {
	const setup = await createSetup({features:["cache-stats"]});
	cleanups.push(setup.cleanup);
	const client = await TestClient.open(setup.server);
	cleanups.push(()=>client.close());
	const hello = await client.hello();
	expect(hello.type).toBe("hello");
	if(hello.type === "hello") expect(hello.features).not.toContain("usage-breakdown");
	const stats = await client.request({type:"cache.stats"});
	expect(stats.type).toBe("cache.stats");
	if(stats.type === "cache.stats") expect(stats.stats.usage).toBeUndefined();
	const reset = await client.request({type:"subscriptions.reset",providerId:"openai-codex",creditId:"synthetic",program:"codex",requestId:crypto.randomUUID(),confirmed:true});
	expect(reset.type).toBe("error");
});

it("reports cache health only for opted-in clients on a supporting server", async () => {
	for (const supported of [false, true]) {
		const setup = await createSetup({ features: supported ? ["cache-stats", "cache-health"] : ["cache-stats"] });
		const client = await TestClient.open(setup.server);
		cleanups.push(() => client.close());
		const hello = await client.hello();
		if (hello.type !== "hello") throw new Error("No hello");
		expect(hello.features?.includes("cache-health")).toBe(supported);
		for (const cacheHealth of [undefined, true]) {
			const reply = await client.request({ type: "cache.stats", cacheHealth });
			if (reply.type !== "cache.stats") throw new Error("No cache stats");
			if (supported && cacheHealth) expect(reply.stats.cacheHealth).toEqual({
				readShare: null, lowReadShare: false, missCostSpiked: false, keepWarmAttempts: 0, keepWarmSuccesses: 0,
			});
			else expect(reply.stats.cacheHealth).toBeUndefined();
		}
	}
});

it("keeps pings out of prompt totals and infers success only from a read without a write or request failure", async () => {
	const now = Date.parse("2026-03-04T15:00:00Z");
	const day = 86_400_000;
	const store = RequestLogStore.open(":memory:");
	cleanups.push(() => store.close());
	const stats = (projectId?: string) => readCacheStats({ store, projects: { list: async () => [] }, now, days: 1, cacheHealth: true, projectId });
	store.insert(row({ at: now - day, input: 10_000, cacheRead: 75_000, cacheWrite: 15_000, promptTokens: 100_000,
		missTokens: 5_000, missCost: 2, source: "backfill" }));
	store.insert(row({ at: now - day - 1, missTokens: 1_000, missCost: 0.5 }));
	store.insert(row({ at: now - 2 * day - 2, missTokens: 50_000, missCost: 10 }));
	store.insert(row({ at: now - day - 2, projectId: "library", missTokens: 5_000, missCost: 5 }));
	for (const [index, fields] of [
		{}, { stopReason: "error" }, { stopReason: "aborted" }, { stopReason: null }, { cacheRead: 0 }, { cacheWrite: 1 },
	].entries()) store.insert(row({ at: now - index, source: "keepWarm", input: 0, cacheRead: 100_000, cacheWrite: 0,
		missTokens: 10_000, missCost: 99, ...fields }));
	const garden = await stats("garden");
	expect(garden.totals.missedCost).toBe(2);
	expect(garden.cacheHealth).toEqual({
		readShare: 0.75, lowReadShare: true, missCostSpiked: true, keepWarmAttempts: 6, keepWarmSuccesses: 1,
	});
	expect((await stats()).cacheHealth?.missCostSpiked).toBe(false); // The other project's prior misses count here.
});

it("compares the elapsed part of local calendar periods, not the end of an earlier day or month", async () => {
	const store = RequestLogStore.open(":memory:");
	cleanups.push(() => store.close());
	const now = Date.parse("2026-04-02T02:00:00Z");
	for (const [at, missCost] of [
		["2026-04-02T00:00:00Z", 2], // Current day and month.
		["2026-04-01T01:00:00Z", 0], // Previous day at the same local time.
		["2026-03-31T02:00:00Z", 9], // Outside the previous day and the comparable part of March.
		["2026-03-01T01:00:00Z", 0], // Previous month at the same local time.
		["2026-04-01T03:00:00Z", 0], // Past the previous day's cutoff.
	] as const) store.insert(row({ at: Date.parse(at), missTokens: missCost > 0 ? 400 : 0, missCost }));
	const options = { store, projects: { list: async () => [] }, now, utcOffsetMinutes: 120, cacheHealth: true };
	for (const period of [{ calendarToday: true }, { month: "2026-04" }]) {
		const stats = await readCacheStats({ ...options, ...period });
		expect(stats.cacheHealth?.lowReadShare).toBe(false); // Not enough prompt tokens to flag.
		expect(stats.cacheHealth?.missCostSpiked).toBe(true);
	}
	expect((await readCacheStats({ ...options, days: 1 })).cacheHealth?.missCostSpiked).toBe(false);
	expect((await readCacheStats({ ...options, days: 7 })).cacheHealth?.missCostSpiked).toBe(false); // No baseline rows.
});

it("calendarToday respects local midnight and excludes rows outside it", async () => {
	const store = RequestLogStore.open(":memory:");
	cleanups.push(() => store.close());
	const now = Date.parse("2026-01-02T02:00:00Z");
	store.insert(row({ at: now - 3 * 3600000 }));
	store.insert(row({ at: now - 3600000 }));
	const stats = await readCacheStats({
		store,
		projects: { list: async () => [] },
		now,
		calendarToday: true,
		utcOffsetMinutes: 120,
	});
	expect(stats.from).toBe("2026-01-01T22:00:00.000Z");
	expect(stats.usage?.totals.requests).toBe(2);
	const utc = await readCacheStats({
		store,
		projects: { list: async () => [] },
		now,
		calendarToday: true,
		utcOffsetMinutes: 0,
	});
	expect(utc.usage?.totals.requests).toBe(1);
});

it('reads a full local month and task/project details from pruned roll-ups without changing legacy reads', async () => {
	const setup = await createSetup();
	cleanups.push(setup.cleanup);
	const client = await TestClient.open(setup.server);
	cleanups.push(() => client.close());
	const hello = await client.hello();
	if (hello.type !== 'hello') throw new Error('No hello');
	expect(hello.features).toContain('recorded-usage');
	const store = setup.server.requestLog!.store;
	const boundary = Date.parse('2025-01-31T22:00:00Z'); // February midnight at UTC+2.
	for (const [index, projectId, taskId, model, cost, at] of [
		[1, 'garden', 'T1', 'small', 100, boundary - 60_000],
		[2, 'garden', 'T1', 'small', 2, boundary],
		[3, 'garden', 'T1', 'large', 3, boundary + 60_000],
		[4, 'garden', 'T2', 'small', 4, boundary + 60_000],
		[5, 'garden', null, 'small', 5, boundary + 60_000],
		[6, 'library', 'T1', 'small', 6, boundary + 60_000],
		[7, 'garden', 'T1', 'small', 100, Date.parse('2025-02-28T22:00:00Z')],
	] as const) {
		store.insert(row({ conversationId: index, at, taskId, projectId, model, cost,
			kind: taskId === null ? 'main' : 'worker', billing: taskId === null ? 'api_key' : 'subscription' }));
	}
	expect(store.prune(Date.parse('2025-07-01T00:00:00Z'))).toBe(7);
	const old = await client.request({ type: 'cache.stats' });
	if (old.type !== 'cache.stats') throw new Error('No cache stats');
	expect(old.stats.recorded).toBeUndefined();
	const range = { month: '2025-02', utcOffsetMinutes: 120 };
	const overview = await client.request({ type: 'cache.stats', ...range });
	if (overview.type !== 'cache.stats') throw new Error('No calendar month stats');
	expect(overview.stats.from).toBe('2025-01-31T22:00:00.000Z');
	expect(overview.stats.to).toBe('2025-02-28T22:00:00.000Z');
	expect(overview.stats.totals.requests).toBe(0); // Cache diagnosis needs the raw rows.
	expect(overview.stats.recorded?.totals).toMatchObject({ requests: 5, cost: 20, cacheReadTokens: 100 });
	expect(overview.stats.recorded?.byProject).toMatchObject([{ key: 'garden', cost: 14 }, { key: 'library', cost: 6 }]);
	expect(overview.stats.recorded?.byRole).toMatchObject([{ key: 'worker', cost: 15 }, { key: 'coordinator', cost: 5 }]);
	expect(overview.stats.recorded?.byProviderBilling).toMatchObject([
		{ key: '["synthetic","subscription"]', cost: 15 }, { key: '["synthetic","api_key"]', cost: 5 },
	]);
	const task = await client.request({ type: 'usage.detail', ...range, selection: { kind: 'task', projectId: 'garden', taskId: 'T1' } });
	if (task.type !== 'usage.detail') throw new Error('No task breakdown');
	expect(task.usage.totals.cost).toBe(5);
	expect(task.usage.byModel).toMatchObject([{ label: 'large', cost: 3 }, { label: 'small', cost: 2 }]);
	const project = await client.request({ type: 'usage.detail', ...range, selection: { kind: 'project', projectId: 'garden' } });
	if (project.type !== 'usage.detail') throw new Error('No project breakdown');
	expect(project.usage.byTask).toMatchObject([
		{ key: '["garden","T1"]', cost: 5 }, { key: '["garden",null]', label: 'Not tied to a task', cost: 5 },
		{ key: '["garden","T2"]', cost: 4 },
	]);
});
