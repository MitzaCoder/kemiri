/**
 * Projects share a board and memory across threads: General (`main`), long-lived
 * coordinators for named areas and background jobs. Additional coordinators and
 * jobs have their own workspaces. Only jobs finish and report to General at this
 * stage. `thread_send` delivers requests to peers, and plain replies do not wake
 * an idle receiver. The existing list shape remains readable by older clients.
 */
import { type Static, Type } from "typebox";
import { ModelRefSchema, ProjectIdSchema, RequestIdSchema, ThinkingLevelSchema } from "./common.ts";

/** The main thread's ID, in every place a thread ID goes. */
export const MAIN_THREAD_ID = "main";

/** How the harness marks what threads post into another thread's transcript. */
export const THREAD_FINISHED_PREFIX = "[thread ";
export const THREAD_MESSAGE_PREFIX = "[from ";

/**
 * - `running`: a turn is in progress, or its workers are running.
 * - `idle`: waiting (for workers, a message, the user) without having finished.
 * - `failed`: its last turn failed; nothing runs.
 * - `stopped`: stopped by main or the user.
 * - `done`: finished with a summary.
 */
export const ThreadStatusSchema = Type.Union([
	Type.Literal("running"),
	Type.Literal("idle"),
	Type.Literal("failed"),
	Type.Literal("stopped"),
	Type.Literal("done"),
]);
export type ThreadStatus = Static<typeof ThreadStatusSchema>;

export const ThreadStateSchema = Type.Union([
 Type.Literal("needs_you"), Type.Literal("working"), Type.Literal("paused"),
 Type.Literal("failed"), Type.Literal("finished"), Type.Literal("stopped"),
]);
export type ThreadState = Static<typeof ThreadStateSchema>;

export const ThreadStartedBySchema = Type.Union([Type.Literal("main"), Type.Literal("schedule"), Type.Literal("user")]);
export type ThreadStartedBy = Static<typeof ThreadStartedBySchema>;

export const ThreadKindSchema = Type.Union([Type.Literal("coordinator"), Type.Literal("job")]);
export type ThreadKind = Static<typeof ThreadKindSchema>;

const ThreadAttentionSchema = Type.Object({
	questions: Type.Integer({ minimum: 0 }),
	warnings: Type.Integer({ minimum: 0 }),
	steps: Type.Integer({ minimum: 0 }),
	review: Type.Integer({ minimum: 0 }),
	failed: Type.Integer({ minimum: 0 }),
});

export const ThreadSummarySchema = Type.Object({
	id: Type.String({ minLength: 1, description: 'Unique in the project; "main" is the main thread.' }),
	title: Type.String(),
	status: ThreadStatusSchema,
 state: Type.Optional({ ...ThreadStateSchema, description: "What the user reads, derived at emission, never stored; absent from older servers." }),
	main: Type.Boolean(),
	kind: Type.Optional(ThreadKindSchema),
	parentThreadId: Type.Optional(Type.String()),
	area: Type.Optional(Type.String()),
	paths: Type.Optional(Type.Array(Type.String())),
	color: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	order: Type.Optional(Type.Integer()),
	held: Type.Optional(Type.Boolean()),
	attention: Type.Optional(ThreadAttentionSchema),
	lastReplyAt: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	lastReplyEntryId: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
	openTasks: Type.Optional(Type.Integer({ minimum: 0 })),
	startedBy: Type.Union([ThreadStartedBySchema, Type.Null()], { description: "Null for main." }),
	scheduleId: Type.Union([Type.String(), Type.Null()]),
	conversationId: Type.Integer({ minimum: 1 }),
	model: Type.Union([ModelRefSchema, Type.Null()]),
	thinkingLevel: Type.Union([ThinkingLevelSchema, Type.Null()]),
	onFinish: Type.Union([Type.Literal("review"), Type.Literal("record")], {
		description: "What its summary does in main: wake it to review, or just record it.",
	}),
	runningWorkers: Type.Integer({ minimum: 0 }),
	taskId: Type.Optional(
		Type.Union([Type.String(), Type.Null()], {
			description: "The board task it was started for; it reports there. Null for main and for threads from older servers.",
		}),
	),
	ownedTasks: Type.Array(Type.String(), { description: "Board task IDs this thread owns." }),
	openQuestions: Type.Integer({ minimum: 0, description: "Board questions this thread asked that wait on the user." }),
	current: Type.Union([Type.String(), Type.Null()], {
		description: 'One line on what it is doing now, e.g. "Running bash · 3m" or "Waiting for 2 workers".',
	}),
	summary: Type.Union([Type.String(), Type.Null()], { description: "Its finish summary, when done." }),
	failure: Type.Union([Type.String(), Type.Null()]),
	createdAt: Type.String(),
	updatedAt: Type.String(),
	finishedAt: Type.Union([Type.String(), Type.Null()]),
	archived: Type.Boolean(),
});
export type ThreadSummary = Static<typeof ThreadSummarySchema>;

// --- requests ----------------------------------------------------------------------------------------------------

/** Every thread of the project, main first. Archived ones only when asked for. */
export const ThreadsListRequestSchema = Type.Object({
	type: Type.Literal("threads.list"),
	id: RequestIdSchema,
	projectId: ProjectIdSchema,
	includeArchived: Type.Optional(Type.Boolean()),
});
export type ThreadsListRequest = Static<typeof ThreadsListRequestSchema>;

