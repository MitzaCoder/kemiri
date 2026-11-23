import { expect, it } from "bun:test";
import type { UsageDrainMode } from "@kemiri/protocol";
import { forecastUsageDrain, UsageDrainMonitor, type UsageDrainForecast, type UsageDrainReading } from "../src/usage-drain.ts";

const MINUTE = 60_000;
const START = Date.parse("2027-01-01T12:00:00Z");
const at = (minute: number) => START + minute * MINUTE;
const reset = (minute: number) => new Date(at(minute)).toISOString();
const reading = (minute: number, usedPercent: number | null, options: Partial<UsageDrainReading> = {}): UsageDrainReading => ({
	at: at(minute), id: "five_hour", label: "5-hour", usedPercent, resetsAt: reset(240), windowMinutes: 300, ...options,
});
const local = () => true;
const forecast = (readings: UsageDrainReading[], requests = local, now = readings.at(-1)!.at) =>
	forecastUsageDrain(readings, now, requests)!;

it("pauses the fast replay within two minutes of the 20-point rise", () => {
	const replay = [2, 4, 6, 9, 12, 17, 22, 27, 33, 39, 45, 51, 57, 62, 68, 74, 79, 84, 89, 93, 97, 100].map((used, minute) => reading(minute, used));
	const firstPause = replay.findIndex((_, index) => forecast(replay.slice(0, index + 1)).level === "pause");
	expect(firstPause).toBe(6);
	expect(forecast(replay.slice(0, firstPause + 1))).toMatchObject({ usedPercent: 22, rise: 20, minutesMeasured: 6, minutesLeft: 23.4, minutesToReset: 234 });
});

it("warns on the slower replay and stays silent for quiet days", () => {
	const slow = Array.from({ length: 121 }, (_, minute) => reading(minute, Math.round(minute * .8)));
	const levels = slow.map((_, index) => forecast(slow.slice(0, index + 1)).level);
	expect(levels).toContain("warning");
	expect(levels).not.toContain("pause");
	for (let day = 0; day < 4; day++) {
		const quiet = Array.from({ length: 181 }, (_, minute) => reading(day * 1440 + minute, Math.round(minute / 10), { resetsAt: reset(day * 1440 + 240) }));
		expect(quiet.every((_, index) => forecast(quiet.slice(0, index + 1)).level === "none")).toBe(true);
	}
});

it("shows the pace without alerting on requests elsewhere or outside the measured interval", () => {
	const surge = [reading(0, 2), reading(6, 22, { scope: "fable" })];
	surge[0]!.scope = "fable";
	const seen: [number, number, string?][] = [];
	const noLocal = forecastUsageDrain(surge, at(6), (from, through, scope) => {
		seen.push([from, through, scope]);
		return false;
	});
	expect(noLocal).toMatchObject({ level: "none", minutesLeft: 23.4 });
	expect(seen).toContainEqual([at(0), at(6), "fable"]);
});

it("keeps the high through flicker and starts over after a large dip or changed reset", () => {
	expect(forecast([reading(0, 70), reading(2, 68), reading(4, 79)]).level).toBe("none");
	expect(forecast([reading(0, 70), reading(2, 67), reading(4, 76)]).level).toBe("none");
	expect(forecast([reading(0, 70), reading(2, 98, { resetsAt: reset(241) })]).level).toBe("none");
	expect(forecast([reading(0, 70), reading(2, 100, { resetsAt: reset(2) })]).level).toBe("none");
});

it("requires two minutes, fresh complete readings, and exhaustion before reset", () => {
	for (const readings of [
		[reading(0, 10), reading(1, 90)],
		[reading(0, 10), reading(7, 90)],
		[reading(0, 10), reading(2, null), reading(4, 90)],
		[reading(0, 10), reading(5, 90, { resetsAt: null })],
		[reading(0, 10), reading(5, 90, { windowMinutes: null })],
		[reading(0, 50, { resetsAt: reset(6) }), reading(5, 70, { resetsAt: reset(6) })],
	]) expect(forecast(readings).level).toBe("none");
	expect(forecast([reading(0, 10), reading(5, 90)], local, at(12)).minutesLeft).toBeNull();
});

it("uses the weekly rise floors and time horizons", () => {
	const weekly = (minute: number, used: number) => reading(minute, used, { windowMinutes: 7 * 24 * 60, resetsAt: reset(1000) });
	// +8 in six minutes; about 66 minutes left. Neither short-window pause test would pass.
	expect(forecast([weekly(0, 4), weekly(6, 12)])).toMatchObject({ level: "pause", minutesLeft: 66 });
	// +5 in thirty minutes; about 9 hours left.
	expect(forecast(Array.from({ length: 7 }, (_, step) => weekly(step * 5, 5 + Math.floor(step * 5 / 6))))).toMatchObject({ level: "warning", minutesLeft: 540 });
});

it.each(["pause-and-tell", "tell-only", "off"] as const)("applies %s, dedupes warnings and remeasures on resume", (initialMode: UsageDrainMode) => {
	let now = at(0);
	let mode = initialMode;
	let paused = false;
	const alerts: UsageDrainForecast[] = [];
	const monitor = new UsageDrainMonitor({
		mode: () => mode, hasLocalRequests: local, isPaused: () => paused, now: () => now,
		alert: (_, alert) => { alerts.push(alert); paused = alert.level === "pause"; },
	});
	const observe = (minute: number, used: number, resetAt?: string) => {
		now = at(minute);
		monitor.observe("anthropic", [reading(minute, used, resetAt ? { resetsAt: resetAt } : {})], now);
	};
	observe(0, 2);
	observe(6, 22);
	observe(7, 25);
	if (mode === "off") {
		expect(alerts).toEqual([]);
		mode = "pause-and-tell";
		monitor.settingsChanged();
		observe(8, 30);
		expect(alerts).toEqual([]);
		return;
	}
	const level = mode === "tell-only" ? "warning" : "pause";
	expect(alerts.map(alert => alert.level)).toEqual([level]);
	if (paused) {
		paused = false;
		monitor.startMeasuringAgain("anthropic");
		monitor.observe("anthropic", [reading(6, 22)], at(6));
		observe(8, 27);
		expect(alerts.map(alert => alert.level)).toEqual([level]);
		observe(11, 50);
	} else {
		observe(8, 1, reset(241));
		observe(12, 24, reset(241));
	}
	expect(alerts.map(alert => alert.level)).toEqual([level, level]);
});
