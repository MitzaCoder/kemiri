import { afterEach, expect, it } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Value } from "typebox/value";
import { HARNESS_FEATURES, LEGACY_HARNESS_FEATURES } from "@kemiri/protocol";
import { BoardQuestionSchema, BoardQuestionClarifyRequestSchema } from "../../protocol/src/board.ts";
import type { JsonObject } from "@earendil-works/pi-durable";
import { askQuestion, boardView, buildTimeline, clarifyQuestion, coordinatorWriter, describeQuestion, emptyBoardState, endQuestionClarification, normalizeBoard, openBoard, openQuestionCount, recordFeedback, replyQuestion, saveTask, setFeedbackState, settleQuestion, writeReport } from "../src/board.ts";
import { taskState, taskActivity, activityTracking } from "../src/task-activity.ts";
import { boardAttention } from "../src/sidebar-attention.ts";
import { boardQuestionNotification } from "../src/notifications.ts";
import { createSetup, entryText, errorOf, TestClient, ViewClient } from "./support.ts";

const now = "2026-11-17T12:00:00.000Z";
const later = "2026-11-17T12:01:00.000Z";
const by = coordinatorWriter("main");
function fixture(kind: "question" | "warning" = "question") {
 const state = emptyBoardState();
 saveTask(state, { task: { title: "Synthetic task", description: "", acceptance: null, status: "in_progress", blockedBy: [], blockedReason: null, writeScopes: [] }, author: "coordinator", now });
 askQuestion(state, { taskId: "T1", text: "Which storage?", options: kind === "warning" ? [] : ["Local", "Remote"], kind, now });
 writeReport(state, { taskId: "T1", sections: { next: "Wait for Q1" }, waitsOn: ["Q1"], by, now });
 return state;
}
function clarify(state: ReturnType<typeof fixture>, text = "What does remote mean?") {
 return clarifyQuestion(state, { questionId: "Q1", expectedRevision: state.questions[0]!.revision, text, now: later });
}
function reply(state: ReturnType<typeof fixture>, extra: Partial<Parameters<typeof replyQuestion>[1]> = {}) {
 return replyQuestion(state, { questionId: "Q1", expectedRevision: state.questions[0]!.revision, text: "Remote means a shared service.", by, now: later, ...extra });
}

it("keeps legacy questions valid, advertises clarification separately and validates its request", () => {
 const state = fixture();
 expect(Value.Check(BoardQuestionSchema, state.questions[0])).toBe(true);
 expect(normalizeBoard(state).questions[0]!.exchanges).toBeUndefined();
 expect(openQuestionCount(state)).toBe(1);
 expect(HARNESS_FEATURES).toContain("question-clarify");
 expect(LEGACY_HARNESS_FEATURES).not.toContain("question-clarify");
 expect(Value.Check(BoardQuestionClarifyRequestSchema, { type: "board.question.clarify", id: "r1", projectId: "p1", questionId: "Q1", expectedRevision: 1, text: "Why?" })).toBe(true);
});

