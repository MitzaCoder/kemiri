import { afterEach, expect, it, spyOn } from "bun:test";
import type { BoardActivityActor, BoardTask } from "@kemiri/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { HARNESS_FEATURES, LEGACY_HARNESS_FEATURES } from "../../protocol/src/projects.ts";
import { activityTracking, endActivitySource, setActivityPhase, taskActivity, type TaskActivitySource } from "../src/task-activity.ts";
import { BoardDoc, addSnapshot, askQuestion, boardView, changeOwner, coordinatorWriter, emptyBoardState, foldTaskLiveIn, normalizeBoard, recordFeedback, saveTask, setFeedbackState, settleQuestion, workerWriter, writeReport, writeReportIn, type BoardState } from "../src/board.ts";
import { syncWorkerActivity, syncWorkerActivityRun, WorkersDoc, workerInstructions, coordinatorSection, threadCoordinatorSection, type WorkerRecord } from "../src/workers.ts";
import { threadInstructions } from "../src/threads.ts";
import { createSetup, errorOf, TestClient } from "./support.ts";

const START = Date.parse("2026-11-12T12:00:00.000Z");
const at = (ms = 0) => new Date(START + ms).toISOString();
function fixture(status: BoardTask["status"] = "in_progress") {
 const state = emptyBoardState(); state.taskActivityEnabled = true;
 saveTask(state, { task: { title: "Card view", description: "", acceptance: null, status, blockedBy: [], blockedReason: null, writeScopes: [], ...(status === "waiting" ? { waitingFor: "external review" } : {}) }, author: "user", now: at() });
 return state;
}
function source(name = "fern", since = at(1), threadId = "main", conversationId = 2): TaskActivitySource {
 const actor: BoardActivityActor = { id: `${threadId}:${conversationId}:run-1`, kind: "worker", name, threadId, conversationId, runId: "run-1" };
 return { actor, state: "running", title: "Card view", since };
}
function add(state: BoardState, source: TaskActivitySource, taskId = "T1") { activityTracking(state, taskId).sources[source.actor.id] = source; return source; }
function activity(state: BoardState, ms = 10) { return taskActivity(state.tasks[0]!, state.questions, state.tasks, state.taskActivity?.T1, START + ms); }

it("advertises activity explicitly, never on legacy backends", () => {
 expect(HARNESS_FEATURES).toContain("task-activity"); expect(LEGACY_HARNESS_FEATURES).not.toContain("task-activity");
});

it.each([
 ["failure", "failure"], ["question", "question"], ["deploy", "deploy"], ["working", "working"], ["feedback", "feedback"], ["blocked", "blocked"], ["delivery", "delivery"], ["idle", "idle"],
] as const)("precedence: %s is the first matching rule", (highest, expected) => {
 const state = fixture(); const tracking = activityTracking(state, "T1");
 if (["failure"].includes(highest)) add(state, { ...source("moss", at(1), "other", 3), state: "failed", failure: "verification failed" });
 if (["failure", "question"].includes(highest)) askQuestion(state, { text: "Choose?", options: [], taskId: "T1", now: at(1) });
 if (["failure", "question", "deploy"].includes(highest)) tracking.deploy = { state: "active", text: "Deploy queued", since: at(2), refs: ["attempt-1"] };
 if (["failure", "question", "deploy", "working"].includes(highest)) add(state, source());
 if (["failure", "question", "deploy", "working", "feedback"].includes(highest)) tracking.feedback = [{ id: "F8", at: at(3) }];
 if (["failure", "question", "deploy", "working", "feedback", "blocked"].includes(highest)) state.tasks[0]!.blockedBy = ["T42"];
 if (highest !== "idle") tracking.delivery = { text: "3 changes landed on main", at: at(), count: 3, refs: ["commit-1"] };
 expect(activity(state).kind).toBe(expected);
});

it("two workers: latest real phase wins, stable IDs break ties, failure dominates, stop clears only itself", () => {
 const state = fixture(); const fern = add(state, source()); const moss = add(state, source("moss", at(1), "other", 3));
 expect(activity(state).text).toBe("fern is working on Card view · +1 worker");
 const tracking = activityTracking(state, "T1");
 setActivityPhase(tracking, moss.actor.id, "testing the card view", at(2));
 expect(activity(state)).toMatchObject({ text: "moss is testing the card view · +1 worker", since: at(2), actor: moss.actor });
 setActivityPhase(tracking, moss.actor.id, "testing the card view", at(8));
 expect(activity(state).since).toBe(at(2));
 fern.state = "failed"; fern.failure = "check failed"; fern.since = at(3);
 expect(activity(state)).toMatchObject({ kind: "failure", text: "fern failed: check failed" });
 endActivitySource(tracking, moss.actor.id, at(4));
 expect(activity(state).kind).toBe("failure");
 fern.state = "ended";
 expect(activity(state)).toMatchObject({ kind: "idle", since: at(4) });
});

