import type { Overview, OverviewTimeLeft } from "@kemiri/protocol";

export const MIN_OVERVIEW_SAMPLE = 8;
const MIN_CALIBRATION_SAMPLE = 5;
export const MAX_RANGE_WIDTH = 4;
const MINUTE_MS = 60_000;
export type FinishedEstimateSample = Overview["estimateInputs"]["completed"][number];
export type RangeEstimate = Extract<OverviewTimeLeft, { kind: "range" }>;
export type SavedOverviewEstimate = { at: string; baselineMs: number; minutes: number; low: number; high: number };
export type ScoredOverviewEstimate = { requestId: string; coordinatorId: string; doneAt: string; actualMs: number; estimate: SavedOverviewEstimate };

export type OverviewCalibrationMiss = { coordinatorId: string; doneAt: string; ratio: number };
export function overviewCalibrationMiss(score: ScoredOverviewEstimate): OverviewCalibrationMiss {
 return { coordinatorId: score.coordinatorId, doneAt: score.doneAt, ratio: score.actualMs / score.estimate.baselineMs };
}

export function overviewQuantile(values: readonly number[], fraction: number): number {
 const ordered = [...values].sort((a, b) => a - b);
 const index = (ordered.length - 1) * fraction;
 const low = Math.floor(index);
 return ordered[low]! + (ordered[Math.ceil(index)]! - ordered[low]!) * (index - low);
}

// Round once, before saving the range. The scored bounds are the same ones returned to the client.
function roundMinutes(ms: number, direction: "nearest" | "down" | "up"): number {
 const minutes = ms / MINUTE_MS;
 const step = minutes < 60 ? 5 : 15;
 const rounded = (direction === "down" ? Math.floor : direction === "up" ? Math.ceil : Math.round)(minutes / step) * step;
 return direction === "nearest" ? Math.max(5, rounded) : rounded;
}

export function isInEstimateRange(estimate: SavedOverviewEstimate, actualMs: number): boolean {
 return actualMs >= estimate.low * MINUTE_MS && actualMs <= estimate.high * MINUTE_MS;
}

export function summarizeOverviewEstimates(scores: readonly ScoredOverviewEstimate[]) {
 return scores.length ? { held: scores.filter(score => isInEstimateRange(score.estimate, score.actualMs)).length, scored: scores.length } : undefined;
}

/** Round empirical percentile bounds outward for thin samples rather than interpolating away a tail observation. */
function calibratedRange(ratios: number[], maximumWidth: number) {
 const values = [...ratios].sort((a, b) => a - b);
 const center = overviewQuantile(values, .5);
 const p10 = values[Math.floor((values.length - 1) * .1)]!;
 const p90 = values[Math.ceil((values.length - 1) * .9)]!;
 if (!Number.isFinite(maximumWidth) || (p10 > 0 && p90 <= maximumWidth * p10)) return { center, low: p10, high: p90 };
 // When both tails do not fit, retain the median and fit the fourfold interval that holds the most past outcomes.
 const anchor = center || p90 || 1;
 const lowest = Math.max(p10, anchor / maximumWidth);
 const highest = Math.min(anchor, Math.max(lowest, p90 / maximumWidth));
 const lowerBounds = [lowest, highest, ...values.flatMap(value => [value, value / maximumWidth])]
  .filter(value => value >= lowest && value <= highest).sort((a, b) => a - b);
 let low = lowest;
 let held = -1;
 let imbalance = Infinity;
 let first = 0;
 let pastLast = 0;
 for (const candidate of lowerBounds) {
  while (first < values.length && values[first]! < candidate) first++;
  while (pastLast < values.length && values[pastLast]! <= candidate * maximumWidth) pastLast++;
  const inside = pastLast - first;
  const distance = Math.abs(Math.log(candidate * Math.sqrt(maximumWidth) / anchor));
  if (inside > held || (inside === held && distance < imbalance)) {
   held = inside;
   imbalance = distance;
   low = candidate;
  }
 }
 return { center, low, high: low * maximumWidth };
}

/** A project's pace at one instant. Replay and live Overview use the same estimator. */
export class OverviewEstimator {
 readonly #finished: readonly FinishedEstimateSample[];
 readonly #misses: readonly OverviewCalibrationMiss[];
 readonly #paceByCoordinator = new Map<string, { basis: RangeEstimate["basis"]; median: number; center: number; low: number; high: number; supportingTimes: number[] } | undefined>();
 constructor(finished: readonly FinishedEstimateSample[], misses: readonly OverviewCalibrationMiss[], asOf: number, private readonly maximumWidth = MAX_RANGE_WIDTH) {
  this.#finished = finished.filter(sample => sample.agentMs > 0 && Date.parse(sample.doneAt) <= asOf);
  this.#misses = misses.filter(miss => Date.parse(miss.doneAt) <= asOf && Number.isFinite(miss.ratio) && miss.ratio >= 0);
 }

