import type { CacheWarmStretch } from "@kemiri/protocol";
/**
 * The request log's database: one row per model request of every project on this backend, kept `REQUEST_LOG_KEEP_DAYS`
 * days, plus each conversation's last prompt fingerprint and which projects were read back from their transcripts.
 * `request-log.ts` writes it; `cache-stats.ts` and `bun run cache-report` read it. bun:sqlite, synchronous: a row is a
 * few hundred bytes, written off the request's path.
 */
import { Database } from "bun:sqlite";
import { existsSync, renameSync, rmSync } from "node:fs";
import {
	type CacheMissReason,
	type ConversationKind,
	LONG_PROMPT_CACHE_TTL_MS,
	type PreviousRequest,
	type RequestSource,
	type WakeReason,
	type UsageSelection,
} from "@kemiri/protocol";
import type { PromptFingerprint } from "./prompt-fingerprint.ts";
import { createLimitLedgerTables, createRequestEndIndex, LimitLedger } from "./limit-ledger.ts";
import { SubscriptionTerms } from "./subscription-terms.ts";
import { usageRole } from "./usage-analysis.ts";
import { tokenCatalogCost, type TokenRates } from "./request-pricing.ts";

export type RequestCatalogPricing = { provider: string; modelRates: (model: string, at: number) => TokenRates | undefined };

/**
 * Schema 3 added billing and the limit ledger in a new file. Releases before it refuse a newer schema, so the
 * schema-2 file stays where they look for it, untouched: a rolled-back release keeps its own log.
 */
export const REQUEST_LOG_FILE = "request-log-v3.sqlite";
/** Where releases before schema 3 keep their log; copied once into {@link REQUEST_LOG_FILE} and left as it is. */
export const LEGACY_REQUEST_LOG_FILE = "request-log.sqlite";
export const REQUEST_LOG_KEEP_DAYS = 90;
const SCHEMA_VERSION = 4;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Which conversation sent a request. */
export type ConversationIdentity = {
	kind: ConversationKind;
	threadId: string | null;
	workerId: string | null;
	taskId: string | null;
	/** The schedule that started the worker or thread, if one did: its first message is then a `schedule` wake. */
	scheduleId: string | null;
};

export type InternalUsagePurpose = "compaction" | "memory_extraction" | "memory_maintenance" | "report_audit" | "task_watcher";

export type RequestBilling = "subscription" | "plan_key" | "api_key" | "agent";

export type RequestRow = ConversationIdentity & {
	billing?: RequestBilling | null;
	periodId?: number | null;
	/** Null for legacy rows whose catalog price at the time of the request is unknown. */
	priced?: boolean | null;
	/** Internal calls have no transcript identity; ordinary roles derive from existing identity fields. */
	purpose?: InternalUsagePurpose | null;
	/** The response's timestamp (pi-ai stamps it when the request starts), ms since the epoch. */
	at: number;
	projectId: string;
	conversationId: number;
	provider: string;
	model: string;
	stopReason: string | null;
	input: number;
	cacheRead: number;
	cacheWrite: number;
	/** The part of `cacheWrite` written for an hour; null when the provider does not split it. */
	cacheWrite1h: number | null;
	output: number;
	cost: number;
	costInput: number;
	costCacheRead: number;
	costCacheWrite: number;
	costOutput: number;
	promptTokens: number;
	/** Since the conversation's previous request; null for its first. */
	idleMs: number | null;
	missTokens: number;
	missCost: number;
	missReason: CacheMissReason | null;
	wake: WakeReason | null;
	/** pi-ai's cache retention for the request (`short`, `long`, `none`); null when not known. */
	retention: string | null;
	changes: string[] | null;
	source: RequestSource;
	durationMs: number | null;
};

type DbRow = {
	billing: RequestBilling | null;
	period_id: number | null;
	priced: number | null;
	purpose: string | null;
	at: number;
	project_id: string;
	conversation_id: number;
	conversation_kind: string;
	thread_id: string | null;
	worker_id: string | null;
	task_id: string | null;
	schedule_id: string | null;
	provider: string;
	model: string;
	stop_reason: string | null;
	input: number;
	cache_read: number;
	cache_write: number;
	cache_write_1h: number | null;
	output: number;
	cost: number;
	cost_input: number;
	cost_cache_read: number;
	cost_cache_write: number;
	cost_output: number;
	prompt_tokens: number;
	idle_ms: number | null;
	miss_tokens: number;
	miss_cost: number;
	miss_reason: string | null;
	wake: string | null;
	retention: string | null;
	changes: string | null;
	source: string;
	duration_ms: number | null;
};

