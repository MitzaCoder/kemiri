import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Value } from "typebox/value";
import { OverviewEventSchema } from "@kemiri/protocol";
import { BoardDoc, boardView } from "../src/board.ts";
import { buildCoordinatorOverview } from "../src/coordinator-overview.ts";
import { agentTime } from "../src/overview-clock.ts";
import { replayOverviewEstimates, type OverviewReplayRequest } from "../src/overview-estimate-replay.ts";
import { overviewCalibrationMiss, OverviewEstimator, type FinishedEstimateSample, type ScoredOverviewEstimate } from "../src/overview-estimates.ts";
import { OverviewRecordsDoc, rememberOverviewEstimates } from "../src/overview-records.ts";
import { bakeryCoordinatorOf, bakeryOverviewFixture, withBakeryLiveWork } from "./fixtures/coordinator-overview.ts";
import { createSetup } from "./support.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const start = Date.parse("2026-04-01T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
function sample(index: number, coordinatorId: string, agentMinutes: number, parts = 2): FinishedEstimateSample {
 const firstWork = start + index * 24 * HOUR;
 return { requestId: `T${index}`, coordinatorId, parts, firstWorkAt: iso(firstWork), readyAt: iso(firstWork + agentMinutes * MINUTE), doneAt: iso(firstWork + agentMinutes * MINUTE + HOUR), agentMs: agentMinutes * MINUTE };
}

test("time per part uses an eight-request coordinator sample before falling back to the project", () => {
 const history = [40, 50, 50, 60, 60, 70, 80, 90].map((minutes, index) => sample(index, "bakery", minutes));
 const asOf = start + 15 * 24 * HOUR;
 const model = new OverviewEstimator(history, [], asOf);
 expect(model.partsLeft("bakery", 2)).toEqual({ baselineMs: HOUR, range: { kind: "range", basis: "coordinator", minutes: 60, low: 40, high: 90 } });
 expect(model.partsLeft("fresh", 2)).toMatchObject({ range: { basis: "project" } });
 expect(new OverviewEstimator(history.slice(1), [], asOf).partsLeft("bakery", 2)).toEqual({ reason: "not_enough_history" });
 const future = iso(asOf + HOUR);
 expect(new OverviewEstimator([...history.slice(0, -1), { ...history[7]!, doneAt: future }], [], asOf).partsLeft("bakery", 2)).toEqual({ reason: "not_enough_history" });
});

test("earlier ratios calibrate the median and tails, and wide ranges are capped", () => {
 const history = Array.from({ length: 8 }, (_, index) => sample(index, "bakery", 60));
 const scores: ScoredOverviewEstimate[] = history.map(row => ({ requestId: row.requestId, coordinatorId: "bakery", doneAt: row.doneAt, actualMs: 90 * MINUTE,
  estimate: { at: row.firstWorkAt, baselineMs: HOUR, minutes: 60, low: 45, high: 75 },
 }));
 const asOf = start + 12 * 24 * HOUR;
 expect(new OverviewEstimator(history, scores.map(overviewCalibrationMiss), asOf).partsLeft("bakery", 2)).toEqual({ baselineMs: HOUR, range: { kind: "range", basis: "coordinator", minutes: 90, low: 60, high: 90 } });
 const broad = scores.map((row, index) => ({ ...row, actualMs: index < 4 ? 5 * MINUTE : 5 * HOUR }));
 const capped = new OverviewEstimator(history, broad.map(overviewCalibrationMiss), asOf).partsLeft("bakery", 2);
 if ("reason" in capped) throw new Error("Expected a capped range, not a refusal");
 expect(capped.range.high / capped.range.low).toBeLessThanOrEqual(4);
 expect(capped.range.minutes).toBeGreaterThanOrEqual(capped.range.low);
 expect(capped.range.minutes).toBeLessThanOrEqual(capped.range.high);
 expect(new OverviewEstimator(history, scores.map(overviewCalibrationMiss), asOf).partsLeft("new-coordinator", 2)).toMatchObject({ range: { basis: "project", minutes: 90 } });
 const futureMisses = scores.map(score => ({ ...overviewCalibrationMiss(score), doneAt: iso(asOf + HOUR) }));
 expect(new OverviewEstimator(history, futureMisses, asOf).partsLeft("bakery", 2)).toMatchObject({ range: { basis: "coordinator", minutes: 60 } });
 const noParts = history.map(row => ({ ...row, parts: 0 }));
 expect(new OverviewEstimator(noParts, [], asOf).usualDuration("bakery", iso(asOf), 65 * MINUTE)).toMatchObject({ kind: "usual", low: 60, high: 60, longer: true });
});