it.each(["question", "warning"] as const)("keeps %s open across unlimited rounds, revisions, wording history and settlement", kind => {
 const state = fixture(kind);
 expect(() => clarifyQuestion(state, { questionId: "Q1", expectedRevision: 99, text: "Why?", now })).toThrow("revision");
 for (let i = 0; i < 4; i++) {
  const asked = clarify(state);
  expect(asked).toMatchObject({ status: "open", waitingOn: "agent", answer: null });
  expect(asked.exchanges!.at(-1)).toMatchObject({ author: { author: "user" }, text: "What does remote mean?", at: later });
  expect(openQuestionCount(state)).toBe(0);
  expect(boardAttention(boardView(state, Date.parse(later), true))).toMatchObject({ questions: 0, warnings: 0 });
  expect(taskState(state.tasks[0]!, state.questions, state.tasks, undefined, Date.parse(later))).toMatchObject({ group: "in_progress", kind: "clarifying", refs: ["Q1"] });
  expect(taskActivity(state.tasks[0]!, state.questions, state.tasks, undefined, Date.parse(later)).text).toContain("clarifying Q1");
  const answered = reply(state, { revisedText: `Storage choice ${i}?`, ...(kind === "question" ? { revisedOptions: ["Shared", "Private"] } : {}) });
  expect(answered).toMatchObject({ status: "open", waitingOn: "user", revision: 3 + i * 2 });
  expect(answered.exchanges!.at(-1)!.previousWording!.text).toBe(i ? `Storage choice ${i - 1}?` : "Which storage?");
  expect(openQuestionCount(state)).toBe(1);
  expect(state.tasks[0]!.report.freshness!.next.stale).toBe(false);
 }
 expect(buildTimeline({ id: "T1" }, state, undefined).entries.filter(e => e.label.includes("you asked back"))).toHaveLength(4);
 expect(buildTimeline({ id: "T1" }, state, undefined).entries.filter(e => e.label.endsWith("revised"))).toHaveLength(4);
 expect(describeQuestion(state.questions[0]!)).toContain("earlier wording");
 expect(describeQuestion(state.questions[0]!)).toContain("user");
 clarify(state);
 const settled = settleQuestion(state, { questionId: "Q1", expectedRevision: state.questions[0]!.revision, answer: "Private", actor: "user", now: later });
 expect(settled.status).toBe("answered");
 expect(settled.waitingOn).toBeUndefined();
 expect(settled.exchanges).toHaveLength(9);
 expect(state.tasks[0]!.report.freshness!.next.stale).toBe(true);
 expect(() => reply(state)).toThrow();
});

it("gives failures and owner-facing blocking questions priority over Clarifying, then gives Clarifying priority over work", () => {
 const state = fixture(); clarify(state);
 askQuestion(state, { taskId: "T1", text: "Another choice?", options: [], now });
 expect(taskState(state.tasks[0]!, state.questions, state.tasks, undefined, Date.parse(later)).kind).toBe("answer_needed");
 const tracking = activityTracking(state, "T1");
 tracking.deployFailure = { text: "Failed", since: now, refs: ["deploy"], targets: [], total: 0 };
 expect(taskState(state.tasks[0]!, state.questions, state.tasks, tracking, Date.parse(later)).kind).toBe("failed");
 state.tasks[0]!.status = "done";
 expect(taskState(state.tasks[0]!, state.questions, state.tasks, tracking, Date.parse(later)).kind).toBe("done");
});

it("reminds once per round, returns No reply yet on the second turn or failure, and ignores stale completions", () => {
 const state = fixture(); const q = clarify(state);
 const end = (revision = q.revision, failed = false) => endQuestionClarification(state, { questionId: q.id, expectedRevision: revision, now: later, failed });
 expect(end(1)).toBeUndefined();
 expect(end()).toBe("remind");
 expect(openQuestionCount(state)).toBe(0);
 const restored = JSON.parse(JSON.stringify(state)) as typeof state;
 expect(endQuestionClarification(restored, { questionId: q.id, expectedRevision: q.revision, now: later })).toBe("returned");
 expect(end()).toBe("returned");
 expect(state.questions[0]).toMatchObject({ status: "open", waitingOn: "user", noReplyYet: true });
 expect(openQuestionCount(state)).toBe(1);
 const again = clarify(state);
 expect(state.questions[0]!.noReplyYet).toBeUndefined();
 expect(end()).toBeUndefined();
 expect(end(again.revision, true)).toBe("returned");
 expect(state.tasks[0]!.report.freshness!.next.stale).toBe(false);
});

