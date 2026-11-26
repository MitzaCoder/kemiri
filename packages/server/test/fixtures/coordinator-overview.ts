import { type BoardTask, type BoardTaskInput } from "@kemiri/protocol";
import { askQuestion, emptyBoardState, saveTask, settleQuestion, type BoardState } from "../../src/board.ts";
import { recordOverviewStatus, type OverviewRecords } from "../../src/overview-records.ts";

const HOUR = 3_600_000;
export function bakeryOverviewFixture(now = Date.parse("2026-05-14T12:00:00.000Z"), forDemo = false) {
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
 if (forDemo) {
  const completedDesign = add("Write the gift card terms", 4.5, "bakery", { parent: baking.id });
  move(completedDesign, "done", 2.5, "coordinator");
  const allergen = add("Show allergens on product pages", 7, "bakery");
  move(allergen, "in_progress", 6, "coordinator");
  const allergenText = add("Write the allergen labels", 6, "bakery", { parent: allergen.id });
  add("Review the ingredient list", 6, "bakery", { parent: allergen.id });
  askQuestion(state, { text: "Show ‘may contain’ as well as ‘contains’?", taskId: allergenText.id, options: ["Show both", "Show ‘contains’ only"], now: at(3.2), threadId: "bakery" });
  const search = add("Speed up product search", 6, "bakery");
  move(search, "in_progress", 5, "coordinator");
  run(search, "product-search", 5, 4);
  move(search, "review", .4, "coordinator");
  add("Order tracking page", 4, "bakery");
  add("Publish the holiday banner", 2, null);
  const finishRequest = (title: string, hoursAgo: number, ownerThreadId: string | null, parts: number, agentHours = 3) => {
   const request = add(title, hoursAgo + agentHours + 2, ownerThreadId);
   move(request, "in_progress", hoursAgo + agentHours + 1, "coordinator");
   for (let index = 0; index < parts; index++) {
    const part = add(`${["Draft", "Check", "Publish"][index]}: ${title}`, hoursAgo + 1 + .85 * agentHours, ownerThreadId, { parent: request.id });
    move(part, "in_progress", hoursAgo + 1 + .67 * agentHours, "coordinator");
    run(part, `part-${index}`, hoursAgo + 1 + .67 * agentHours, hoursAgo + 1 + .15 * agentHours);
    move(part, "done", hoursAgo + 1 + .15 * agentHours, "coordinator");
   }
   move(request, "review", hoursAgo + 1, "coordinator");
   move(request, "done", hoursAgo, "user");
  };
  finishRequest("Add rye and oat bread to the catalogue", 26, "bakery", 2);
  finishRequest("Publish the pickup instructions", 27, "bakery", 1);
  finishRequest("Point the receipt to the order page", 51, "bakery", 1);
  finishRequest("Show sold-out items next to substitutes", 74, "bakery", 3);
  finishRequest("Add a note for flour substitutions", 77, "bakery", 0);
  finishRequest("Add opening hours to the footer", 98, null, 1);
  finishRequest("Group recipes by bread type", 125, "bakery", 2);
  finishRequest("Publish the winter hours notice", 130, null, 1);
  finishRequest("Update pickup instructions for market days", 180, "bakery", 2, 1);
  finishRequest("Add substitutions to the recipe cards", 194, "bakery", 3, 2);
  finishRequest("Group the morning pastries", 202, "bakery", 2, 1.5);
  finishRequest("Update the returns page", 218, "bakery", 2, 1.25);
  finishRequest("Add a receipt option for large orders", 235, "bakery", 2, 1.75);
  finishRequest("Add the large-order collection card", 246, "bakery", 3, 2.25);
  records.tasks[finished.id]!.firstEstimate = { at: at(8), baselineMs: 3 * HOUR, minutes: 180, low: 120, high: 240 };
 }
 return { now, at, state, records, finished, labels, baking, checkout, design, general, waiting };
}

export function bakeryCoordinatorOf(owner?: string | null) { return owner === "bakery" ? owner : "main"; }
export function withBakeryLiveWork(board: BoardState, taskId: string, at: string, conversationId = 10) {
 board.taskActivityEnabled = true;
 board.taskLiveEnabled = true;
 board.taskActivity = { [taskId]: { sources: { "gift-card": {
  actor: { id: "gift-card", kind: "worker", name: "gift-card", threadId: "bakery", conversationId, runId: "1" },
  state: "running", since: at, title: "Design the gift card",
  livePlan: [{ text: "Draw gift card", status: "done", doneAt: at }, { text: "Review gift card", status: "doing" }, { text: "Save gift card", status: "todo" }],
 } } } };
}