test("replay uses the first issued range without training on the target, and excludes stopped time", () => {
 const requests: OverviewReplayRequest[] = Array.from({ length: 10 }, (_, index) => ({
  sample: sample(index, "bakery", 60), clock: { work: [], waits: [] }, partsLeft: () => 2,
 }));
 const lastStart = Date.parse(requests[9]!.sample.firstWorkAt);
 requests[9]!.clock.waits.push([lastStart, lastStart + 20 * MINUTE]);
 const replay = replayOverviewEstimates(requests);
 expect(replay.firstEstimates).toEqual({ scored: 2, held: 1, withinFactorTwo: 2, medianAbsoluteMissMinutes: 10, medianWidth: 1, maxWidth: 1 });
 expect(replay.stopped).toBe(1);
 expect(agentTime({ work: [[40, 50]], waits: [[10, 60], [20, 70]] }, 0, 100)).toBe(50);
});

test("Overview serves range, Stopped, and No estimate without using a finish date", () => {
 const { state, records, now, at, baking, design } = bakeryOverviewFixture(undefined, true);
 withBakeryLiveWork(state, design.id, at(.38));
 const estimate = buildCoordinatorOverview({ board: boardView(state, now, true, bakeryCoordinatorOf, true, true), state, records,
  scope: { projectId: "bakery", coordinatorId: "bakery" }, now, coordinatorOf: bakeryCoordinatorOf });
 expect(Value.Check(OverviewEventSchema, estimate)).toBe(true);
 expect(estimate.inFlight.find(row => row.requestId === baking.id)?.left).toMatchObject({ kind: "range", basis: "coordinator", overrun: false });
 expect(estimate.inFlight.some(row => row.left?.kind === "stopped" && row.left.then)).toBe(true);
 expect(estimate.inFlight.some(row => row.left?.kind === "none" && row.left.reason === "not_started")).toBe(true);
 expect(estimate.more.estimates).toEqual({ held: 1, scored: 1 });
 expect(estimate.more.estimateReplay?.scored).toBeGreaterThan(0);
});

test("the server persists a first range once when it issues the overview", async () => {
 const fixture = bakeryOverviewFixture(undefined, true);
 const { state, records, now, at, baking, design } = fixture;
 const setup = await createSetup({ terminals: false, now: () => now });
 const project = await setup.server.manager.store.add(setup.projectDir);
 const { runtime } = await setup.server.manager.open(project.id);
 withBakeryLiveWork(state, design.id, at(.38), runtime.conversation.id);
 await runtime.harness.commit(async tx => {
  const board = await tx.doc(BoardDoc, runtime.conversation.id);
  const table = await tx.doc(OverviewRecordsDoc, runtime.conversation.id);
  Object.assign(board, state);
  Object.assign(table, records);
 }, BACKGROUND_CONTEXT);
 const snapshot = await setup.server.manager.coordinatorOverview(project.id, null);
 const range = snapshot.inFlight.find(row => row.requestId === baking.id)?.left;
 expect(range?.kind).toBe("range");
 if (range?.kind !== "range") return;
 const ledger = await runtime.harness.snapshot(OverviewRecordsDoc, runtime.conversation.id, BACKGROUND_CONTEXT);
 const first = ledger?.tasks[baking.id]?.firstEstimate;
 expect(first).toMatchObject({ at: snapshot.asOf, low: range.low, high: range.high });
 await runtime.harness.commit(tx => rememberOverviewEstimates(tx, runtime.conversation.id, new Map([[baking.id, { at: at(1), baselineMs: 1, minutes: 1, low: 1, high: 1 }]])), BACKGROUND_CONTEXT);
 expect((await runtime.harness.snapshot(OverviewRecordsDoc, runtime.conversation.id, BACKGROUND_CONTEXT))?.tasks[baking.id]?.firstEstimate).toEqual(first);
});
