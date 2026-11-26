import { describe, expect, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { BoardTaskInput } from "@kemiri/protocol";
import { MAX_LATER_MS, nextLaterMorning, validateLaterDeadline } from "../src/attention-later.ts";
import { HARNESS_WRITER, askQuestion, boardView, describeBoard, emptyBoardState, normalizeBoard, openQuestionCount, saveTask, setBoardLater, settleQuestion, type BoardService } from "../src/board.ts";
import { notificationBlocked } from "../src/notifications.ts";
import { auditEligible } from "../src/report-audit.ts";
import { boardAttention } from "../src/sidebar-attention.ts";
import { noteTaskFact, prepareReportNudges } from "../src/task-freshness.ts";
import { activityTracking } from "../src/task-activity.ts";
import { createSetup, TestClient } from "./support.ts";

const NOW = Date.parse("2026-03-07T18:00:00Z");
const iso = (time = NOW) => new Date(time).toISOString();
const requestInput = (extra: Partial<BoardTaskInput> = {}): BoardTaskInput => ({
 title: "Pack the sample order", description: "", acceptance: null, status: "in_progress", blockedBy: [], blockedReason: null, writeScopes: [], ...extra,
});

function fixture() {
 const state = emptyBoardState();
 state.taskStateEnabled = true;
 state.taskPartStatesEnabled = true;
 const task = saveTask(state, { task: requestInput(), author: "user", now: iso() }).after;
 const part = saveTask(state, { task: requestInput({ title: "Print labels", parent: task.id }), author: "user", now: iso() }).after;
 const question = askQuestion(state, { text: "Which label?", taskId: part.id, now: iso(), options: [] });
 const normal = () => boardView(state, NOW, true, undefined, true, true);
 const modern = () => boardView(state, NOW, true, undefined, true, true, true);
 return { state, task, part, question, normal, modern };
}

function configureLater(board: BoardService, projectId: string, target: { taskId: string } | { questionId: string }, expectedRevision: number, until: string | null, whenLast?: true) {
 return board.setLater({ type: "board.later.set", id: "test", projectId, target, expectedRevision, until, whenLast });
}

describe("Later policy", () => {
 test("only eligible roots and unattached asks can be set; revisions, limits and times are stable", () => {
  const { state, task, part, question } = fixture();
  const set = (until: string | null, expectedRevision = task.revision) => setBoardLater(state, { target: { taskId: task.id }, expectedRevision, until }, NOW);
  expect(() => set(iso(NOW + MAX_LATER_MS + 1))).toThrow("30 days");
  expect(() => set(iso())).toThrow("future time");
  expect(() => set("2026-03-08")).toThrow("future time");
  for (const target of [{ taskId: part.id }, { questionId: question.id }]) {
   expect(() => setBoardLater(state, { target, expectedRevision: 1, until: iso(NOW + 1_000) }, NOW)).toThrow("whole request");
  }
  const eventSeq = state.tasks[0]!.eventSeq;
  const first = set(iso(NOW + 1_000));
  expect(first.later).toEqual({ since: iso(), until: iso(NOW + 1_000), by: "user", times: 1 });
  expect(state.tasks[0]).toMatchObject({ status: task.status, eventSeq, updatedAt: task.updatedAt });
  expect(() => set(null)).toThrow();
  const cleared = set(null, first.revision);
  expect(cleared.later).toBeNull();
  expect(set(iso(NOW + 2_000), cleared.revision).later?.times).toBe(2);
  const approval = askQuestion(state, { text: "Approve the run?", taskId: null, now: iso(), options: [], outsideModelApproval: true });
  expect(() => setBoardLater(state, { target: { questionId: approval.id }, expectedRevision: approval.revision, until: iso(NOW + 1000) }, NOW)).toThrow("needs the owner");
 });

 test("warning limits follow the local work day and DST, including gaps and overlaps", () => {
  const workDay = { timeZone: "America/New_York", start: "02:30" };
  expect(iso(nextLaterMorning(NOW, workDay))).toBe("2026-03-08T07:30:00.000Z");
  expect(iso(nextLaterMorning(Date.parse("2026-10-31T18:00:00Z"), { ...workDay, start: "01:30" }))).toBe("2026-11-01T05:30:00.000Z");
  expect(validateLaterDeadline({ until: "2026-03-08T07:30:00Z", workDay }, NOW, true)).toBe("2026-03-08T07:30:00.000Z");
  expect(() => validateLaterDeadline({ until: "2026-03-08T07:31:00Z", workDay }, NOW, true)).toThrow("next work-day start");
  expect(() => validateLaterDeadline({ until: iso(NOW + 1_000), whenLast: true }, NOW, true)).toThrow("next work-day start");
 });

 test("covers parts and ordinary asks, but leaves new warnings, failures and approvals visible", () => {
  const { state, task, part, question, normal, modern } = fixture();
  const firstWarning = askQuestion(state, { taskId: part.id, kind: "warning", text: "Check the weights", now: iso(), options: [] });
  setBoardLater(state, { target: { taskId: task.id }, expectedRevision: task.revision, until: iso(NOW + 1_000) }, NOW);
  const secondQuestion = askQuestion(state, { taskId: task.id, text: "Which box?", now: iso(), options: [] });
  expect(modern().tasks.map(row => row.state?.group)).toEqual(["later", "later"]);
  expect(modern().tasks[0]?.partsDigest?.needsOwner).toBe(0);
  expect(modern().questions.filter(row => row.postponed).map(row => row.id)).toEqual([question.id, firstWarning.id, secondQuestion.id]);
  expect(normal().tasks[0]?.state?.group).toBe("needs_you");
  expect(boardAttention(modern())).toMatchObject({ questions: 0, warnings: 0, laterItems: 1, nextLaterAt: iso(NOW + 1_000) });
  expect(openQuestionCount(state, true)).toBe(0);
  expect(describeBoard(modern())).toContain("later until");
  const secondWarning = askQuestion(state, { taskId: part.id, kind: "warning", text: "New damage to sample", now: iso(), options: [] });
  expect(modern().tasks[0]?.state).toMatchObject({ group: "needs_you", refs: [secondWarning.id] });
  expect(boardAttention(modern())).toMatchObject({ questions: 0, warnings: 1, laterItems: 1 });
  const approval = askQuestion(state, { taskId: task.id, text: "Approve the run?", now: iso(), options: [], outsideModelApproval: true });
  expect(modern().questions.find(row => row.id === approval.id)?.postponed).toBeUndefined();
  const stored = state.tasks.find(row => row.id === part.id)!;
  saveTask(state, { taskId: part.id, expectedRevision: stored.revision, task: { ...stored, status: "blocked", blockedReason: "Printer failed" }, author: "user", now: iso(NOW + 1) });
  expect(modern().tasks[0]?.state).toMatchObject({ group: "needs_you", kind: "failed", fromPartId: part.id });
  expect(modern().questions.find(row => row.id === question.id)?.postponed).toBe(true);
 });

 test("when a postponed answer settles, a quiet request does not become Paused", () => {
  const { state, task, part, question } = fixture();
  setBoardLater(state, { target: { taskId: task.id }, expectedRevision: task.revision, until: iso(NOW + 3_600_000) }, NOW);
  settleQuestion(state, { questionId: question.id, expectedRevision: 1, answer: "Small", now: iso(NOW + 1_000) });
  const raw = boardView(state, NOW + 16 * 60_000, false);
  expect(raw.tasks.find(row => row.id === part.id)?.state?.kind).toBe("paused");
  const projected = boardView(state, NOW + 16 * 60_000, false, undefined, true, true, true);
  for (const row of projected.tasks) expect(row.state).toMatchObject({ group: "later", kind: "waiting_outside" });
 });

 test("settling a taskless ask or normalizing corrupt records cannot hide an unrelated ask", () => {
  const state = emptyBoardState();
  const question = askQuestion(state, { taskId: null, text: "Which box?", now: iso(), options: [] });
  const later = setBoardLater(state, { target: { questionId: question.id }, expectedRevision: question.revision, until: iso(NOW + 1000) }, NOW);
  expect(openQuestionCount(state, true)).toBe(0);
  expect(settleQuestion(state, { questionId: question.id, expectedRevision: later.revision, answer: "Small", now: iso() }).later).toBeUndefined();
  const next = askQuestion(state, { taskId: null, text: "Which paper?", now: iso(), options: [] });
  state.questions[1]!.later = { ...later.later!, until: "invalid" };
  normalizeBoard(state);
  expect(state.questions.find(row => row.id === next.id)?.later).toBeUndefined();
  expect(openQuestionCount(state, true)).toBe(1);
 });

 test("automatic report and audit nudges ignore postponed requests", () => {
  const { state, task } = fixture();
  noteTaskFact(state, task.id, { at: iso(), kind: "worker_report", actor: "worker", reason: "Sample packed" });
  const set = setBoardLater(state, { target: { taskId: task.id }, expectedRevision: task.revision, until: iso(NOW + 1000) }, NOW);
  expect(auditEligible(state, state.tasks[0]!)).toBe(false);
  prepareReportNudges(state, NOW + 31_000, () => "main");
  expect(state.reportOutbox).toEqual([]);
  setBoardLater(state, { target: { taskId: task.id }, expectedRevision: set.revision, until: null }, NOW);
  prepareReportNudges(state, NOW + 31_000, () => "main");
  expect(state.reportOutbox).toEqual([]);
 });

 test("quiet hours allow the silent return while project mutes and kind preferences still apply", () => {
  const preferences = { kinds: ["later_back"] as const, quietHours: { start: "00:00", end: "23:59", timezone: "UTC", allowFailures: false }, mutedProjects: [] as string[] };
  const device = { deviceId: "sample", preferences: { ...preferences, kinds: [...preferences.kinds] } };
  expect(notificationBlocked(device, { kind: "later_back", projectId: "sample" }, { at: new Date(NOW) })).toBeUndefined();
  device.preferences.mutedProjects.push("sample");
  expect(notificationBlocked(device, { kind: "later_back", projectId: "sample" }, { at: new Date(NOW) })).toBe("muted");
 });
});

async function connect(test: Awaited<ReturnType<typeof createSetup>>, later: boolean) {
 const client = await TestClient.open(test.server);
 const features = ["request-attention", "coordinator-overview", ...(later ? ["attention-later", "in-app-alerts"] : [])];
 const hello = await client.request({ type: "hello", protocolVersion: 1, client: { name: "test", version: "0", features } });
 if (hello.type !== "hello") throw Error(JSON.stringify(hello));
 return client;
}

async function addProject(test: Awaited<ReturnType<typeof createSetup>>, client: TestClient) {
 const response = await client.request({ type: "projects.add", path: test.projectDir });
 if (response.type !== "projects.add") throw Error(JSON.stringify(response));
 const projectId = response.project.id;
 await client.request({ type: "projects.configure", projectId, coordinatorModel: { provider: "faux", modelId: "faux-1" } });
 return projectId;
}

async function waitFor(check: () => Promise<boolean>) {
 for (let i = 0; i < 150; i++) {
  if (await check()) return;
  await Bun.sleep(20);
 }
 throw Error("Later state did not arrive");
}

test("wire clients negotiate Later; closed project returns group after restart without waking an agent", async () => {
 let now = NOW;
 const setup = await createSetup({ now: () => now, boardEditDebounceMs: 60_000 });
 let modern: TestClient | undefined;
 let old: TestClient | undefined;
 try {
  modern = await connect(setup, true); old = await connect(setup, false);
  const projectId = await addProject(setup, modern);
  const { runtime } = await setup.server.manager.open(projectId);
  const task = await runtime.board.commitFor(change => runtime.harness.commit(change, BACKGROUND_CONTEXT), state => saveTask(state, { task: requestInput({ status: "review" }), author: "user", now: iso() }).after, HARNESS_WRITER, "test-task");
  const question = await runtime.board.commitFor(change => runtime.harness.commit(change, BACKGROUND_CONTEXT), state => askQuestion(state, { taskId: null, text: "Pick a label", now: iso(), options: [] }), HARNESS_WRITER, "test-ask");
  runtime.board.noticeQuestion(question);
  await waitFor(async () => (await setup.server.notifications.recent(0))?.events.some(event => event.type === "alert" && event.alert.questionId === question.id) === true);
  const write = { type: "board.later.set" as const, projectId, target: { taskId: task.id }, expectedRevision: task.revision, until: iso(NOW + 1_000) };
  expect(await old.request(write)).toMatchObject({ type: "error", error: { code: "unknown_request" } });
  expect(await modern.request(write)).toMatchObject({ type: write.type, revision: task.revision + 1, later: { times: 1 } });
  await configureLater(runtime.board, projectId, { questionId: question.id }, question.revision, write.until);
  expect(await modern.request({ type: "board.get", projectId })).toMatchObject({ board: { tasks: [{ state: { group: "later", kind: "review" } }], questions: [{ postponed: true }] } });
  const legacy = await old.request({ type: "board.get", projectId });
  expect(legacy).toMatchObject({ board: { tasks: [{ state: { group: "needs_you" } }], questions: [{ status: "open" }] } });
  expect(JSON.stringify(legacy)).not.toContain('"later"');
  expect(await modern.request({ type: "overview.get", projectId, coordinatorId: null })).toMatchObject({ counts: { open: 1, waitingOnOwner: 0 }, waiting: [] });
  expect(await old.request({ type: "overview.get", projectId, coordinatorId: null })).toMatchObject({ counts: { open: 1, waitingOnOwner: 2 } });
  await waitFor(async () => (await setup.server.manager.list())[0]?.attention?.laterItems === 2);
  expect(await modern.request({ type: "projects.list" })).toMatchObject({ projects: [{ attention: { questions: 0, reviewTasks: 0, laterItems: 2 } }] });
  expect(await old.request({ type: "projects.list" })).toMatchObject({ projects: [{ attention: { questions: 1, reviewTasks: 1 } }] });
  expect((await setup.server.notifications.recent(0))?.events).toContainEqual(expect.objectContaining({ type: "alert", resolved: true, alert: expect.objectContaining({ questionId: question.id }) }));
  modern.close(); old.close();
  now += 2_000;
  await setup.restart();
  await waitFor(async () => (await setup.server.notifications.recent(0))?.events.some(event => event.type === "alert" && event.alert.kind === "later_back") === true);
  const reopened = (await setup.server.manager.open(projectId)).runtime;
  await reopened.board.checkWaiting();
  const notices = (await setup.server.notifications.recent(0))?.events.filter(event => event.type === "alert" && event.alert.kind === "later_back");
  expect(notices).toEqual([expect.objectContaining({ alert: expect.objectContaining({ level: "inbox", title: "2 things are back from Later" }) })]);
  expect((await reopened.board.state()).tasks[0]?.later).toBeUndefined();
  expect((await reopened.board.state()).questions[0]?.later).toBeUndefined();
  const entries = await reopened.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
  expect(JSON.stringify(entries.items)).not.toContain("put T1 aside");
 } finally { modern?.close(); old?.close(); await setup.cleanup(); }
}, 20_000);

test("a postponed dated wait returns inside Later and last-thing waits for live work", async () => {
 let now = NOW;
 const setup = await createSetup({ now: () => now, boardEditDebounceMs: 60_000 });
 const client = await connect(setup, true);
 try {
  const projectId = await addProject(setup, client);
  const { runtime } = await setup.server.manager.open(projectId);
  const waiting = await runtime.board.saveTask({ task: requestInput({ status: "waiting", waitingFor: "Printer approval", waitUntil: iso(NOW + 1000) }) }, "user");
  const running = await runtime.board.saveTask({ task: requestInput() }, "user");
  await runtime.board.commitFor(change => runtime.harness.commit(change, BACKGROUND_CONTEXT), state => {
   for (const task of [waiting, running]) askQuestion(state, { taskId: task.id, text: "Which label?", now: iso(), options: [] });
   activityTracking(state, running.id).sources.sample = { state: "running", title: "Print labels", since: iso(), actor: { id: "sample", name: "Sample", kind: "worker", conversationId: 123, runId: "1", threadId: "main" } };
  }, HARNESS_WRITER, "test-running");
  await configureLater(runtime.board, projectId, { taskId: waiting.id }, waiting.revision, iso(NOW + 10_000));
  await configureLater(runtime.board, projectId, { taskId: running.id }, running.revision, null, true);
  now += 2_000;
  await runtime.board.checkWaiting();
  const tasks = (await runtime.board.get()).tasks;
  expect(tasks.find(task => task.id === waiting.id)).toMatchObject({ status: "review", later: { until: iso(NOW + 10_000) } });
  expect(tasks.find(task => task.id === running.id)).toMatchObject({ later: { whenLast: true }, state: { liveWorkSince: iso() } });
  await runtime.board.commitFor(change => runtime.harness.commit(change, BACKGROUND_CONTEXT), state => { activityTracking(state, running.id).sources.sample!.state = "ended"; }, HARNESS_WRITER, "test-ended");
  await runtime.board.checkWaiting();
  expect((await runtime.board.state()).tasks.find(task => task.id === running.id)?.later).toBeUndefined();
  expect((await setup.server.notifications.recent(0))?.events.some(event => event.type === "alert" && event.alert.kind === "task_review")).toBe(false);
 } finally { client.close(); await setup.cleanup(); }
}, 20_000);

test("the coordinator sees Later on its next run and a new ordinary board-tool ask makes no alert", async () => {
 const setup = await createSetup({ now: () => NOW, boardEditDebounceMs: 60_000 });
 const client = await connect(setup, true);
 try {
  const projectId = await addProject(setup, client);
  const { runtime } = await setup.server.manager.open(projectId);
  const task = await runtime.board.saveTask({ task: requestInput({ status: "review" }) }, "user");
  await configureLater(runtime.board, projectId, { taskId: task.id }, task.revision, iso(NOW + 10_000));
  await runtime.board.checkPaused();
  expect(await runtime.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT).then(page => JSON.stringify(page))).not.toContain("put T1 aside");
  let messages = "";
  setup.faux.setResponses([
   context => { messages = JSON.stringify(context.messages.map(message => message.content ?? "").concat(context.messages.flatMap(message => message.role === "system" ? [JSON.stringify(message.sections)] : []))); return fauxAssistantMessage([fauxToolCall("board", { action: "ask", taskId: task.id, text: "Pick the label" })], { stopReason: "toolUse" }); },
   fauxAssistantMessage([fauxToolCall("board", { action: "ask", taskId: task.id, kind: "warning", text: "The sample is damaged." })], { stopReason: "toolUse" }),
   fauxAssistantMessage("Other work continues."),
  ]);
  const turn = await runtime.conversation.submit({ type: "input", content: "Check the board.", requestId: "later-check" }, BACKGROUND_CONTEXT);
  await turn.wait(BACKGROUND_CONTEXT);
  expect(messages).toContain("put T1 aside");
  expect(messages).toContain("do not re-ask");
  const entries = await runtime.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
  expect(JSON.stringify(entries)).toContain("under Later");
  await waitFor(async () => (await setup.server.notifications.recent(0))?.events.some(event => event.type === "alert" && event.alert.kind === "board_question" && event.alert.warning === true) === true);
  const alerts = (await setup.server.notifications.recent(0))?.events.flatMap(event => event.type === "alert" && event.alert.kind === "board_question" ? [event.alert] : []);
  expect(alerts?.map(alert => alert.warning)).toEqual([true]);
 } finally { client.close(); await setup.cleanup(); }
}, 20_000);
