import { expect, it } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { LiveDoc, type ConversationId, type EntryId, type TaskId, type Tx } from "@earendil-works/pi-durable";
import { HARNESS_FEATURES, type TaskWatcherSettings } from "@kemiri/protocol";
import { emptyBoardState, foldTaskLiveIn, openBoard } from "../src/board.ts";
import { activityTracking, endActivitySource, type TaskActivitySource } from "../src/task-activity.ts";
import { TaskWatcherRun, evaluateWatcherRun } from "../src/task-watcher-live.ts";
import { createSetup, TestClient } from "./support.ts";

const START = Date.UTC(2026, 5, 1, 12);
const at = (t: number) => new Date(t).toISOString();
const model = { provider: "faux", modelId: "faux-1" };
const output = "write: all tests pass";

function tool(path: string, at: number) {
 const call = fauxToolCall("edit", { path });
 return { call, assistant: { ...fauxAssistantMessage([call], { stopReason: "toolUse" }), timestamp: at },
  result: { role: "toolResult" as const, toolName: call.name, toolCallId: call.id, timestamp: at, isError: false, content: [{ type: "text" as const, text: output }] } };
}

it("evaluates only new work at the tuned threshold, never an idle hour, and honors the publication floor even at end", () => {
 const state = emptyBoardState();
 state.taskWatcherSettings = { mode: "auto", dailyTokens: 0 };
 const run = new TaskWatcherRun();
 const tracking = activityTracking(state, "T1");
 const source: TaskActivitySource = tracking.sources.run = { actor: { id: "run", kind: "worker", name: "fern", threadId: "main", conversationId: 1, runId: "1" }, title: "Payments", state: "running", since: at(START) };
 let now = START;
 let id = 0;
 const add = (path: string, gap = 0) => {
  now += gap;
  const call = tool(path, now);
  for (const model of [call.assistant, call.result]) run.add({ id: ++id as EntryId, kind: model.role === "assistant" ? "pi.assistant" : "pi.tool-result", model: [model], conversationId: 1 as ConversationId });
 };
 for (let i = 0; i < 5; i++) add("payments.ts");
 expect(run.due(undefined, now, false)).toBe(false);
 now += 3_600_000;
 expect(run.due(undefined, now, false)).toBe(false);
 add("payments.ts");
 evaluateWatcherRun(state, "T1", tracking, source, run, now);
 expect(tracking.liveLines?.map(line => line.text)).toEqual(["Editing the payments file."]);
 expect(source.watcherCursor).toMatchObject({ entryId: 12 });
 for (let i = 0; i < 6; i++) add("receipts.ts");
 evaluateWatcherRun(state, "T1", tracking, source, run, now + 179_999, true);
 expect(tracking.liveLines).toHaveLength(1);
 evaluateWatcherRun(state, "T1", tracking, source, run, now + 180_000);
 expect(tracking.liveLines?.map(line => line.text)).toEqual(["Editing the payments file.", "Editing the receipts file."]);
 add("gift-cards.ts", 361_000);
 expect(run.due(source.watcherCursor, now, false)).toBe(false);
 evaluateWatcherRun(state, "T1", tracking, source, run, now, true);
 expect(tracking.liveLines?.at(-1)?.text).toBe("Editing the gift cards file.");
 expect(JSON.stringify(tracking.liveLines)).not.toMatch(/all tests pass|passed/);
 expect(run.due(source.watcherCursor, now + 3_600_000, true)).toBe(false);
 const another = new TaskWatcherRun();
 const first = tool("payments.ts", START);
 const second = tool("payments.ts", START + 120_000);
 another.add({ id: 1 as EntryId, conversationId: 1 as ConversationId, kind: "pi.assistant", model: [first.assistant] });
 another.add({ id: 2 as EntryId, conversationId: 1 as ConversationId, kind: "pi.assistant", model: [second.assistant] });
 expect(another.due(undefined, START + 120_000, false)).toBe(true);
});