it("blocking questions count only live workers; answering and withdrawing clear the wait immediately", () => {
 const state = fixture(); add(state, source()); add(state, source("moss", at(1), "other", 3));
 askQuestion(state, { text: "Nonblocking", options: [], taskId: "T1", now: at(1), blocksWork: false });
 askQuestion(state, { text: "Warning", options: [], taskId: "T1", now: at(1), kind: "warning" });
 const q = askQuestion(state, { text: "Choose", options: [], taskId: "T1", now: at(2) });
 const q2 = askQuestion(state, { text: "Choose again", options: [], taskId: "T1", now: at(3) });
 expect(activity(state).text).toBe("Waiting for your answer to Q3 and 1 more · 2 workers still running");
 settleQuestion(state, { questionId: q.id, answer: "Yes", now: at(4) });
 expect(activity(state).text).toBe("Waiting for your answer to Q4 · 2 workers still running");
 settleQuestion(state, { questionId: q2.id, answer: null, now: at(5) });
 expect(activity(state).kind).toBe("working");
});

it("only a linked warning acknowledgement clears a failure", () => {
 const state = fixture(); const worker = add(state, { ...source(), state: "failed" });
 const unrelated = askQuestion(state, { text: "Unrelated", options: [], taskId: "T1", kind: "warning", now: at(1) });
 settleQuestion(state, { questionId: unrelated.id, answer: "Seen", now: at(2) }); expect(activity(state).kind).toBe("failure");
 const linked = askQuestion(state, { text: "Failure", options: [], taskId: "T1", kind: "warning", activitySourceId: worker.actor.id, now: at(3) });
 settleQuestion(state, { questionId: linked.id, answer: "Seen", now: at(4) }); expect(activity(state).kind).toBe("idle");
});

it.each(["done", "dropped"] as const)("%s ignores lingering work, keeps failures and recent deliveries", status => {
 const state = fixture(status); add(state, source());
 expect(activity(state)).toMatchObject({ kind: status, since: at() });
 activityTracking(state, "T1").delivery = { text: "3 changes landed on main", at: at(2), refs: ["commit-1"], count: 3 };
 expect(activity(state).kind).toBe("delivery");
 add(state, { ...source("moss", at(4), "other", 3), state: "failed" }); expect(activity(state).kind).toBe("failure");
});

it.each(["todo", "waiting", "review", "blocked", "in_progress"] as const)("%s fallback has a stable since, not an age", status => {
 const state = fixture(status); const before = JSON.stringify(state);
 expect(activity(state).kind).toBe(({ todo: "not_started", waiting: "waiting", review: "review", blocked: "blocked", in_progress: "idle" } as const)[status]);
 expect(activity(state, 60_000)).toEqual(activity(state)); expect(JSON.stringify(state)).toBe(before);
});

it("24-hour delivery expires without a write and never implies deployment", () => {
 const state = fixture(); activityTracking(state, "T1").delivery = { text: "3 changes landed on main", at: at(), count: 3, refs: ["commit-1"] };
 const before = JSON.stringify(state);
 expect(activity(state, 86_399_999)).toMatchObject({ kind: "delivery", text: "3 changes landed on main", since: at() });
 expect(activity(state, 86_400_000).kind).toBe("idle"); expect(JSON.stringify(state)).toBe(before);
});

it("legacy Now is history only; canonical mirror never refreshes prose metadata, and phase changes add no history", () => {
 const state = fixture(); const task = state.tasks[0]!;
 task.report.now = "Old stale prose";
 const history = { snapshots: [], keys: [] };
 addSnapshot(history, task, { label: "Old snapshot", by: coordinatorWriter("main"), at: at() });
 normalizeBoard(state); expect(boardView(state, START, true).tasks[0]!.report.now).toBe("Idle");
 expect(history.snapshots[0]).toMatchObject({ report: { now: "Old stale prose" } });
 writeReport(state, { taskId: "T1", sections: { results: "Tests pass", next: "Review" }, by: coordinatorWriter("main"), now: at(1) });
 const report = structuredClone(task.report); const timeline = task.timelineRevision; const seq = task.eventSeq;
 const worker = add(state, source());
 writeReport(state, { taskId: "T1", sections: { now: "testing" }, by: workerWriter("main", "fern"), now: at(2) });
 const mirrored = boardView(state, START + 3, true).tasks[0]!;
 expect(mirrored.report.now).toBe("fern is testing"); expect(mirrored.report.now).toBe(mirrored.activity!.text);
 for (const field of ["updatedAt", "updatedBy", "revision", "freshness", "results", "next"] as const) expect(task.report[field]).toEqual(report[field]);
 expect(task.timelineRevision).toBe(timeline); expect(task.eventSeq).toBe(seq); expect(history.snapshots).toHaveLength(1);
 endActivitySource(activityTracking(state, "T1"), worker.actor.id, at(4));
 expect(activity(state).text).toBe("Idle");
});

