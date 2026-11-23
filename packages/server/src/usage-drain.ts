import type { UsageDrainMode } from "@kemiri/protocol";
import type { WindowReading } from "./subscription-usage.ts";

const MINUTE_MS = 60_000;
const MAX_LOOKBACK_MS = 30 * MINUTE_MS;
// Allow a five-minute poll plus scheduling and transport time, not a skipped poll.
const MAX_READING_GAP_MS = 6 * MINUTE_MS;

export type UsageDrainReading = WindowReading & { at: number };
type MeasuredReading = UsageDrainReading & { usedPercent: number; reset: number; windowMinutes: number };
export type UsageDrainForecast = {
	level: "none" | "warning" | "pause";
	limit: WindowReading;
	usedPercent: number | null;
	rise: number | null;
	minutesMeasured: number | null;
	minutesLeft: number | null;
	minutesToReset: number | null;
};
type HasLocalRequests = (from: number, through: number, scope?: string) => boolean;

/** Append in observation order. Preserve the period high across small dips and trimming. */
function appendReading(series: MeasuredReading[], reading: UsageDrainReading): void {
	const previous = series.at(-1);
	if (previous && reading.at < previous.at) return;
	const { usedPercent, windowMinutes, at } = reading;
	const reset = reading.resetsAt === null ? NaN : Date.parse(reading.resetsAt);
	if (!Number.isFinite(at) || usedPercent === null || !Number.isFinite(usedPercent) || usedPercent < 0 ||
		windowMinutes === null || !Number.isFinite(windowMinutes) || windowMinutes <= 0 || !Number.isFinite(reset) || reset <= at) {
		series.length = 0;
		return;
	}
	if (previous && (previous.id !== reading.id || previous.scope !== reading.scope || previous.reset !== reset ||
		at - previous.at > MAX_READING_GAP_MS || usedPercent < previous.usedPercent - 2)) series.length = 0;
	const high = Math.max(usedPercent, series.at(-1)?.usedPercent ?? 0);
	const firstWithinLookback = series.findIndex(sample => sample.at >= at - MAX_LOOKBACK_MS);
	if (firstWithinLookback > 0) series.splice(0, firstWithinLookback);
	if (series.at(-1)?.at === at) series.pop();
	series.push({ ...reading, usedPercent: high, reset, windowMinutes });
}

/** Evaluate one limit's chronological readings. A pace without local work is still a forecast, not an alert. */
export function forecastUsageDrain(
	readings: readonly UsageDrainReading[], now: number, hasLocalRequests: HasLocalRequests,
): UsageDrainForecast | undefined {
	const series: MeasuredReading[] = [];
	const latest = readings.at(-1);
	if (!latest) return undefined;
	for (const reading of readings) appendReading(series, reading);
	return forecastPeriod(latest, series, now, hasLocalRequests);
}

function forecastPeriod(
	limit: WindowReading, series: readonly MeasuredReading[], now: number, hasLocalRequests: HasLocalRequests,
): UsageDrainForecast {
	const latest = series.at(-1);
	const fresh = latest && latest.at <= now && now - latest.at <= MAX_READING_GAP_MS && latest.reset > now;
	const minutesToReset = fresh ? (latest.reset - now) / MINUTE_MS : null;
	const noPace: UsageDrainForecast = {
		level: "none", limit, usedPercent: fresh ? latest.usedPercent : limit.usedPercent,
		rise: null, minutesMeasured: null, minutesLeft: null, minutesToReset,
	};
	if (!fresh || minutesToReset === null) return noPace;
	const shortWindow = latest.windowMinutes <= 24 * 60;
	let forecast = noPace;
	for (const lookback of [5, 10, 30]) {
		const anchor = series.find(reading => reading.at >= latest.at - lookback * MINUTE_MS);
		if (!anchor) continue;
		const minutesMeasured = (latest.at - anchor.at) / MINUTE_MS;
		const rise = latest.usedPercent - anchor.usedPercent;
		if (minutesMeasured < 2 || rise <= 0) continue;
		const minutesLeft = Math.max(0, 100 - latest.usedPercent) * minutesMeasured / rise;
		forecast = { ...noPace, rise, minutesMeasured, minutesLeft };
		const warning = lookback === 30;
		const pointsNeeded = warning ? (shortWindow ? 10 : 5) : (shortWindow ? 20 : 8);
		const minutesAllowed = warning ? (shortWindow ? 120 : 720) : (shortWindow ? 30 : 180);
		if (rise >= pointsNeeded && minutesLeft <= minutesAllowed && minutesLeft < minutesToReset &&
			hasLocalRequests(anchor.at, latest.at, latest.scope)) return { ...forecast, level: warning ? "warning" : "pause" };
	}
	return forecast;
}

