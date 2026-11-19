import { afterEach, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LimitReading } from "../src/limit-ledger.ts";
import { ConversationRequests } from "../src/request-log.ts";
import { LEGACY_REQUEST_LOG_FILE, REQUEST_LOG_FILE, RequestLogStore, type RequestRow } from "../src/request-log-store.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const START = Date.parse("2026-01-02T12:00:00Z");
const PROVIDER = "synthetic";
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "limit-ledger-"));
	const path = join(dir, "test.sqlite");
	let now = START;
	let store = RequestLogStore.open(path, { now });
	const sql = new Database(path, { readonly: true });
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }), () => store.close(), () => sql.close());
	return {
		get store() { return store; },
		get now() { return now; },
		sql,
		advance: (ms: number) => { now += ms; },
		reopen: () => { store.close(); store = RequestLogStore.open(path, { now }); },
		read: (usedPercent: number, overrides: Partial<LimitReading> = {}) => store.ledger.reading(PROVIDER, {
			id: "weekly", label: "Weekly limit", windowMinutes: 10_080,
			usedPercent, resetsAt: iso(START + DAY), source: "usage_api", ...overrides,
		}, now),
		periods: () => sql.query("SELECT * FROM limit_periods ORDER BY id").all(),
		samples: () => sql.query("SELECT * FROM limit_samples ORDER BY at, id").all(),
	};
}

const iso = (at: number) => new Date(at).toISOString();
function request(overrides: Partial<RequestRow> = {}): RequestRow {
	return {
		...new ConversationRequests({ projectId: "garden", conversationId: 1,
			identity: { kind: "main", threadId: "main", taskId: null, workerId: null, scheduleId: null },
		}).request({ provider: PROVIDER, model: "small", timestamp: START,
			usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: { total: 0.125 } },
		}, { wake: "user", retention: "short", changes: null, source: "live" }),
		billing: "subscription", priced: true, ...overrides,
	};
}

it("closes a period at the scheduled reset when a reading passes it", () => {
	const f = fixture();
	f.read(93);
	f.advance(DAY + MINUTE);
	expect(f.store.ledger.bindingPeriodId(PROVIDER, f.now)).toBeNull();
	f.read(1, { resetsAt: iso(f.now + DAY) });
	expect(f.periods()).toMatchObject([
		{ id: 1, ended_at: START + DAY, end_reason: "reset", last_percent: 93 },
		{ id: 2, started_at: f.now, ended_at: null, first_percent: 1 },
	]);
});

it("records small reset-time changes but starts a new period when it moves by over five minutes", () => {
	const f = fixture();
	f.read(25);
	f.advance(MINUTE);
	f.read(25, { resetsAt: iso(START + DAY + 5 * MINUTE) });
	expect(f.periods()).toHaveLength(1);
	expect(f.samples()).toHaveLength(2);
	f.advance(MINUTE);
	f.read(25, { resetsAt: iso(START + DAY - MINUTE) });
	expect(f.periods()).toMatchObject([{ ended_at: f.now, end_reason: "reset" }, { ended_at: null, first_percent: 25 }]);
});

it("closes a period when use drops without a reset-time change", () => {
	const f = fixture();
	f.read(30);
	f.advance(MINUTE);
	f.read(12);
	expect(f.periods()).toMatchObject([{ end_reason: "drop", last_percent: 30 }, { first_percent: 12, ended_at: null }]);
});

it("continues the same period after reopening and keeps only the two ends of a flat run", () => {
	const f = fixture();
	f.read(5);
	f.advance(1_000);
	f.read(6);
	f.advance(1_000);
	f.read(6);
	f.reopen();
	f.advance(1_000);
	f.read(6, { source: "stream_event" });
	f.advance(1_000);
	f.read(7, { source: "response_headers" });
	expect(f.periods()).toMatchObject([{ id: 1, first_percent: 5, last_percent: 7, ended_at: null }]);
	expect(f.samples()).toMatchObject([
		{ at: START, period_id: 1, used_percent: 5, source: "usage_api" },
		{ at: START + 1_000, period_id: 1, used_percent: 6, source: "usage_api" },
		{ at: START + 3_000, period_id: 1, used_percent: 6, source: "stream_event" },
		{ at: START + 4_000, period_id: 1, used_percent: 7, source: "response_headers" },
	]);
});

