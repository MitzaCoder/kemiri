import { type BoardTask, type BoardTaskInput } from "@kemiri/protocol";
import { askQuestion, emptyBoardState, saveTask, settleQuestion, type BoardState } from "../../src/board.ts";
import { recordOverviewStatus, type OverviewRecords } from "../../src/overview-records.ts";

const HOUR = 3_600_000;
export function bakeryOverviewFixture(now = Date.parse("2026-05-14T12:00:00.000Z")) {
 const state = emptyBoardState();
 state.taskStateEnabled = true;
 const records: OverviewRecords = { backfilled: true, tasks: {} };
 const at = (hoursAgo: number) => new Date(now - hoursAgo * HOUR).toISOString();
 const add = (title: string, hoursAgo: number, ownerThreadId: string | null, fields: Partial<BoardTaskInput> = {}) => {
  const { after } = saveTask(state, { now: at(hoursAgo), author: "user", ownerThreadId,
   task: { title, description: "Synthetic bakery work.", status: "todo", writeScopes: [], acceptance: null, blockedBy: [], blockedReason: null, ...fields } });
  recordOverviewStatus(records, after, at(hoursAgo), "user");
  return state.tasks.find(task => task.id === after.id)!;
 };
 const move = (task: BoardTask, status: BoardTask["status"], hoursAgo: number, by: "user" | "coordinator") => {
  task.status = status;
  task.updatedAt = at(hoursAgo);
  task.updatedBy = by;
  task.settledAt = status === "done" || status === "dropped" ? task.updatedAt : null;
  if (task.settledAt) (state.taskClosures ??= {})[task.id] = { by, at: task.settledAt };
  recordOverviewStatus(records, task, at(hoursAgo), by);
 };
 const run = (task: BoardTask, name: string, start: number, end: number, outcome = "reported") => {
  const row = records.tasks[task.id]!;
  (row.runs ??= {})[name] = { at: at(start), endAt: at(end), source: "worker", outcome };
 };
 const finished = add("Print the new bread labels", 9, "bakery");
 const labels = add("Check the flour labels", 8, "bakery", { parent: finished.id });
 move(finished, "in_progress", 8, "coordinator");
 move(labels, "in_progress", 8, "coordinator");
 run(labels, "labels", 8, 6);
 const question = askQuestion(state, { text: "Which loaf size should the label use?", taskId: labels.id, options: [], now: at(7), threadId: "bakery" });
 settleQuestion(state, { questionId: question.id, answer: "Small", now: at(5) });
 move(labels, "done", 5, "coordinator");
 move(finished, "review", 4, "coordinator");
 move(finished, "in_progress", 3.5, "user");
 run(finished, "review-fix", 3.5, 3);
 move(finished, "review", 3, "coordinator");
 move(finished, "done", 2, "user");
 const baking = add("Set up gift cards", 5, "bakery");
 move(baking, "in_progress", 4, "coordinator");
 const checkout = add("Add gift cards to checkout", 4, "bakery", { parent: baking.id });
 const design = add("Design the gift card", 4, "bakery", { parent: baking.id });
 move(design, "in_progress", 4, "coordinator");
 run(design, "gift-card", 3, 1, "running");
 askQuestion(state, { text: "Which payment provider issues the gift card?", taskId: checkout.id, options: [], now: at(2), threadId: "bakery" });
 const general = add("Post summer opening hours", 6, null);
 move(general, "in_progress", 4, "coordinator");
 move(general, "review", 1, "coordinator");
 const waiting = askQuestion(state, { text: "Confirm the Saturday opening time.", taskId: general.id, options: [], now: at(1), threadId: "main", blocksWork: false });
 return { now, at, state, records, finished, labels, baking, checkout, design, general, waiting };
}

export function bakeryCoordinatorOf(owner?: string | null) { return owner === "bakery" ? owner : "main"; }
export function withBakeryLiveWork(board: BoardState, taskId: string, at: string) {
 board.taskActivityEnabled = true;
 board.taskLiveEnabled = true;
 board.taskActivity = { [taskId]: { sources: { "gift-card": {
  actor: { id: "gift-card", kind: "worker", name: "gift-card", threadId: "bakery", conversationId: 10, runId: "1" },
  state: "running", since: at, title: "Design the gift card",
  livePlan: [{ text: "Draw gift card", status: "done", doneAt: at }, { text: "Review gift card", status: "doing" }, { text: "Save gift card", status: "todo" }],
 } } } };
}