type UsageDrainAlert = UsageDrainForecast & { level: "warning" | "pause" };

/** Live evidence is not carried over a restart, a credential change, or an explicit Resume. */
export class UsageDrainMonitor {
	readonly #providers = new Map<string, Map<string, { readings: MeasuredReading[]; lastAt: number }>>();
	readonly #measureFrom = new Map<string, number>();
	readonly #warnedUntil = new Map<string, number>();
	#mode: UsageDrainMode | undefined;
	#modeChangedAt = -Infinity;

	constructor(private readonly options: {
		mode: () => UsageDrainMode;
		hasLocalRequests: (providerLogin: string, from: number, through: number, scope?: string) => boolean;
		isPaused: (providerLogin: string) => boolean;
		alert: (providerLogin: string, forecast: UsageDrainAlert) => void;
		now?: () => number;
	}) {}

	startMeasuringAgain(providerLogin: string): void {
		this.#providers.delete(providerLogin);
		this.#measureFrom.set(providerLogin, this.options.now?.() ?? Date.now());
	}

	settingsChanged(): void {
		const mode = this.options.mode();
		if (this.#mode !== undefined && mode !== this.#mode) {
			this.#providers.clear();
			this.#modeChangedAt = this.options.now?.() ?? Date.now();
		}
		this.#mode = mode;
	}

	observe(providerLogin: string, windows: readonly WindowReading[], at: number): void {
		this.settingsChanged();
		const now = this.options.now?.() ?? Date.now();
		if (this.#mode === "off" || at < this.#modeChangedAt || at < (this.#measureFrom.get(providerLogin) ?? -Infinity) ||
			at > now || now - at > MAX_READING_GAP_MS || this.options.isPaused(providerLogin)) return;
		const seriesByLimit = this.#providers.get(providerLogin) ?? new Map();
		this.#providers.set(providerLogin, seriesByLimit);
		const forecasts: UsageDrainAlert[] = [];
		for (const limit of windows) {
			const series = seriesByLimit.get(limit.id) ?? { readings: [], lastAt: -Infinity };
			if (at < series.lastAt) continue;
			series.lastAt = at;
			seriesByLimit.set(limit.id, series);
			appendReading(series.readings, { ...limit, at });
			const forecast = forecastPeriod(limit, series.readings, now, (from, through, scope) =>
				this.options.hasLocalRequests(providerLogin, from, through, scope));
			if (forecast.level !== "none") forecasts.push({ ...forecast, level: forecast.level });
		}
		const pause = this.#mode !== "tell-only" && forecasts.find(forecast => forecast.level === "pause");
		if (pause) {
			this.options.alert(providerLogin, pause);
			return;
		}
		for (const [key, reset] of this.#warnedUntil) if (reset <= now) this.#warnedUntil.delete(key);
		for (const forecast of forecasts) {
			const key = JSON.stringify([providerLogin, forecast.limit.id, forecast.limit.resetsAt]);
			if (this.#warnedUntil.has(key)) continue;
			this.options.alert(providerLogin, { ...forecast, level: "warning" });
			this.#warnedUntil.set(key, Date.parse(forecast.limit.resetsAt!));
		}
	}
}