it("opens a period before any request and binds requests to the longest unscoped window at their start", () => {
	const f = fixture();
	f.read(10, { id: "short", windowMinutes: 300 });
	f.read(20);
	f.read(30, { id: "metered", windowMinutes: 12_000, scope: "Synthetic model", label: "Synthetic limit" });
	expect(f.periods()).toMatchObject([
		{ id: 1, requests: 0, scope: null }, { id: 2, requests: 0, kemiri_points: 0, elsewhere_points: 20 },
		{ id: 3, requests: 0, scope: "Synthetic model", window_minutes: 12_000, label: "Synthetic limit" },
	]);
	f.advance(MINUTE);
	f.read(0);
	f.store.insertMany([
		request({ at: START - 1 }), request(), request({ billing: "api_key" }), request({ at: f.now, billing: "plan_key" }),
	]);
	expect(f.store.rows({ from: START - 1, to: f.now + 1 }).map(row => row.periodId)).toEqual([null, 2, null, 4]);
	expect(f.periods()).toMatchObject([{ requests: 0 }, { requests: 1, api_value: 0.125 }, { requests: 0 }, { requests: 1, api_value: 0.125 }]);
});

it("prunes requests and samples without losing grouped usage or periods", () => {
	const f = fixture();
	f.read(10);
	f.store.insertMany([request(), request({ at: START + 1, priced: false }), request({ at: START + DAY })]);
	const rollup = () => f.sql.query("SELECT * FROM usage_rollup ORDER BY day").all();
	const before = rollup();
	expect(before).toMatchObject([
		{ day: "2026-01-02", requests: 2, input: 4, output: 6, cache_read: 8, cache_write: 10, cost: 0.25,
			role: "coordinator", billing: "subscription", period_id: 1, task_id: null, worker_id: null, unpriced_requests: 1 },
		{ day: "2026-01-03", requests: 1, period_id: null },
	]);
	f.advance(92 * DAY);
	expect(f.store.prune(f.now)).toBe(3);
	expect(f.samples()).toEqual([]);
	expect(f.periods()).toHaveLength(1);
	expect(rollup()).toEqual(before);
});