it("reopens an answered question once, retaining the earlier answer, and never reopens withdrawals or MCP approvals", () => {
 const state = fixture();
 settleQuestion(state, { questionId: "Q1", answer: "What does remote mean?", now });
 const reopened = reply(state, { reopen: true, revisedOptions: ["Private"] });
 expect(reopened).toMatchObject({ status: "open", reopened: true, waitingOn: "user", answer: null, answeredAt: null });
 expect(reopened.exchanges![0]!.previousAnswer).toEqual({ text: "What does remote mean?", at: now });
 settleQuestion(state, { questionId: "Q1", answer: "Private", now });
 expect(() => reply(state, { reopen: true })).toThrow();
 const withdrawn = fixture(); settleQuestion(withdrawn, { questionId: "Q1", answer: null, now });
 expect(() => reply(withdrawn, { reopen: true })).toThrow();
 const mcp = fixture(); mcp.questions[0]!.mcpApproval = true;
 expect(() => clarify(mcp)).toThrow("MCP");
 settleQuestion(mcp, { questionId: "Q1", answer: "Deny", now });
 expect(() => reply(mcp, { reopen: true })).toThrow("MCP");
 const oldMcp = fixture(); oldMcp.questions[0]!.text = "MCP approval: fixture / inspect"; oldMcp.questions[0]!.options = ["Approve once", "Always allow this tool", "Deny"];
 normalizeBoard(oldMcp);
 expect(() => clarify(oldMcp)).toThrow("MCP");
});

it("replies use the existing notification setting and replacement tag but a new dedup key", () => {
 const initial = boardQuestionNotification({ projectId: "p", projectName: "Fixture", questionId: "Q1", text: "Choose?" });
 const response = boardQuestionNotification({ projectId: "p", projectName: "Fixture", questionId: "Q1", text: "Explanation", reply: true, revision: 3 });
 expect(response.kind).toBe(initial.kind);
 expect(response.tag).toBe(initial.tag);
 expect(response.key).not.toBe(initial.key);
 expect(response.title).toBe("Reply on Q1 · Fixture");
});

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function start() {
 const test = await createSetup(); cleanups.push(test.cleanup);
 const client = await TestClient.open(test.server); cleanups.push(async () => client.close());
 await client.hello();
 const added = await client.request({ type: "projects.add", path: test.projectDir });
 if (added.type !== "projects.add") throw errorOf(added);
 const projectId = added.project.id;
 await client.request({ type: "projects.configure", projectId, coordinatorModel: { provider: "faux", modelId: "faux-1" }, coordinatorThinkingLevel: "low" });
 const { runtime } = await test.server.manager.open(projectId);
 return { test, client, projectId, runtime };
}
async function until(check: () => Promise<boolean>) { const deadline = Date.now() + 10_000; while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(20); } throw new Error("Timed out"); }

it("delivers Ask back on main, records an agent revision, publishes reply state and rejects stale answers", async () => {
 const { test, client, projectId } = await start();
 const call = (arguments_: JsonObject) => fauxAssistantMessage([fauxToolCall("board", arguments_)], { stopReason: "toolUse" });
 test.faux.setResponses([
  () => call({ action: "ask", text: "Which storage?", options: ["Local", "Remote"] }),
  () => fauxAssistantMessage("Waiting."),
  request => { expect(JSON.stringify(request.messages)).toContain("[board] The user asked back on Q1 (r2)"); return call({ action: "reply_question", id: "Q1", expectedRevision: 2, text: "Remote is shared.", revisedText: "Private or shared?", revisedOptions: ["Private", "Shared"] }); },
  () => fauxAssistantMessage("Explained."),
  () => fauxAssistantMessage("Settled."),
 ]);
 const view = new ViewClient(client); await view.start(projectId);
 await client.request({ type: "conversation.submit", projectId, requestId: "ask", content: "Plan it." });
 await view.waitForView(v => v.entries.some(e => entryText(e) === "Waiting."));
 const clarified = await client.request({ type: "board.question.clarify", projectId, questionId: "Q1", expectedRevision: 1, text: "What does remote mean?" });
 expect(clarified.type).toBe("board.question.clarify");
 if (clarified.type === "board.question.clarify") expect(clarified.question).toMatchObject({ waitingOn: "agent", status: "open" });
 await view.waitForView(v => v.entries.some(e => entryText(e) === "Explained."));
 const board = await client.request({ type: "board.get", projectId });
 if (board.type !== "board.get") throw errorOf(board);
 expect(board.board.questions[0]).toMatchObject({ revision: 3, waitingOn: "user", text: "Private or shared?", exchanges: [{ text: "What does remote mean?" }, { text: "Remote is shared." }] });
 const stale = await client.request({ type: "board.question.answer", projectId, questionId: "Q1", expectedRevision: 2, answer: "Remote" });
 expect(errorOf(stale).code).toBe("board_conflict");
 const answered = await client.request({ type: "board.question.answer", projectId, questionId: "Q1", expectedRevision: 3, answer: "Private" });
 expect(answered.type).toBe("board.question.answer");
});