it("projects each distinct recorded step once without retaining output, commands or private arguments", () => {
 const run = new TaskWatcherRun();
 let id = 0;
 for (const [name, args] of [
  ["read", { path: "/hidden/location/checkout.ts" }],
  ["edit", { path: "balance.ts" }],
  ["edit", { path: "balance.ts" }],
  ["bash", { command: "bun test tests/checkout.test.ts" }],
  ["bash", { command: "bun test", intent: "Check partial payments" }],
  ["bash", { command: "echo hidden", intent: "echo hidden" }],
  ["bash", { command: "bun test", intent: "Check password synthetic" }],
  ["read", { path: "private-key.json" }],
 ] as const) {
  const call = fauxToolCall(name, args);
  for (const model of [fauxAssistantMessage([call]), { role: "toolResult" as const, toolName: name, toolCallId: call.id, timestamp: START, isError: false, content: [{ type: "text" as const, text: output }] }]) {
   run.add({ id: ++id as EntryId, kind: model.role === "assistant" ? "pi.assistant" : "pi.tool-result", conversationId: 1 as ConversationId, model: [{ ...model, timestamp: START }] });
  }
 }
 expect(run.pass(undefined, START, false, [])?.steps).toEqual([
  { entryId: "2", description: "Reading a file · checkout.ts" },
  { entryId: "4", description: "Editing a file · balance.ts" },
  { entryId: "6", description: "Editing a file · balance.ts" },
  { entryId: "8", description: "Running tests · checkout.test.ts" },
  { entryId: "10", description: "Running tests · Check partial payments" },
  { entryId: "12", description: "Running a command" },
  { entryId: "14", description: "Running tests" },
  { entryId: "16", description: "Reading a file" },
 ]);
});