it("unhandled feedback clears as soon as the coordinator handles it", () => {
 const state = fixture(); const history = { snapshots: [], keys: [] };
 const f = recordFeedback(state, history, { taskId: "T1", text: "Please check", images: 0, threadId: "main", key: "feedback-1", now: at(1) });
 expect(activity(state).text).toBe("Feedback F1 is waiting for the coordinator");
 setFeedbackState(state, history, { taskId: "T1", feedbackId: f.id, state: "handling", note: null, by: coordinatorWriter("main"), now: at(2) });
 expect(activity(state).kind).toBe("idle");
});

it("ownership alone is not activity, and release leaves another source working", () => {
 const state = fixture(); const task = state.tasks[0]!;
 changeOwner(state, { taskId: task.id, expectedRevision: task.revision, change: { kind: "claim", threadId: "thread-a" }, now: at(1) });
 expect(activity(state).kind).toBe("idle");
 const coordinator = add(state, { ...source("thread-a", at(2), "thread-a", 3), actor: { ...source("thread-a", at(2), "thread-a", 3).actor, kind: "thread" } });
 add(state, source());
 changeOwner(state, { taskId: task.id, expectedRevision: task.revision, change: { kind: "release", threadId: "thread-a" }, now: at(3) });
 expect(coordinator.state).toBe("ended"); expect(activity(state).text).toBe("fern is working on Card view");
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function integration(taskLiveEnabled = true) {
 const features = HARNESS_FEATURES.filter(feature => taskLiveEnabled || feature !== "task-live");
 const setup = await createSetup({ features, now: () => START, boardEditDebounceMs: 60_000 }); cleanups.push(setup.cleanup);
 const client = await TestClient.open(setup.server); cleanups.push(async () => client.close()); await client.hello();
 const added = await client.request({ type: "projects.add", path: setup.projectDir }); if (added.type !== "projects.add") throw errorOf(added);
 const configured = await client.request({ type: "projects.configure", projectId: added.project.id, coordinatorModel: { provider: "faux", modelId: "faux-1" } }); if (configured.type !== "projects.configure") throw errorOf(configured);
 const { runtime } = await setup.server.manager.open(added.project.id);
 await runtime.harness.commit(async tx => { const state = await tx.doc(BoardDoc, runtime.conversation.id); const seed = fixture(); Object.assign(state, seed); }, BACKGROUND_CONTEXT);
 return { setup, runtime, projectId: added.project.id };
}

it("reconciles ended and unreachable sources after restart, without inferring legacy phases", async () => {
 const { setup, runtime, projectId } = await integration();
 await runtime.harness.commit(async tx => {
  const state = await tx.doc(BoardDoc, runtime.conversation.id) as BoardState;
  add(state, source("fern", at(), "main", runtime.conversation.id));
  add(state, source("moss", at(), "other", 999999));
  state.tasks[0]!.report.now = "Old working claim";
 }, BACKGROUND_CONTEXT);
 await setup.restart(); const reopened = (await setup.server.manager.open(projectId)).runtime;
 expect((await reopened.board.get()).tasks[0]!.activity).toMatchObject({ kind: "unknown", text: "Status unknown" });
 const tracking = (await reopened.board.state()).taskActivity!.T1!;
 expect(Object.values(tracking.sources).find(s => s.actor.name === "fern")!.state).toBe("ended");
 expect(Object.values(tracking.sources).every(s => s.phase === undefined)).toBe(true);
}, 15_000);

it("worker retries use thread/conversation/run identity; phases expire and another worker's failure stays", async () => {
 const { runtime } = await integration();
 const record = (id: string, conversationId: number): WorkerRecord => ({ id, title: "Card view", conversationId, isolation: "shared", workspacePath: null, model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: null, status: "running", taskId: "T1", spawnedByCallId: null, createdAt: at(), updatedAt: at(), lastReport: null, failure: null, anchorTaskId: 1 });
 const fern = record("fern", 10), moss = record("moss", 11);
 const sync = async (worker: WorkerRecord) => runtime.harness.commit(tx => syncWorkerActivity(tx, runtime.workers, worker, runtime.conversation.id), BACKGROUND_CONTEXT);
 await sync(fern); await sync(moss);
 moss.status = "failed"; moss.failure = "checks failed"; moss.updatedAt = at(1); await sync(moss);
 fern.status = "stopped"; fern.updatedAt = at(2); await sync(fern);
 expect((await runtime.board.get()).tasks[0]!.activity!.text).toBe("moss failed: checks failed");
 fern.status = "running"; fern.updatedAt = at(3); await sync(fern);
 const tracking = (await runtime.board.state()).taskActivity!.T1!;
 expect(Object.values(tracking.sources).filter(s => s.actor.name === "fern").map(s => s.actor.runId)).toEqual([at(), at(3)]);
 expect((await runtime.board.get()).tasks[0]!.activity!.kind).toBe("failure");
 moss.status = "running"; moss.updatedAt = at(4); await sync(moss);
 expect((await runtime.board.get()).tasks[0]!.activity!.text).toBe("moss is working on Card view · +1 worker");
 fern.status = "failed"; fern.failure = "old run failed"; fern.updatedAt = at(5); await sync(fern);
 await sync({ ...fern, conversationId: 20, status: "running", activityRunId: undefined, updatedAt: at(6) });
 expect((await runtime.board.get()).tasks[0]!.activity).toMatchObject({ kind: "failure", actor: { conversationId: 10 } });
}, 15_000);

it.each([false, true])("legacy coordinator Now is a turn phase and folds only with task-live=%s", async taskLiveEnabled => {
 const { setup, runtime } = await integration(taskLiveEnabled);
 await runtime.board.saveTask({ task: { ...fixture().tasks[0]!, title: "Other task" } }, "coordinator");
 const samples: BoardTask[][] = [];
 const call = (action: string, fields: Record<string, unknown> = {}) => fauxAssistantMessage([fauxToolCall("board", { action, ...fields })], { stopReason: "toolUse" });
 setup.faux.setResponses([
  call("claim", { id: "T1", expectedRevision: 1 }), call("claim", { id: "T2", expectedRevision: 1 }),
  async () => { samples.push((await runtime.board.get()).tasks); return call("write_report", { id: "T1", results: "Synthetic checks pass" }); },
  async () => { samples.push((await runtime.board.get()).tasks); return call("write_report", { id: "T1", now: "testing the card view" }); },
  async () => { samples.push((await runtime.board.get()).tasks); return fauxAssistantMessage("Finished."); },
 ]);
 const before = await runtime.board.timeline("T1", ["worker"], true);
 const submission = await runtime.conversation.submit({ type: "input", content: "Test focused work", requestId: "focus-test" }, BACKGROUND_CONTEXT);
 await submission.wait(BACKGROUND_CONTEXT); await runtime.conversation.waitForIdle(BACKGROUND_CONTEXT); await runtime.board.reconcileActivity();
 expect(samples[0]![0]!.activity!.kind).toBe("idle"); expect(samples[0]![1]!.activity!.kind).toBe("idle");
 expect(samples[1]![0]!.activity!.kind).toBe("working"); expect(samples[1]![1]!.activity!.kind).toBe("idle");
 expect(samples[2]![0]!.activity!.text).toBe("Coordinator is testing the card view");
 expect(samples[2]![0]!.report.updatedAt).toBe(samples[1]![0]!.report.updatedAt);
 const ended = (await runtime.board.get()).tasks[0]!;
 const timeline = await runtime.board.timeline("T1", ["worker"], true);
 expect(ended.activity!.kind).toBe("idle");
 expect(ended.live).toBeUndefined();
 if (taskLiveEnabled) {
  const lines = samples[2]![0]!.live!.lines;
  expect(lines).toEqual([expect.objectContaining({ kind: "phase", text: "testing the card view", actor: expect.objectContaining({ kind: "coordinator" }) })]);
  expect(timeline.entries).toEqual([expect.objectContaining({ live: expect.objectContaining({ lines, counters: expect.objectContaining({ steps: 4 }) }) })]);
  expect(timeline.groups?.flatMap(group => group.entries)).toEqual([expect.objectContaining({ group: "work", live: expect.objectContaining({ lines }) })]);
 } else {
  expect(samples[2]![0]!.live).toBeUndefined();
  expect(timeline.entries).toEqual(before.entries);
  expect(timeline.groups).toEqual(before.groups);
 }
 expect((await runtime.board.state()).tasks[0]!.report.results).toBe("Synthetic checks pass");
}, 15_000);


it("all project prompts ask for Results/Next, automatic Now, and changed phases only", async () => {
 const { runtime } = await integration(); const project = { ...runtime.project, name: "Synthetic project", path: "." };
 const main = coordinatorSection(project), thread = threadCoordinatorSection(project);
 for (const prompt of [main, thread]) {
  expect(prompt).toContain("Now is automatic;");
  expect(prompt).not.toContain("board action `focus`");
  expect(prompt).toContain("Keep Results and Next current with `board.write_report`.");
  expect(prompt).not.toContain("keeps the task's `now` current");
 }
 const worker = workerInstructions({ id: "fern", title: "Card view", project, cwd: ".", isolation: "shared", taskId: "T1" });
 expect(worker).toContain("use `now` only when the phase changes");
 expect(worker).not.toContain("is what you are doing at this moment");
 const instructions = threadInstructions({ id: "thread-a", title: "Card view", project, checkout: ".", checkoutKind: "directory", startedBy: "main", taskId: "T1" });
 expect(instructions).toContain("keep Results and Next current"); expect(instructions).toContain("Now is automatic");
 expect(instructions).toContain("The user reads that task, not this conversation: keep Results and Next current");
}, 15_000);


it("moves, questions and decisions infer cumulative focus without claims or extra tool calls", async () => {
 const { setup, runtime } = await integration();
 for (const title of ["Review assets", "Choose policy"]) await runtime.board.saveTask({ task: { ...fixture().tasks[0]!, title } }, "coordinator");
 const samples: BoardState[] = [];
 const call = (action: string, fields: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall("board", { action, ...fields })], { stopReason: "toolUse" });
 setup.faux.setResponses([
  call("update_task", { id: "T1", expectedRevision: 1, status: "review" }),
  async () => { samples.push(await runtime.board.state()); return call("ask", { taskId: "T2", text: "Choose?", blocksWork: false }); },
  async () => { samples.push(await runtime.board.state()); return call("decide", { taskId: "T3", text: "Use synthetic evidence" }); },
  async () => { samples.push(await runtime.board.state()); return fauxAssistantMessage("Recorded."); },
 ]);
 const submission = await runtime.conversation.submit({ type: "input", content: "Act on the tasks", requestId: "inferred-actions" }, BACKGROUND_CONTEXT);
 await submission.wait(BACKGROUND_CONTEXT); await runtime.conversation.waitForIdle(BACKGROUND_CONTEXT);
 for (const [index, state] of samples.entries()) for (let task = 1; task <= 3; task++) {
  const live = Object.values(state.taskActivity?.[`T${task}`]?.sources ?? {}).some(source => source.actor.kind === "coordinator" && source.state === "running");
  expect(live).toBe(task <= index + 1);
 }
 const state = await runtime.board.state();
 expect(Object.values(state.taskActivity!).flatMap(t => Object.values(t.sources)).every(source => source.state !== "running")).toBe(true);
}, 15_000);

it("a task-scoped feedback submission infers focus before any task-writing action", async () => {
 const { setup, runtime } = await integration();
 let resolveFocus!: () => void;
 const focused = new Promise<void>(resolve => { resolveFocus = resolve; });
 const watch = await runtime.harness.watchDoc(BoardDoc, runtime.conversation.id, BACKGROUND_CONTEXT);
 if (!watch) throw new Error("Missing board");
 watch.start(async call => { if (call.kind !== "failed" && Object.values(call.value?.taskActivity?.T1?.sources ?? {}).some(source => source.actor.kind === "coordinator" && source.state === "running")) resolveFocus(); });
 setup.faux.setResponses([async () => { await focused; expect((await runtime.board.get()).tasks[0]!.activity!.kind).toBe("working"); return fauxAssistantMessage("Read."); }]);
 try {
  const submission = await runtime.conversation.submit({ type: "input", content: "[task T1, feedback F8] Please check this", requestId: "scoped-focus" }, BACKGROUND_CONTEXT);
  await submission.wait(BACKGROUND_CONTEXT); await runtime.conversation.waitForIdle(BACKGROUND_CONTEXT);
  expect((await runtime.board.get()).tasks[0]!.activity!.kind).toBe("idle");
 } finally { await watch.stop(); }
}, 15_000);

it("a thread's own task and touched tasks work this turn, not every task it holds", async () => {
 const { setup, runtime } = await integration();
 for (const title of ["Touched task", "Only held task"]) await runtime.board.saveTask({ task: { ...fixture().tasks[0]!, title } }, "coordinator");
 const samples: BoardTask[][] = [];
 let resolveSample!: () => void;
 const sampled = new Promise<void>(resolve => { resolveSample = resolve; });
 const call = (action: string, fields: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall("board", { action, ...fields })], { stopReason: "toolUse" });
 setup.faux.setResponses([
  call("claim", { id: "T2", expectedRevision: 1 }), call("claim", { id: "T3", expectedRevision: 1 }),
  async () => { samples.push((await runtime.board.get()).tasks); return call("write_report", { id: "T2", results: "Synthetic evidence checked" }); },
  async () => { samples.push((await runtime.board.get()).tasks); return call("ask", { taskId: "T2", text: "Optional review?", blocksWork: false }); },
  call("decide", { taskId: "T2", text: "Keep synthetic evidence" }),
  async () => { resolveSample(); return fauxAssistantMessage("Finished this turn."); },
 ]);
 const started = await runtime.threads.start({ id: "thread-a", title: "Card view", brief: "Check the tasks", model: null, thinkingLevel: null, onFinish: "record", startedBy: "main", scheduleId: null, taskId: "T1", key: "inferred-thread" });
 if (!started.ok) throw new Error(started.message);
 await sampled;
 const conversation = await runtime.harness.conversation(started.record.conversationId as typeof runtime.conversation.id, BACKGROUND_CONTEXT);
 await conversation!.waitForIdle(BACKGROUND_CONTEXT);
 expect(samples[0]!.map(task => task.activity!.kind)).toEqual(["working", "idle", "idle"]);
 expect(samples[1]!.map(task => task.activity!.kind)).toEqual(["working", "working", "idle"]);
 expect((await runtime.board.get()).tasks.map(task => task.activity!.kind)).toEqual(["idle", "idle", "idle"]);
}, 15_000);

