import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { Value } from "typebox/value";
import { OverviewEventSchema, OverviewGetResponseSchema, LEGACY_HARNESS_FEATURES } from "@kemiri/protocol";
import { boardView, openBoard, openTaskHistory, writeReportIn, HARNESS_WRITER } from "../src/board.ts";
import { backfillOverviewRecords, readOverviewRecords, OverviewRecordsDoc } from "../src/overview-records.ts";
import { buildCoordinatorOverview } from "../src/coordinator-overview.ts";
import { recordTimelineRun } from "../src/task-timeline.ts";
import { updateLivePlan } from "../src/task-live-plan.ts";
import { createSetup, errorOf, TestClient } from "./support.ts";
import { seedBoardReplay } from "./fixtures/board-replay.ts";
import { bakeryCoordinatorOf, bakeryOverviewFixture, withBakeryLiveWork } from "./fixtures/coordinator-overview.ts";

const HOUR = 3_600_000;

test("scopes the live counts and separates overlapping worker time and owner wait", () => {
 const { state, records, now, at, baking, design, checkout, finished } = bakeryOverviewFixture();
 withBakeryLiveWork(state, design.id, at(3));
 const board = boardView(state, now, true, bakeryCoordinatorOf, true, true);
 const overview = buildCoordinatorOverview({ board, state, records, scope: { projectId: "bakery", coordinatorId: "bakery" }, now, coordinatorOf: bakeryCoordinatorOf });
 expect(Value.Check(OverviewEventSchema, overview)).toBe(true);
 expect(overview.counts).toEqual({ open: 1, running: 1, waitingOnOwner: 1, oldestWaitSince: at(2) });
 expect(overview.waiting).toEqual([{ kind: "question", taskId: checkout.id, requestId: baking.id, questionId: "Q2", since: at(2), holdsParts: 1 }]);
 expect(overview.inFlight).toEqual([{ requestId: baking.id, parts: { done: 0, total: 2, working: 1, needsOwner: 1 }, planStep: { taskId: design.id, number: 2, total: 3, text: "Review gift card" }, heldUp: false, runningSince: at(3), firstWorkAt: at(4), left: { kind: "none", reason: "not_enough_history" } }]);
 expect(overview.week).toMatchObject({ requests: 1, parts: 1, sentBack: 1, reopened: 0, startToDoneMs: 6 * HOUR, split: { agentsMs: 2.5 * HOUR, waitingMs: 2.5 * HOUR, otherMs: HOUR } });
 expect(overview.more.heldUpTodayMs).toBe(2.5 * HOUR);
 expect(overview.estimateInputs.completed).toEqual([{ requestId: finished.id, coordinatorId: "bakery", firstWorkAt: at(8), readyAt: at(4), doneAt: at(2), parts: 1, agentMs: 3 * HOUR }]);
 const all = buildCoordinatorOverview({ board, state, records, scope: { projectId: "bakery", coordinatorId: null }, now, coordinatorOf: bakeryCoordinatorOf });
 expect(all.counts).toMatchObject({ open: 2, running: 1, waitingOnOwner: 3 });
 expect(all.waiting.map(wait => wait.kind)).toEqual(["question", "question", "review"]);
});

test("backfill commits bounded pages and can resume after reopening storage", async () => {
 const dir = await mkdtemp(join(tmpdir(), "overview-backfill-"));
 const path = join(dir, "session.sqlite");
 try {
  await seedBoardReplay(path, { taskCount: 35, closedCount: 10, reportBytes: 80, deltas: 2 });
  let storage = await openNodeSqliteStorage(path);
  await backfillOverviewRecords(storage, 1);
  expect(Object.keys((await readOverviewRecords(storage))!.tasks)).toHaveLength(32);
  expect((await readOverviewRecords(storage))!.backfilled).toBeUndefined();
  await storage.close(BACKGROUND_CONTEXT);
  storage = await openNodeSqliteStorage(path);
  try {
   await backfillOverviewRecords(storage);
   const records = (await readOverviewRecords(storage))!;
   expect(records.backfilled).toBe(true);
   expect(Object.keys(records.tasks)).toHaveLength(35);
   expect(records.tasks.T1?.statuses[0]).toMatchObject({ status: "done", by: "user" });
   await backfillOverviewRecords(storage);
   expect(await readOverviewRecords(storage)).toEqual(records);
  } finally { await storage.close(BACKGROUND_CONTEXT); }
 } finally { await rm(dir, { recursive: true, force: true }); }
});

