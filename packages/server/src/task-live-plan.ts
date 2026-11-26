import { BoardLivePlanStatusSchema, LIVE_PLAN_MAX_STEPS, LIVE_PLAN_MIN_STEPS, LIVE_PLAN_STEP_MAX_CHARS, livePlanProgress, type BoardLivePlanStep } from "@kemiri/protocol";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { ServerError } from "./errors.ts";

export const LivePlanInputSchema = Type.Array(Type.Object({
 text: Type.String({ minLength: 1, maxLength: LIVE_PLAN_STEP_MAX_CHARS, pattern: "\\S" }),
 status: Type.Optional(BoardLivePlanStatusSchema),
}), { minItems: LIVE_PLAN_MIN_STEPS, maxItems: LIVE_PLAN_MAX_STEPS, description: "Replace the run's plan with three to seven short steps. Omit status to keep the status of a matching step." });
export const LivePlanTickSchema = Type.Array(Type.Integer({ minimum: 1, maximum: LIVE_PLAN_MAX_STEPS }), {
 minItems: 1, maxItems: LIVE_PLAN_MAX_STEPS, uniqueItems: true, description: "Mark these 1-based plan steps done. With a replacement plan, tick numbers refer to that new plan.",
});
export type LivePlanUpdate = {
 plan?: unknown;
 tick?: unknown;
};

const normalizeStepText = (text: string) => text.replace(/\s+/g, " ").trim();

export function updateLivePlan(previous: readonly BoardLivePlanStep[] | undefined, { plan, tick }: LivePlanUpdate, at?: string): BoardLivePlanStep[] {
 if (plan !== undefined && !Value.Check(LivePlanInputSchema, plan)) {
  throw new ServerError("bad_request", `A plan needs ${LIVE_PLAN_MIN_STEPS} to ${LIVE_PLAN_MAX_STEPS} steps with nonblank text up to ${LIVE_PLAN_STEP_MAX_CHARS} characters and optional todo, doing or done status.`);
 }
 if (tick !== undefined && !Value.Check(LivePlanTickSchema, tick)) {
  throw new ServerError("bad_request", "Tick needs distinct 1-based plan step numbers.");
 }
 const previousByText = new Map<string, BoardLivePlanStep[]>();
 for (const step of previous ?? []) {
  const key = normalizeStepText(step.text).toLowerCase();
  const statuses = previousByText.get(key) ?? [];
  statuses.push(step);
  previousByText.set(key, statuses);
 }
 const next: BoardLivePlanStep[] | undefined = plan?.map(({ text, status }) => {
  const clean = normalizeStepText(text);
  const prior = previousByText.get(clean.toLowerCase())?.shift();
  const nextStatus = status ?? prior?.status ?? "todo";
  const doneAt = nextStatus === "done" ? (prior?.status === "done" ? prior.doneAt : at) : undefined;
  return { text: clean, status: nextStatus, ...(doneAt ? { doneAt } : {}) };
 }) ?? previous?.map(step => ({ ...step }));
 if (!next) throw new ServerError("bad_request", "Write a plan before ticking its steps.");
 if (tick?.some(number => number > next.length)) throw new ServerError("bad_request", `Tick numbers must be between 1 and ${next.length}.`);
 for (const number of tick ?? []) {
  const step = next[number - 1]!;
  if (step.status !== "done" && at) step.doneAt = at;
  step.status = "done";
 }
 // An explicit doing step outranks an inherited doing step. Keep one in plan order.
 const explicitDoing = plan?.findIndex((step, index) => step.status === "doing" && next[index]?.status === "doing") ?? -1;
 const doing = explicitDoing >= 0 ? explicitDoing : next.findIndex(step => step.status === "doing");
 if (doing >= 0) next.forEach((step, index) => { if (index !== doing && step.status === "doing") step.status = "todo"; });
 else if (tick?.length) {
  const nextTodo = next.find(step => step.status === "todo");
  if (nextTodo) nextTodo.status = "doing";
 }
 return next;
}

export function describeLivePlan(plan: readonly BoardLivePlanStep[]): string {
 const mark = { done: "x", doing: ">", todo: " " };
 return [`Plan (${livePlanProgress(plan)}):`, ...plan.map((step, index) => `${index + 1}. [${mark[step.status]}] ${step.text}`)].join("\n");
}