/** Stop a background thread: its running turn and workers are aborted. Main cannot be stopped this way. */
export const ThreadsStopRequestSchema = Type.Object({
	type: Type.Literal("threads.stop"),
	id: RequestIdSchema,
	projectId: ProjectIdSchema,
	threadId: Type.String({ minLength: 1 }),
});
export type ThreadsStopRequest = Static<typeof ThreadsStopRequestSchema>;

export const ThreadsArchiveRequestSchema = Type.Object({
	type: Type.Literal("threads.archive"),
	id: RequestIdSchema,
	projectId: ProjectIdSchema,
	threadId: Type.String({ minLength: 1 }),
	archived: Type.Boolean({ description: "False brings it back." }),
	moveTasksTo: Type.Optional(Type.String({ minLength: 1 })),
	operationId: Type.Optional(RequestIdSchema),
});
export type ThreadsArchiveRequest = Static<typeof ThreadsArchiveRequestSchema>;

const title = Type.String({ minLength: 1, maxLength: 120 });
const area = Type.String({ minLength: 1, maxLength: 2000 });
const coordinatorSettings = {
	paths: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { maxItems: 100 })),
	color: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 40 }), Type.Null()])),
	model: Type.Optional(ModelRefSchema),
	thinkingLevel: Type.Optional(Type.Union([ThinkingLevelSchema, Type.Null()])),
};

export const ThreadsCreateRequestSchema = Type.Object({
	type: Type.Literal("threads.create"), id: RequestIdSchema, projectId: ProjectIdSchema,
	title, area, ...coordinatorSettings, operationId: Type.Optional(RequestIdSchema),
	taskIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});
export type ThreadsCreateRequest = Static<typeof ThreadsCreateRequestSchema>;

export const ThreadsUpdateRequestSchema = Type.Object({
	type: Type.Literal("threads.update"), id: RequestIdSchema, projectId: ProjectIdSchema,
	threadId: Type.String({ minLength: 1 }), title: Type.Optional(title), area: Type.Optional(area),
	...coordinatorSettings, operationId: Type.Optional(RequestIdSchema), order: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type ThreadsUpdateRequest = Static<typeof ThreadsUpdateRequestSchema>;

export const ThreadsHoldRequestSchema = Type.Object({
	type: Type.Literal("threads.hold"), id: RequestIdSchema, projectId: ProjectIdSchema,
	threadId: Type.String({ minLength: 1 }), held: Type.Boolean(), operationId: Type.Optional(RequestIdSchema),
});
export type ThreadsHoldRequest = Static<typeof ThreadsHoldRequestSchema>;

// --- responses ---------------------------------------------------------------------------------------------------

export const ThreadsListResponseSchema = Type.Object({
	type: Type.Literal("threads.list"),
	id: RequestIdSchema,
	threads: Type.Array(ThreadSummarySchema),
});
export type ThreadsListResponse = Static<typeof ThreadsListResponseSchema>;

export const ThreadsStopResponseSchema = Type.Object({
	type: Type.Literal("threads.stop"),
	id: RequestIdSchema,
	thread: ThreadSummarySchema,
});
export type ThreadsStopResponse = Static<typeof ThreadsStopResponseSchema>;

export const ThreadsArchiveResponseSchema = Type.Object({
	type: Type.Literal("threads.archive"),
	id: RequestIdSchema,
	thread: ThreadSummarySchema,
});
export type ThreadsArchiveResponse = Static<typeof ThreadsArchiveResponseSchema>;

export const ThreadsCreateResponseSchema = Type.Object({
	type: Type.Literal("threads.create"), id: RequestIdSchema, thread: ThreadSummarySchema,
});
export type ThreadsCreateResponse = Static<typeof ThreadsCreateResponseSchema>;

export const ThreadsUpdateResponseSchema = Type.Object({
	type: Type.Literal("threads.update"), id: RequestIdSchema, thread: ThreadSummarySchema,
});
export type ThreadsUpdateResponse = Static<typeof ThreadsUpdateResponseSchema>;

export const ThreadsHoldResponseSchema = Type.Object({
	type: Type.Literal("threads.hold"), id: RequestIdSchema, thread: ThreadSummarySchema,
});
export type ThreadsHoldResponse = Static<typeof ThreadsHoldResponseSchema>;

// --- server events -----------------------------------------------------------------------------------------------

/** The project's threads without archived ones, pushed to every connection whenever any changes. */
export const ThreadsStateEventSchema = Type.Object({
	type: Type.Literal("threads.state"),
	projectId: ProjectIdSchema,
	threads: Type.Array(ThreadSummarySchema),
});
export type ThreadsStateEvent = Static<typeof ThreadsStateEventSchema>;

/** First match wins: terminal status, failure, question, live work, then pause. */
export function threadState(t: Pick<ThreadSummary, "status" | "openQuestions" | "runningWorkers">): ThreadState {
 if (t.status === "done") return "finished";
 if (t.status === "stopped") return "stopped";
 if (t.status === "failed") return "failed";
 if (t.openQuestions > 0) return "needs_you";
 if (t.status === "running" || t.runningWorkers > 0) return "working";
 return "paused";
}

/** Counts only unarchived background jobs; a failure also needs the user. */
export function backgroundJobCounts(threads: readonly ThreadSummary[], _now?: number): { needsYou: number; working: number } {
 const counts = { needsYou: 0, working: 0 };
 for (const t of threads) {
  if (t.main || t.archived) continue;
  const state = t.state ?? threadState(t);
  if (state === "needs_you" || state === "failed") counts.needsYou++;
  else if (state === "working") counts.working++;
 }
 return counts;
}
