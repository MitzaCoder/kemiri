import { Type, type Static } from "typebox";
import { BoardTaskStatusSchema } from "./board.ts";
import { ProjectIdSchema, RequestIdSchema } from "./common.ts";

const count = Type.Integer({ minimum: 0 });
const milliseconds = Type.Number({ minimum: 0 });
const coordinatorId = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);
const scope = Type.Object({ projectId: ProjectIdSchema, coordinatorId });
const counts = Type.Object({ open: count, running: count, waitingOnOwner: count, oldestWaitSince: Type.Optional(Type.String()) });
const durationSample = Type.Object({ count, medianMs: milliseconds, p75Ms: milliseconds });
const countRange = Type.Object({ low: Type.Number(), high: Type.Number() });
const usage = Type.Object({ apiValue: Type.Number(), unpricedRequests: count });

export const OverviewGetRequestSchema = Type.Object({ type: Type.Literal("overview.get"), id: RequestIdSchema,
 ...scope.properties, subscribe: Type.Optional(Type.Boolean()),
});
export type OverviewGetRequest = Static<typeof OverviewGetRequestSchema>;

// A reply and a push share the same fields. Pushes omit the request ID.
export const OverviewEventSchema = Type.Object({
 type: Type.Literal("overview"), asOf: Type.String(), scope, counts,
 waiting: Type.Array(Type.Object({
  kind: Type.Union([Type.Literal("question"), Type.Literal("warning"), Type.Literal("review"), Type.Literal("steps")]),
  taskId: Type.Union([Type.String(), Type.Null()]), requestId: Type.Union([Type.String(), Type.Null()]),
  questionId: Type.Optional(Type.String()), since: Type.String(), holdsParts: count,
 })),
 inFlight: Type.Array(Type.Object({
  requestId: Type.String(),
  parts: Type.Optional(Type.Object({ done: count, total: count, working: count, needsOwner: count })),
  planStep: Type.Optional(Type.Object({ taskId: Type.String(), number: count, total: count, text: Type.String() })),
  runningSince: Type.Optional(Type.String()), firstWorkAt: Type.Optional(Type.String()),
  heldUp: Type.Boolean(),
 })),
 week: Type.Object({
  requests: count, parts: count, perDay: Type.Array(Type.Object({ day: Type.String(), requests: count, parts: count }), { minItems: 7, maxItems: 7 }),
  usualWeek: Type.Optional(countRange), startToDoneMs: Type.Optional(milliseconds),
  split: Type.Optional(Type.Object({ agentsMs: milliseconds, waitingMs: milliseconds, otherMs: milliseconds })),
  sentBack: count, reopened: count,
  taskUsage: Type.Optional(usage), coordinatorUsage: Type.Optional(usage), usualRequestValue: Type.Optional(Type.Number()),
 }),
 more: Type.Object({
  heldUpTodayMs: milliseconds,
  statusTimes: Type.Array(Type.Object({ status: BoardTaskStatusSchema, medianMs: milliseconds })),
  runs: Type.Object({ started: count, failed: count, stopped: count, tasksWithMultipleRuns: count, workerMs: milliseconds, medianMs: Type.Optional(milliseconds) }),
  questions: Type.Object({ asked: count, answered: count, answerTime: Type.Optional(durationSample) }),
  reviews: Type.Optional(durationSample),
  checks: Type.Object({ passed: count, failed: count }),
  modelRequests: Type.Optional(Type.Object({ errors: count, aborted: count })),
  runningJobs: Type.Array(Type.String()),
  nextSchedule: Type.Optional(Type.Object({ scheduleId: Type.String(), at: Type.String() })),
  deploys: Type.Optional(Type.Object({ landed: count, failed: count, rolledBack: count })),
 }),
 // Finished episodes for stage 3, not a forecast. Project samples are also sent in a narrow scope for fallback.
 estimateInputs: Type.Object({
  completed: Type.Array(Type.Object({ requestId: Type.String(), coordinatorId: Type.String(), firstWorkAt: Type.String(), readyAt: Type.String(), doneAt: Type.String(), parts: count, agentMs: milliseconds })),
 }),
 coordinators: Type.Optional(Type.Array(Type.Object({ coordinatorId: Type.String(), counts, week: Type.Object({ requests: count, parts: count, taskUsage: Type.Optional(usage) }) }))),
});
export const OverviewGetResponseSchema = Type.Object({ ...OverviewEventSchema.properties, id: RequestIdSchema });
export type Overview = Static<typeof OverviewEventSchema>;
export type OverviewGetResponse = Static<typeof OverviewGetResponseSchema>;