it("migrates schema 2 and seeds the roll-up for retained rows exactly once", () => {
	const dir = mkdtempSync(join(tmpdir(), "usage-migration-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "test.sqlite");
	const store = RequestLogStore.open(path, { now: START });
	store.insertMany([request({ purpose: "compaction" }), request({ purpose: "compaction" })]);
	store.close();
	using sql = new Database(path);
	sql.exec(`ALTER TABLE requests DROP COLUMN billing; ALTER TABLE requests DROP COLUMN period_id;
		ALTER TABLE requests DROP COLUMN priced; DROP TABLE usage_rollup; DROP TABLE limit_samples;
		DROP TABLE limit_periods; DROP TABLE subscription_terms; UPDATE meta SET value = '2' WHERE key = 'schema_version'`);
	for (let i = 0; i < 2; i++) {
		const reopened = RequestLogStore.open(path, { now: START });
		try {
			expect(reopened.rows({ from: START, to: START + 1 })).toMatchObject(Array(2).fill({
				cost: 0.125, billing: null, periodId: null, priced: null, purpose: "compaction",
			}));
			expect(sql.query("SELECT * FROM usage_rollup").all()).toMatchObject([{ requests: 2, cost: 0.25, role: "compaction", billing: null }]);
			expect(sql.query("SELECT * FROM subscription_terms").all()).toEqual([]);
		} finally { reopened.close(); }
	}
	sql.exec("UPDATE meta SET value = '5' WHERE key = 'schema_version'");
	expect(() => RequestLogStore.open(path)).toThrow("schema 5 is newer");
});

it("copies an older release's log into the new file and leaves the old one for a rollback", () => {
	const dir = mkdtempSync(join(tmpdir(), "usage-legacy-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const legacyPath = join(dir, LEGACY_REQUEST_LOG_FILE);
	const path = join(dir, REQUEST_LOG_FILE);
	const store = RequestLogStore.open(legacyPath, { now: START });
	store.insertMany([request({ purpose: "compaction" })]);
	store.close();
	{
		using sql = new Database(legacyPath);
		sql.exec(`ALTER TABLE requests DROP COLUMN billing; ALTER TABLE requests DROP COLUMN period_id;
			ALTER TABLE requests DROP COLUMN priced; DROP TABLE usage_rollup; DROP TABLE limit_samples;
			DROP TABLE limit_periods; DROP TABLE subscription_terms; UPDATE meta SET value = '2' WHERE key = 'schema_version'`);
	}
	expect(RequestLogStore.copyLegacy(legacyPath, path)).toBe(true);
	expect(RequestLogStore.copyLegacy(legacyPath, path)).toBe(false);
	const migrated = RequestLogStore.open(path, { now: START });
	try {
		expect(migrated.rows({ from: START, to: START + 1 })).toMatchObject([{ cost: 0.125, purpose: "compaction" }]);
	} finally { migrated.close(); }
	using legacy = new Database(legacyPath, { readonly: true });
	expect(legacy.query("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "2" });
	expect(legacy.query("SELECT name FROM sqlite_master WHERE name = 'usage_rollup'").all()).toEqual([]);
	expect(RequestLogStore.copyLegacy(join(dir, "missing.sqlite"), join(dir, "other.sqlite"))).toBe(false);
});

it.each([
	{ label: "a request ends inside", duration: 5 * MINUTE, kemiri: 10, elsewhere: 0, apiValue: 0.125 },
	{ label: "a request ends two minutes before", duration: MINUTE, kemiri: 10, elsewhere: 0, apiValue: 0 },
	{ label: "the jump is after a quiet stretch", duration: MINUTE - 1, kemiri: 0, elsewhere: 10, apiValue: 0 },
	{ label: "a request is still running", duration: 9 * MINUTE, kemiri: 0, elsewhere: 10, apiValue: 0 },
	{ label: "the first reading starts above zero", duration: 5 * MINUTE, kemiri: 10, elsewhere: 7, apiValue: 0.125 },
])("splits a period when $label", ({ duration, kemiri, elsewhere, apiValue }) => {
	const f = fixture();
	const first = elsewhere === 7 ? 7 : 0;
	f.advance(3 * MINUTE);
	f.read(first);
	f.advance(4 * MINUTE);
	f.read(first + 10);
	// Headers can enter the ledger before the completed response reaches the log.
	f.store.insert(request({ at: START, durationMs: duration }));
	expect(f.periods()).toMatchObject([{ kemiri_points: kemiri, elsewhere_points: elsewhere, observed_api_value: apiValue }]);
	f.advance(MINUTE);
	f.read(0);
	f.store.insert(request({ at: START, durationMs: 5 * MINUTE }));
	expect(f.periods()).toMatchObject([{ kemiri_points: kemiri, elsewhere_points: elsewhere, observed_api_value: apiValue },
		{ kemiri_points: 0, elsewhere_points: 0 }]);
});

it("upgrades schema 3, leaving only already-pruned UTC days approximate at local month boundaries", () => {
	const dir = mkdtempSync(join(tmpdir(), "value-migration-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "test.sqlite");
	const midnight = Date.parse("2026-02-01T00:00:00Z");
	const store = RequestLogStore.open(path, { now: START });
	store.insertMany([request({ at: midnight - 2 * 60 * MINUTE }), request({ at: midnight - MINUTE }), request({ at: midnight + MINUTE })]);
	store.close();
	using sql = new Database(path);
	// Turn the synthetic rows into the schema-3 equivalents, including one request already pruned.
	sql.exec(`DROP INDEX usage_rollup_group;
		ALTER TABLE usage_rollup DROP COLUMN minute;
		UPDATE usage_rollup SET requests = 2, cost = 0.25 WHERE rowid = 1;
		DELETE FROM usage_rollup WHERE rowid = 2;
		CREATE UNIQUE INDEX usage_rollup_group ON usage_rollup (day, project_id, coalesce(task_id, 0),
			coalesce(worker_id, 0), coalesce(thread_id, 0), role, provider, model, coalesce(billing, 0), coalesce(period_id, ''));
		DELETE FROM requests WHERE id = 1;
		ALTER TABLE limit_periods DROP COLUMN observed_api_value;
		ALTER TABLE limit_periods DROP COLUMN measured_through;
		ALTER TABLE subscription_terms DROP COLUMN login_since;
		UPDATE meta SET value = '3' WHERE key = 'schema_version'`);
	const reopened = RequestLogStore.open(path);
	cleanups.push(() => reopened.close());
	const feb = (offset: number) => reopened.monthlyUsage(midnight - offset, midnight + 28 * DAY - offset);
	expect(feb(0)).toMatchObject({ groups: [{ cost: 0.125 }], approximate: false });
	expect(feb(60 * MINUTE)).toMatchObject({ groups: [{ cost: 0.25 }], approximate: true });
	expect(sql.query("SELECT sum(cost) AS cost, sum(requests) AS requests FROM usage_rollup").get()).toEqual({ cost: 0.375, requests: 3 });
});
