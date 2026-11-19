import { expect, it } from "bun:test";
import { updateLivePlan, type LivePlanUpdate } from "../src/task-live-plan.ts";

const plan = [{ text: "Trace payments" }, { text: "Check balances" }, { text: "Run tests" }];

it("ticks by number and carries forward the statuses of rewritten steps", () => {
 const first = updateLivePlan(undefined, { plan });
 expect(first.map(step => step.status)).toEqual(["todo", "todo", "todo"]);
 const ticked = updateLivePlan(first, { tick: [1] });
 expect(ticked.map(step => step.status)).toEqual(["done", "doing", "todo"]);
 expect(updateLivePlan(ticked, { tick: [1] })).toEqual(ticked);
 const rewritten = updateLivePlan(ticked, { plan: [{ text: "Check balances" }, { text: "  TRACE   Payments  " }, { text: "Read the receipt" }] });
 expect(rewritten).toEqual([
  { text: "Check balances", status: "doing" }, { text: "TRACE Payments", status: "done" }, { text: "Read the receipt", status: "todo" },
 ]);
 expect(updateLivePlan(rewritten, { tick: [1, 3] }).map(step => step.status)).toEqual(["done", "done", "done"]);
});

it("uses one doing step and lets explicit statuses override inherited ones", () => {
 const first = updateLivePlan(undefined, { plan: plan.map(step => ({ ...step, status: "doing" })) });
 expect(first.map(step => step.status)).toEqual(["doing", "todo", "todo"]);
 const rewrite = updateLivePlan(first, { plan: [plan[0], { ...plan[1], status: "doing" }, { ...plan[2], status: "doing" }] });
 expect(rewrite.map(step => step.status)).toEqual(["todo", "doing", "todo"]);
 expect(updateLivePlan(rewrite, { plan: [plan[2], plan[1], { ...plan[0], status: "done" }], tick: [2] }).map(step => step.status)).toEqual(["doing", "done", "done"]);
});

it.each([
 { plan: plan.slice(0, 2) }, { plan: Array(8).fill(plan[0]) },
 { plan: [{ text: "x".repeat(81) }, ...plan] }, { plan: [{ text: "  \n  " }, ...plan] },
 { plan: [{ text: "Unknown status", status: "finished" }, ...plan] },
 { tick: [] }, { tick: [0] }, { tick: [4] }, { tick: [1.5] }, { tick: [1, 1] },
] satisfies LivePlanUpdate[])("rejects an invalid plan or tick: %j", change => {
 const prior = updateLivePlan(undefined, { plan });
 expect(() => updateLivePlan(prior, change)).toThrow();
 expect(prior.map(step => step.status)).toEqual(["todo", "todo", "todo"]);
});

it("accepts the largest allowed plan and rejects ticking before any plan exists", () => {
 const longest = Array.from({ length: 7 }, (_, n) => ({ text: String(n).repeat(80) }));
 const final = updateLivePlan(undefined, { plan: longest, tick: [7] });
 expect(final).toHaveLength(7);
 expect(final[6]?.status).toBe("done");
 expect(() => updateLivePlan(undefined, { tick: [1] })).toThrow("Write a plan");
});