it("worker requests in the same run take the read-only fast path", async () => {
 const { runtime } = await integration();
 await runtime.harness.commit(async tx => {
  const doc = await tx.doc(WorkersDoc, runtime.conversation.id);
  doc.workers.fern = { id: "fern", title: "Card view", conversationId: 10, activityRunId: "run-1", isolation: "shared", workspacePath: null, model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: null, status: "running", taskId: "T1", spawnedByCallId: null, createdAt: at(), updatedAt: at(), lastReport: null, failure: null, anchorTaskId: 1 };
  await syncWorkerActivity(tx, runtime.workers, doc.workers.fern, runtime.conversation.id);
 }, BACKGROUND_CONTEXT);
 const before = await runtime.board.state();
 const commit = spyOn(runtime.harness, "commit");
 try {
  await syncWorkerActivityRun(runtime.workers, 10, "run-1");
  await syncWorkerActivityRun(runtime.workers, 10, "run-1");
  expect(commit).not.toHaveBeenCalled();
  expect(await runtime.board.state()).toEqual(before);
  await syncWorkerActivityRun(runtime.workers, 10, "run-2");
  expect(commit).toHaveBeenCalledTimes(1);
  await syncWorkerActivityRun(runtime.workers, 10, "run-2");
  expect(commit).toHaveBeenCalledTimes(1);
 } finally { commit.mockRestore(); }
}, 15_000);


