import { afterEach, expect, it } from "bun:test";
import type { BoardTask, BoardTaskInput } from "@kemiri/protocol";
import { HARNESS_FEATURES, LEGACY_HARNESS_FEATURES } from "../../protocol/src/projects.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BoardDoc, askQuestion, boardView, changeLink, claimTaskForThread, emptyBoardState, migrateTaskStates, moveTaskForWorker, saveTask, unblockedBy, type BoardState } from "../src/board.ts";
import { activityTracking, endActivitySource, taskState, TASK_PAUSED_MS, type TaskActivitySource } from "../src/task-activity.ts";
import { createSetup, entryText, errorOf, TestClient, ViewClient } from "./support.ts";

const START = Date.parse("2026-11-12T12:00:00.000Z");
const at = (ms = 0) => new Date(START + ms).toISOString();
const input = (extra: Partial<BoardTaskInput> = {}): BoardTaskInput => ({ title: "Synthetic task", description: "Keep this description", acceptance: null, status: "todo", blockedBy: [], blockedReason: null, writeScopes: [], ...extra });
function add(state: BoardState, extra: Partial<BoardTaskInput> = {}) { return saveTask(state, { task: input(extra), author: "user", now: at() }).after; }
function update(state: BoardState, id: string, extra: Partial<BoardTaskInput>, author: "user" | "coordinator" = "coordinator", openParts?: "close" | "follow_up") {
 const task = state.tasks.find(t => t.id === id)!;
 return saveTask(state, { taskId: id, expectedRevision: task.revision, task: { ...task, ...extra }, author, now: at(10), openParts });
}
function source(state: BoardState, status: TaskActivitySource["state"] = "running", id = "run-1") {
 const run: TaskActivitySource = { actor: { id, kind: "worker", name: "fern", threadId: "main", conversationId: 2, runId: id }, state: status, since: at(2), title: "Synthetic task" };
 activityTracking(state, "T1").sources[id] = run; return run;
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
 update(s, "T2", { status: "review" }); update(s, "T3", { status: "waiting", waitingFor: "Reply" }); update(s, "T1", { status, waitingFor: "Reply" });
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
async function integration() {
 let now = START;
 const setup = await createSetup({ now: () => now, boardEditDebounceMs: 60_000 }); cleanups.push(setup.cleanup);
 setup.faux.setResponses(Array.from({ length: 30 }, () => () => fauxAssistantMessage("Noted.")));
 const client = await TestClient.open(setup.server); cleanups.push(async () => client.close()); await client.hello();
 const added = await client.request({ type: "projects.add", path: setup.projectDir }); if (added.type !== "projects.add") throw errorOf(added);
 const configured = await client.request({ type: "projects.configure", projectId: added.project.id, coordinatorModel: { provider: "faux", modelId: "faux-1" } }); if (configured.type !== "projects.configure") throw errorOf(configured);
 const { runtime } = await setup.server.manager.open(added.project.id);
 return { setup, client, runtime, projectId: added.project.id, clock: (ms: number) => { now = START + ms; } };
}

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
 expect(board.tasks[0]!.state).toEqual({ group: "in_progress", kind: "working", since: at(2), refs: ["T3"], sentence: { kind: "working", text: "1 of 3 parts done · 1 working", since: at(2), refs: ["T3"], ageFormat: "none" } });
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

it.each(["failed", "answer_needed", "review", "blocked_by_task", "waiting_outside", "done"] as const)("parent's own %s is not replaced by parts", kind => {
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
 expect(parent.state!.kind).toBe(kind);
 expect(parent.activity!.text).not.toContain("parts done");
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
