import type { BoardTask } from "@kemiri/protocol";
import { agentTime, time, type RequestWorkClock } from "./overview-clock.ts";
import { isInEstimateRange, MAX_RANGE_WIDTH, MIN_OVERVIEW_SAMPLE, overviewQuantile, OverviewEstimator, type FinishedEstimateSample, type OverviewCalibrationMiss, type SavedOverviewEstimate } from "./overview-estimates.ts";
import type { OverviewTaskRecord } from "./overview-records.ts";

const REPLAY_STEP_MS = 20 * 60_000;
export type OverviewReplayRequest = {
 sample: FinishedEstimateSample;
 clock: RequestWorkClock;
 partsLeft(at: number): number;
 canEstimateAt?(at: number): boolean;
 /** Eligibility only changes at these events; the live reader need not walk every 20-minute interval. */
 changes?: readonly number[];
};

type ReplayPoint = { coordinatorId: string; estimate: SavedOverviewEstimate; actualMs: number };
type CalibrationPoint = OverviewCalibrationMiss & { requestId: string };

export function overviewReplayRequest(sample: FinishedEstimateSample, task: BoardTask, members: readonly BoardTask[], rows: Readonly<Record<string, OverviewTaskRecord>>, clock: RequestWorkClock): OverviewReplayRequest {
 const statuses = rows[task.id]?.statuses ?? [];
 const directParts = members.filter(part => part.parent === task.id).map(part => ({
  created: time(part.createdAt), moves: rows[part.id]?.statuses ?? [],
  fallbackClosedAt: part.status === "done" || part.status === "dropped" ? time(part.settledAt) : NaN,
 }));
 return { sample, clock,
  changes: [...statuses.map(move => time(move.at)), ...directParts.flatMap(part => [part.created, part.fallbackClosedAt, ...part.moves.map(move => time(move.at))]), ...clock.waits.flat(), ...clock.work.flat()],
  canEstimateAt(at) {
   const status = statuses.findLast(move => time(move.at) <= at)?.status;
   return status !== "todo" && status !== "waiting" && status !== "review" && status !== "dropped";
  },
  partsLeft(at) {
   return directParts.filter(part => {
    if (part.created > at) return false;
    const status = part.moves.findLast(move => time(move.at) <= at)?.status;
    return status ? status !== "done" && status !== "dropped" : !(part.fallbackClosedAt <= at);
   }).length;
  },
 };
}

function eligibleParts(row: OverviewReplayRequest, at: number) {
 return row.canEstimateAt?.(at) === false || agentTime(row.clock, at, at + 1) === 0 ? 0 : row.partsLeft(at);
}

/** One miss per request, at its first eligible 20-minute sample. Every baseline sees only earlier completions. */
export function collectOverviewCalibration(requests: readonly OverviewReplayRequest[], maximumWidth = MAX_RANGE_WIDTH) {
 const training = requests.map(row => row.sample);
 const firstProjectSample = training.filter(row => row.parts >= 2 && row.agentMs > 0).map(row => time(row.doneAt)).sort((a, b) => a - b)[MIN_OVERVIEW_SAMPLE - 1];
 const misses: CalibrationPoint[] = [];
 const first: { row: OverviewReplayRequest; at: number; parts: number; actualMs: number }[] = [];
 if (firstProjectSample !== undefined) for (const row of requests) {
  const { sample } = row;
  if (sample.parts < 2) continue;
  const start = time(sample.firstWorkAt);
  const ready = time(sample.readyAt);
  const roundUp = (at: number) => start + Math.ceil(Math.max(0, at - start) / REPLAY_STEP_MS) * REPLAY_STEP_MS;
  const earliest = roundUp(firstProjectSample + 1);
  if (earliest >= ready) continue;
  const checkpoints = row.changes ? [...new Set([earliest, ...row.changes.filter(at => at >= earliest && at < ready).map(roundUp)])].sort((a, b) => a - b)
   : Array.from({ length: Math.ceil((ready - earliest) / REPLAY_STEP_MS) }, (_, index) => earliest + index * REPLAY_STEP_MS);
  for (const at of checkpoints) {
   if (at >= ready) break;
   const parts = eligibleParts(row, at);
   if (!parts) continue;
   const baseline = new OverviewEstimator(training, [], at - 1).partsBaseline(sample.coordinatorId, parts);
   if (!baseline) continue;
   const actualMs = agentTime(row.clock, at, ready);
   first.push({ row, at, parts, actualMs });
   misses.push({ requestId: sample.requestId, coordinatorId: sample.coordinatorId, doneAt: sample.doneAt, ratio: actualMs / baseline });
   break;
  }
 }
 const makePoint = (row: OverviewReplayRequest, at: number, parts: number, actualMs: number): ReplayPoint | undefined => {
  const forecast = new OverviewEstimator(training, misses, at - 1, maximumWidth).partsLeft(row.sample.coordinatorId, parts);
  if ("reason" in forecast) return;
  const { low, high, minutes } = forecast.range;
  return { coordinatorId: row.sample.coordinatorId, estimate: { at: new Date(at).toISOString(), low, high, minutes, baselineMs: forecast.baselineMs }, actualMs };
 };
 return { misses, first: first.flatMap(({ row, at, parts, actualMs }) => makePoint(row, at, parts, actualMs) ?? []), makePoint };
}