const COLUMNS = [
	"billing",
	"period_id",
	"priced",
	"purpose",
	"at",
	"project_id",
	"conversation_id",
	"conversation_kind",
	"thread_id",
	"worker_id",
	"task_id",
	"schedule_id",
	"provider",
	"model",
	"stop_reason",
	"input",
	"cache_read",
	"cache_write",
	"cache_write_1h",
	"output",
	"cost",
	"cost_input",
	"cost_cache_read",
	"cost_cache_write",
	"cost_output",
	"prompt_tokens",
	"idle_ms",
	"miss_tokens",
	"miss_cost",
	"miss_reason",
	"wake",
	"retention",
	"changes",
	"source",
	"duration_ms",
] as const;

function toDb(row: RequestRow): DbRow {
	return {
		billing: row.billing ?? null,
		period_id: row.periodId ?? null,
		priced: row.priced == null ? null : Number(row.priced),
		purpose: row.purpose ?? null,
		at: row.at,
		project_id: row.projectId,
		conversation_id: row.conversationId,
		conversation_kind: row.kind,
		thread_id: row.threadId,
		worker_id: row.workerId,
		task_id: row.taskId,
		schedule_id: row.scheduleId,
		provider: row.provider,
		model: row.model,
		stop_reason: row.stopReason,
		input: row.input,
		cache_read: row.cacheRead,
		cache_write: row.cacheWrite,
		cache_write_1h: row.cacheWrite1h,
		output: row.output,
		cost: row.cost,
		cost_input: row.costInput,
		cost_cache_read: row.costCacheRead,
		cost_cache_write: row.costCacheWrite,
		cost_output: row.costOutput,
		prompt_tokens: row.promptTokens,
		idle_ms: row.idleMs,
		miss_tokens: row.missTokens,
		miss_cost: row.missCost,
		miss_reason: row.missReason,
		wake: row.wake,
		retention: row.retention,
		changes: row.changes === null ? null : JSON.stringify(row.changes),
		source: row.source,
		duration_ms: row.durationMs,
	};
}

function fromDb(row: DbRow): RequestRow {
	return {
		billing: row.billing ?? null,
		periodId: row.period_id ?? null,
		priced: row.priced == null ? null : row.priced === 1,
		purpose: (row.purpose ?? null) as InternalUsagePurpose | null,
		at: row.at,
		projectId: row.project_id,
		conversationId: row.conversation_id,
		kind: row.conversation_kind as ConversationKind,
		threadId: row.thread_id,
		workerId: row.worker_id,
		taskId: row.task_id,
		scheduleId: row.schedule_id,
		provider: row.provider,
		model: row.model,
		stopReason: row.stop_reason,
		input: row.input,
		cacheRead: row.cache_read,
		cacheWrite: row.cache_write,
		cacheWrite1h: row.cache_write_1h,
		output: row.output,
		cost: row.cost,
		costInput: row.cost_input,
		costCacheRead: row.cost_cache_read,
		costCacheWrite: row.cost_cache_write,
		costOutput: row.cost_output,
		promptTokens: row.prompt_tokens,
		idleMs: row.idle_ms,
		missTokens: row.miss_tokens,
		missCost: row.miss_cost,
		missReason: row.miss_reason as CacheMissReason | null,
		wake: row.wake as WakeReason | null,
		retention: row.retention,
		changes: row.changes === null ? null : (JSON.parse(row.changes) as string[]),
		source: row.source as RequestSource,
		durationMs: row.duration_ms,
	};
}

