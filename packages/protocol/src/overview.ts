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

const estimateBasis = Type.Union([Type.Literal("coordinator"), Type.Literal("project")]);
const estimateRange = { minutes: Type.Number({ minimum: 0 }), low: Type.Number({ minimum: 0 }), high: Type.Number({ minimum: 0 }), basis: estimateBasis };
export const OverviewTimeLeftSchema = Type.Union([
 Type.Object({ kind: Type.Literal("range"), ...estimateRange,
  overrunInMs: Type.Optional(milliseconds), overrun: Type.Optional(Type.Boolean()),
 }),
 Type.Object({ kind: Type.Literal("usual"), low: estimateRange.low, high: estimateRange.high, basis: estimateBasis,
  runningSince: Type.String(), longerInMs: milliseconds, longer: Type.Boolean(),
 }),
 Type.Object({ kind: Type.Literal("stopped"), reason: Type.Union([Type.Literal("owner_wait"), Type.Literal("review")]), then: Type.Optional(Type.Object(estimateRange)) }),
 Type.Object({ kind: Type.Literal("none"), reason: Type.Union([
  Type.Literal("not_started"), Type.Literal("no_parts"), Type.Literal("not_enough_history"),
  Type.Literal("outside_wait"), Type.Literal("wide_range"), Type.Literal("all_parts_done"), Type.Literal("already_reviewed"),
 ]) }),
]);
export type OverviewTimeLeft = Static<typeof OverviewTimeLeftSchema>;

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
  left: Type.Optional(OverviewTimeLeftSchema),
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
  estimates: Type.Optional(Type.Object({ held: count, scored: count })),
  estimateReplay: Type.Optional(Type.Object({ held: count, scored: count })),
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
 // Measured finished episodes. A narrow scope also includes project samples so derivations can share the same basis.
 estimateInputs: Type.Object({
  completed: Type.Array(Type.Object({ requestId: Type.String(), coordinatorId: Type.String(), firstWorkAt: Type.String(), readyAt: Type.String(), doneAt: Type.String(), parts: count, agentMs: milliseconds })),
 }),
 coordinators: Type.Optional(Type.Array(Type.Object({ coordinatorId: Type.String(), counts, week: Type.Object({ requests: count, parts: count, taskUsage: Type.Optional(usage) }) }))),
});
export const OverviewGetResponseSchema = Type.Object({ ...OverviewEventSchema.properties, id: RequestIdSchema });
export type Overview = Static<typeof OverviewEventSchema>;
export type OverviewGetResponse = Static<typeof OverviewGetResponseSchema>;