it("spawning and sending task workers infer coordinator focus in the existing action transaction", async () => {
 const { setup, runtime } = await integration();
 let releaseWorker!: () => void;
 const workerReady = new Promise<void>(resolve => { releaseWorker = resolve; });
 let finishSample!: () => void;
 const sampled = new Promise<void>(resolve => { finishSample = resolve; });
 const coordinatorSources: boolean[] = [];
 const isFocused = async () => Object.values((await runtime.board.state()).taskActivity?.T1?.sources ?? {}).some(source => source.actor.kind === "coordinator" && source.state === "running");
 setup.faux.setResponses(Array.from({ length: 15 }, () => async request => {
  if (JSON.stringify(request.messages.find(message => message.role === "system")).includes('You are the worker')) {
   await workerReady; return fauxAssistantMessage("Worker checked the evidence.");
  }
  const last = request.messages.findLast(message => message.role !== "system");
  if (last?.role === "toolResult" && last.toolName === "worker_spawn") {
   coordinatorSources.push(await isFocused());
   const state = await runtime.board.state();
   const runId = Object.values(state.taskActivity!.T1!.sources).find(source => source.actor.kind === "coordinator" && source.state === "running")!.actor.runId;
   await runtime.board.endTaskFocus(runtime.conversation.id, runId);
   return fauxAssistantMessage([fauxToolCall("worker_send", { id: "fern", message: "Check one more synthetic detail", interrupt: true })], { stopReason: "toolUse" });
  }
  if (last?.role === "toolResult" && last.toolName === "worker_send") {
   coordinatorSources.push(await isFocused()); finishSample(); releaseWorker(); return fauxAssistantMessage("Delegated.");
  }
  if (last?.role === "user" && typeof last.content === "string" && last.content === "Start the task worker") return fauxAssistantMessage([fauxToolCall("worker_spawn", { id: "fern", taskId: "T1", title: "Check card view", task: "Check synthetic evidence", model: { provider: "faux", modelId: "faux-1" } })], { stopReason: "toolUse" });
  return fauxAssistantMessage("Recorded.");
 }));
 try {
  const submission = await runtime.conversation.submit({ type: "input", content: "Start the task worker", requestId: "infer-worker-actions" }, BACKGROUND_CONTEXT);
  await sampled; await submission.wait(BACKGROUND_CONTEXT); await runtime.conversation.waitForIdle(BACKGROUND_CONTEXT);
  expect(coordinatorSources).toEqual([true, true]);
 } finally { releaseWorker(); }
}, 15_000);


