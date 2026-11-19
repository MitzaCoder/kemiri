import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifacts.ts";
import { expect, it, mock } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { EntryRecord, Harness, LiveState } from "@earendil-works/pi-durable";
import type { Board, BoardActivityActor, BoardLiveCounters } from "@kemiri/protocol";
import type { BoardState } from "../src/board.ts";
import type { TaskActivitySource } from "../src/task-activity.ts";
import { TaskLiveRun } from "../src/task-live-run.ts";
import { TaskLiveWatch } from "../src/task-live-watch.ts";
import { liveRunFacts } from "../src/task-live.ts";

const at = new Date(0).toISOString();
const actor: BoardActivityActor = { id: "main:8:10", kind: "worker", name: "fern", threadId: "main", conversationId: 8, runId: "10" };
const source: TaskActivitySource = { state: "running", title: "Check payments", since: at, actor };
const counters = (steps: number, filesChanged: number, commits: number): BoardLiveCounters => ({ steps, filesChanged, commits, filesSaved: 0, checks: 0 });

function tool(name: string, args: Record<string, string>, failed = false, output = "") {
 const call = fauxToolCall(name, args);
 const assistant = { model: [fauxAssistantMessage([call], { stopReason: "toolUse" })] } satisfies Pick<EntryRecord, "model">;
 const result = { model: [{ role: "toolResult", toolCallId: call.id, toolName: name, isError: failed, timestamp: 0, content: [{ type: "text", text: output }] }] } satisfies Pick<EntryRecord, "model">;
 return { call, assistant, result };
}

it("counts calls, distinct successful edits, and only successful direct VCS commands", () => {
 const run = new TaskLiveRun();
 for (const { assistant, result } of [
  tool("write", { path: "src/balance.ts" }), tool("edit", { path: "./src/balance.ts" }), tool("edit", { path: "other.ts" }, true),
  tool("bash", { command: "git commit -m 'Synthetic change'" }, false, "[main abcdef0] Synthetic change\n"),
  tool("bash", { command: "jj commit -m 'Synthetic next change'" }),
  tool("bash", { command: 'jj describe -m "Synthetic title"' }),
  tool("bash", { command: 'git commit -m "not committed"' }, true),
  tool("bash", { command: "git commit --dry-run" }), tool("bash", { command: "git commit -m Example || true" }),
 ]) { run.add(assistant); run.add(result); }
 const facts = liveRunFacts("T1", source, run, []);
 expect(facts.counters).toEqual(counters(9, 1, 3));
 expect(facts.lines).toEqual([]);
});

it("keeps only fixed pulse labels and ignores progress tokens", () => {
 const run = new TaskLiveRun();
 for (const command of [`bun test ${"private-argument ".repeat(30)}`, "DEMO_TOKEN=synthetic-private bun test"]) {
  const { call, assistant } = tool("bash", { command });
  run.add(assistant);
  const slot = { name: "bash", callId: call.id, status: "running" as const, output: "DEMO_TOKEN=synthetic-private" };
  run.updatePulse({ tools: [slot] }, at);
  const pulse = run.pulse;
  expect(pulse).toEqual({ tool: "bash", label: command.startsWith("bun") ? "Running tests" : "Running a command", since: at });
  expect(JSON.stringify(pulse)).not.toMatch(/bun test|DEMO_TOKEN|private/);
  run.updatePulse({ tools: [{ ...slot, output: "more output" }] }, new Date(1000).toISOString());
  expect(run.pulse).toBe(pulse);
  run.updatePulse({ tools: [{ ...slot, status: "done" }] }, at);
  expect(run.pulse).toBeUndefined();
 }
});

it("merges nine durable saves into one line without losing the count", () => {
 const saves = Array.from({ length: 9 }, (_, i) => ({ id: String(i), taskId: "T1", conversationId: actor.conversationId, runId: actor.runId, at: new Date(i * 1000).toISOString() }));
 const facts = liveRunFacts("T1", source, undefined, saves);
 expect(facts.lines).toEqual([expect.objectContaining({ kind: "fact", text: "Saved 9 files" })]);
 expect(liveRunFacts("T1", source, undefined, saves.slice(0, 1)).lines[0]?.id).toBe(facts.lines[0]?.id);
 expect(facts.counters?.filesSaved).toBe(9);
});