it("the real turn-end hook reminds once, then returns an unanswered clarification to Needs you", async () => {
 const { test, client, projectId, runtime } = await start();
 test.faux.setResponses([
  () => fauxAssistantMessage([fauxToolCall("board", { action: "ask", text: "Choose?" })], { stopReason: "toolUse" }),
  () => fauxAssistantMessage("Waiting."),
  () => fauxAssistantMessage("Forgot to reply."),
  request => { expect(JSON.stringify(request.messages)).toContain("Clarification reminder for Q1 (r2)"); return fauxAssistantMessage("Forgot again."); },
 ]);
 const view = new ViewClient(client); await view.start(projectId);
 await client.request({ type: "conversation.submit", projectId, requestId: "ask", content: "Plan." });
 await view.waitForView(v => v.entries.some(e => entryText(e) === "Waiting."));
 await client.request({ type: "board.question.clarify", projectId, questionId: "Q1", expectedRevision: 1, text: "Why?" });
 await until(async () => (await runtime.board.state()).questions[0]?.noReplyYet === true);
 const state = await runtime.board.state();
 expect(state.questions[0]).toMatchObject({ status: "open", waitingOn: "user", noReplyYet: true });
 expect(openQuestionCount(state)).toBe(1);
 await view.waitForView(v => v.entries.some(e => entryText(e) === "Forgot again."));
 expect(view.view!.entries.filter(e => entryText(e).startsWith("[board] Clarification reminder"))).toHaveLength(1);
}, 20_000);

it("routes a missing asking thread to main and leaves approvals unchanged", async () => {
 const { test, client, projectId, runtime } = await start();
 await runtime.harness.commit(async tx => {
  const state = await openBoard(tx, runtime.conversation.id);
  askQuestion(state, { taskId: null, threadId: "missing-thread", text: "Choose?", options: [], now });
 }, BACKGROUND_CONTEXT);
 test.faux.setResponses([
  request => { expect(JSON.stringify(request.messages)).toContain("The user asked back on Q1"); return fauxAssistantMessage([fauxToolCall("board", { action: "reply_question", id: "Q1", expectedRevision: 2, text: "Here is why." })], { stopReason: "toolUse" }); },
  () => fauxAssistantMessage("Done."),
 ]);
 await client.request({ type: "board.question.clarify", projectId, questionId: "Q1", expectedRevision: 1, text: "Why?" });
 await until(async () => (await runtime.board.state()).questions[0]?.waitingOn === "user");
 const id = await runtime.board.requestMcpApproval({ text: "MCP approval: fixture / inspect", options: ["Approve once", "Always allow this tool", "Deny"], threadId: "main", key: "synthetic" });
 const approval = (await runtime.board.state()).questions.find(q => q.id === id)!;
 const refused = await client.request({ type: "board.question.clarify", projectId, questionId: id, expectedRevision: approval.revision, text: "Why?" });
 expect(errorOf(refused).code).toBe("bad_request");
 expect((await runtime.board.state()).questions.find(q => q.id === id)).toMatchObject({ status: "open", revision: 1, mcpApproval: true });
});