it("keeps five report lines in order and folds only the ending source into one work row", async () => {
 const { runtime } = await integration();
 const main = runtime.conversation.id;
 const initialWorker: WorkerRecord = { id: "moss", title: "Card view", conversationId: 10, activityRunId: "run-1", isolation: "shared", workspacePath: null, model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: null, status: "running", taskId: "T1", spawnedByCallId: null, createdAt: at(), updatedAt: at(), lastReport: null, failure: null, anchorTaskId: 1 };
 await runtime.harness.commit(async tx => {
  const state = await tx.doc(BoardDoc, main);
  state.taskLiveEnabled = true;
  await syncWorkerActivity(tx, runtime.workers, { ...initialWorker }, main);
  add(state, source("fern", at(), "main", 11));
 }, BACKGROUND_CONTEXT);
 const read = () => runtime.board.timeline("T1", ["worker"], true);
 const write = (n: number, now?: string, addResult?: string, writer = "moss") => runtime.harness.commit(tx => writeReportIn(tx, main, { taskId: "T1", sections: { now }, addResult, by: workerWriter("main", writer) }, `call:${n}`, at(n)), BACKGROUND_CONTEXT);
 const before = await read();
 const factsBefore = await runtime.board.state();
 const snapshotsBefore = await runtime.board.history("T1");
 await write(1, "reading the inputs");
 await write(2, "  reading   the inputs  ");
 await write(3, "building the form", "The form accepts a card.");
 await write(4, "checking the balance");
 await write(5, undefined, "Partial payment works.");
 const working = (await runtime.board.get()).tasks[0]!;
 const lines = working.live!.lines;
 expect(lines.map(line => [line.kind, line.text, line.at])).toEqual([
  ["phase", "reading the inputs", at(1)], ["phase", "building the form", at(3)], ["result", "The form accepts a card.", at(3)],
  ["phase", "checking the balance", at(4)], ["result", "Partial payment works.", at(5)],
 ]);
 expect(new Set(lines.map(line => line.id)).size).toBe(5);
 expect(lines.every(line => line.actor.name === "moss")).toBe(true);
 expect(await read()).toEqual(before);
 expect(await runtime.board.history("T1")).toEqual(snapshotsBefore);
 expect(working.eventSeq).toBe(factsBefore.tasks[0]!.eventSeq);
 expect((await runtime.board.state()).pausedNotices).toEqual(factsBefore.pausedNotices);
 await write(6, "checking the labels", undefined, "fern");
 await runtime.harness.commit(tx => syncWorkerActivity(tx, runtime.workers, { ...initialWorker, status: "stopped", updatedAt: at(23 * 60_000) }, main), BACKGROUND_CONTEXT);
 const finished = await read();
 expect(finished.entries).toHaveLength(1);
 expect(finished.entries[0]).toMatchObject({ label: "moss worked 23 minutes: 3 phases, 2 results · stopped", live: { lines } });
 expect(finished.groups?.flatMap(group => group.entries)).toEqual([expect.objectContaining({ group: "work", live: { lines } })]);
 expect((await runtime.board.get()).tasks[0]!.live?.lines.map(line => line.actor.name)).toEqual(["fern"]);
 for (let n = 7; n < 45; n++) await write(n, `checking sample ${n}`, undefined, "fern");
 expect((await runtime.board.get()).tasks[0]!.live?.lines.map(line => line.text)).toEqual(Array.from({ length: 30 }, (_, n) => `checking sample ${15 + n}`));
 await runtime.board.reconcileActivity();
 expect((await runtime.board.get()).tasks[0]!.live).toBeUndefined();
}, 15_000);

