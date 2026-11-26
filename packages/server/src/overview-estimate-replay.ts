import { agentTime, time, type RequestWorkClock } from "./overview-clock.ts";
import { isInEstimateRange, overviewQuantile, OverviewEstimator, type FinishedEstimateSample, type SavedOverviewEstimate, type ScoredOverviewEstimate } from "./overview-estimates.ts";

const REPLAY_STEP_MS = 20 * 60_000;
export type OverviewReplayRequest = {
 sample: FinishedEstimateSample;
 clock: RequestWorkClock;
 partsLeft(at: number): number;
 canEstimateAt?(at: number): boolean;
};

type ReplayPoint = { estimate: SavedOverviewEstimate; actualMs: number };
function replaySummary(points: readonly ReplayPoint[]) {
 const errors = points.map(point => Math.abs(point.actualMs - point.estimate.minutes * 60_000));
 return {
  scored: points.length,
  held: points.filter(point => isInEstimateRange(point.estimate, point.actualMs)).length,
  withinFactorTwo: points.filter(({ actualMs, estimate }) => actualMs >= estimate.minutes * 30_000 && actualMs <= estimate.minutes * 120_000).length,
  medianAbsoluteMissMinutes: errors.length ? overviewQuantile(errors, .5) / 60_000 : null,
 };
}

/** Only completions strictly before each 20-minute sample can inform it, including calibration. */
export function replayOverviewEstimates(requests: readonly OverviewReplayRequest[]) {
 const training = requests.map(row => row.sample);
 const candidates = requests.filter(row => row.sample.parts >= 2);
 const checkpoints = candidates.flatMap(row => {
  const points = [];
  const ready = time(row.sample.readyAt);
  for (let at = time(row.sample.firstWorkAt); at < ready; at += REPLAY_STEP_MS) points.push({ at, row });
  return points;
 }).sort((a, b) => a.at - b.at);
 const first = new Map<string, ScoredOverviewEstimate>();
 const points: ReplayPoint[] = [];
 let stopped = 0;
 let withoutRange = 0;
 for (const { at, row } of checkpoints) {
  const parts = row.partsLeft(at);
  if (!parts || row.canEstimateAt?.(at) === false) continue;
  if (agentTime(row.clock, at, at + 1) === 0) { stopped++; continue; }
  const estimator = new OverviewEstimator(training, [...first.values()], at - 1);
  const forecast = estimator.partsLeft(row.sample.coordinatorId, parts);
  if ("reason" in forecast) { withoutRange++; continue; }
  const { low, high, minutes } = forecast.range;
  const estimate = { at: new Date(at).toISOString(), low, high, minutes, baselineMs: forecast.baselineMs };
  const actualMs = agentTime(row.clock, at, time(row.sample.readyAt));
  points.push({ estimate, actualMs });
  if (!first.has(row.sample.requestId)) first.set(row.sample.requestId, { coordinatorId: row.sample.coordinatorId, doneAt: row.sample.doneAt, estimate, actualMs });
 }
 return { multiPartCompletions: candidates.length, firstEstimates: replaySummary([...first.values()]), allEstimates: replaySummary(points), stopped, withoutRange };
}
