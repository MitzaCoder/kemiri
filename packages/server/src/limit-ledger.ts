import type { Database } from "bun:sqlite";

const ATTRIBUTION_LAG_MS = 2 * 60_000;
const REQUEST_END = "at + coalesce(duration_ms, 0)";

export function createRequestEndIndex(db: Database): void {
	db.exec(`CREATE INDEX IF NOT EXISTS requests_by_provider_end ON requests (provider, (${REQUEST_END}))`);
}

/** A limit can name a model ID, or a family. Match complete terms, never substrings. */
export function matchesModelScope(scope: string, model: string): boolean {
	const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(" ");
	const scopeWords = words(scope);
	return scopeWords !== "" && ` ${words(model)} `.includes(` ${scopeWords} `);
}

export const RESET_TOLERANCE_MS = 5 * 60_000;

export type LimitReading = {
	id: string;
	label: string;
	windowMinutes: number | null;
	scope?: string;
	usedPercent: number | null;
	resetsAt: string | null;
	source: "usage_api" | "response_headers" | "stream_event";
};

export function createLimitLedgerTables(db: Database): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS limit_periods (
			id INTEGER PRIMARY KEY,
			provider TEXT NOT NULL, window_id TEXT NOT NULL, label TEXT NOT NULL, window_minutes INTEGER, scope TEXT,
			started_at INTEGER NOT NULL, resets_at INTEGER, ended_at INTEGER, end_reason TEXT,
			first_percent REAL, last_percent REAL, kemiri_points REAL, elsewhere_points REAL,
			api_value REAL NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0,
			observed_api_value REAL, measured_through INTEGER
		) STRICT;
		CREATE UNIQUE INDEX IF NOT EXISTS limit_periods_open ON limit_periods (provider, window_id) WHERE ended_at IS NULL;
		CREATE INDEX IF NOT EXISTS limit_periods_by_window ON limit_periods (provider, window_id, started_at, id);
		CREATE TABLE IF NOT EXISTS limit_samples (
			id INTEGER PRIMARY KEY,
			at INTEGER NOT NULL, provider TEXT NOT NULL, window_id TEXT NOT NULL, period_id INTEGER NOT NULL,
			used_percent REAL, resets_at INTEGER, source TEXT NOT NULL
		) STRICT;
		CREATE INDEX IF NOT EXISTS limit_samples_by_time ON limit_samples (at);
		CREATE INDEX IF NOT EXISTS limit_samples_by_period ON limit_samples (period_id, at, id);
		CREATE TABLE IF NOT EXISTS subscription_terms (
			provider TEXT NOT NULL, since INTEGER NOT NULL, plan TEXT, credential_type TEXT, monthly_price REAL,
			login_since INTEGER,
			PRIMARY KEY (provider, since)
		) STRICT;
	`);
}

type OpenPeriod = {
	id: number;
	started_at: number;
	resets_at: number | null;
	last_percent: number | null;
	label: string;
	window_minutes: number | null;
};
export type MeasuredLimitPeriod = {
	window_id: string;
	label: string;
	window_minutes: number | null;
	scope: string | null;
	kemiri_points: number | null;
	elsewhere_points: number | null;
	observed_api_value: number | null;
	measured_through: number | null;
	end_reason: string | null;
};

type Sample = { id: number; at: number; used_percent: number | null; resets_at: number | null };

/** Provider-agnostic limit history. The open period and the tail of its sample run live in SQLite. */
export class LimitLedger {
	readonly #db: Database;
	/** Only a recent, confirmed spend on this exact period can explain a drop. */
	readonly #manualResets = new Map<number, number>();

	constructor(db: Database) {
		this.#db = db;
	}

	manualReset(provider: string, windowIds: readonly string[], at: number): void {
		for (const [id, until] of this.#manualResets) if (until < at) this.#manualResets.delete(id);
		for (const windowId of windowIds) {
			const period = this.#openPeriod(provider, windowId);
			if (period) this.#manualResets.set(period.id, at + RESET_TOLERANCE_MS);
		}
	}

	#openPeriod(provider: string, windowId: string): OpenPeriod | null {
		return this.#db.query<OpenPeriod, [string, string]>(
			"SELECT id, started_at, resets_at, last_percent, label, window_minutes FROM limit_periods WHERE provider = ? AND window_id = ? AND ended_at IS NULL",
		).get(provider, windowId);
	}

	reading(provider: string, window: LimitReading, at: number): void {
		const resetsAt = window.resetsAt === null ? null : Date.parse(window.resetsAt);
		const reset = resetsAt !== null && Number.isFinite(resetsAt) ? resetsAt : null;
		const percent = window.usedPercent;
		const closedId = this.#db.transaction(() => {
			const period = this.#openPeriod(provider, window.id);
			const [last, beforeLast] = period === null ? [] : this.#db.query<Sample, [number]>(
				"SELECT id, at, used_percent, resets_at FROM limit_samples WHERE period_id = ? ORDER BY at DESC, id DESC LIMIT 2",
			).all(period.id);
			if (period && at < (last?.at ?? period.started_at)) return;
			const previousReset = period?.resets_at ?? null;
			const passedReset = previousReset !== null && at >= previousReset;
			const movedReset = previousReset !== null && reset !== null && Math.abs(reset - previousReset) > RESET_TOLERANCE_MS;
			const dropped = period?.last_percent != null && percent !== null && percent < period.last_percent;
			const windowMinutes = window.windowMinutes ?? period?.window_minutes ?? null;
			const label = window.windowMinutes === null && period?.window_minutes != null ? period.label : window.label;
			let periodId: number;
			if (period === null || passedReset || movedReset || dropped) {
				if (period) {
					this.#measure(period.id);
					const manual = dropped && !passedReset && at <= (this.#manualResets.get(period.id) ?? -Infinity);
					const reason = manual ? "manual_reset" : passedReset || movedReset ? "reset" : "drop";
					this.#db.query("UPDATE limit_periods SET ended_at = ?, end_reason = ? WHERE id = ?")
						.run(passedReset ? previousReset : at, reason, period.id);
				}
				const inserted = this.#db.query(`INSERT INTO limit_periods
					(provider, window_id, label, window_minutes, scope, started_at, resets_at, first_percent, last_percent)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
				).run(provider, window.id, label, windowMinutes, window.scope ?? null, at,
					reset !== null && reset > at ? reset : null, percent, percent);
				periodId = Number(inserted.lastInsertRowid);
			} else {
				periodId = period.id;
				this.#db.query(`UPDATE limit_periods SET label = ?, window_minutes = ?,
					resets_at = coalesce(?, resets_at), first_percent = coalesce(first_percent, ?),
					last_percent = coalesce(?, last_percent) WHERE id = ?`
				).run(label, windowMinutes, reset !== null && reset > at ? reset : null, percent, percent, periodId);
				const matches = (sample: Sample | undefined) => sample !== undefined && sample.used_percent === percent && sample.resets_at === reset;
				if (last && matches(last)) {
					if (last.at === at) return;
					// Keep the first and most recent readings of a flat run, even across a restart.
					if (matches(beforeLast)) {
						this.#db.query("UPDATE limit_samples SET at = ?, source = ? WHERE id = ?").run(at, window.source, last.id);
						this.#measure(periodId);
						return;
					}
				}
			}
			this.#db.query(`INSERT INTO limit_samples (at, provider, window_id, period_id, used_percent, resets_at, source)
				VALUES (?, ?, ?, ?, ?, ?, ?)`).run(at, provider, window.id, periodId, percent, reset, window.source);
			this.#measure(periodId);
			return periodId === period?.id ? undefined : period?.id;
		})();
		if (closedId !== undefined) this.#manualResets.delete(closedId);
	}

	/** A different plan or login cannot finish a window opened under the old terms. */
	closeProvider(provider: string, at: number): void {
		for (const { id, resets_at } of this.#db.query<{ id: number; resets_at: number | null }, [string, number]>(`
			SELECT id, resets_at FROM limit_periods WHERE provider = ? AND ended_at IS NULL AND started_at <= ?
		`).all(provider, at)) {
			this.#measure(id);
			this.#db.query("UPDATE limit_periods SET ended_at = ?, end_reason = ? WHERE id = ?")
				.run(Math.min(at, resets_at ?? at), "terms_change", id);
			this.#manualResets.delete(id);
		}
	}

	/** A response can be inserted after a reading that already included its tokens. */
	requestEnded(provider: string, end: number): void {
		for (const { id } of this.#db.query<{ id: number }, [string, number, number]>(`
			SELECT id FROM limit_periods WHERE provider = ? AND ended_at IS NULL
			AND started_at <= ? AND measured_through >= ?
		`).all(provider, end + ATTRIBUTION_LAG_MS, end)) this.#measure(id);
	}

	/** Before pruning, finish expired windows and do not recalculate an open window from a partial sample run. */
	closeExpired(at: number, cutoff: number): void {
		for (const { id, resets_at, measured_through } of this.#db.query<{
			id: number; resets_at: number | null; measured_through: number | null;
		}, [number, number]>(`SELECT id, resets_at, measured_through FROM limit_periods WHERE ended_at IS NULL
			AND (resets_at <= ? OR started_at < ?)` ).all(at, cutoff + ATTRIBUTION_LAG_MS)) {
			this.#measure(id);
			const expired = resets_at !== null && resets_at <= at;
			this.#db.query("UPDATE limit_periods SET ended_at = ?, end_reason = ? WHERE id = ?")
				.run(expired ? resets_at : measured_through ?? cutoff, expired ? "reset" : "gap", id);
			this.#manualResets.delete(id);
		}
	}

	backfillMeasurements(): void {
		for (const { id } of this.#db.query<{ id: number }, []>("SELECT id FROM limit_periods").all()) this.#measure(id);
	}

	#measure(periodId: number): void {
		const period = this.#db.query<{ provider: string; scope: string | null; started_at: number }, [number]>(`
			SELECT provider, scope, started_at FROM limit_periods WHERE id = ?
		`).get(periodId);
		if (!period) return;
		const samples = this.#db.query<{ at: number; used_percent: number | null }, [number]>(`
			SELECT at, used_percent FROM limit_samples WHERE period_id = ? ORDER BY at, id
		`).all(periodId);
		if (samples[0]?.at !== period.started_at) return; // Older history was already pruned.
		const levels = samples.flatMap(sample => sample.used_percent === null ? [] : [{ at: sample.at, points: Math.min(100, sample.used_percent) }]);
		const first = levels[0];
		const last = levels.at(-1);
		if (!first || !last) return;
		const requests = this.#db.query<{ ended: number; model: string; cost: number }, [string, number, number]>(`
			SELECT ${REQUEST_END} AS ended, model, cost FROM requests
			WHERE provider = ? AND (${REQUEST_END}) >= ? AND (${REQUEST_END}) <= ?
			AND billing IN ('subscription', 'plan_key') ORDER BY (${REQUEST_END})
		`).all(period.provider, first.at - ATTRIBUTION_LAG_MS, last.at)
			.filter(request => period.scope === null || matchesModelScope(period.scope, request.model));
		let requestIndex = 0;
		let lastRequestEnd = -Infinity;
		let kemiri = 0;
		let elsewhere = first.points;
		let apiValue = 0;
		for (const [index, sample] of levels.entries()) {
			const previous = levels[index - 1];
			while (requests[requestIndex] && requests[requestIndex]!.ended <= sample.at) {
				const request = requests[requestIndex++]!;
				lastRequestEnd = request.ended;
				if (previous) apiValue += request.cost;
			}
			if (!previous) continue;
			const delta = sample.points - previous.points;
			if (lastRequestEnd >= previous.at - ATTRIBUTION_LAG_MS) kemiri += delta;
			else elsewhere += delta;
		}
		this.#db.query(`UPDATE limit_periods SET kemiri_points = ?, elsewhere_points = ?,
			observed_api_value = ?, measured_through = ? WHERE id = ?`).run(kemiri, elsewhere, apiValue, last.at, periodId);
	}

	/** Use only the selected plan and login, with measurements no later than the selected month. */
	periods(provider: string, billing: string, plan: string | null, loginSince: number | null, at: number): MeasuredLimitPeriod[] {
		return this.#db.query<MeasuredLimitPeriod, [string, number, number | null, number | null, string, string | null]>(`
			SELECT p.* FROM limit_periods p
			LEFT JOIN subscription_terms t ON t.provider = p.provider AND t.since = (
				SELECT max(since) FROM subscription_terms WHERE provider = p.provider AND since <= p.started_at
			)
			WHERE p.provider = ? AND p.started_at <= ? AND (? IS NULL OR p.started_at >= ?)
			AND (t.since IS NULL OR t.credential_type = ?) AND t.plan IS ?
			ORDER BY p.started_at, p.id
		`).all(provider, at, loginSince, loginSince, billing, plan);
	}

	startedAt(): number | null {
		return this.#db.query<{ at: number | null }, []>("SELECT min(started_at) AS at FROM limit_periods").get()?.at ?? null;
	}

	/** Longest known unscoped window at request start. A gap in that window is not a shorter window. */
	bindingPeriodId(provider: string, at: number): number | null {
		const period = this.#db.query<{ id: number; ended_at: number | null; resets_at: number | null }, [string, number, number]>(`
			SELECT period.id, period.ended_at, period.resets_at FROM limit_periods AS period
			WHERE period.provider = ? AND period.started_at <= ? AND period.scope IS NULL
			AND NOT EXISTS (
				SELECT 1 FROM limit_periods AS newer WHERE newer.provider = period.provider AND newer.window_id = period.window_id
				AND newer.started_at <= ? AND (newer.started_at, newer.id) > (period.started_at, period.id)
			)
			ORDER BY period.window_minutes DESC, period.window_id LIMIT 1
		`).get(provider, at, at);
		const end = period?.ended_at ?? period?.resets_at;
		return period && (end == null || at < end) ? period.id : null;
	}
}