it("rebuilds a live view from the transcript after restart and opens no transactions for tool progress", async () => {
 const { call, assistant, result } = tool("write", { path: "checkout.ts" });
 const entries = [{ ...assistant, id: 10 }, { ...result, id: 11 }];
 const scan = mock(async ({ minEntryId }: { minEntryId: number }) => ({ items: entries.filter(entry => entry.id >= minEntryId) }));
 const commit = mock(() => { throw new Error("The live view must not write"); });
 const state = { tasks: [{ id: "T1", status: "in_progress" }], taskActivity: { T1: { sources: { [actor.id]: source } } } } as unknown as BoardState;
 const view = () => ({ tasks: [{ id: "T1", live: { lines: [] } }] }) as unknown as Board;
 const live = { run: { taskId: 7, first: 10, inputs: [], turns: 1 }, tools: [{ callId: call.id, name: call.name, status: "running" }] } as unknown as LiveState;
 for (let restart = 0; restart < 2; restart++) {
  let changed: ((update: { kind: "changed"; value: LiveState }) => Promise<void>) | undefined;
  const fake = { commit, conversation: async () => ({ entries: scan }), watchDoc: async () => ({ value: live, start(fn: typeof changed) { changed = fn; }, stop: async () => {} }) } as unknown as Harness;
  const { promise, resolve } = Promise.withResolvers<void>();
  const watch = new TaskLiveWatch(fake, resolve, error => { throw error; });
  try {
   watch.sync(state);
   await promise;
   expect(watch.project(view(), state).tasks[0]?.live).toMatchObject({ pulse: { tool: "write" }, counters: counters(1, 1, 0) });
   const reads = scan.mock.calls.length;
   await changed?.({ kind: "changed", value: { ...live, tools: live.tools?.map(slot => ({ ...slot, output: "new tokens" })) } });
   expect(scan.mock.calls).toHaveLength(reads);
   expect(commit).not.toHaveBeenCalled();
  } finally { await watch.stop(); }
 }
}, 10_000);


it("counts persisted codemode receipts, without publishing nested arguments", () => {
 const run = new TaskLiveRun();
 const { call, assistant } = tool("codemode", { code: "synthetic" });
 run.add(assistant);
 const receipt = { model: [{ role: "toolResult", toolCallId: call.id, toolName: call.name, isError: false, timestamp: 0, content: [], details: { calls: [
  { name: "edit", args: '{"path":"checkout.ts","edits":[…', status: "ok" },
  { name: "bash", args: JSON.stringify({ command: "jj commit -m Synthetic" }), status: "ok" },
  { name: "write", args: JSON.stringify({ path: "ignored.ts" }), status: "error" },
 ] } }] } satisfies Pick<EntryRecord, "model">;
 run.add(receipt);
 run.add(receipt);
 expect(liveRunFacts("T1", source, run, []).counters).toEqual(counters(4, 1, 1));
});

it("records only new successful saves in the artifact transaction and recovers them from disk", async () => {
 const directory = await mkdtemp(join(tmpdir(), "kemiri-live-artifact-test-"));
 try {
  const sourcePath = join(directory, "synthetic.txt");
  await Bun.write(sourcePath, "Synthetic receipt.");
  const store = new ArtifactStore({ dataDir: directory, now: () => 0 });
  const changed = mock(() => {});
  const stop = store.watchTaskSaves("demo", changed);
  const save = { projectId: "demo", sourcePath, taskId: "T1", threadId: "main", title: null, note: null, workerId: "fern",
   liveRun: { conversationId: actor.conversationId, runId: actor.runId } };
  for (let n = 0; n < 9; n++) await store.save({ ...save, artifactId: `demo-${n}` });
  await store.save({ ...save, artifactId: "demo-0" });
  await expect(store.save({ ...save, artifactId: "demo-missing", sourcePath: join(directory, "missing.txt") })).rejects.toThrow();
  expect(changed).toHaveBeenCalledTimes(9);
  stop();
  const restarted = new ArtifactStore({ dataDir: directory });
  const facts = liveRunFacts("T1", source, undefined, await restarted.taskSaves("demo"));
  expect(facts.counters?.filesSaved).toBe(9);
  expect(facts.lines.map(line => line.text)).toEqual(["Saved 9 files"]);
 } finally { await rm(directory, { recursive: true, force: true }); }
});