it("folds a plan without trail lines and leaves report freshness alone", async () => {
 const { runtime } = await integration();
 const main = runtime.conversation.id;
 const worker = source("fern", at(1));
 await runtime.harness.commit(async tx => { add(await tx.doc(BoardDoc, main), worker); }, BACKGROUND_CONTEXT);
 const before = (await runtime.board.get()).tasks[0]!;
 await runtime.harness.commit(tx => writeReportIn(tx, main, {
  taskId: "T1", sections: {}, by: workerWriter("main", "fern"),
  planUpdate: { plan: [{ text: "Read the receipt" }, { text: "Check the balance" }, { text: "Report the result" }], tick: [1] },
 }, "demo-plan", at(2)), BACKGROUND_CONTEXT);
 const during = (await runtime.board.get()).tasks[0]!;
 expect(during.live?.lines).toEqual([]);
 expect(during.eventSeq).toBe(before.eventSeq);
 expect(during.report).toEqual(before.report);
 await runtime.harness.commit(async tx => {
  const state = await tx.doc(BoardDoc, main);
  endActivitySource(activityTracking(state, "T1"), worker.actor.id, at(60_001));
  await foldTaskLiveIn(tx, main, state, "T1", worker.actor.id, "reported", at(60_001));
 }, BACKGROUND_CONTEXT);
 expect((await runtime.board.get()).tasks[0]?.live).toBeUndefined();
 expect((await runtime.board.state()).taskActivity?.T1?.sources[worker.actor.id]?.livePlan).toBeUndefined();
 expect((await runtime.board.timeline("T1", ["worker"], true)).entries[0]).toMatchObject({
  label: "fern worked 1 minute: 1 of 3 plan steps", live: { plan: during.live!.plan!, lines: [] },
 });
});