 #sample<T extends { coordinatorId: string }>(eligible: readonly T[], coordinatorId: string, minimum = MIN_OVERVIEW_SAMPLE) {
  const coordinator = eligible.filter(row => row.coordinatorId === coordinatorId);
  if (coordinator.length >= minimum) return { rows: coordinator, basis: "coordinator" as const };
  if (eligible.length >= minimum) return { rows: eligible, basis: "project" as const };
 }

 /** The uncorrected pace, also used to reconstruct historical prediction errors. */
 partsBaseline(coordinatorId: string, partsLeft: number): number | undefined {
  const sample = this.#sample(this.#finished.filter(row => row.parts >= 2), coordinatorId);
  return sample ? overviewQuantile(sample.rows.map(row => row.agentMs / row.parts), .5) * partsLeft : undefined;
 }

 partsLeft(coordinatorId: string, partsLeft: number):
  | { range: RangeEstimate; baselineMs: number }
  | { reason: "not_enough_history" } {
  let pace = this.#paceByCoordinator.get(coordinatorId);
  if (!this.#paceByCoordinator.has(coordinatorId)) {
   const history = this.#sample(this.#finished.filter(row => row.parts >= 2), coordinatorId);
   if (history) {
    const timePerPart = history.rows.map(row => row.agentMs / row.parts);
    const median = overviewQuantile(timePerPart, .5);
    const calibration = this.#sample(this.#misses, coordinatorId, MIN_CALIBRATION_SAMPLE);
    const misses = calibration?.rows.map(miss => miss.ratio);
    // Keep two interior pace anchors for the bounds. They temper the tails when only a few misses are known,
    // and have steadily less influence as real outcomes arrive. The point estimate still uses the observed median miss.
    const ratios = misses ? [...misses, overviewQuantile(timePerPart, .25) / median, overviewQuantile(timePerPart, .75) / median]
     : timePerPart.map(ms => ms / median);
    const band = calibratedRange(ratios, this.maximumWidth);
    pace = { basis: history.basis === "project" || calibration?.basis === "project" ? "project" : "coordinator", median,
     center: (misses ? overviewQuantile(misses, .5) : band.center) * median, low: band.low * median, high: band.high * median,
     supportingTimes: ratios.map(ratio => ratio * median) };
    this.#paceByCoordinator.set(coordinatorId, pace);
   } else this.#paceByCoordinator.set(coordinatorId, undefined);
  }
  if (!pace) return { reason: "not_enough_history" };
  const baselineMs = pace.median * partsLeft;
  let low = Math.max(5, roundMinutes(pace.low * partsLeft, "down"));
  const requestedHigh = roundMinutes(pace.high * partsLeft, "up");
  // An outward rounding step must not make the displayed or saved range wider than fourfold.
  let high = Math.max(low, roundMinutes(Math.min(requestedHigh, low * this.maximumWidth) * MINUTE_MS, "down"));
  if (high < requestedHigh) {
   const upperAnchoredLow = roundMinutes(requestedHigh * MINUTE_MS / this.maximumWidth, "up");
   const held = (lower: number, upper: number) => pace.supportingTimes.filter(ms => ms * partsLeft >= lower * MINUTE_MS && ms * partsLeft <= upper * MINUTE_MS).length;
   // Outward rounding can exceed the cap. Preserve the end that covers more known outcomes instead of always cutting the top.
   if (upperAnchoredLow <= requestedHigh && held(upperAnchoredLow, requestedHigh) > held(low, high)) {
    low = upperAnchoredLow;
    high = requestedHigh;
   }
  }
  return { baselineMs, range: { kind: "range", minutes: Math.min(high, Math.max(low, roundMinutes(pace.center * partsLeft, "nearest"))), low, high, basis: pace.basis } };
 }

 usualDuration(coordinatorId: string, runningSince: string, elapsedMs: number): Extract<OverviewTimeLeft, { kind: "usual" }> | undefined {
  const history = this.#sample(this.#finished.filter(row => row.parts === 0), coordinatorId);
  if (!history) return;
  const times = history.rows.map(row => row.agentMs);
  const longerInMs = Math.max(0, overviewQuantile(times, .9) - elapsedMs);
  return { kind: "usual", low: roundMinutes(overviewQuantile(times, .25), "down"), high: roundMinutes(overviewQuantile(times, .75), "up"),
   basis: history.basis, runningSince, longerInMs, longer: longerInMs === 0 };
 }
}