function createUsageRollup(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS usage_rollup (
			day TEXT NOT NULL, minute INTEGER, project_id TEXT NOT NULL, task_id TEXT, worker_id TEXT, thread_id TEXT,
			role TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, billing TEXT, period_id INTEGER,
			requests INTEGER NOT NULL, input INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL,
			output INTEGER NOT NULL, cost REAL NOT NULL, unpriced_requests INTEGER NOT NULL
		) STRICT;
		CREATE UNIQUE INDEX IF NOT EXISTS usage_rollup_group ON usage_rollup (
			day, coalesce(minute, ''), project_id, coalesce(task_id, 0), coalesce(worker_id, 0), coalesce(thread_id, 0),
			role, provider, model, coalesce(billing, 0), coalesce(period_id, '')
		);
	`);
}

function addToUsageRollup(db: Database, row: RequestRow, bucket: "minute" | "legacy-day" = "minute", sign = 1): void {
	// The grouping index treats missing dimensions as equal, using a different SQLite type from each column.
	db.query(`INSERT INTO usage_rollup (day, minute, project_id, task_id, worker_id, thread_id, role, provider, model, billing, period_id,
		requests, input, cache_read, cache_write, output, cost, unpriced_requests)
		VALUES (date(? / 1000.0, 'unixepoch'), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT DO UPDATE SET requests = requests + excluded.requests, input = input + excluded.input,
		cache_read = cache_read + excluded.cache_read, cache_write = cache_write + excluded.cache_write,
		output = output + excluded.output, cost = cost + excluded.cost, unpriced_requests = unpriced_requests + excluded.unpriced_requests`
	).run(row.at, bucket === "legacy-day" ? null : Math.floor(row.at / 60_000), row.projectId, row.taskId, row.workerId,
		row.threadId, usageRole(row), row.provider, row.model, row.billing ?? null, row.periodId ?? null,
		sign, sign * row.input, sign * row.cacheRead, sign * row.cacheWrite, sign * row.output, sign * row.cost,
		sign * Number(row.priced === false));
}

type UsageCostGroup = {
	provider: string; model: string; billing: RequestBilling | null; cost: number; unpriced: number;
};

export type MonthlyUsageGroup = UsageCostGroup & {
	project_id: string; task_id: string | null; is_coordinator: 0 | 1;
};

export type RecordedUsageRow = UsageCostGroup & {
	projectId: string; taskId: string | null; role: string; requests: number;
	inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
};

export type TaskUsageGroup = UsageCostGroup & {
	task_id: string; worker_id: string | null; thread_id: string | null; period_id: number | null; requests: number;
};

export type BackfillRecord = { projectId: string; doneAt: number; rows: number; error: string | null };

export class RequestLogStore {
	readonly #db: Database;
	readonly ledger: LimitLedger;
	readonly subscriptionTerms: SubscriptionTerms;
	readonly #warmListeners = new Set<() => void>();
	readonly #insert: ReturnType<Database["prepare"]>;

	private constructor(db: Database, private readonly catalogPricing?: RequestCatalogPricing) {
		this.#db = db;
		this.ledger = new LimitLedger(db);
		this.subscriptionTerms = new SubscriptionTerms(db, this.ledger);
		const knownColumns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(requests)").all().map(column => column.name));
		const columns = COLUMNS.filter(column => knownColumns.has(column));
		this.#insert = db.prepare(
			`INSERT INTO requests (${columns.join(", ")}) VALUES (${columns.map((column) => `$${column}`).join(", ")})`,
		);
	}

	/**
	 * Copy the log of an older release to `path` when `path` does not exist yet, leaving the old file unchanged.
	 * Returns whether it copied. The copy is migrated when `path` is opened.
	 */
	static copyLegacy(legacyPath: string, path: string): boolean {
		if (existsSync(path) || !existsSync(legacyPath)) return false;
		const partial = `${path}.copying`;
		rmSync(partial, { force: true });
		const legacy = new Database(legacyPath, { readonly: true, strict: true });
		try {
			legacy.query("VACUUM INTO ?").run(partial);
		} finally {
			legacy.close();
		}
		renameSync(partial, path);
		return true;
	}

	/** Open or create the log; `now` stamps a new one's `liveSince`. `readonly` opens an existing file for reading only. */
	static open(path: string, options: { now?: number; readonly?: boolean; catalogPricing?: RequestCatalogPricing } = {}): RequestLogStore {
		if (options.readonly === true) {
			const db = new Database(path, { readonly: true, strict: true });
			return new RequestLogStore(db);
		}
		const db = new Database(path, { create: true, strict: true });
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`);
		const version = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
		if (version !== null && Number(version.value) > SCHEMA_VERSION) {
			db.close();
			throw new Error(`request log schema ${version.value} is newer than this release's ${SCHEMA_VERSION}`);
		}
		db.exec(`CREATE TABLE IF NOT EXISTS requests (
			id INTEGER PRIMARY KEY,
			at INTEGER NOT NULL,
			project_id TEXT NOT NULL,
			conversation_id INTEGER NOT NULL,
			conversation_kind TEXT NOT NULL,
			thread_id TEXT,
			worker_id TEXT,
			task_id TEXT,
			schedule_id TEXT,
			provider TEXT NOT NULL,
			model TEXT NOT NULL,
			stop_reason TEXT,
			input INTEGER NOT NULL,
			cache_read INTEGER NOT NULL,
			cache_write INTEGER NOT NULL,
			cache_write_1h INTEGER,
			output INTEGER NOT NULL,
			cost REAL NOT NULL,
			cost_input REAL NOT NULL,
			cost_cache_read REAL NOT NULL,
			cost_cache_write REAL NOT NULL,
			cost_output REAL NOT NULL,
			prompt_tokens INTEGER NOT NULL,
			idle_ms INTEGER,
			miss_tokens INTEGER NOT NULL,
			miss_cost REAL NOT NULL,
			miss_reason TEXT,
			wake TEXT,
			retention TEXT,
			changes TEXT,
			source TEXT NOT NULL,
			duration_ms INTEGER
		) STRICT`);
		db.exec(`CREATE TABLE IF NOT EXISTS cache_warm_snapshots (project_id TEXT NOT NULL, conversation_id INTEGER NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(project_id, conversation_id)) STRICT`);
		db.exec(`CREATE TABLE IF NOT EXISTS cache_warm_stretches (
            project_id TEXT NOT NULL, conversation_id INTEGER NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL,
            summary TEXT NOT NULL, PRIMARY KEY (project_id, conversation_id, id)
        ) STRICT`);
        db.exec("CREATE INDEX IF NOT EXISTS requests_by_time ON requests (at)");
		db.exec("CREATE INDEX IF NOT EXISTS requests_by_conversation ON requests (project_id, conversation_id, at)");
		db.exec(`CREATE TABLE IF NOT EXISTS prompt_state (
			project_id TEXT NOT NULL,
			conversation_id INTEGER NOT NULL,
			updated_at INTEGER NOT NULL,
			fingerprint TEXT NOT NULL,
			PRIMARY KEY (project_id, conversation_id)
		) STRICT`);
		db.exec(`CREATE TABLE IF NOT EXISTS backfills (
			project_id TEXT PRIMARY KEY,
			done_at INTEGER NOT NULL,
			rows INTEGER NOT NULL,
			error TEXT
		) STRICT`);
		try {
			db.transaction(() => {
				const schema = db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
				if (Number(schema?.value) === SCHEMA_VERSION) return;
				if (schema && Number(schema.value) > SCHEMA_VERSION) {
					throw new Error(`request log schema ${schema.value} is newer than this release's ${SCHEMA_VERSION}`);
				}
				const columns = new Set(db.query<{ name: string }, []>("PRAGMA table_info(requests)").all().map(column => column.name));
				for (const [name, type] of [["purpose", "TEXT"], ["billing", "TEXT"], ["period_id", "INTEGER"], ["priced", "INTEGER"]] as const) {
					if (!columns.has(name)) db.exec(`ALTER TABLE requests ADD COLUMN ${name} ${type}`);
				}
				createLimitLedgerTables(db);
				const upgradeDailyRollups = Number(schema?.value) === 3;
				if (upgradeDailyRollups) {
					db.exec(`ALTER TABLE usage_rollup ADD COLUMN minute INTEGER;
						DROP INDEX usage_rollup_group;
						ALTER TABLE limit_periods ADD COLUMN observed_api_value REAL;
						ALTER TABLE limit_periods ADD COLUMN measured_through INTEGER;
						ALTER TABLE subscription_terms ADD COLUMN login_since INTEGER`);
				}
				createUsageRollup(db);
				createRequestEndIndex(db);
				// Upgrade retained rows to minute precision. Only already-pruned schema-3 rows stay daily.
				for (const stored of db.query<DbRow, []>("SELECT * FROM requests").iterate()) {
					const row = fromDb(stored);
					if (upgradeDailyRollups) addToUsageRollup(db, row, "legacy-day", -1);
					addToUsageRollup(db, row);
				}
				if (upgradeDailyRollups) {
					db.exec("DELETE FROM usage_rollup WHERE requests = 0");
					new LimitLedger(db).backfillMeasurements();
				}
				db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
			}).immediate();
		} catch (error) {
			db.close();
			throw error;
		}
		db.exec("CREATE INDEX IF NOT EXISTS usage_rollup_by_task ON usage_rollup (project_id, task_id) WHERE task_id IS NOT NULL");
		db.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('internal_since', ?)").run(String(options.now ?? Date.now()));
		db.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('live_since', ?)").run(String(options.now ?? Date.now()));
		const store = new RequestLogStore(db, options.catalogPricing);
		try {
			store.#priceRetainedRequests();
			return store;
		} catch (error) {
			db.close();
			throw error;
		}
	}

	#withCatalogCost(row: RequestRow): RequestRow {
		if (row.cost !== 0 || row.provider !== this.catalogPricing?.provider) return row;
		const rates = this.catalogPricing.modelRates(row.model, row.at);
		if (!rates) return row;
		const cost = tokenCatalogCost(rates, row);
		return { ...row, priced: true, cost: cost.total, costInput: cost.input,
			costOutput: cost.output, costCacheRead: cost.cacheRead, costCacheWrite: cost.cacheWrite };
	}

	/** Repair retained rows only. Pruned buckets can mix requests with different pricing histories. */
	#priceRetainedRequests(): void {
		const pricing = this.catalogPricing;
		if (!pricing) return;
		const db = this.#db;
		db.transaction(() => {
			const update = db.query(`UPDATE requests SET priced = 1, cost = ?, cost_input = ?, cost_output = ?,
				cost_cache_read = ?, cost_cache_write = ? WHERE id = ?`);
			const updatePeriod = db.query("UPDATE limit_periods SET api_value = api_value + ? WHERE id = ?");
			let refreshOpenPeriods = false;
			for (const stored of db.query<DbRow & { id: number }, [string]>(`
				SELECT * FROM requests WHERE provider = ? AND priced IS NOT 1 AND cost = 0
			`).all(pricing.provider)) {
				const row = fromDb(stored);
				const priced = this.#withCatalogCost(row);
				if (priced === row) continue;
				update.run(priced.cost, priced.costInput, priced.costOutput, priced.costCacheRead, priced.costCacheWrite, stored.id);
				addToUsageRollup(db, row, "minute", -1);
				addToUsageRollup(db, priced);
				if (priced.cost > 0 && (row.billing === "subscription" || row.billing === "plan_key")) {
					if (row.periodId != null) updatePeriod.run(priced.cost, row.periodId);
					refreshOpenPeriods = true;
				}
			}
			if (refreshOpenPeriods) this.ledger.refreshOpenMeasurements(pricing.provider);
		}).immediate();
	}

	internalSince(): number | null {
		const row = this.#db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'internal_since'").get();
		return row === null ? null : Number(row.value);
	}

	/** When this log started recording requests as they ran: older ones come from the transcripts. */
	markWarmRestarted(): void {
        for (const row of this.#db.query<{project_id: string; conversation_id: number; id: string; summary: string}, []>("SELECT * FROM cache_warm_stretches").all()) {
            const summary = JSON.parse(row.summary) as CacheWarmStretch;
            if (summary.stopped !== undefined) continue;
            summary.stopped = "Server restarted";
            this.#db.query("UPDATE cache_warm_stretches SET summary = ? WHERE project_id = ? AND conversation_id = ? AND id = ?")
                .run(JSON.stringify(summary), row.project_id, row.conversation_id, row.id);
        }
	}

	liveSince(): number | null {
		const row = this.#db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'live_since'").get();
		return row === null ? null : Number(row.value);
	}

	insert(row: RequestRow): void {
		this.#db.transaction(() => this.#insertRequest(row))();
	}

	#insertRequest(row: RequestRow): void {
		row = this.#withCatalogCost(row);
		if (row.periodId === undefined && (row.billing === "subscription" || row.billing === "plan_key")) {
			row = { ...row, periodId: this.ledger.bindingPeriodId(row.provider, row.at) };
		}
		this.#insert.run(toDb(row) as never);
		addToUsageRollup(this.#db, row);
		if (row.billing === "subscription" || row.billing === "plan_key") {
			this.ledger.requestEnded(row.provider, row.at + (row.durationMs ?? 0));
		}
		if (row.periodId != null) {
			this.#db.query("UPDATE limit_periods SET api_value = api_value + ?, requests = requests + 1 WHERE id = ?")
				.run(row.cost, row.periodId);
		}
	}

	insertMany(rows: readonly RequestRow[]): void {
		this.#db.transaction(() => {
			for (const row of rows) this.#insertRequest(row);
		})();
	}

	/** The conversation's newest request, for a tracker to go on from after a restart. */
	previousRequest(projectId: string, conversationId: number): (PreviousRequest & { at: number }) | undefined {
		const row = this.#db
			.query<{ at: number; prompt_tokens: number; provider: string; model: string }, [string, number]>(
				"SELECT at, prompt_tokens, provider, model FROM requests WHERE project_id = ? AND conversation_id = ? AND source != 'keepWarm' AND prompt_tokens > 0 ORDER BY at DESC, id DESC LIMIT 1",
			)
			.get(projectId, conversationId);
		if (row === null) return undefined;
		const cached = this.#db
			.query<{ found: number }, [string, number]>(
				"SELECT EXISTS (SELECT 1 FROM requests WHERE project_id = ? AND conversation_id = ? AND source != 'keepWarm' AND cache_read + cache_write > 0) AS found",
			)
			.get(projectId, conversationId);
		// The cache lasts as long as the newest write asked for: the tracker's rule (`CacheMissTracker`), from the rows.
		const write = this.#db
			.query<{ hour: number | null }, [string, number]>(
				"SELECT cache_write_1h AS hour FROM requests WHERE project_id = ? AND conversation_id = ? AND source != 'keepWarm' AND cache_write > 0 ORDER BY at DESC, id DESC LIMIT 1",
			)
			.get(projectId, conversationId);
		return {
			at: row.at,
			timestamp: row.at,
			promptTokens: row.prompt_tokens,
			modelKey: `${row.provider}/${row.model}`,
			reportedCache: (cached?.found ?? 0) === 1,
			...((write?.hour ?? 0) > 0 ? { cacheTtlMs: LONG_PROMPT_CACHE_TTL_MS } : {}),
		};
	}

	/** The newest request's time of the conversation, any request (failed ones too). */
	lastRequestAt(projectId: string, conversationId: number): number | undefined {
		const row = this.#db
			.query<{ at: number }, [string, number]>(
				"SELECT MAX(at) AS at FROM requests WHERE project_id = ? AND conversation_id = ? AND source != 'keepWarm'",
			)
			.get(projectId, conversationId);
		return row?.at ?? undefined;
	}

	promptState(projectId: string, conversationId: number): PromptFingerprint | undefined {
		const row = this.#db
			.query<{ fingerprint: string }, [string, number]>(
				"SELECT fingerprint FROM prompt_state WHERE project_id = ? AND conversation_id = ?",
			)
			.get(projectId, conversationId);
		return row === null ? undefined : (JSON.parse(row.fingerprint) as PromptFingerprint);
	}

	savePromptState(projectId: string, conversationId: number, fingerprint: PromptFingerprint, at: number): void {
		this.#db
			.query(
				"INSERT INTO prompt_state (project_id, conversation_id, updated_at, fingerprint) VALUES (?, ?, ?, ?) ON CONFLICT (project_id, conversation_id) DO UPDATE SET updated_at = excluded.updated_at, fingerprint = excluded.fingerprint",
			)
			.run(projectId, conversationId, at, JSON.stringify(fingerprint));
	}

	backfill(projectId: string): BackfillRecord | undefined {
		const row = this.#db
			.query<{ project_id: string; done_at: number; rows: number; error: string | null }, [string]>(
				"SELECT project_id, done_at, rows, error FROM backfills WHERE project_id = ?",
			)
			.get(projectId);
		return row === null ? undefined : { projectId: row.project_id, doneAt: row.done_at, rows: row.rows, error: row.error };
	}

	/** Record a project's read-back with its rows in one transaction, so a crash in between reads it again. */
	finishBackfill(projectId: string, rows: readonly RequestRow[], at: number, error: string | null): void {
		this.#db.transaction(() => {
			if (this.backfill(projectId) !== undefined) return;
			for (const row of rows) this.#insertRequest(row);
			this.#db
				.query("INSERT OR REPLACE INTO backfills (project_id, done_at, rows, error) VALUES (?, ?, ?, ?)")
				.run(projectId, at, rows.length, error);
		}).immediate();
	}

	/** Forget rows, samples and fingerprints older than `keepDays`, but keep their accumulated totals. */
	prune(now: number, keepDays: number = REQUEST_LOG_KEEP_DAYS): number {
		const cutoff = now - keepDays * DAY_MS;
		this.#db.query("DELETE FROM cache_warm_snapshots WHERE json_extract(snapshot, '$.request.row.at') < ?").run(now - 8 * 3_600_000);
		this.#db.query("DELETE FROM cache_warm_stretches WHERE at < ?").run(cutoff);
		this.ledger.closeExpired(now, cutoff);
		const removed = this.#db.query("DELETE FROM requests WHERE at < ?").run(cutoff).changes;
		this.#db.query("DELETE FROM prompt_state WHERE updated_at < ?").run(cutoff);
		this.#db.query("DELETE FROM limit_samples WHERE at < ?").run(cutoff);
		return removed;
	}

	/** Exact for minute roll-ups. Assign an older daily total to the local month containing UTC noon. */
	monthlyUsage(from: number, to: number): { groups: MonthlyUsageGroup[]; approximate: boolean } {
		const firstDay = new Date(from).toISOString().slice(0, 10);
		const lastDay = new Date(to - 1).toISOString().slice(0, 10);
		const groups = this.#db.query<MonthlyUsageGroup, Record<string, string | number>>(`
			SELECT provider, model, billing, project_id, task_id, role = 'coordinator' AS is_coordinator,
				sum(cost) AS cost, sum(unpriced_requests) AS unpriced
			FROM usage_rollup WHERE day BETWEEN $firstDay AND $lastDay
			AND coalesce(minute, unixepoch(day, '12 hours') / 60) >= $from
			AND coalesce(minute, unixepoch(day, '12 hours') / 60) < $to
			GROUP BY provider, model, billing, project_id, task_id, is_coordinator
		`).all({ firstDay, lastDay, from: from / 60_000, to: to / 60_000 });
		const approximate = this.#db.query<{ found: number }, [string, string, number, number]>(`
			SELECT EXISTS (SELECT 1 FROM usage_rollup WHERE minute IS NULL
			AND ((day = ?1 AND ?3 % 86400 != 0) OR (day = ?2 AND ?4 % 86400 != 0))) AS found
		`).get(firstDay, lastDay, from / 1000, to / 1000);
		return { groups, approximate: approximate?.found === 1 };
	}

	/** The same stored totals power the overview and a detail scoped to one row. */
	recordedUsage(query: { from: number; to: number; projectId?: string; selection?: UsageSelection }): { rows: RecordedUsageRow[]; approximate: boolean } {
		const { from, to, projectId, selection } = query;
		if (from >= to) return { rows: [], approximate: false };
		const firstDay = new Date(from).toISOString().slice(0, 10);
		const lastDay = new Date(to - 1).toISOString().slice(0, 10);
		const args: Record<string, string | number | null> = { firstDay, lastDay };
		let scope = "day BETWEEN $firstDay AND $lastDay";
		function narrow(column: string, value: string | null): void {
			const key = `filter${Object.keys(args).length}`;
			scope += ` AND ${column} IS $${key}`;
			args[key] = value;
		}
		if (projectId !== undefined) narrow("project_id", projectId);
		if (selection?.kind === "project" || selection?.kind === "task") narrow("project_id", selection.projectId);
		if (selection?.kind === "task") narrow("task_id", selection.taskId);
		if (selection?.kind === "role") narrow("role", selection.role);
		if (selection?.kind === "model" || selection?.kind === "providerBilling") narrow("provider", selection.provider);
		if (selection?.kind === "model") narrow("model", selection.model);
		if (selection?.kind === "providerBilling") narrow("billing", selection.billing);
		const approximate = this.#db.query<{ found: number }, typeof args>(`SELECT EXISTS (
			SELECT 1 FROM usage_rollup WHERE ${scope} AND minute IS NULL
			AND ((day = $firstDay AND $from % 86400000 != 0) OR (day = $lastDay AND $to % 86400000 != 0))
		) AS found`).get({ ...args, from, to })?.found === 1;
		const rows = this.#db.query<RecordedUsageRow, typeof args>(`
			SELECT project_id AS projectId, task_id AS taskId, role, provider, model, billing,
				sum(requests) AS requests, sum(input) AS inputTokens, sum(output) AS outputTokens,
				sum(cache_read) AS cacheReadTokens, sum(cache_write) AS cacheWriteTokens,
				sum(cost) AS cost, sum(unpriced_requests) AS unpriced
			FROM usage_rollup WHERE ${scope}
			AND coalesce(minute, unixepoch(day, '12 hours') / 60) >= $from
			AND coalesce(minute, unixepoch(day, '12 hours') / 60) < $to
			GROUP BY project_id, task_id, role, provider, model, billing
		`).all({ ...args, from: Math.floor(from / 60_000), to: to / 60_000 });
		return { rows, approximate };
	}

	/** Lifetime totals, including usage that has aged out of the request log. */
	taskUsage(projectId: string, taskIds: readonly string[]): TaskUsageGroup[] {
		return this.#db.query<TaskUsageGroup, [string, string]>(`
			SELECT task_id, worker_id, thread_id, provider, model, billing, period_id,
				sum(cost) AS cost, sum(requests) AS requests, sum(unpriced_requests) AS unpriced
			FROM usage_rollup WHERE project_id = ? AND task_id IS NOT NULL
			AND task_id IN (SELECT value FROM json_each(?)) AND role NOT IN ('coordinator', 'keep_warm')
			GROUP BY task_id, worker_id, thread_id, provider, model, billing, period_id
		`).all(projectId, JSON.stringify(taskIds));
	}

	/** Rows in `[from, to)`, oldest first; one project's when `projectId` is given. */
	rows(query: { from: number; to: number; projectId?: string }): RequestRow[] {
		const rows =
			query.projectId === undefined
				? this.#db
						.query<DbRow, [number, number]>(`SELECT * FROM requests WHERE at >= ? AND at < ? ORDER BY at, id`)
						.all(query.from, query.to)
				: this.#db
						.query<DbRow, [number, number, string]>(
							`SELECT * FROM requests WHERE at >= ? AND at < ? AND project_id = ? ORDER BY at, id`,
						)
						.all(query.from, query.to, query.projectId);
		return rows.map(fromDb);
	}

    saveWarmSnapshot(projectId: string, conversationId: number, snapshot: unknown): void {
        this.#db.query("INSERT OR REPLACE INTO cache_warm_snapshots VALUES (?, ?, ?)").run(projectId, conversationId, JSON.stringify(snapshot));
    }
    warmSnapshots(projectId: string): unknown[] {
        return this.#db.query<{snapshot: string}, [string]>("SELECT snapshot FROM cache_warm_snapshots WHERE project_id = ?").all(projectId).map(row => JSON.parse(row.snapshot));
    }
    deleteWarmSnapshots(projectId: string, conversationId?: number): void {
        if (conversationId === undefined) this.#db.query("DELETE FROM cache_warm_snapshots WHERE project_id = ?").run(projectId);
        else this.#db.query("DELETE FROM cache_warm_snapshots WHERE project_id = ? AND conversation_id = ?").run(projectId, conversationId);
    }
    onWarmChange(listener: () => void): () => void { this.#warmListeners.add(listener); return () => { this.#warmListeners.delete(listener); }; }
    saveWarmStretch(projectId: string, conversationId: number, summary: CacheWarmStretch): void {
        this.#db.query("INSERT OR REPLACE INTO cache_warm_stretches VALUES (?, ?, ?, ?, ?)")
            .run(projectId, conversationId, summary.id, summary.lastAt, JSON.stringify(summary));
		queueMicrotask(() => { for (const listener of this.#warmListeners) listener(); });
    }
    warmStretches(projectId: string, conversationId: number): CacheWarmStretch[] {
        return this.#db.query<{summary: string}, [string, number]>("SELECT summary FROM cache_warm_stretches WHERE project_id = ? AND conversation_id = ? ORDER BY at")
            .all(projectId, conversationId).map(row => JSON.parse(row.summary) as CacheWarmStretch);
    }
    recordWarm(row: RequestRow, summary: CacheWarmStretch): void {
        this.#db.transaction(() => { this.#insertRequest(row); this.saveWarmStretch(row.projectId, row.conversationId, summary); })();
    }
	close(): void {
		this.#db.close();
	}
}