export function summarizeOverviewReplay(points: readonly ReplayPoint[]) {
 const errors = points.map(point => Math.abs(point.actualMs - point.estimate.minutes * 60_000));
 const widths = points.map(({ estimate }) => estimate.high / estimate.low);
 return {
  scored: points.length,
  held: points.filter(point => isInEstimateRange(point.estimate, point.actualMs)).length,
  withinFactorTwo: points.filter(({ actualMs, estimate }) => actualMs >= estimate.minutes * 30_000 && actualMs <= estimate.minutes * 120_000).length,
  medianAbsoluteMissMinutes: errors.length ? overviewQuantile(errors, .5) / 60_000 : null,
  medianWidth: widths.length ? overviewQuantile(widths, .5) : null,
  maxWidth: widths.length ? widths.reduce((max, width) => Math.max(max, width), 1) : null,
 };
}

/** In hindsight, how wide must a single multiplier band be to hold four in five first misses? */
function pooledWidthCheck(misses: readonly CalibrationPoint[]) {
 const ratios = misses.map(miss => miss.ratio).sort((a, b) => a - b);
 const target = Math.ceil(.8 * ratios.length);
 let minWidth = Infinity;
 let maxHeld = 0;
 for (let start = 0, end = 0; start < ratios.length; start++) {
  const lower = ratios[start]!;
  if (lower <= 0) continue;
  if (start + target <= ratios.length) minWidth = Math.min(minWidth, ratios[start + target - 1]! / lower);
  while (end < ratios.length && ratios[end]! <= lower * MAX_RANGE_WIDTH) end++;
  maxHeld = Math.max(maxHeld, end - start);
 }
 return { scored: ratios.length, target, widthForTarget: Number.isFinite(minWidth) ? minWidth : null, maxHeldAtCap: maxHeld };
}

/** Stays read-only; repeated checkpoints use the same earlier first misses as live Overview. */
export function replayOverviewEstimates(requests: readonly OverviewReplayRequest[], maximumWidth = MAX_RANGE_WIDTH) {
 const { first, makePoint, misses } = collectOverviewCalibration(requests, maximumWidth);
 const candidates = requests.filter(row => row.sample.parts >= 2);
 const points: ReplayPoint[] = [];
 let stopped = 0;
 let withoutRange = 0;
 for (const row of candidates) {
  const ready = time(row.sample.readyAt);
  for (let at = time(row.sample.firstWorkAt); at < ready; at += REPLAY_STEP_MS) {
   const parts = row.partsLeft(at);
   if (!parts || row.canEstimateAt?.(at) === false) continue;
   if (agentTime(row.clock, at, at + 1) === 0) { stopped++; continue; }
   const point = makePoint(row, at, parts, agentTime(row.clock, at, ready));
   if (point) points.push(point); else withoutRange++;
  }
 }
 return { rangeWidthCap: Number.isFinite(maximumWidth) ? maximumWidth : null, multiPartCompletions: candidates.length, firstEstimates: summarizeOverviewReplay(first), allEstimates: summarizeOverviewReplay(points), pooledWidthCheck: pooledWidthCheck(misses), stopped, withoutRange };
}