test("overview replies and pushes on the existing board stream, retaining run and failed check history", async () => {
 const setup = await createSetup({ terminals: false });
 const project = await setup.server.manager.store.add(setup.projectDir);
 const client = await TestClient.open(setup.server);
 try {
  await client.hello();
  const subscription = await client.request({ type: "overview.get", projectId: project.id, coordinatorId: "main", subscribe: true });
  expect(Value.Check(OverviewGetResponseSchema, subscription)).toBe(true);
  const { runtime } = await setup.server.manager.open(project.id);
  const created = await client.request({ type: "board.task.save", projectId: project.id, task: {
   title: "Print bread labels", status: "in_progress", description: "", blockedBy: [], blockedReason: null, acceptance: null, writeScopes: [],
  } });
  expect(created.type).toBe("board.task.save");
  if (created.type !== "board.task.save") return;
  const id = created.task.id;
  const push = await client.waitFor(message => message.type === "overview" && !("id" in message) && message.counts.open === 1);
  expect(push).toMatchObject({ scope: { coordinatorId: "main" }, inFlight: [{ requestId: id }] });
  await runtime.harness.commit(async tx => {
   const board = await openBoard(tx, runtime.conversation.id);
   const history = await openTaskHistory(tx, runtime.conversation.id, id);
   const worker = { kind: "worker" as const, id: "label-print", name: "label-print", conversationId: 20, threadId: "main", runId: "1" };
   recordTimelineRun(history, board.tasks[0]!, worker, "running", "2026-05-14T09:00:00.000Z", "Print labels");
   recordTimelineRun(history, board.tasks[0]!, worker, "stopped", "2026-05-14T10:00:00.000Z", "Stopped");
   await writeReportIn(tx, runtime.conversation.id, { taskId: id, by: HARNESS_WRITER, sections: { checks: [{ name: "proof", result: "failed" }] } }, "failed", "2026-05-14T10:00:00.000Z");
  }, BACKGROUND_CONTEXT);
  await runtime.harness.commit(tx => writeReportIn(tx, runtime.conversation.id, { taskId: id, by: HARNESS_WRITER, sections: { checks: [{ name: "proof", result: "passed" }] } }, "passed", "2026-05-14T10:15:00.000Z"), BACKGROUND_CONTEXT);
  const table = await runtime.harness.snapshot(OverviewRecordsDoc, runtime.conversation.id, BACKGROUND_CONTEXT);
  expect(table?.tasks[id]?.statuses[0]?.status).toBe("in_progress");
  expect(Object.values(table?.tasks[id]?.runs ?? {})).toEqual([{ at: "2026-05-14T09:00:00.000Z", endAt: "2026-05-14T10:00:00.000Z", source: "worker", outcome: "stopped", workerId: "label-print", conversationId: 20 }]);
  await runtime.harness.commit(async tx => {
   const history = await openTaskHistory(tx, runtime.conversation.id, id);
   expect(history.failedChecks?.map(check => check.result)).toEqual(["failed"]);
  }, BACKGROUND_CONTEXT);
  await client.request({ type: "overview.get", projectId: project.id, coordinatorId: null, subscribe: false });
  const bad = await client.request({ type: "overview.get", projectId: project.id, coordinatorId: "not-a-coordinator" });
  expect(errorOf(bad).code).toBe("unknown_thread");
 } finally { client.close(); }
});

test("legacy capability fallback does not turn on the overview", async () => {
 expect(LEGACY_HARNESS_FEATURES).not.toContain("coordinator-overview" as never);
 const setup = await createSetup({ terminals: false, features: LEGACY_HARNESS_FEATURES });
 const client = await TestClient.open(setup.server);
 try {
  await client.hello();
  expect(errorOf(await client.request({ type: "overview.get", projectId: "bakery", coordinatorId: null })).code).toBe("unknown_request");
 } finally { client.close(); }
});

test("ticks record when a step was done without inventing times for legacy steps", () => {
 const first = "2026-05-14T10:00:00.000Z";
 const later = "2026-05-14T11:00:00.000Z";
 const plan = [{ text: "Check paper", status: "done" as const }, { text: "Print label", status: "doing" as const }, { text: "Review label" }];
 const current = updateLivePlan(updateLivePlan(undefined, { plan }), { tick: [2] }, first);
 expect(current.map(step => step.doneAt)).toEqual([undefined, first, undefined]);
 expect(updateLivePlan(current, { plan: [{ text: "Check paper" }, { text: "Print label" }, { text: "Review label", status: "done" }] }, later).map(step => step.doneAt)).toEqual([undefined, first, later]);
});
