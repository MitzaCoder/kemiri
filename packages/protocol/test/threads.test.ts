import { describe, expect, it } from "bun:test";
import { backgroundJobCounts, HARNESS_FEATURES, LEGACY_HARNESS_FEATURES, threadState, type ThreadSummary, type ThreadStatus } from "../src/index.ts";

const summary = (status: ThreadStatus, extra: Partial<ThreadSummary> = {}): ThreadSummary => ({
 id: "fixture", title: "Fixture", status, main: false, startedBy: "main", scheduleId: null,
 conversationId: 1, model: null, thinkingLevel: null, onFinish: "record", runningWorkers: 0,
 ownedTasks: [], openQuestions: 0, current: null, summary: null, failure: null,
 createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", finishedAt: null, archived: false,
 ...extra,
});

describe("threadState", () => {
 for (const [status, questions, workers, expected] of [
  ["done", 1, 1, "finished"], ["stopped", 1, 1, "stopped"],
  ["failed", 1, 1, "failed"], ["running", 1, 1, "needs_you"],
  ["idle", 1, 0, "needs_you"], ["running", 0, 0, "working"],
  ["idle", 0, 1, "working"], ["idle", 0, 0, "paused"],
 ] as const) {
  it(`${status}, ${questions} questions, ${workers} workers → ${expected}`, () => {
   expect(threadState({ status, openQuestions: questions, runningWorkers: workers })).toBe(expected);
  });
 }
});

it("counts only unarchived background jobs; failures need the user", () => {
 expect(backgroundJobCounts([
  summary("failed"), summary("running", { openQuestions: 1 }), summary("running"),
  summary("idle", { runningWorkers: 1 }), summary("idle"), summary("done"), summary("stopped"),
  summary("failed", { main: true }), summary("running", { main: true }),
  summary("failed", { archived: true }), summary("running", { archived: true }),
 ])).toEqual({ needsYou: 2, working: 2 });
 expect(backgroundJobCounts([])).toEqual({ needsYou: 0, working: 0 });
});

it("prefers emitted state to the old-status fallback", () => {
 expect(backgroundJobCounts([summary("idle", { state: "working" }), summary("running", { state: "paused" })]))
  .toEqual({ needsYou: 0, working: 1 });
});
it("advertises thread-state, never as a legacy assumption", () => {
 expect(HARNESS_FEATURES).toContain("thread-state");
 expect(LEGACY_HARNESS_FEATURES).not.toContain("thread-state");
});