it("a reused worker's progress goes to its new task and folds when its answer ends", async () => {
 const { setup, runtime } = await integration();
 const main = runtime.conversation.id;
 await runtime.board.saveTask({ task: { title: "Check the receipt", description: "", acceptance: null, status: "todo", blockedBy: [], blockedReason: null, writeScopes: [] } }, "user");
 let held!: () => void;
 const gate = new Promise<void>(resolve => { held = resolve; });
 let sampled!: () => void;
 let commandOutput: string | undefined;
 let commandSchema: object | undefined;
 let coordinatorSchema: object | undefined;
 let shownTask: string | undefined;
 let planWrites = 0;
 const sample = new Promise<void>(resolve => { sampled = resolve; });
 setup.faux.setResponses(Array.from({ length: 25 }, () => async request => {
  const last = request.messages.findLast(message => message.role !== "system");
  const call = (tool: string, args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: "toolUse" });
  if (last?.role === "user" && last.content === "Start a worker") return call("worker_spawn", { id: "fern", taskId: "T1", title: "Check the card", task: "Check the card", model: { provider: "faux", modelId: "faux-1" } });
  if (last?.role === "user" && typeof last.content === "string" && last.content.startsWith("[worker fern reported]")) return fauxAssistantMessage("Recorded.");
  const bash = () => request.messages.findLast(message => message.role === "system" && message.toolsAdded?.some(tool => tool.name === "bash"));
  if (last?.role === "user" && last.content === "Read the run plan") {
   const system = bash();
   coordinatorSchema = system?.role === "system" ? system.toolsAdded?.find(tool => tool.name === "bash")?.parameters : undefined;
   return call("board", { action: "show_task", id: "T2" });
  }
  if (last?.role === "toolResult" && last.toolName === "board") {
   shownTask = last.content.find(part => part.type === "text")?.text;
   return fauxAssistantMessage("Read the plan.");
  }
  if (last?.role === "user" && last.content === "Reuse the worker") return call("worker_send", { id: "fern", taskId: "T2", message: "Check the receipt" });
  if (last?.role === "user" && typeof last.content === "string" && last.content.startsWith("[task T2]")) return call("task_progress", { now: "reading the receipt", addResult: "The receipt includes the balance.", plan: [{ text: "Read the receipt" }, { text: "Check the balance" }, { text: "Report the result" }] });
  if (last?.role === "toolResult" && last.toolName === "task_progress") {
   const text = last.content.find(part => part.type === "text")?.text ?? "";
   if (text.includes("Run plan updated.")) return call("task_progress", planWrites++ === 0 ? { tick: [1] } : {});
   if (text.includes("Plan (1 of 3):\n1. [x] Read the receipt\n2. [>] Check the balance")) {
    const system = bash();
    commandSchema = system?.role === "system" ? system.toolsAdded?.find(tool => tool.name === "bash")?.parameters : undefined;
    return call("bash", { command: "printf 'synthetic-receipt'", intent: "Verify the receipt" });
   }
   held(); sampled(); throw new Error("Expected task_progress to print the plan");
  }
  if (last?.role === "toolResult" && last.toolName === "bash") {
   commandOutput = last.content.find(part => part.type === "text")?.text;
   sampled(); await gate; return fauxAssistantMessage("Receipt checked.");
  }
  return fauxAssistantMessage("Card checked.");
 }));
 const send = async (content: string) => {
  const submission = await runtime.conversation.submit({ type: "input", content, requestId: content }, BACKGROUND_CONTEXT);
  await submission.wait(BACKGROUND_CONTEXT);
 };
 const mainWatch = await runtime.harness.watchDoc(WorkersDoc, main, BACKGROUND_CONTEXT);
 const idle = Promise.withResolvers<void>();
 mainWatch!.start(async call => { if (call.kind !== "failed" && call.value?.workers.fern?.status === "idle") idle.resolve(); });
 try {
  await send("Start a worker");
  await idle.promise;
  await send("Reuse the worker");
  await sample;
  expect(commandOutput).toContain("synthetic-receipt");
  expect(commandSchema).toMatchObject({ properties: { intent: { type: "string" } }, required: ["command"] });
  expect((commandSchema as { properties: { intent: Record<string, unknown> } }).properties.intent.maxLength).toBeUndefined();
  await send("Read the run plan");
  expect(shownTask).toContain("Plan (1 of 3):\n1. [x] Read the receipt\n2. [>] Check the balance");
  expect(coordinatorSchema).toBeDefined();
  expect(coordinatorSchema).not.toHaveProperty("properties.intent");
  const worker = (await runtime.workers.state()).workers.fern!;
  expect(worker.taskId).toBe("T2");
  const tasks = (await runtime.board.get()).tasks;
  expect(tasks.find(task => task.id === "T1")?.live?.lines ?? []).toEqual([]);
  expect(tasks.find(task => task.id === "T1")?.live?.plan).toBeUndefined();
  const plan = tasks.find(task => task.id === "T2")?.live?.plan;
  expect(plan?.map(step => step.status)).toEqual(["done", "doing", "todo"]);
  expect(tasks.find(task => task.id === "T2")?.live?.lines.map(line => line.text)).toEqual(["reading the receipt", "The receipt includes the balance."]);
  const conversation = await runtime.harness.conversation(worker.conversationId as typeof main, BACKGROUND_CONTEXT);
  held();
  await conversation!.waitForIdle(BACKGROUND_CONTEXT);
  const workerRows = (await runtime.board.timeline("T2", ["worker"], true)).entries;
  expect(workerRows).toHaveLength(1);
  expect(workerRows[0]!.live?.lines).toHaveLength(2);
  expect(workerRows[0]!.live?.plan).toEqual(plan as NonNullable<typeof plan>);
  expect(workerRows[0]!.label).toContain("1 of 3 plan steps");
  expect((await runtime.board.get()).tasks.find(task => task.id === "T2")?.live?.plan).toBeUndefined();
 } finally { held(); await mainWatch?.stop(); }
}, 15_000);