it("an answer during clarification cancels the reminder and a late reply cannot overwrite it", async () => {
 const { test, client, projectId, runtime } = await start();
 let release: () => void = () => undefined;
 const gate = new Promise<void>(resolve => { release = resolve; });
 test.faux.setResponses([
  () => fauxAssistantMessage([fauxToolCall("board", { action: "ask", text: "Choose?" })], { stopReason: "toolUse" }),
  () => fauxAssistantMessage("Waiting."),
  async () => { await gate; return fauxAssistantMessage([fauxToolCall("board", { action: "reply_question", id: "Q1", expectedRevision: 2, text: "A late explanation." })], { stopReason: "toolUse" }); },
  request => { expect(JSON.stringify(request.messages)).toContain("The user answered Q1"); return fauxAssistantMessage("Already settled."); },
 ]);
 const view = new ViewClient(client); await view.start(projectId);
 await client.request({ type: "conversation.submit", projectId, requestId: "ask", content: "Plan." });
 await view.waitForView(v => v.entries.some(e => entryText(e) === "Waiting."));
 try {
  await client.request({ type: "board.question.clarify", projectId, questionId: "Q1", expectedRevision: 1, text: "Why?" });
  const answer = await client.request({ type: "board.question.answer", projectId, questionId: "Q1", expectedRevision: 2, answer: "Private" });
  expect(answer.type).toBe("board.question.answer");
 } finally { release(); }
 await view.waitForView(v => v.entries.some(e => entryText(e) === "Already settled."));
 await until(async () => (await runtime.board.state()).clarificationReminders?.Q1 === undefined);
 const question = (await runtime.board.state()).questions[0]!;
 expect(question).toMatchObject({ status: "answered", revision: 3, answer: "Private" });
 expect(question.exchanges).toHaveLength(1);
 expect(view.view!.entries.filter(e => entryText(e).startsWith("[board] Clarification reminder"))).toHaveLength(0);
});

it("a failed clarification run returns the card to Needs you immediately, without a reminder", async () => {
 const { test, client, projectId, runtime } = await start();
 test.faux.setResponses([
  () => fauxAssistantMessage([fauxToolCall("board", { action: "ask", text: "Choose?" })], { stopReason: "toolUse" }),
  () => fauxAssistantMessage("Waiting."),
  () => { throw new Error("Synthetic clarification failure"); },
 ]);
 const view = new ViewClient(client); await view.start(projectId);
 await client.request({ type: "conversation.submit", projectId, requestId: "ask", content: "Plan." });
 await view.waitForView(v => v.entries.some(e => entryText(e) === "Waiting."));
 await client.request({ type: "board.question.clarify", projectId, questionId: "Q1", expectedRevision: 1, text: "Why?" });
 await until(async () => (await runtime.board.state()).questions[0]?.noReplyYet === true);
 expect((await runtime.board.state()).questions[0]).toMatchObject({ status: "open", waitingOn: "user", noReplyYet: true });
 expect(openQuestionCount(await runtime.board.state())).toBe(1);
 expect(view.view!.entries.filter(e => entryText(e).startsWith("[board] Clarification reminder"))).toHaveLength(0);
}, 20_000);


it("checks the task's questions once per note and refuses to address it until the checks are settled", () => {
 const state = fixture();
 const history = { keys: [], snapshots: [] };
 const legacy = askQuestion(state, { taskId: "T1", text: "Approve the tool?", options: [], now });
 state.questions.find(q => q.id === legacy.id)!.mcpApproval = true;
 const second = askQuestion(state, { taskId: "T1", text: "Is the old plan ready?", options: [], now });
 const note = { taskId: "T1", text: "Try the new plan instead", images: 0, threadId: "area", key: "note", now: later };
 const feedback = recordFeedback(state, history, note);
 expect(recordFeedback(state, history, note).id).toBe(feedback.id);
 expect(state.questions[0]).toMatchObject({ waitingOn: "agent", revision: 2, exchanges: [{ text: note.text, feedbackId: feedback.id }] });
 expect(state.questions.find(q => q.id === legacy.id)).toMatchObject({ revision: 1 });
 expect(state.clarificationReminders?.Q1).toMatchObject({ feedbackThreadId: "area", feedbackIds: [feedback.id] });
 const address = () => setFeedbackState(state, history, { taskId: "T1", feedbackId: feedback.id, state: "addressed", note: "Tried it", by, now: later });
 expect(address).toThrow("Q1 (r2), Q3 (r2)");
 reply(state, { revisedText: "Try both plans?" });
 expect(address).toThrow("Q3 (r2)");
 settleQuestion(state, { questionId: second.id, expectedRevision: 2, answer: null, now: later, actor: "coordinator" });
 expect(address().feedback.state).toBe("addressed");
});

