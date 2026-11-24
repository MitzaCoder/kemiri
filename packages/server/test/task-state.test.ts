import { afterEach, expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import type { BoardTask, BoardTaskInput } from "@kemiri/protocol";
import { HARNESS_FEATURES, LEGACY_HARNESS_FEATURES } from "../../protocol/src/projects.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { defineDoc, type JsonObject } from "@earendil-works/pi-durable";
import { BoardDoc, TaskHistoryDoc, askQuestion, boardView, changeLink, claimTaskForThread, emptyBoardState, migrateTaskStates, moveTaskForWorker, partDropReason, recordScheduledReport, saveTask, settleQuestion, unblockedBy, writeReport, HARNESS_WRITER, type BoardState } from "../src/board.ts";
import { activityTracking, endActivitySource, taskState, TASK_PAUSED_MS, type TaskActivitySource } from "../src/task-activity.ts";
import { boardAttention } from "../src/sidebar-attention.ts";
import { topRequest } from "../src/request-attention.ts";
import { createSetup, entryText, errorOf, TestClient, ViewClient } from "./support.ts";

const START = Date.parse("2026-11-12T12:00:00.000Z");
const at = (ms = 0) => new Date(START + ms).toISOString();
const input = (extra: Partial<BoardTaskInput> = {}): BoardTaskInput => ({ title: "Synthetic task", description: "Keep this description", acceptance: null, status: "todo", blockedBy: [], blockedReason: null, writeScopes: [], ...extra });
function add(state: BoardState, extra: Partial<BoardTaskInput> = {}) { return saveTask(state, { task: input(extra), author: "user", now: at() }).after; }
function update(state: BoardState, id: string, extra: Partial<BoardTaskInput>, author: "user" | "coordinator" = "coordinator", openParts?: "close" | "follow_up") {
 const task = state.tasks.find(t => t.id === id)!;
 return saveTask(state, { taskId: id, expectedRevision: task.revision, task: { ...task, ...extra }, author, now: at(10), openParts });
}
function source(state: BoardState, status: TaskActivitySource["state"] = "running", id = "run-1", taskId = "T1") {
 const run: TaskActivitySource = { actor: { id, kind: "worker", name: "fern", threadId: "main", conversationId: 2, runId: id }, state: status, since: at(2), title: "Synthetic task" };
 activityTracking(state, taskId).sources[id] = run; return run;
}
function derive(state: BoardState, ms = 100) { return taskState(state.tasks[0]!, state.questions, state.tasks, state.taskActivity?.T1, START + ms); }
const blockedMessage = "T2 is blocked by T1 (in progress). Wait for T1 to close, or if T2 no longer needs it, remove the blocker in the same call: update_task id=T2 status=in_progress blockedBy=[]";

it("advertises optional state separately, not on legacy backends", () => {
 expect(HARNESS_FEATURES).toContain("task-state"); expect(LEGACY_HARNESS_FEATURES).not.toContain("task-state");
 const s = emptyBoardState(); add(s); expect(boardView(s, START, true).tasks[0]!.state).toBeUndefined();
 s.taskStateEnabled = true; expect(boardView(s, START, true).tasks[0]!.state).toMatchObject({ group: "todo", kind: "todo" }); expect(s.tasks[0]!.state).toBeUndefined();
});

it.each(["done", "dropped"] as const)("closed %s wins over failures, blocking questions and running sources", status => {
 const s = emptyBoardState(); add(s, { status }); source(s, "failed"); source(s, "running", "run-2"); askQuestion(s, { taskId: "T1", text: "Choose", options: [], now: at() });
 expect(derive(s)).toMatchObject({ group: "closed", kind: status, since: at(), refs: [] });
});

it.each(["source", "deploy", "stored"] as const)("failure %s wins over questions and work", failure => {
 const s = emptyBoardState(); add(s, { status: failure === "stored" ? "blocked" : "todo", blockedReason: failure === "stored" ? "Stuck" : null });
 source(s); if (failure === "source") source(s, "failed", "failed-run");
 if (failure === "deploy") activityTracking(s, "T1").deployFailure = { text: "Deploy failed", since: at(1), refs: ["deploy-1"], targets: ["test"], total: 1 };
 askQuestion(s, { taskId: "T1", text: "Choose", options: [], now: at() });
 expect(derive(s)).toMatchObject({ group: "needs_you", kind: "failed", refs: failure === "source" ? ["failed-run"] : failure === "deploy" ? ["deploy-1"] : [] });
});

it("blocking questions override deploy, live sources and blockers; warnings use the activity blocking test", () => {
 const s = emptyBoardState(); add(s, { status: "review" }); add(s); s.tasks[0]!.blockedBy = ["T2"]; source(s);
 const tracking = activityTracking(s, "T1"); tracking.deploy = { state: "active", text: "Deploying", since: at(), refs: ["deploy"] };
 askQuestion(s, { taskId: "T1", text: "Not blocking", kind: "warning", options: [], now: at() });
 expect(derive(s).kind).toBe("working");
 askQuestion(s, { taskId: "T1", text: "Explicit", kind: "warning", blocksWork: true, options: [], now: at(3) });
 expect(derive(s)).toMatchObject({ kind: "answer_needed", since: at(3), refs: ["Q2"] });
});

it("ranks steps above idle review and waiting and keeps them while working", () => {
 const s = emptyBoardState(); add(s, { status: "review" });
 const write = (steps: string, ms: number) => writeReport(s, { taskId: "T1", sections: { steps }, by: HARNESS_WRITER, now: at(ms) });
 expect(LEGACY_HARNESS_FEATURES).not.toContain("task-steps");
 expect(derive(s).kind).toBe("review");
 const before = writeReport(s, { taskId: "T1", sections: { next: "Verify", results: "Prepared" }, by: HARNESS_WRITER, now: at(1) });
 const written = write("1. Apply the setting.", 2);
 expect(written.report.freshness).toEqual(before.report.freshness);
 expect(written.eventSeq).toBe(before.eventSeq);
 expect(derive(s)).toMatchObject({ group: "needs_you", kind: "steps_needed", since: at(2) });
 writeReport(s, { taskId: "T1", sections: { next: "Check the new value" }, by: HARNESS_WRITER, now: at(3) });
 expect(derive(s).since).toBe(at(2));
 for (const status of ["in_progress", "waiting"] as const) {
  s.tasks[0]!.status = status;
  expect(derive(s).kind).toBe("steps_needed");
 }
 source(s);
 expect(derive(s)).toMatchObject({ kind: "working", liveWorkSince: at(2) });
 endActivitySource(activityTracking(s, "T1"), "run-1", at(3));
 expect(derive(s).kind).toBe("steps_needed");
 source(s, "running", "run-2");
 askQuestion(s, { taskId: "T1", text: "Choose a value", options: [], now: at(4) });
 expect(derive(s).kind).toBe("answer_needed");
 source(s, "failed", "failed-run");
 expect(derive(s).kind).toBe("failed");
 for (const status of ["done", "dropped"] as const) {
  update(s, "T1", { status }, "user");
  expect(derive(s)).toMatchObject({ group: "closed", kind: status });
  expect(s.tasks[0]!.report.steps).toBe("1. Apply the setting.");
 }
});

it.each(["worker", "thread", "coordinator", "deploy"] as const)("live %s overrides blocker and review", kind => {
 const s = emptyBoardState(); add(s, { status: "review" }); add(s); s.tasks[0]!.blockedBy = ["T2"];
 if (kind === "deploy") activityTracking(s, "T1").deploy = { state: "active", text: "Deploying", since: at(2), refs: ["deploy"] };
 else source(s).actor.kind = kind;
 expect(derive(s)).toMatchObject({ group: "in_progress", kind: "working", since: at(2), refs: [kind === "deploy" ? "deploy" : "run-1"] });
});

it("open blockers precede review/waiting and bare blocked; dropped and done blockers resolve", () => {
 const s = emptyBoardState(); add(s, { status: "blocked" }); add(s); s.tasks[0]!.blockedBy = ["T2"];
 expect(derive(s)).toMatchObject({ group: "waiting", kind: "blocked_by_task", refs: ["T2"] });
 s.tasks[0]!.blockedReason = "Stuck"; expect(derive(s).kind).toBe("failed"); s.tasks[0]!.blockedReason = null;
 for (const status of ["review", "waiting"] as const) { s.tasks[0]!.status = status; expect(derive(s).kind).toBe("blocked_by_task"); }
 s.tasks[1]!.status = "dropped"; expect(derive(s).kind).toBe("waiting_outside");
 s.tasks[0]!.status = "review"; expect(derive(s).kind).toBe("review");
 s.tasks[1]!.status = "done"; expect(derive(s).kind).toBe("review");
 s.tasks[0]!.status = "blocked"; expect(derive(s).kind).toBe("failed");
});

it("paused begins at exactly 15 minutes of quiet, max(status start, run end), without mutation", () => {
 const s = emptyBoardState(); add(s, { status: "in_progress" }); source(s); const tracking = activityTracking(s, "T1"); endActivitySource(tracking, "run-1", at(30_000));
 const before = JSON.stringify(s);
 expect(derive(s, 30_000 + TASK_PAUSED_MS - 1).kind).toBe("working");
 expect(derive(s, 30_000 + TASK_PAUSED_MS)).toMatchObject({ group: "in_progress", kind: "paused", since: at(30_000 + TASK_PAUSED_MS), refs: [] });
 expect(JSON.stringify(s)).toBe(before);
 tracking.statusSince = at(60_000); expect(derive(s, TASK_PAUSED_MS + 30_000).kind).toBe("working");
});

it.each(["review", "waiting"] as const)("agent parent %s refuses unfinished direct parts with a way out", status => {
 const s = emptyBoardState(); add(s); add(s, { parent: "T1" }); add(s, { parent: "T1", status: "in_progress" });
 expect(() => update(s, "T1", { status, waitingFor: "Council reply" })).toThrow(`T1 can't go to ${status}: its parts T2 (to do) and T3 (in progress) are not finished. Finish them first. If one is a follow-up rather than a part of T1, make it one: update_task id=T2 parent=null foundWhile=T1.`);
 update(s, "T2", { status: "done" }, "user"); update(s, "T3", { status: "waiting", waitingFor: "Reply" }); update(s, "T1", { status, waitingFor: "Reply" });
 expect(s.tasks[0]!.status).toBe(status);
});

it.each(["review", "waiting", "done", "dropped"] as const)("agent cannot attach an open part under %s, by save or link", status => {
 const s = emptyBoardState(); add(s, { status, waitingFor: "Reply" }); add(s);
 const message = `T2 can't become an open part of T1 (${status === "review" ? "in review" : status}). Use foundWhile=T1 for follow-up work${["done", "dropped"].includes(status) ? "." : ", or move T1 back to in_progress first."}`;
 expect(() => update(s, "T2", { parent: "T1" })).toThrow(message);
 expect(() => changeLink(s, { taskId: "T2", link: "parent", to: "T1", remove: false, now: at(1) })).toThrow(message);
 expect(() => saveTask(s, { task: input({ parent: "T1" }), author: "coordinator", now: at(1) })).toThrow(message.replace("T2", "T3"));
});

it("starting a part pulls todo ancestors into progress level by level and records harness moves", () => {
 const s = emptyBoardState(); add(s); add(s, { parent: "T1" }); add(s, { parent: "T2" });
 const result = update(s, "T3", { status: "in_progress" });
 expect(s.tasks.map(t => t.status)).toEqual(["in_progress", "in_progress", "in_progress"]);
 expect(s.tasks.slice(0, 2).every(t => t.updatedBy === "harness")).toBe(true); expect(result.notices).toHaveLength(2);
});

it.each(["review", "waiting"] as const)("user reopened part pulls %s parent back", status => {
 const s = emptyBoardState(); add(s, { status, waitingFor: "Reply" }); add(s, { parent: "T1", status: "review" });
 const result = update(s, "T2", { status: "todo" }, "user"); expect(s.tasks[0]!.status).toBe("in_progress"); expect(result.notices).toContain("T1 moved back to in_progress for its part T2.");
});

it.each(["done", "dropped"] as const)("user reopened part of %s becomes follow-up without reopening parent", status => {
 const s = emptyBoardState(); add(s, { status }); add(s, { parent: "T1", status: "done" });
 update(s, "T2", { status: "todo" }, "user"); expect(s.tasks[0]!.status).toBe(status); expect(s.tasks[1]).toMatchObject({ parent: null, foundWhile: "T1" });
});

it("user closing requires an explicit choice, with a distinct code and the open direct parts", () => {
 const s = emptyBoardState(); add(s); add(s, { parent: "T1" }); add(s, { parent: "T1", status: "review" });
 try { update(s, "T1", { status: "done" }, "user"); throw new Error("Accepted"); } catch (e: any) {
  expect(e.code).toBe("open_parts"); expect(e.message).toBe("T1 has 2 open parts (T2 to do, T3 in review). Choose: close them too, or keep them as follow-ups.");
 }
 expect(s.tasks[0]!.status).toBe("todo");
});

it.each(["done", "dropped"] as const)("close choice closes open descendants recursively as %s, naming running workers", status => {
 const s = emptyBoardState(); add(s); add(s, { parent: "T1" }); add(s, { parent: "T2", status: "waiting", waitingFor: "Reply" }); add(s, { parent: "T1", status: "dropped" });
 activityTracking(s, "T3").sources.run = { ...source(emptyBoardState()), state: "running" };
 const change = update(s, "T1", { status }, "user", "close"); expect(s.tasks.map(t => t.status)).toEqual([status, status, status, "dropped"]);
 expect(change.notices?.join(" ")).toContain("Workers still running on T3: fern; stop them or explain why not.");
});

it("follow_up choice detaches direct open parts only and preserves occupied discovery origins", () => {
 const s = emptyBoardState(); add(s); add(s, { parent: "T1" }); add(s, { parent: "T2" }); add(s); add(s, { parent: "T1", foundWhile: "T4" });
 update(s, "T1", { status: "done" }, "user", "follow_up");
 expect(s.tasks[1]).toMatchObject({ parent: null, foundWhile: "T1", status: "todo" }); expect(s.tasks[2]!.parent).toBe("T2");
 expect(s.tasks[4]).toMatchObject({ parent: null, foundWhile: "T4", related: ["T1"] }); expect(s.tasks[0]!.related).toContain("T5");
});

it.each(["in_progress", "review"] as const)("agent %s with open blocker is refused unless the same call removes it; user start overrides it", status => {
 const s = emptyBoardState(); add(s, { status: "in_progress" }); add(s, { blockedBy: ["T1"] });
 expect(() => update(s, "T2", { status })).toThrow(blockedMessage.replace("status=in_progress", `status=${status}`));
 const user = structuredClone(s); const result = update(user, "T2", { status }, "user"); expect(user.tasks[1]).toMatchObject({ status, blockedBy: [], related: ["T1"] }); expect(result.notices?.join(" ")).toContain("became related links");
 update(s, "T2", { status, blockedBy: [] }); expect(s.tasks[1]!.status).toBe(status);
});

it("adding open blocker to waiting is refused unless moved to todo; blocked needs a reason", () => {
 const s = emptyBoardState(); add(s, { status: "in_progress" }); add(s, { status: "waiting", waitingFor: "Reply" });
 expect(() => update(s, "T2", { blockedBy: ["T1"] })).toThrow("T2 can't add an open blocker while waiting. Move it to todo in the same call: update_task id=T2 status=todo blockedBy=[T1].");
 expect(() => changeLink(s, { taskId: "T2", link: "blockedBy", to: "T1", remove: false, now: at() })).toThrow("T2 can't add an open blocker while waiting.");
 update(s, "T2", { status: "todo", blockedBy: ["T1"] });
 expect(() => update(s, "T2", { status: "blocked" })).toThrow("Status blocked is for a failure or being stuck; give blockedReason. To wait for another task, keep status todo and set blockedBy.");
 update(s, "T2", { status: "blocked", blockedReason: "Checks failed" });
});

it("spawn and thread start refuse open blockers; dropped blockers free and notice once", () => {
 const s = emptyBoardState(); add(s, { status: "in_progress" }); add(s, { blockedBy: ["T1"] });
 expect(() => moveTaskForWorker(s, { key: "spawn", taskId: "T2", move: { kind: "spawned", workerId: "fern" }, now: at() })).toThrow(blockedMessage);
 expect(() => claimTaskForThread(s, { key: "thread", taskId: "T2", threadId: "test", now: at() })).toThrow(blockedMessage);
 const change = update(s, "T1", { status: "dropped" }, "user"); expect(unblockedBy(s, change).map(t => t.id)).toEqual(["T2"]);
 expect(unblockedBy(s, update(s, "T1", { title: "New title" }, "user"))).toEqual([]);
 expect(moveTaskForWorker(s, { key: "retry", taskId: "T2", move: { kind: "spawned", workerId: "fern" }, now: at() })!.after.status).toBe("in_progress");
});

it("migration detaches legacy contradictions, moves todo ancestors, resolves stale review/wait blockers, and runs once without deleting data", () => {
 const s = emptyBoardState();
 for (let i = 0; i < 14; i++) add(s);
 const t = s.tasks;
 t[0]!.status = "done"; t[0]!.archived = true; t[1]!.parent = "T1"; t[1]!.archived = true;
 t[2]!.status = "review"; t[3]!.parent = "T3"; t[4]!.parent = "T3"; t[4]!.status = "waiting";
 t[5]!.status = "waiting"; t[6]!.parent = "T6"; t[6]!.status = "blocked"; t[6]!.foundWhile = "T8";
 t[8]!.parent = "T10"; t[8]!.status = "done"; t[9]!.parent = "T11";
 t[11]!.status = "review"; t[11]!.blockedBy = ["T8", "T1"]; t[12]!.status = "waiting"; t[12]!.blockedBy = ["T8"];
 askQuestion(s, { taskId: "T1", text: "Preserve", options: [], now: at() });
 const prose = t.map(t => [t.id, t.title, t.description, t.report]); const questions = structuredClone(s.questions);
 expect(migrateTaskStates(s, at(20)).length).toBeGreaterThan(0);
 expect(t[1]).toMatchObject({ parent: null, foundWhile: "T1" }); expect(t[3]).toMatchObject({ parent: null, foundWhile: "T3" }); expect(t[4]!.parent).toBe("T3");
 expect(t[6]).toMatchObject({ parent: null, foundWhile: "T8", related: ["T6"] }); expect(t[9]!.status).toBe("in_progress"); expect(t[10]!.status).toBe("in_progress");
 expect(t[11]).toMatchObject({ blockedBy: ["T1"], related: ["T8"] }); expect(t[12]).toMatchObject({ blockedBy: [], related: ["T8"] });
 expect(t.map(t => [t.id, t.title, t.description, t.report])).toEqual(prose); expect(s.questions).toEqual(questions); expect(s.tasks).toHaveLength(14);
 const saved = JSON.stringify(s); expect(migrateTaskStates(s, at(30))).toEqual([]); expect(JSON.stringify(s)).toBe(saved);
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function integration(features?: readonly string[], clientFeatures?: string[]) {
 let now = START;
 const setup = await createSetup({ now: () => now, boardEditDebounceMs: 60_000, ...(features === undefined ? {} : { features }) }); cleanups.push(setup.cleanup);
 setup.faux.setResponses(Array.from({ length: 30 }, () => () => fauxAssistantMessage("Noted.")));
 const client = await TestClient.open(setup.server); cleanups.push(async () => client.close()); const hello = clientFeatures ? await client.request({ type: "hello", protocolVersion: 1, client: { name: "test", version: "0", features: clientFeatures } }) : await client.hello();
 const added = await client.request({ type: "projects.add", path: setup.projectDir }); if (added.type !== "projects.add") throw errorOf(added);
 const configured = await client.request({ type: "projects.configure", projectId: added.project.id, coordinatorModel: { provider: "faux", modelId: "faux-1" } }); if (configured.type !== "projects.configure") throw errorOf(configured);
 const { runtime } = await setup.server.manager.open(added.project.id);
 return { setup, client, runtime, hello, projectId: added.project.id, clock: (ms: number) => { now = START + ms; } };
}

async function runBoardTool({ setup, runtime }: Awaited<ReturnType<typeof integration>>, ...calls: JsonObject[]) {
 const results: { text: string; isError: boolean }[] = [];
 const capture = (request: Parameters<FauxResponseFactory>[0]) => {
  const last = request.messages.at(-1);
  if (last?.role === "toolResult" && last.toolName === "board") results.push({
   text: last.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n"), isError: last.isError,
  });
 };
 setup.faux.setResponses([
  ...calls.map((call): FauxResponseFactory => request => {
   capture(request);
   return fauxAssistantMessage([fauxToolCall("board", call)], { stopReason: "toolUse" });
  }),
  request => { capture(request); return fauxAssistantMessage("Noted."); },
  ...Array.from({ length: 5 }, () => () => fauxAssistantMessage("Noted.")),
 ]);
 const turn = await runtime.conversation.submit({ type: "input", content: "Check the synthetic tasks." }, BACKGROUND_CONTEXT);
 await turn.wait(BACKGROUND_CONTEXT);
 await runtime.conversation.waitForIdle(BACKGROUND_CONTEXT);
 expect(results).toHaveLength(calls.length);
 return results;
}

it("a checked nested part replaces review with done and frees its sibling only after all four guards pass", async () => {
 const project = await integration();
 const { runtime, client, projectId } = project;
 await runtime.harness.commit(async tx => {
  const state = await tx.doc(BoardDoc, runtime.conversation.id) as BoardState;
  add(state, { status: "in_progress" }); add(state, { parent: "T1", status: "in_progress" });
  add(state, { parent: "T2", status: "in_progress", title: "Verify the label" });
  add(state, { parent: "T2", blockedBy: ["T3"], title: "Print the label" });
  writeReport(state, { taskId: "T3", sections: { results: "  ", checks: [{ name: "Label size", result: "failed" }] }, by: HARNESS_WRITER, now: at() });
  askQuestion(state, { taskId: "T3", text: "Which size?", options: [], blocksWork: false, now: at() });
  askQuestion(state, { taskId: "T3", text: "The proof is out of date.", options: [], kind: "warning", now: at() });
  activityTracking(state, "T3").sources["run-1"] = { actor: { id: "run-1", kind: "worker", name: "fern", threadId: "main", conversationId: 2, runId: "run-1" }, state: "running", since: at(), title: "Measure the label" };
 }, BACKGROUND_CONTEXT);
 const [done, review, addInReview] = await runBoardTool(project,
  { action: "update_task", id: "T3", expectedRevision: 1, status: "done" },
  { action: "update_task", id: "T3", expectedRevision: 1, status: "review" },
  { action: "add_task", parent: "T2", title: "Unverified part", status: "review" });
 const guardLines = ["Write Results for the part.", "Resolve the failed checks: Label size.", "Resolve the open questions or warnings: Q1, Q2.", "Wait for the running workers to finish: fern."].join("\n");
 expect(done).toEqual({ text: guardLines, isError: true });
 expect(review).toEqual({ text: `Parts no longer go to review.\n${guardLines}`, isError: true });
 expect(addInReview).toMatchObject({ text: expect.stringContaining("Parts no longer go to review."), isError: true });
 expect((await runtime.board.state()).tasks[2]).toMatchObject({ status: "in_progress", revision: 1 });
 await runtime.harness.commit(async tx => {
  const state = await tx.doc(BoardDoc, runtime.conversation.id) as BoardState;
  writeReport(state, { taskId: "T3", sections: { checks: [{ name: "Label size", result: "passed" }] }, blocks: { results: [{ kind: "outcome", text: "The label fits the box." }] }, by: HARNESS_WRITER, now: at() });
  // The typed blocks alone satisfy the guard, even without the legacy Markdown mirror.
  state.tasks[2]!.report.results = "";
  endActivitySource(activityTracking(state, "T3"), "run-1", at());
  for (const question of state.questions) settleQuestion(state, { questionId: question.id, expectedRevision: question.revision, answer: "Resolved", now: at(), actor: "user" });
 }, BACKGROUND_CONTEXT);
 const view = new ViewClient(client); await view.start(projectId);
 const [checked, started] = await runBoardTool(project,
  { action: "update_task", id: "T3", expectedRevision: 1, status: "review" },
  { action: "update_task", id: "T4", expectedRevision: 1, status: "in_progress" });
 expect(checked).toMatchObject({ text: expect.stringContaining("Parts no longer go to review: T3 was marked done because you checked it."), isError: false });
 expect(started).toMatchObject({ text: expect.stringContaining("T4 (now r2, in_progress)"), isError: false });
 await view.waitForView(value => value.entries.some(entry => entryText(entry).includes('T4 "Print the label" has all its blockers closed and can start.')));
 expect((await runtime.board.history("T3")).at(-1)).toMatchObject({ label: "in_progress → done", by: { author: "coordinator", threadId: "main" } });
});

it("the board tool requires drop reasons and keeps request review and closure separate", async () => {
 const project = await integration();
 const { runtime, client, projectId } = project;
 await runtime.harness.commit(async tx => {
  const state = await tx.doc(BoardDoc, runtime.conversation.id) as BoardState;
  add(state, { status: "in_progress" }); add(state, { parent: "T1", status: "review" });
  add(state, { parent: "T1", status: "waiting", waitingFor: "A reply" }); add(state, { parent: "T1" }); add(state, { parent: "T1" });
  writeReport(state, { taskId: "T2", sections: { results: "The label fits the box." }, by: HARNESS_WRITER, now: at() });
 }, BACKGROUND_CONTEXT);
 const root = { action: "update_task", id: "T1", expectedRevision: 1 };
 const [review, waiting, close, dropRequest, noReason, blankReason, done, dropped, droppedViaUpdate, accepted] = await runBoardTool(project,
  { ...root, status: "review" }, { ...root, status: "waiting", waitingFor: "A reply" }, { ...root, status: "done" },
  { ...root, action: "drop_task", reason: "Not needed." },
  { action: "drop_task", id: "T4", expectedRevision: 1 },
  { action: "update_task", id: "T5", expectedRevision: 1, status: "dropped", reason: "   " },
  { action: "update_task", id: "T2", expectedRevision: 1, status: "done" },
  { action: "drop_task", id: "T4", expectedRevision: 1, reason: "  The box needs only one label.  " },
  { action: "update_task", id: "T5", expectedRevision: 1, status: "dropped", reason: "The label comes preprinted." },
  { ...root, status: "review" });
 for (const result of [review, waiting]) expect(result).toMatchObject({ isError: true, text: expect.stringContaining("T2 (in review) and T4 (to do) and T5 (to do)") });
 for (const result of [close, dropRequest]) expect(result).toMatchObject({ isError: true, text: expect.stringContaining("Only the owner closes a request.") });
 for (const result of [noReason, blankReason]) expect(result).toMatchObject({ isError: true, text: expect.stringContaining("needs a reason to be dropped") });
 for (const result of [done, dropped, droppedViaUpdate, accepted]) expect(result?.isError).toBe(false);
 const state = await runtime.board.state();
 expect(state.tasks.map(task => task.status)).toEqual(["review", "done", "waiting", "dropped", "dropped"]);
 expect(partDropReason(state, "T4")).toBe("The box needs only one label.");
 expect(partDropReason(state, "T5")).toBe("The label comes preprinted.");
 expect((await runtime.board.timeline("T4")).entries).toContainEqual(expect.objectContaining({
  kind: "status", label: "todo → dropped: The box needs only one label.", by: { author: "coordinator", threadId: "main", workerId: null },
 }));
 const wire = await client.request({ type: "board.get", projectId });
 expect(wire.type).toBe("board.get");
 expect(JSON.stringify(wire)).not.toContain("The box needs only one label.");
 // An ordinary app edit may still reopen the part, and reopens its reviewed request.
 const reopened = await client.request({ type: "board.task.save", projectId, taskId: "T4", expectedRevision: 2, task: input({ status: "todo" }) });
 expect(reopened.type).toBe("board.task.save");
 expect((await runtime.board.state()).tasks[0]!.status).toBe("in_progress");
 expect(partDropReason(await runtime.board.state(), "T4")).toBeUndefined();
});

it("closing parts does not reopen their request when it is already waiting or in review", async () => {
 const project = await integration();
 const { runtime } = project;
 await runtime.harness.commit(async tx => {
  const state = await tx.doc(BoardDoc, runtime.conversation.id) as BoardState;
  add(state, { status: "review" }); add(state, { status: "review", parent: "T1" });
  add(state, { status: "waiting", waitingFor: "A reply" }); add(state, { status: "waiting", waitingFor: "A reply", parent: "T3" });
  writeReport(state, { taskId: "T2", sections: { results: "The label fits the box." }, by: HARNESS_WRITER, now: at() });
 }, BACKGROUND_CONTEXT);
 const results = await runBoardTool(project,
  { action: "update_task", id: "T2", expectedRevision: 1, status: "done" },
  { action: "drop_task", id: "T4", expectedRevision: 1, reason: "No second label is needed." });
 expect(results.map(result => result.isError)).toEqual([false, false]);
 expect((await runtime.board.state()).tasks.map(task => task.status)).toEqual(["review", "done", "waiting", "dropped"]);
});

it("wire close refusal, recursive close and repairs have timeline snapshots; start-now links are recorded", async () => {
 const { client, projectId, runtime } = await integration();
 const root = await runtime.board.saveTask({ task: input() }, "user");
 const part = await runtime.board.saveTask({ task: input({ parent: root.id }) }, "user");
 const response = await client.request({ type: "board.task.save", projectId, taskId: root.id, expectedRevision: root.revision, task: input({ status: "done" }) });
 expect(errorOf(response)).toMatchObject({ code: "open_parts", message: "T1 has 1 open parts (T2 to do). Choose: close them too, or keep them as follow-ups." });
 await runtime.board.saveTask({ taskId: part.id, expectedRevision: part.revision, task: input({ parent: root.id, status: "in_progress" }) }, "user");
 expect((await runtime.board.history(root.id)).at(-1)).toMatchObject({ status: "in_progress", by: { author: "harness" } });
 const freshRoot = (await runtime.board.get()).tasks[0]!;
 const closed = await client.request({ type: "board.task.save", projectId, taskId: root.id, expectedRevision: freshRoot.revision, task: input({ status: "done" }), openParts: "close" });
 expect(closed.type).toBe("board.task.save"); expect((await runtime.board.history(part.id)).at(-1)!.status).toBe("done");
});

it("paused nudge persists once per episode across restart and nudges again after work and status changes", async () => {
 const { runtime, setup, client, projectId, clock } = await integration();
 const view = new ViewClient(client); await view.start(projectId);
 const nudgeCount = () => view.view?.entries.filter(e => e.kind === "pi.user" && entryText(e).startsWith("[board] T1 is in progress but nothing has run")).length ?? 0;
 await runtime.board.saveTask({ task: input({ status: "in_progress" }) }, "user");
 clock(TASK_PAUSED_MS - 1); await runtime.board.checkPaused(); expect((await runtime.board.state()).taskActivity?.T1?.pauseNudgedEpisode).toBeUndefined();
 clock(TASK_PAUSED_MS); await runtime.board.checkPaused();
 const first = (await runtime.board.state()).taskActivity!.T1!.pauseNudgedEpisode; expect(first).toBeDefined();
 await view.waitForView(() => nudgeCount() === 1);
 await runtime.board.checkPaused(); expect((await runtime.board.state()).taskActivity!.T1!.pauseNudgedEpisode).toBe(first); expect(nudgeCount()).toBe(1);
 await setup.restart(); const reopened = (await setup.server.manager.open(projectId)).runtime; await reopened.board.checkPaused();
 expect((await reopened.board.state()).taskActivity!.T1!.pauseNudgedEpisode).toBe(first);
 await reopened.harness.commit(async tx => {
  const s = await tx.doc(BoardDoc, reopened.conversation.id) as BoardState; source(s); endActivitySource(activityTracking(s, "T1"), "run-1", at(TASK_PAUSED_MS + 1));
 }, BACKGROUND_CONTEXT);
 clock(2 * TASK_PAUSED_MS + 1); await reopened.board.checkPaused(); const second = (await reopened.board.state()).taskActivity!.T1!.pauseNudgedEpisode; expect(second).not.toBe(first);
 const task = (await reopened.board.get()).tasks[0]!;
 await reopened.board.saveTask({ taskId: task.id, expectedRevision: task.revision, task: input({ status: "todo" }) }, "user");
 clock(2 * TASK_PAUSED_MS + 2); const todo = (await reopened.board.get()).tasks[0]!;
 await reopened.board.saveTask({ taskId: todo.id, expectedRevision: todo.revision, task: input({ status: "in_progress" }) }, "user");
 clock(3 * TASK_PAUSED_MS + 2); await reopened.board.checkPaused(); expect((await reopened.board.state()).taskActivity!.T1!.pauseNudgedEpisode).not.toBe(second);
 expect((await reopened.board.state()).pausedNotices).toEqual([]);
}, 20_000);

it("migration is applied once at open and records links/moves in touched task timelines", async () => {
 const { runtime, setup, projectId } = await integration();
 await runtime.harness.commit(async tx => {
  const s = await tx.doc(BoardDoc, runtime.conversation.id) as BoardState;
  add(s, { status: "done" }); add(s); add(s); add(s);
  s.tasks[1]!.parent = "T1"; s.tasks[3]!.parent = "T3"; s.tasks[3]!.status = "done";
  delete s.taskStateMigrated;
 }, BACKGROUND_CONTEXT);
 await setup.restart(); const reopened = (await setup.server.manager.open(projectId)).runtime;
 expect((await reopened.board.get(true)).tasks[1]).toMatchObject({ parent: null, foundWhile: "T1" });
 expect((await reopened.board.timeline("T2")).entries.some(e => e.kind === "link")).toBe(true);
 expect((await reopened.board.history("T3")).at(-1)!.status).toBe("in_progress");
 const before = await reopened.board.timeline("T2"); await reopened.board.ensureDocument(); expect(await reopened.board.timeline("T2")).toEqual(before);
}, 20_000);


it("the upgrade closes only parts in review and remains safe after an old-shape rewrite", async () => {
 const { runtime, setup, projectId } = await integration();
 const previousBoardDoc = defineDoc<Omit<BoardState, "partsReviewMigrated" | "partDropReasons">>({
  ...BoardDoc.definition, scope: "conversation", history: "latest", fork: "initial",
 });
 await runtime.harness.commit(async tx => {
  const state = await tx.doc(BoardDoc, runtime.conversation.id) as BoardState;
  add(state, { status: "review" }); add(state, { parent: "T1", status: "review" });
  add(state, { parent: "T2", status: "waiting", waitingFor: "A reply" });
  add(state, { status: "in_progress" }); add(state, { parent: "T4" });
  writeReport(state, { taskId: "T2", sections: { results: "Preserve this report." }, by: HARNESS_WRITER, now: at() });
  delete state.partsReviewMigrated;
 }, BACKGROUND_CONTEXT);
 await setup.restart();
 const reopened = (await setup.server.manager.open(projectId)).runtime;
 const board = await reopened.board.state();
 expect(board.partsReviewMigrated).toBe(true);
 expect(board.tasks.map(task => [task.status, task.parent])).toEqual([
  ["review", null], ["done", "T1"], ["waiting", "T2"], ["in_progress", null], ["todo", "T4"],
 ]);
 const history = await reopened.board.history("T2");
 expect(history).toEqual([expect.objectContaining({
  status: "done", by: HARNESS_WRITER, report: expect.objectContaining({ results: "Preserve this report." }),
  label: "review → done: Marked done at upgrade. Parts no longer go to review. The request is reviewed instead.",
 })]);
 expect((await reopened.board.timeline("T2")).entries[0]?.kind).toBe("status");
 await reopened.board.ensureDocument();
 expect(await reopened.board.history("T2")).toEqual(history);
 await reopened.harness.commit(async tx => {
  const old = (await tx.doc(previousBoardDoc, reopened.conversation.id))!;
  expect(old.tasks[1]).toMatchObject({ status: "done", parent: "T1", updatedBy: "harness" });
  // Simulate an older writer reconstructing the document from fields it knows.
  delete (old as BoardState).partsReviewMigrated;
  old.tasks[4]!.description = "Edited by the older release.";
 }, BACKGROUND_CONTEXT);
 await reopened.board.ensureDocument();
 const after = await reopened.board.state();
 expect(after.partsReviewMigrated).toBe(true);
 expect(after.tasks[4]).toMatchObject({ status: "todo", description: "Edited by the older release." });
 expect(after.tasks[2]).toMatchObject({ status: "waiting", parent: "T2" });
 expect(await reopened.board.history("T2")).toEqual(history);
}, 20_000);

it("check-again sends an agent's waiting part back to the coordinator, not to review", async () => {
 const project = await integration();
 const { runtime, clock } = project;
 await runtime.harness.commit(async tx => {
  const state = await tx.doc(BoardDoc, runtime.conversation.id) as BoardState;
  add(state, { status: "in_progress" }); add(state, { parent: "T1", status: "in_progress" });
 }, BACKGROUND_CONTEXT);
 const [result] = await runBoardTool(project, { action: "update_task", id: "T2", expectedRevision: 1, status: "waiting", waitingFor: "A reply", waitUntil: at(5000) });
 expect(result?.isError).toBe(false);
 clock(5000);
 await runtime.board.checkWaiting();
 expect((await runtime.board.history("T2")).map(snapshot => snapshot.status)).toEqual(["waiting", "in_progress"]);
});

it.each(["in_progress", "review"] as const)("agent cannot add an open blocker while already %s, including link action", status => {
 const s = emptyBoardState(); add(s); add(s, { status });
 const message = `T2 can't add an open blocker while ${status === "review" ? "in review" : "in progress"}. Move it to todo in the same call: update_task id=T2 status=todo blockedBy=[T1].`;
 expect(() => update(s, "T2", { blockedBy: ["T1"] })).toThrow(message);
 expect(() => changeLink(s, { taskId: "T2", link: "blockedBy", to: "T1", remove: false, now: at() })).toThrow(message);
 update(s, "T2", { status: "todo", blockedBy: ["T1"] }); expect(s.tasks[1]!.blockedBy).toEqual(["T1"]);
});

it("shared expiry timer republishes paused at the boundary without polling writes", async () => {
 const { runtime, clock } = await integration();
 await runtime.board.saveTask({ task: input({ status: "in_progress" }) }, "user");
 clock(TASK_PAUSED_MS - 30);
 const seen: string[] = [];
 const stop = await runtime.board.watch(board => { const kind = board.tasks[0]?.state?.kind; if (kind) seen.push(kind); }); cleanups.push(stop);
 clock(TASK_PAUSED_MS);
 const deadline = Date.now() + 2000;
 while (!seen.includes("paused") && Date.now() < deadline) await Bun.sleep(10);
 expect(seen).toContain("working"); expect(seen).toContain("paused");
 const task = (await runtime.board.get()).tasks[0]!; expect(task.revision).toBe(1); expect(task.updatedAt).toBe(at());
});

it("overdue pause after restart admits exactly one durable notice", async () => {
 const { runtime, clock, setup, projectId } = await integration();
 await runtime.board.saveTask({ task: input({ status: "in_progress" }) }, "user");
 await setup.server.stop(); clock(TASK_PAUSED_MS + 1); await setup.restart();
 const reopened = (await setup.server.manager.open(projectId)).runtime;
 expect((await reopened.board.state()).taskActivity!.T1!.pauseNudgedEpisode).toBeDefined();
 const before = (await reopened.board.state()).taskActivity!.T1!.pauseNudgedEpisode;
 await reopened.board.ensureDocument(); expect((await reopened.board.state()).taskActivity!.T1!.pauseNudgedEpisode).toBe(before);
}, 20_000);

it("real worker_spawn refuses an open blocker without creating a worker or moving its task", async () => {
 const { runtime, setup, client, projectId } = await integration();
 await runtime.board.saveTask({ task: input({ status: "in_progress" }) }, "user");
 await runtime.board.saveTask({ task: input({ blockedBy: ["T1"] }) }, "user");
 const configured = await client.request({ type: "projects.configure", projectId, workerModels: [{ provider: "faux", modelId: "faux-1" }] }); if (configured.type !== "projects.configure") throw errorOf(configured);
 let output = "";
 setup.faux.setResponses([
  () => fauxAssistantMessage([fauxToolCall("worker_spawn", { id: "blocked-worker", title: "Blocked work", task: "Do the synthetic work", taskId: "T2", isolation: "shared" })], { stopReason: "toolUse" }),
  params => { output = JSON.stringify(params.messages.at(-1)); return fauxAssistantMessage("Stopped."); },
 ]);
 const submission = await runtime.conversation.submit({ type: "input", requestId: "blocked-spawn-test", content: "Try blocked task." }, BACKGROUND_CONTEXT); await submission.wait(BACKGROUND_CONTEXT);
 expect(output).toContain(blockedMessage);
 const listed = await client.request({ type: "workers.list", projectId }); if (listed.type !== "workers.list") throw errorOf(listed); expect(listed.workers).toEqual([]);
 expect((await runtime.board.get()).tasks[1]!.status).toBe("todo");
});

it("dropping a blocker sends the owning coordinator a resolved-blockers notice", async () => {
 const { runtime, client, projectId } = await integration(); const view = new ViewClient(client); await view.start(projectId);
 const blocker = await runtime.board.saveTask({ task: input() }, "user");
 await runtime.board.saveTask({ task: input({ blockedBy: [blocker.id] }) }, "user");
 await runtime.board.saveTask({ taskId: blocker.id, expectedRevision: blocker.revision, task: input({ status: "dropped" }) }, "user");
 await view.waitForView(v => v.entries.some(e => entryText(e).includes('is dropped, so T2')));
 expect(view.view!.entries.filter(e => entryText(e).includes('is dropped, so T2'))).toHaveLength(1);
});


it("parent follows live direct and descendant work, but not idle grace or unknown work", () => {
 const s = emptyBoardState(); s.taskStateEnabled = true; s.taskPartStatesEnabled = true; s.taskActivityEnabled = true;
 add(s, { status: "in_progress" }); add(s, { parent: "T1", status: "done" });
 add(s, { parent: "T1", status: "in_progress" }); add(s, { parent: "T1" }); add(s, { parent: "T3", status: "in_progress" });
 add(s, { parent: "T1", status: "dropped" });
 activityTracking(s, "T5").sources.fern = { actor: { id: "fern", kind: "worker", name: "fern", threadId: "main", conversationId: 2, runId: "run" }, state: "running", since: at(2), title: "Photos" };
 const before = JSON.stringify(s);
 const board = boardView(s, START + 2 * TASK_PAUSED_MS, true);
 expect(board.tasks[0]!.state).toEqual({ group: "in_progress", kind: "working", since: at(2), liveWorkSince: at(2), refs: ["T3"], sentence: { kind: "working", text: "1 of 3 parts done · 1 working", since: at(2), refs: ["T3"], ageFormat: "none" } });
 expect(board.tasks[0]!.subtaskCount).toEqual({ done: 1, total: 3 });
 expect(board.tasks[0]!.subtaskStates).toEqual(["done", "working", "todo"]);
 expect(board.tasks[0]!.activity!.text).toBe("1 of 3 parts done · 1 working");
 expect(JSON.stringify(s)).toBe(before);
 activityTracking(s, "T5").sources.fern!.state = "unknown";
 expect(boardView(s, START + 2 * TASK_PAUSED_MS, true).tasks[0]!.state!.kind).toBe("paused");
 activityTracking(s, "T3").statusSince = at(2 * TASK_PAUSED_MS);
 expect(boardView(s, START + 2 * TASK_PAUSED_MS, true).tasks[0]!.state!.kind).toBe("paused");
 s.taskPartStatesEnabled = false;
 expect(boardView(s, START, true).tasks[0]!.subtaskStates).toBeUndefined();
 expect(HARNESS_FEATURES).toContain("task-part-states"); expect(LEGACY_HARNESS_FEATURES).not.toContain("task-part-states");
});

it.each(["failed", "answer_needed", "review", "blocked_by_task", "waiting_outside", "done"] as const)("parent keeps real attention beside live parts, but live parts replace passive %s", kind => {
 const s = emptyBoardState(); s.taskStateEnabled = true; s.taskPartStatesEnabled = true; s.taskActivityEnabled = true;
 add(s, { status: "in_progress" }); add(s, { parent: "T1", status: "in_progress" }); add(s);
 activityTracking(s, "T2").sources.fern = { actor: { id: "fern", kind: "worker", name: "fern", threadId: "main", conversationId: 2, runId: "run" }, state: "running", since: at(2), title: "Photos" };
 const root = s.tasks[0]!;
 if (kind === "failed") { root.status = "blocked"; root.blockedReason = "Stuck"; }
 if (kind === "answer_needed") askQuestion(s, { taskId: root.id, text: "Choose", options: [], now: at() });
 if (kind === "review") root.status = "review";
 if (kind === "blocked_by_task") root.blockedBy = ["T3"];
 if (kind === "waiting_outside") { root.status = "waiting"; root.waiting = { note: "Council", since: at(), by: "user" }; }
 if (kind === "done") root.status = "done";
 const parent = boardView(s, START + TASK_PAUSED_MS, true).tasks[0]!;
 const retainsKind = kind === "failed" || kind === "answer_needed" || kind === "done";
 expect(parent.state!.kind).toBe(retainsKind ? kind : "working");
 expect(parent.state!.liveWorkSince).toBe(kind === "done" ? undefined : at(2));
 if (retainsKind) expect(parent.activity!.text).not.toContain("parts done");
});

it("live parts suppress parent pause notices until work ends, with an injected clock", async () => {
 const { runtime, clock } = await integration();
 await runtime.board.saveTask({ task: input({ status: "in_progress" }) }, "user");
 await runtime.board.saveTask({ task: input({ parent: "T1", status: "in_progress" }) }, "user");
 await runtime.harness.commit(async tx => {
  const s = await tx.doc(BoardDoc, runtime.conversation.id) as BoardState;
  activityTracking(s, "T2").sources.fern = { actor: { id: "fern", kind: "worker", name: "fern", threadId: "main", conversationId: 2, runId: "run" }, state: "running", since: at(2), title: "Photos" };
 }, BACKGROUND_CONTEXT);
 clock(2 * TASK_PAUSED_MS); await runtime.board.checkPaused();
 expect((await runtime.board.get()).tasks[0]!.state!.kind).toBe("working");
 expect((await runtime.board.state()).taskActivity?.T1?.pauseNudgedEpisode).toBeUndefined();
 expect((await runtime.board.state()).pausedNotices ?? []).toEqual([]);
 await runtime.harness.commit(async tx => {
  const s = await tx.doc(BoardDoc, runtime.conversation.id) as BoardState;
  endActivitySource(activityTracking(s, "T2"), "fern", at(2 * TASK_PAUSED_MS));
 }, BACKGROUND_CONTEXT);
 await runtime.board.checkPaused();
 expect((await runtime.board.get()).tasks[0]!.state!.kind).toBe("paused");
 expect((await runtime.board.state()).taskActivity!.T1!.pauseNudgedEpisode).toBeDefined();
}, 20_000);

it("lifts nested attention by urgency without changing the part state or stored question", () => {
 const state = { ...emptyBoardState(), taskStateEnabled: true, taskPartStatesEnabled: true };
 add(state, { title: "Ship the boxes", status: "in_progress" });
 add(state, { title: "Pack boxes", parent: "T1" });
 add(state, { title: "Choose a label", parent: "T2" });
 add(state, { title: "Print the inserts", parent: "T1" });
 const board = () => boardView(state, START + 100, false, undefined, true);
 const steps = (taskId: string) => writeReport(state, { taskId, by: HARNESS_WRITER, now: at(), sections: { steps: "1. Approve the proof." } });
 steps("T3"); steps("T4");
 const withSteps = board();
 expect(withSteps.tasks[0]?.state).toMatchObject({ kind: "steps_needed", fromPartId: "T3", fromPartTitle: "Choose a label" });
 expect(withSteps.tasks[1]?.state).toMatchObject({ kind: "todo" });
 expect(withSteps.tasks[2]).toMatchObject({ requestId: "T1", state: { kind: "steps_needed" } });
 expect(withSteps.tasks[2]?.state?.fromPartId).toBeUndefined();
 expect(boardAttention(withSteps)).toMatchObject({ stepsTasks: 1, stepsTaskId: "T3", reviewTasks: 0 });
 expect(boardAttention(boardView(state, START + 100, false))).toMatchObject({ stepsTasks: 1, stepsTaskId: "T3" });

 askQuestion(state, { taskId: "T3", text: "Which label?", options: [], now: at() });
 expect(board().tasks[0]?.state).toMatchObject({ kind: "answer_needed", refs: ["Q1"], fromPartId: "T3" });
 expect(board().questions[0]).toMatchObject({ taskId: "T3", requestId: "T1" });
 expect(boardAttention(board())).toMatchObject({ questions: 1, questionTaskId: "T3", stepsTasks: 0 });
 expect(state.questions[0]?.requestId).toBeUndefined();
 expect(state.tasks[2]?.requestId).toBeUndefined();

 const failed = source(state, "failed");
 delete state.taskActivity!.T1;
 activityTracking(state, "T4").sources[failed.actor.id] = failed;
 expect(board().tasks[0]?.state).toMatchObject({ kind: "failed", fromPartId: "T4", refs: [failed.actor.id] });
 delete state.taskActivity!.T4;
 update(state, "T4", { status: "blocked", blockedReason: "The printer broke." }, "user");
 expect(board().tasks[0]?.state).toMatchObject({ kind: "failed", fromPartId: "T4" });
});

it("lifts owner-waiting warnings but not clarifications or review on a part", () => {
 const state = { ...emptyBoardState(), taskStateEnabled: true };
 add(state, { status: "review" }); add(state, { parent: "T1", status: "review" });
 const view = () => boardView(state, START, false, undefined, true);
 expect(view().tasks[0]?.state).toMatchObject({ kind: "review" });
 expect(boardAttention(view())).toMatchObject({ reviewTasks: 1, reviewTaskId: "T1" });
 askQuestion(state, { taskId: "T2", text: "The proof is old.", kind: "warning", options: [], now: at() });
 expect(view().tasks[0]?.state).toMatchObject({ kind: "answer_needed", fromPartId: "T2", refs: ["Q1"] });
 expect(view().tasks[1]?.state).toMatchObject({ kind: "review" });
 expect(boardAttention(view())).toMatchObject({ reviewTasks: 0, warnings: 1, warningTaskId: "T2" });
 state.questions[0]!.waitingOn = "agent";
 expect(view().tasks[0]?.state).toMatchObject({ kind: "review" });
 expect(boardAttention(view())).toMatchObject({ reviewTasks: 1, warnings: 0 });
});

it("live descendants suppress request steps but their questions and warnings still rise", () => {
 const s = { ...emptyBoardState(), taskStateEnabled: true };
 add(s, { status: "review" });
 add(s, { parent: "T1", status: "waiting", waitingFor: "The shop" });
 add(s, { parent: "T2" });
 add(s, { parent: "T1" });
 s.tasks[1]!.status = "waiting"; // Preserve a stored wait while a descendant runs.
 const run = source(s, "running", "print-run", "T3");
 writeReport(s, { taskId: "T4", sections: { steps: "Print the old draft." }, by: HARNESS_WRITER, now: at() });
 const view = () => boardView(s, START + TASK_PAUSED_MS, false, undefined, true);
 expect(view().tasks[0]?.state).toMatchObject({ kind: "working", refs: ["T2"], liveWorkSince: at(2) });
 expect(boardAttention(view())).toMatchObject({ stepsTasks: 0, waitingTasks: 0, reviewTasks: 0 });
 askQuestion(s, { taskId: "T3", kind: "warning", text: "The printer may be late.", options: [], now: at(3) });
 expect(view().tasks[0]?.state).toMatchObject({ kind: "answer_needed", fromPartId: "T3", liveWorkSince: at(2) });
 expect(boardAttention(view())).toMatchObject({ warnings: 1, stepsTasks: 0, waitingTasks: 0 });
 askQuestion(s, { taskId: "T3", text: "Which printer?", options: [], now: at(4) });
 expect(view().tasks[0]?.state).toMatchObject({ kind: "answer_needed", refs: ["Q2"], fromPartId: "T3", liveWorkSince: at(2) });
 expect(view().tasks[2]?.state).toMatchObject({ kind: "answer_needed", liveWorkSince: at(2) });
 s.questions.forEach(question => { question.waitingOn = "agent"; });
 endActivitySource(activityTracking(s, "T3"), run.actor.id, at(5));
 expect(view().tasks[0]?.state).toMatchObject({ kind: "steps_needed", fromPartId: "T4" });
 expect(view().tasks[0]?.state?.liveWorkSince).toBeUndefined();
 expect(boardAttention(view())).toMatchObject({ stepsTasks: 1, waitingTasks: 1 });
});

it("a missing parent or a cycle cannot provide a top request", () => {
 const tasks = new Map([["T1", { id: "T1", parent: "T2" }], ["T2", { id: "T2", parent: "T1" }]]);
 expect(topRequest(tasks.get("T1")!, tasks)).toBeUndefined();
 tasks.delete("T2");
 expect(topRequest(tasks.get("T1")!, tasks)).toBeUndefined();
});

it.each([[true, true], [true, false], [false, true]])("gates request attention (server %s, client %s) without changing the durable board", async (serverEnabled, clientEnabled) => {
 const project = await integration(HARNESS_FEATURES.filter(feature => serverEnabled || feature !== "request-attention"), clientEnabled ? ["request-attention"] : undefined);
 const enabled = serverEnabled && clientEnabled;
 const { client, projectId, runtime, hello } = project;
 if (hello.type !== "hello") throw errorOf(hello);
 expect(hello.features?.includes("request-attention")).toBe(serverEnabled);
 expect(LEGACY_HARNESS_FEATURES).not.toContain("request-attention");
 const previousBoard = defineDoc<Omit<BoardState, "tasks" | "questions"> & {
  tasks: Omit<BoardState["tasks"][number], "requestId">[];
  questions: Omit<BoardState["questions"][number], "requestId">[];
 }>({ ...BoardDoc.definition, scope: "conversation", history: "latest", fork: "initial" });
 await runtime.harness.commit(async tx => {
  const state = await tx.doc(BoardDoc, runtime.conversation.id) as BoardState;
  add(state, { title: "Ship the boxes" }); add(state, { title: "Pack boxes", parent: "T1" });
  add(state, { title: "Pick labels", parent: "T2" });
  askQuestion(state, { taskId: "T3", text: "Which label?", options: [], now: at() });
 }, BACKGROUND_CONTEXT);
 const result = await client.request({ type: "board.get", projectId });
 if (result.type !== "board.get") throw errorOf(result);
 expect(result.board.tasks[0]?.state?.kind).toBe(enabled ? "answer_needed" : "todo");
 expect(result.board.tasks[0]?.state?.fromPartId).toBe(enabled ? "T3" : undefined);
 expect(result.board.tasks[2]?.requestId).toBe(enabled ? "T1" : undefined);
 expect(result.board.questions[0]?.requestId).toBe(enabled ? "T1" : undefined);
 const watched = await client.waitFor(message => message.type === "board.state" && message.projectId === projectId && message.board.questions.some(question => question.id === "Q1"));
 if (watched.type !== "board.state") throw errorOf(watched);
 expect(watched.board.tasks[0]?.state?.fromPartId).toBe(enabled ? "T3" : undefined);
 expect(watched.board.questions[0]?.requestId).toBe(enabled ? "T1" : undefined);
 const old = await runtime.harness.snapshot(previousBoard, runtime.conversation.id, BACKGROUND_CONTEXT);
 expect(old?.questions[0]).toMatchObject({ taskId: "T3", text: "Which label?" });
 expect(old?.tasks[2]).toMatchObject({ parent: "T2", status: "todo" });
 expect(JSON.stringify(old)).not.toMatch(/"(?:requestId|fromPartId|fromPartTitle)":/);
 const [shown] = await runBoardTool(project, { action: "show_task", id: "T3" });
 expect(shown?.text).toContain('\nRequest: T1 "Ship the boxes"\n');
});

it("records a schedule run's Results on a part without putting it up for review", () => {
 const state = emptyBoardState();
 add(state, { status: "in_progress" }); add(state, { parent: "T1", status: "in_progress" });
 state.tasks[1]!.scheduleId = "packing";
 const change = recordScheduledReport(state, { key: "record-packing", scheduleId: "packing", taskId: "T2", workerId: "packer", text: "Boxes packed.", now: at() });
 expect(change?.after.status).toBe("in_progress");
 expect(change?.after.report.results).toContain("Boxes packed.");
});

it("projects live parts, drops and reports on the request without touching evidence storage", async () => {
 const features = ["request-digest", "task-steps"];
 const project = await integration(undefined, features);
 const { setup, client, runtime, projectId, hello } = project;
 const legacy = await TestClient.open(setup.server); cleanups.push(async () => legacy.close()); await legacy.hello();
 expect(hello.type === "hello" && hello.features).toContain("request-digest");
 expect(LEGACY_HARNESS_FEATURES).not.toContain("request-digest");
 const oldBoard = defineDoc<Omit<BoardState, "taskClosures" | "tasks"> & {
  tasks: Omit<BoardTask, "partsDigest" | "derivedNotDone">[];
 }>({ ...BoardDoc.definition, scope: "conversation", history: "latest", fork: "initial" });
 const artifacts = spyOn(setup.server.artifacts, "listTaskEvidence");
 const catalogue = spyOn(setup.server.artifacts, "libraryRows");
 const snapshot = spyOn(runtime.harness, "snapshot");
 try {
  await runtime.harness.commit(async tx => {
   const state = await tx.doc(BoardDoc, runtime.conversation.id) as BoardState;
   add(state, { title: "Ship the boxes" });
   const packing = add(state, { title: "Pack the boxes", parent: "T1", status: "in_progress" });
   source(state, "running", "packing-run", packing.id);
   const nested = add(state, { title: "Print labels", parent: "T2" });
   add(state, { title: "Order cartons", parent: "T1" });
   const drop = add(state, { title: "Print flyers", parent: "T1" });
   add(state, { title: "Arrange pickup", parent: "T1" });
   add(state, { title: "Offer gift wrap", foundWhile: "T1" });
   add(state, { title: "Order stickers", parent: "T2", status: "dropped" });
   writeReport(state, { taskId: "T1", by: HARNESS_WRITER, now: at(), sections: { notDone: "No weekend pickup." } });
   writeReport(state, { taskId: "T2", by: HARNESS_WRITER, now: at(), sections: { results: "\n- Packed the samples.\nMore detail.", checks: [{ name: "Seal", result: "failed", count: 5 }] } });
   writeReport(state, { taskId: "T3", by: HARNESS_WRITER, now: at(), sections: { summary: "  Labels fit.\nAnother detail.", results: "Should not be the summary.", checks: [{ name: "Fit", result: "passed", count: 12 }] }, blocks: { notDone: [{ kind: "risk", title: "Colors", text: "No color printing." }] } });
   writeReport(state, { taskId: "T6", by: HARNESS_WRITER, now: at(), sections: { steps: "1. Choose a pickup time." } });
   update(state, nested.id, { status: "done" });
   const checked = state.tasks.find(task => task.id === nested.id)!;
   saveTask(state, { taskId: nested.id, expectedRevision: checked.revision, task: { ...checked, title: "Print shipping labels" }, author: "user", now: at(20) });
   state.tasks.find(task => task.id === nested.id)!.archived = true;
   update(state, "T4", { status: "done" }, "user");
   saveTask(state, { taskId: drop.id, expectedRevision: drop.revision, task: { ...drop, status: "dropped" }, author: "coordinator", now: at(15), reason: "The boxes already have inserts." });
   state.tasks.find(task => task.id === "T4")!.order = 0;
  }, BACKGROUND_CONTEXT);
  const requestChanged = (message: import("@kemiri/protocol").ServerMessage) => message.type === "board.state" && message.board.tasks.some(task => task.id === "T8");
  const pushed = await client.waitFor(requestChanged);
  const legacyPush = await legacy.waitFor(requestChanged);
  const read = await client.request({ type: "board.get", projectId });
  if (pushed.type !== "board.state" || legacyPush.type !== "board.state" || read.type !== "board.get") throw Error("Expected board views");
  expect(artifacts).not.toHaveBeenCalled();
  expect(catalogue).not.toHaveBeenCalled();
  expect(snapshot.mock.calls.some(([token]) => Object.is(token, TaskHistoryDoc))).toBe(false);
  const request = read.board.tasks.find(task => task.id === "T1")!;
  expect(request.partsDigest).toMatchObject({ done: 1, total: 3, working: 1, needsOwner: 1, parts: [
   { id: "T4", parentId: "T1", state: "done", closedBy: "user", closedAt: at(10) },
   { id: "T2", parentId: "T1", state: "working", summary: "Packed the samples.", checks: { passed: 0, failed: 1, total: 1 }, notDoneCount: 0 },
   { id: "T3", parentId: "T2", state: "done", title: "Print shipping labels", summary: "Labels fit.", checks: { passed: 1, failed: 0, total: 1 }, notDoneCount: 1, closedBy: "coordinator", closedAt: at(10) },
   { id: "T8", parentId: "T2", state: "dropped", closedBy: "user" },
   { id: "T5", parentId: "T1", state: "dropped", closedBy: "coordinator", dropReason: "The boxes already have inserts." },
   { id: "T6", parentId: "T1", state: "steps_needed" },
  ] });
  expect(read.board.tasks.some(task => task.id === "T3")).toBe(false);
  expect(read.board.tasks.filter(task => task.partsDigest).map(task => task.id)).toEqual(["T1"]);
  expect(pushed.board.tasks.find(task => task.id === "T1")?.partsDigest).toEqual(request.partsDigest);
  expect(legacyPush.board.tasks.every(task => !task.partsDigest && !task.derivedNotDone)).toBe(true);
  expect(request.derivedNotDone).toEqual([
   { partId: "T8", text: "Order stickers was dropped: No reason recorded." },
   { partId: "T5", text: "Print flyers was dropped: The boxes already have inserts." },
  ]);
  expect(request.report.notDone).toBe("No weekend pickup.");
  const old = await runtime.harness.snapshot(oldBoard, runtime.conversation.id, BACKGROUND_CONTEXT);
  expect(old?.tasks[0]?.report.notDone).toBe("No weekend pickup.");
  expect(JSON.stringify(old?.tasks)).not.toMatch(/"(?:partsDigest|derivedNotDone)":/);
  const [shown] = await runBoardTool(project, { action: "show_task", id: "T1" });
  expect(shown?.text).toContain("Parts digest (1/3 done):");
  expect(shown?.text).toContain("T3 (part of T2) [done] Labels fit. · 1/1 checks passed");
  expect(shown?.text).toContain("T2 [working] Packed the samples. · 0/1 checks passed, 1 failed");
  expect(shown?.text).toContain("No weekend pickup.\n- Order stickers was dropped: No reason recorded.\n- Print flyers was dropped: The boxes already have inserts.");
 } finally {
  artifacts.mockRestore(); catalogue.mockRestore(); snapshot.mockRestore();
 }
}, 20_000);

it.each([true, false])("task media gathers part proof only for a negotiated feature (server %s)", async serverEnabled => {
 const { setup, client, runtime, projectId, hello } = await integration(HARNESS_FEATURES.filter(feature => serverEnabled || feature !== "request-digest"), ["request-digest"]);
 const legacy = await TestClient.open(setup.server); cleanups.push(async () => legacy.close()); await legacy.hello();
 expect(hello.type === "hello" && hello.features?.includes("request-digest")).toBe(serverEnabled);
 await runtime.harness.commit(async tx => {
  const state = await tx.doc(BoardDoc, runtime.conversation.id) as BoardState;
  add(state); add(state, { parent: "T1" }); add(state, { parent: "T2" }); add(state, { foundWhile: "T1" });
 }, BACKGROUND_CONTEXT);
 const read = await client.request({ type: "board.get", projectId });
 expect(read.type === "board.get" && !!read.board.tasks[0]?.partsDigest).toBe(serverEnabled);
 const save = async (taskId: string, name: string, continueArtifactId?: string) => {
  const sourcePath = join(setup.projectDir, name);
  await Bun.write(sourcePath, "Synthetic proof");
  return setup.server.artifacts.save({ projectId, taskId, sourcePath, threadId: "main", workerId: null, ...(continueArtifactId ? { continueArtifactId } : {}) });
 };
 const own = await save("T1", "samples.txt");
 const image = await save("T2", "labels.png");
 await save("T2", "labels.png"); // A version, not a second proof file.
 const video = await save("T2", "labels.webm");
 const html = await save("T3", "report.html");
 const nested = await save("T3", "details.txt");
 await save("T3", "samples.txt", own.id); // The request and a part share one stable artifact.
 await save("T4", "unrelated.txt");
 const request = { type: "artifacts.list", projectId, taskId: "T1" } as const;
 const before = await legacy.request(request);
 if (before.type !== "artifacts.list") throw errorOf(before);
 expect(before.artifacts.map(({ id, partIds }) => ({ id, partIds }))).toEqual([{ id: own.id, partIds: undefined }]);
 expect(before.partProof).toBeUndefined();
 const after = await client.request(request);
 if (after.type !== "artifacts.list") throw errorOf(after);
 if (!serverEnabled) {
  expect(after.artifacts).toEqual(before.artifacts);
  expect(after.partProof).toBeUndefined();
 } else {
  expect(after.artifacts.map(({ id, partIds }) => [id, partIds]).sort()).toEqual([
   [own.id, ["T3"]], [image.id, ["T2"]], [video.id, ["T2"]], [html.id, ["T3"]], [nested.id, ["T3"]],
  ].sort());
  expect(after.partProof).toEqual([
   { partId: "T2", images: 1, videos: 1, html: 0, files: 0 },
   { partId: "T3", images: 0, videos: 0, html: 1, files: 2 },
  ]);
  expect(await client.request({ ...request, limit: 1 })).toMatchObject({ partProof: after.partProof });
  const part = await client.request({ ...request, taskId: "T2" });
  expect(part).toMatchObject({ artifacts: [expect.objectContaining({ id: video.id }), expect.objectContaining({ id: image.id })] });
  expect(part.type === "artifacts.list" && part.partProof).toBeUndefined();
 }
}, 20_000);
