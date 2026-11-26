import type { Overview, OverviewTimeLeft } from "@kemiri/protocol";

export const MIN_OVERVIEW_SAMPLE = 8;
const MINUTE_MS = 60_000;
export type FinishedEstimateSample = Overview["estimateInputs"]["completed"][number];
export type RangeEstimate = Extract<OverviewTimeLeft, { kind: "range" }>;
export type SavedOverviewEstimate = { at: string; baselineMs: number; minutes: number; low: number; high: number };
export type ScoredOverviewEstimate = { coordinatorId: string; doneAt: string; actualMs: number; estimate: SavedOverviewEstimate };

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

/** A project's pace at one instant. Replay and live Overview use the same estimator. */
export class OverviewEstimator {
 readonly #finished: readonly FinishedEstimateSample[];
 readonly #scores: readonly ScoredOverviewEstimate[];
 readonly #paceByCoordinator = new Map<string, { basis: RangeEstimate["basis"]; median: number; center: number; low: number; high: number } | undefined>();
 constructor(finished: readonly FinishedEstimateSample[], scores: readonly ScoredOverviewEstimate[], asOf: number) {
  this.#finished = finished.filter(sample => sample.agentMs > 0 && Date.parse(sample.doneAt) <= asOf);
  this.#scores = scores.filter(score => Date.parse(score.doneAt) <= asOf && score.estimate.baselineMs > 0);
 }

 #sample<T extends { coordinatorId: string }>(eligible: readonly T[], coordinatorId: string) {
  const coordinator = eligible.filter(row => row.coordinatorId === coordinatorId);
  if (coordinator.length >= MIN_OVERVIEW_SAMPLE) return { rows: coordinator, basis: "coordinator" as const };
  if (eligible.length >= MIN_OVERVIEW_SAMPLE) return { rows: eligible, basis: "project" as const };
 }

 partsLeft(coordinatorId: string, partsLeft: number):
  | { range: RangeEstimate; baselineMs: number }
  | { reason: "not_enough_history" | "wide_range" } {
  let pace = this.#paceByCoordinator.get(coordinatorId);
  if (!this.#paceByCoordinator.has(coordinatorId)) {
   const history = this.#sample(this.#finished.filter(row => row.parts >= 2), coordinatorId);
   if (history) {
    const timePerPart = history.rows.map(row => row.agentMs / row.parts);
    const median = overviewQuantile(timePerPart, .5);
    const earlierMisses = this.#sample(this.#scores, coordinatorId)?.rows.map(score => score.actualMs / score.estimate.baselineMs);
    // Before enough first estimates come back, use the spread in measured time per part.
    pace = { basis: history.basis, median, center: earlierMisses ? overviewQuantile(earlierMisses, .5) * median : median, low: earlierMisses ? overviewQuantile(earlierMisses, .1) * median : overviewQuantile(timePerPart, .1),
     high: earlierMisses ? overviewQuantile(earlierMisses, .9) * median : overviewQuantile(timePerPart, .9) };
    // Keep the uncorrected median as the denominator for the next finished request's error ratio.
    this.#paceByCoordinator.set(coordinatorId, pace);
   } else this.#paceByCoordinator.set(coordinatorId, undefined);
  }
  if (!pace) return { reason: "not_enough_history" };
  if (pace.low <= 0 || pace.high > pace.low * 10) return { reason: "wide_range" };
  const baselineMs = pace.median * partsLeft;
  const low = roundMinutes(pace.low * partsLeft, "down");
  const high = roundMinutes(pace.high * partsLeft, "up");
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