it("sends the check with the feedback, hides its instructions from chat, and reuses the reminder", async () => {
 const { test, client, projectId, runtime } = await start();
 const modern = await TestClient.open(test.server); cleanups.push(async () => modern.close());
 await modern.request({ type: "hello", protocolVersion: 1, client: { name: "test", version: "1", features: ["task-status-details"] } });
 const task = await runtime.board.saveTask({ task: { title: "Synthetic task", description: "", acceptance: null, status: "in_progress", blockedBy: [], blockedReason: null, writeScopes: [] } }, "coordinator");
 await runtime.harness.commit(async tx => {
  const state = await openBoard(tx, runtime.conversation.id);
  askQuestion(state, { taskId: task.id, threadId: "main", text: "Choose the plan?", options: [], now });
  const actor = { id: "worker:fixture", kind: "worker", name: "fixture", threadId: "main", conversationId: 2, runId: "1" } as const;
  activityTracking(state, task.id).sources[actor.id] = { actor, state: "running", since: now, phase: "testing the plan", title: task.title };
 }, BACKGROUND_CONTEXT);
 const before = await modern.request({ type: "board.get", projectId });
 if (before.type !== "board.get") throw errorOf(before);
 expect(before.board.tasks[0]?.state).toMatchObject({ kind: "answer_needed", runningWork: { text: "fixture is testing the plan" } });
 let finish = () => {};
 const pause = new Promise<void>(resolve => { finish = resolve; });
 test.faux.setResponses([
  async request => {
   expect(JSON.stringify(request.messages)).toContain("Check Q1 (r2) asked");
   expect(JSON.stringify(request.messages)).toContain("Choose the plan?");
   await pause;
   return fauxAssistantMessage("Forgot to settle the question.");
  },
  request => { expect(JSON.stringify(request.messages)).toContain("Clarification reminder for Q1 (r2)"); return fauxAssistantMessage("Forgot again."); },
 ]);
 const view = new ViewClient(client); await view.start(projectId);
 try {
  await client.request({ type: "conversation.submit", projectId, taskId: task.id, requestId: "note", content: "A new plan is ready." });
  await view.waitForView(v => v.entries.some(entry => entryText(entry).includes("A new plan is ready.")));
  expect(view.view!.entries.map(entryText).join("\n")).not.toContain("Check Q1 (r2) asked");
  const checked = await modern.request({ type: "board.get", projectId });
  const old = await client.request({ type: "board.get", projectId });
  if (checked.type !== "board.get" || old.type !== "board.get") throw new Error("Expected two board views");
  expect(checked.board.tasks[0]?.state).toMatchObject({ group: "in_progress", kind: "clarifying", checkingFeedbackId: "F1", runningWork: expect.any(Object) });
  expect(checked.board.questions[0]?.exchanges?.[0]?.feedbackId).toBe("F1");
  expect(old.board.tasks[0]?.state?.runningWork).toBeUndefined();
  expect(old.board.tasks[0]?.state?.checkingFeedbackId).toBeUndefined();
  expect(old.board.questions[0]).toMatchObject({ waitingOn: "agent", exchanges: [{ text: "A new plan is ready." }] });
  expect(old.board.questions[0]?.exchanges?.[0]?.feedbackId).toBeUndefined();
 } finally { finish(); }
 await until(async () => (await runtime.board.state()).questions[0]?.noReplyYet === true);
 expect((await runtime.board.state()).questions[0]).toMatchObject({ waitingOn: "user", noReplyYet: true });
}, 20_000);