const features = HARNESS_FEATURES.filter(feature => feature !== "report-audit");
async function fixture() {
 let now = START;
 const setup = await createSetup({ now: () => now, features, terminals: false });
 const manager = setup.server.manager;
 const { id: projectId } = await manager.add(setup.projectDir);
 const client = await TestClient.open(setup.server);
 await client.request({ type: "hello", protocolVersion: 1, client: { name: "test", version: "0", features: ["task-live-watcher"] } });
 const { runtime } = await manager.open(projectId);
 const mainId = runtime.conversation.id;
 async function task(path: string, calls = 6) {
  const task = await runtime.board.saveTask({ task: { title: "Synthetic checkout", description: "", acceptance: null, status: "in_progress", blockedBy: [], blockedReason: null, writeScopes: [] } }, "coordinator");
  const conversation = await runtime.harness.createConversation({ ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
  async function append(tx: Tx) {
   const step = tool(path, now);
   const { id } = await tx.appendEntry(conversation.id, { kind: "pi.assistant", model: [step.assistant] });
   await tx.appendEntry(conversation.id, { kind: "pi.tool-result", model: [step.result] });
   return id;
  }
  const actor = await runtime.harness.commit(async tx => {
   const first = await append(tx);
   for (let i = 1; i < calls; i++) await append(tx);
   const live = await tx.doc(LiveDoc, conversation.id);
   live.run = { first, taskId: 1 as TaskId, inputs: [], turns: 0 };
   const actor = { id: `main:${conversation.id}:${first}`, kind: "worker", name: "fern", threadId: "main", conversationId: conversation.id, runId: String(first) } as const;
   activityTracking(await openBoard(tx, mainId), task.id).sources[actor.id] = { actor, title: task.title, state: "running", since: at(now) };
   return actor;
  }, BACKGROUND_CONTEXT);
  const end = () => runtime.harness.commit(async tx => {
   delete (await tx.doc(LiveDoc, conversation.id)).run;
   const board = await openBoard(tx, mainId);
   endActivitySource(activityTracking(board, task.id), actor.id, at(now));
   await foldTaskLiveIn(tx, mainId, board, task.id, actor.id, "reported", at(now));
  }, BACKGROUND_CONTEXT);
  return { task, actor, end };
 }
 const configure = (taskWatcher: TaskWatcherSettings | null) => client.request({ type: "projects.configure", projectId, taskWatcher });
 const waitForState = (state: string) => client.waitFor(message => message.type === "project.state" && message.project.id === projectId && message.project.taskWatcherStatus?.state === state);
 const waitForLine = (taskId: string) => client.waitFor(message => message.type === "board.state" && message.board.tasks.some(task => task.id === taskId && task.live?.lines.some(line => line.kind === "auto")));
 await client.request({ type: "board.get", projectId });
 return { setup, client, runtime, projectId, task, configure, waitForState, waitForLine, advance: (ms: number) => { now += ms; } };
}

it("persists evidence and idempotent feedback without affecting reports, Needs you, freshness, nudges, or timeline rows", async () => {
 const f = await fixture();
 try {
  const { task, actor } = await f.task("payments.ts");
  const timeline = await f.runtime.board.timeline(task.id);
  await f.waitForLine(task.id);
  const before = await f.runtime.board.state();
  const first = before.tasks.find(row => row.id === task.id)!;
  const line = first.live!.lines[0]!;
  expect(line).toMatchObject({ kind: "auto", text: "Editing the payments file.", picker: "most_steps", evidence: { conversationId: actor.conversationId } });
  expect(line.evidence?.steps.length).toBeGreaterThan(0);
  expect(first.state?.group).toBe("in_progress");
  expect({ ...first.report, now: task.report.now }).toEqual(task.report);
  expect(first.eventSeq).toBe(task.eventSeq);
  expect(first.snapshots).toBe(task.snapshots);
  expect(await f.runtime.board.timeline(task.id)).toEqual(timeline);
  const legacy = await TestClient.open(f.setup.server);
  try {
   await legacy.hello();
   const list = await legacy.request({ type: "projects.list" });
   expect(list.type === "projects.list" && list.projects[0]?.taskWatcher).toBeUndefined();
   expect((await legacy.request({ type: "board.live.mark_wrong", projectId: f.projectId, taskId: task.id, lineId: line.id })).type).toBe("error");
  } finally { legacy.close(); }
  for (let i = 0; i < 2; i++) expect((await f.client.request({ type: "board.live.mark_wrong", projectId: f.projectId, taskId: task.id, lineId: line.id })).type).toBe("board.live.mark_wrong");
  const after = await f.runtime.board.state();
  expect(after.tasks[0]?.live?.lines[0]?.wrong).toEqual({ by: "owner", at: at(START) });
  expect(after.tasks[0]?.report).toEqual(first.report);
  expect(after.reportTracking).toEqual(before.reportTracking);
  expect(after.reportOutbox).toEqual(before.reportOutbox);
  expect(after.taskWatcherStatus).toMatchObject({ totals: { written: 1, wrong: 1 }, byPicker: { most_steps: { written: 1, wrong: 1 } } });
  f.advance(3_600_000);
  await f.setup.restart();
  const { runtime } = await f.setup.server.manager.open(f.projectId);
  const reopened = await runtime.board.state();
  expect(reopened.taskWatcherStatus?.totals).toEqual({ written: 1, wrong: 1 });
  expect(reopened.taskActivity?.[task.id]?.liveLines?.map(row => row.id)).toEqual([line.id]);
  expect(reopened.taskActivity?.[task.id]?.sources[actor.id]?.watcherCursor?.entryId).toBeGreaterThan(Number(actor.runId));
  expect(f.setup.faux.state.callCount).toBe(0);
 } finally { f.client.close(); await f.setup.cleanup(); }
}, 20_000);

it("round-trips modes, discards a malformed pick whole, and falls back without a call when the budget is spent", async () => {
 const f = await fixture();
 try {
  const settings = { mode: "model", model, dailyTokens: 65_000 } as const;
  const configured = await f.configure(settings);
  expect(configured.type === "projects.configure" && configured.project.taskWatcher).toEqual(settings);
  f.setup.faux.setResponses([fauxAssistantMessage('{"candidate":"A1","line":"All tests pass"}')]);
  const malformed = await f.task("payments.ts");
  await f.waitForState("error");
  expect((await f.runtime.board.state()).tasks.find(task => task.id === malformed.task.id)?.live?.lines).toEqual([]);
  expect(f.setup.faux.state.callCount).toBe(1);
  await f.configure({ ...settings, dailyTokens: 0 });
  const fallback = await f.task("receipts.ts");
  await f.waitForLine(fallback.task.id);
  const budget = await f.runtime.board.state();
  expect(budget.taskWatcherStatus).toMatchObject({ state: "budget", reason: expect.stringContaining("Automatic") });
  expect(budget.tasks.find(task => task.id === fallback.task.id)?.live?.lines[0]?.picker).toBe("most_steps");
  expect(f.setup.faux.state.callCount).toBe(1);
  await f.configure(settings);
  f.setup.faux.setResponses([fauxAssistantMessage('{"candidate":"A1"}')]);
  const modelFlush = await f.task("partial-payments.ts", 1);
  await modelFlush.end();
  await f.waitForState("checked");
  const modelHistory = await f.runtime.board.timeline(modelFlush.task.id);
  expect(modelHistory.entries.filter(entry => entry.live)).toHaveLength(1);
  expect(modelHistory.entries.find(entry => entry.live)?.live?.lines).toMatchObject([{ text: "Editing the partial payments file.", picker: "model:faux/faux-1" }]);
  await f.setup.server.requestLog!.flush();
  expect(f.setup.server.requestLog!.store.rows({ from: 0, to: Date.now() + 1 }).filter(row => row.purpose === "task_watcher")).toHaveLength(2);
  const off = await f.configure({ mode: "off", dailyTokens: 0 });
  expect(off.type === "projects.configure" && off.project.taskWatcherStatus?.state).toBe("off");
  const reset = await f.configure(null);
  expect(reset.type === "projects.configure" && reset.project.taskWatcher?.mode).toBe("auto");
  const short = await f.task("gift-cards.ts", 1);
  await short.end();
  const history = await f.runtime.board.timeline(short.task.id);
  expect(history.entries.filter(entry => entry.live)).toHaveLength(1);
  expect(history.entries.find(entry => entry.live)?.live?.lines[0]?.text).toBe("Editing the gift cards file.");
 } finally { f.client.close(); await f.setup.cleanup(); }
}, 20_000);
