import { expect, it } from "bun:test";
import { Value } from "typebox/value";
import { HARNESS_FEATURES, LEGACY_HARNESS_FEATURES, ServerMessageSchema } from "../src/index.ts";
import { BoardTaskLiveSchema } from "../src/board.ts";

it("advertises task-live explicitly and accepts future line kinds on the wire", () => {
 expect(HARNESS_FEATURES).toContain("task-live");
 expect(LEGACY_HARNESS_FEATURES).not.toContain("task-live");
 const line = { id: "line-1", at: "2026-06-01T12:00:00.000Z", kind: "fact", text: "A future fact", actor: { id: "main:1:run", kind: "worker", name: "fern", threadId: "main", conversationId: 1, runId: "run" } };
 expect(Value.Check(BoardTaskLiveSchema, { lines: [line] })).toBe(true);
 expect(Value.Check(BoardTaskLiveSchema, { lines: Array(31).fill(line) })).toBe(false);
 expect(Value.Check(ServerMessageSchema, { type: "board.task.timeline", id: "read", projectId: "demo", taskId: "T1", entries: [{ at: line.at, kind: "worker", label: "fern worked", live: { lines: [line] } }], feedback: [] })).toBe(true);
});


it("accepts a bounded plan and keeps it optional for earlier backends", () => {
 const plan = [{ text: "Read the receipt", status: "done" }, { text: "Check balances", status: "doing" }, { text: "Run tests", status: "todo" }];
 expect(Value.Check(BoardTaskLiveSchema, { lines: [] })).toBe(true);
 expect(Value.Check(BoardTaskLiveSchema, { lines: [], plan })).toBe(true);
 expect(Value.Check(BoardTaskLiveSchema, { lines: [], plan: plan.slice(0, 2) })).toBe(false);
 expect(Value.Check(BoardTaskLiveSchema, { lines: [], plan: [{ text: "x".repeat(81), status: "todo" }, ...plan] })).toBe(false);
});
