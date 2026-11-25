/**
 * The board: the coordinator's working state for a project.
 *
 * Tasks (with dependencies, advisory write scopes and the workers that ran them), questions waiting on the user, and
 * decisions. It is a durable document on the coordinator's conversation. The coordinator changes it with its `board`
 * tool; the harness changes it when a worker for a task starts, reports or fails, and when a scheduled run fails or is
 * skipped; the user changes it from the app. Every row carries a `revision`: a change names the revision it was made
 * on and is refused with `board_conflict` when the row moved on since, so nobody overwrites a newer edit.
 *
 * The board is shared by every thread of the project (see threads.ts): a task's `ownerThreadId` says which thread
 * claimed it, and claiming uses the same revision check, so two threads cannot take the same task.
 *
 * The user's changes reach the coordinator as `[board]` inputs; an answered question reaches it like a message.
 * `done` and `dropped` tasks are archived 7 days after they settle: out of the coordinator's view, still listed with
 * `includeArchived`.
 *
 * Every subject the user raises is a task, and each task carries a short `report` the agents keep current by rewriting
 * it in place: what is happening now, what came out of it, what comes next. The user reads tasks instead of the chat.
 * A report change that names a milestone, and every status change, saves a snapshot of the task, listed by
 * `board.task.history`. Only the owner closes a request (a task with no parent). The coordinator marks a checked
 * part `done` or drops it with a reason. Only requests go to `review` through the board tool.
 *
 * Tasks link to each other (parent, origin, related, blockedBy; each shown from both sides), and the user's messages
 * about a task become feedback entries on it with a state of their own. `board.task.timeline` lists everything that
 * happened to a task in time order. See DESIGN.md, "Task links and feedback".
 */
import { type Static, type TSchema, Type } from "typebox";
import { ProjectIdSchema, RequestIdSchema } from "./common.ts";

/** How the harness marks the board changes it posts to the coordinator: `[board]` followed by what changed. */
export const BOARD_PREFIX = "[board]";

/**
 * How a user message names the task it is about: the input text starts with `[task T12] `, or `[task T12, feedback F3] `
 * on a server that records the message as feedback on the task. The server writes it when a `conversation.submit` carries
 * `taskId`; the app shows it as a chip on the message. A reader takes the task ID up to the first comma.
 */
export const TASK_REFERENCE_PREFIX = "[task ";

export const BoardTaskStatusSchema = Type.Union(
	[
		Type.Literal("todo"),
		Type.Literal("in_progress"),
		Type.Literal("blocked"),
		Type.Literal("review"),
		Type.Literal("waiting"),
		Type.Literal("done"),
		Type.Literal("dropped"),
	],
	{
		description:
			"todo: not started. in_progress: being worked on. blocked: waiting on a dependency or stopped by a failure (see blockedReason). review: ready for the user to review. done: closed. dropped: will not be done. Only the owner closes requests; coordinators close parts.",
	},
);
export type BoardTaskStatus = Static<typeof BoardTaskStatusSchema>;

export const BoardAuthorSchema = Type.Union([
	Type.Literal("user"),
	Type.Literal("coordinator"),
	Type.Literal("harness"),
]);
export type BoardAuthor = Static<typeof BoardAuthorSchema>;

const Revision = Type.Integer({ minimum: 1, description: "Bumped on every change to this row." });

/** Who wrote a report or a snapshot: a coordinator (main or a background thread), one of its workers, the user or the harness. */
export const BoardWriterSchema = Type.Object({
	author: Type.Union([BoardAuthorSchema, Type.Literal("worker")]),
	threadId: Type.Union([Type.String(), Type.Null()], { description: 'The coordinator thread, "main" for main; null for the user and the harness.' }),
	workerId: Type.Union([Type.String(), Type.Null()], { description: "Set when a worker wrote it." }),
});
export type BoardWriter = Static<typeof BoardWriterSchema>;

/** Section-local age and coverage; optional container means an older backend. No timeline row is created. */
export const BoardReportSectionSchema = Type.Object({
	writtenAt: Type.Union([Type.String(), Type.Null()], { description: "ISO date, null when never written. Show written 2 h ago; prefix approximate dates with about." }),
	writtenBy: Type.Union([BoardWriterSchema, Type.Null()]),
	version: Type.Integer({ minimum: 0, description: "Changes only for a substantive rewrite of this section; no-op writes do not rearm nudges." }),
	coveredEventSeq: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()], { description: "Highest task event sequence covered by the rewrite. Omitted agent coverage defaults to the sequence at write time; null is unknown legacy coverage." }),
	approximate: Type.Boolean({ description: "Legacy date inferred from the shared report timestamp, not a known section write." }),
	stale: Type.Boolean({ description: "Preserve the prose but show needs update. Empty Results at review/done: No results yet · work finished." }),
	eventsSince: Type.Integer({ minimum: 0, description: "Uncovered meaningful facts, not timeline rows. Show 6 events since; counts keep updating after the one nudge." }),
	reasons: Type.Array(Type.String(), { description: "Short deterministic causes, e.g. Q121 answered; work advanced. Empty when current." }),
	waitsOn: Type.Optional(Type.Array(Type.String(), { description: "Next only: explicit Q/task/change/deploy IDs. Without it any answered/withdrawn task question invalidates nonempty Next." })),
});
export type BoardReportSection = Static<typeof BoardReportSectionSchema>;

export const REPORT_BLOCK_SECTIONS = ["summary", "results", "notDone", "next", "steps"] as const;
export type ReportBlockSection = (typeof REPORT_BLOCK_SECTIONS)[number];

// Keep this JSON Schema pattern valid in Go's RE2 (Antigravity) as well as JavaScript.
// Use literal Unicode characters in the pattern and spell out JS whitespace: RE2's \s is ASCII-only.
const lineBreaks = "\\r\\n\u2028\u2029";
const singleLineWhitespace = "\\t\\v\\f \u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\ufeff";
const singleLine = (description: string) => Type.String({ pattern: `^[${singleLineWhitespace}]*[^${singleLineWhitespace}${lineBreaks}][^${lineBreaks}]*$`, description });
const reportProse = singleLine("Short prose with optional inline emphasis, code or safe links.");
const reportTitle = singleLine("A short plain-text heading.");
const reportBlock = <K extends string, P extends Record<string, import("typebox").TSchema>>(kind: K, fields: P) =>
	Type.Object({ kind: Type.Literal(kind), ...fields }, { additionalProperties: false });

const outcomeBlock = reportBlock("outcome", { text: reportProse });
const riskBlock = reportBlock("risk", { title: reportTitle, text: reportProse });
const nextActionBlock = reportBlock("nextAction", { text: reportProse });
const stepBlock = reportBlock("step", {
	text: reportProse,
	copyText: Type.Optional(Type.String({ pattern: "\\S", description: "Exact copyable value or command, possibly multiline." })),
	language: Type.Optional(Type.String({ pattern: "^[A-Za-z0-9_+.#-]+$", description: "Optional code language for display only." })),
});
const markdownBlock = reportBlock("markdown", { text: Type.String({ pattern: "\\S", description: "Server-preserved legacy Markdown; not authorable." }) });
const resultBlocks = [
	outcomeBlock,
	reportBlock("finding", { title: reportTitle, text: reportProse }),
	reportBlock("setup", { title: reportTitle, facts: Type.Array(Type.Object({ label: singleLine("Plain-text name."), value: singleLine("Plain-text value.") }, { additionalProperties: false }), { minItems: 1, maxItems: 8 }) }),
	reportBlock("proof", {
		text: reportProse,
		artifactRef: Type.Object({ artifactId: Type.String({ pattern: "^[A-Za-z0-9_-]+$", description: "Saved artifact ID on this task, without a version suffix." }), version: Type.Optional(Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "An optional retained version." })) }, { additionalProperties: false }),
	}),
	reportBlock("cleanup", { text: reportProse }),
	riskBlock,
	reportBlock("metric", { label: singleLine("Plain-text measurement name."), value: Type.Number(), unit: Type.Optional(singleLine("Plain-text unit.")), context: Type.Optional(reportProse) }),
] as const;
export const ResultBlockSchema = Type.Union([...resultBlocks]);
export type ResultBlock = Static<typeof ResultBlockSchema>;
export const ReportBlockSchema = Type.Union([...resultBlocks, markdownBlock, nextActionBlock, stepBlock]);
export type ReportBlock = Static<typeof ReportBlockSchema>;

const reportBlockSections = {
	summary: Type.Optional(Type.Array(outcomeBlock, { maxItems: 2 })),
	notDone: Type.Optional(Type.Array(riskBlock, { maxItems: 64 })),
	next: Type.Optional(Type.Array(nextActionBlock, { maxItems: 64 })),
	steps: Type.Optional(Type.Array(stepBlock, { maxItems: 64 })),
};
export const ReportBlocksInputSchema = Type.Object({
	...reportBlockSections,
	results: Type.Optional(Type.Array(ResultBlockSchema, { maxItems: 64 })),
}, { additionalProperties: false, description: "Replace each named section in order. Omit to preserve; [] clears. Do not also send Markdown for the same section. Up to 32 KiB per write." });
export type ReportBlocksInput = Static<typeof ReportBlocksInputSchema>;
export const ReportBlocksSchema = Type.Object({
	...reportBlockSections,
	results: Type.Optional(Type.Array(Type.Union([...resultBlocks, markdownBlock]), { maxItems: 64 })),
}, { description: "Authoritative typed sections, with Markdown mirrors in the sibling string fields." });
export type ReportBlocks = Static<typeof ReportBlocksSchema>;

export const REPORT_SECTION_VIEW_SECTIONS = ["results", "notDone"] as const;
export type ReportSectionViewSection = (typeof REPORT_SECTION_VIEW_SECTIONS)[number];

export const ReportSectionViewSchema = Type.Object({
	artifactId: Type.String({ pattern: "^[A-Za-z0-9_-]+$", description: "Saved artifact ID on this task, without a version suffix." }),
	version: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Exact retained version, never latest." }),
	label: Type.String({ pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f\\u2028\\u2029]+$", maxLength: 80, description: "Short, plain-text button label." }),
}, { additionalProperties: false });
export type ReportSectionView = Static<typeof ReportSectionViewSchema>;
export const ReportSectionViewsSchema = Type.Object({
	results: Type.Optional(ReportSectionViewSchema),
	notDone: Type.Optional(ReportSectionViewSchema),
}, { description: "Pinned supplemental HTML views. The report blocks hold the required facts." });
export type ReportSectionViews = Static<typeof ReportSectionViewsSchema>;

const BoardReportStepsSchema = Type.Optional(Type.String({ description: "task-steps: Your steps, a numbered Markdown list of manual actions with exact values and copyable commands. Absent when cleared." }));

export const BoardReportCheckSchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	result: Type.Union([Type.Literal("passed"), Type.Literal("failed")]),
	count: Type.Optional(Type.Integer({ minimum: 0 })),
	note: Type.Optional(Type.String()),
	at: Type.String({ description: "ISO timestamp of the check." }),
});
export type BoardReportCheck = Static<typeof BoardReportCheckSchema>;

const BoardReportOutcomeSchema = {
	blocks: Type.Optional(ReportBlocksSchema),
	sectionViews: Type.Optional(ReportSectionViewsSchema),
	summary: Type.Optional(Type.String({ description: "One or two sentences about what came out of the task, above Results." })),
	notDone: Type.Optional(Type.String({ description: "Markdown, one item per line, about what is missing or left out." })),
	checks: Type.Optional(Type.Array(BoardReportCheckSchema)),
};
export const BoardTaskGoalSchema = Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "One sentence saying what the task is for. Null clears it." }));

export const BoardTaskReportSchema = Type.Object({
	freshness: Type.Optional(Type.Object({ results: BoardReportSectionSchema, next: BoardReportSectionSchema }, { description: "task-freshness capability: section metadata, independent of Now and the shared report timestamp." })),

	now: Type.String({ description: "Canonical automatic activity text on task-activity backends; legacy mirror without ages." }),
	results: Type.String({
		description: "What changed, one whole sentence per item.",
	}),
	next: Type.String({ description: "What comes next, and who does it." }),
	revision: Type.Integer({
		minimum: 0,
		description: "Bumped on every report write; 0 for a report never written. Separate from the task's revision, so report writes do not make the user's task edits conflict.",
	}),
	updatedAt: Type.Union([Type.String(), Type.Null()]),
	updatedBy: Type.Union([BoardWriterSchema, Type.Null()]),
	steps: BoardReportStepsSchema,
	stepsWrittenAt: Type.Optional(Type.String({ description: "ISO date when the current Your steps text was last rewritten. Absent when cleared." })),
	...BoardReportOutcomeSchema,
});
export type BoardTaskReport = Static<typeof BoardTaskReportSchema>;

export const BoardFeedbackStateSchema = Type.Union(
	[Type.Literal("open"), Type.Literal("handling"), Type.Literal("addressed"), Type.Literal("dismissed")],
	{
		description:
			"open: the user said it, nobody acted yet. handling: a coordinator is acting on it. addressed: done; the note holds the answer or says what addressed it (a commit or result). dismissed: the user says it is not needed.",
	},
);
export type BoardFeedbackState = Static<typeof BoardFeedbackStateSchema>;

/** One change of a feedback entry's state. */
export const BoardFeedbackChangeSchema = Type.Object({
	state: BoardFeedbackStateSchema,
	at: Type.String(),
	by: BoardWriterSchema,
	note: Type.Union([Type.String(), Type.Null()]),
});
export type BoardFeedbackChange = Static<typeof BoardFeedbackChangeSchema>;

/**
 * What the user said about a task: each message sent with `conversation.submit`'s `taskId` becomes one entry, so a
 * task's feedback stays apart from its description. The coordinator marks it `handling` when it acts and `addressed`
 * with evidence when done; the user may dismiss or reopen it.
 */
export const BoardFeedbackSchema = Type.Object({
	id: Type.String({ minLength: 1, description: 'Short and unique on the board, e.g. "F3".' }),
	text: Type.String({ description: "The user's words, without the `[task ...]` prefix." }),
	images: Type.Optional(Type.Integer({ minimum: 1, description: "How many images the message carried." })),
	threadId: Type.String({ description: 'The chat it was sent in: "main" or a background thread.' }),
	at: Type.String(),
	state: BoardFeedbackStateSchema,
	note: Type.Union([Type.String(), Type.Null()], { description: "What the last change said, e.g. what addressed it." }),
	updatedAt: Type.String(),
	changes: Type.Array(BoardFeedbackChangeSchema, { description: "Every state change, oldest first." }),
});
export type BoardFeedback = Static<typeof BoardFeedbackSchema>;

/** How many of a task's feedback entries are in each state. */
export const BoardFeedbackCountsSchema = Type.Object({
	open: Type.Integer({ minimum: 0 }),
	handling: Type.Integer({ minimum: 0 }),
	addressed: Type.Integer({ minimum: 0 }),
	dismissed: Type.Integer({ minimum: 0 }),
});
export type BoardFeedbackCounts = Static<typeof BoardFeedbackCountsSchema>;

/** The kinds of link one task stores, named as the board tool's `link` and `unlink` actions name them. */
export const BoardLinkKindSchema = Type.Union(
	[Type.Literal("parent"), Type.Literal("foundWhile"), Type.Literal("related"), Type.Literal("blockedBy")],
	{
		description:
			"parent: this task is a subtask of another (at most one; no cycles; loose: nothing follows automatically). foundWhile: it was discovered while working on another (at most one). related: a symmetric see-also. blockedBy: it waits for another.",
	},
);
export type BoardLinkKind = Static<typeof BoardLinkKindSchema>;

/** Progress of a task's subtasks: `total` leaves out dropped ones, which will not be done. */
export const BoardSubtaskCountSchema = Type.Object({ total: Type.Integer({ minimum: 0 }), done: Type.Integer({ minimum: 0 }) });
export type BoardSubtaskCount = Static<typeof BoardSubtaskCountSchema>;

/** External dependency after the work is finished. Optional for boards and clients predating task-waiting. */
export const BoardTaskWaitingSchema = Type.Object({
	note: Type.String({ minLength: 1, maxLength: 2000 }),
	since: Type.String(),
	until: Type.Optional(Type.String()),
	by: Type.Union([Type.Literal("user"), Type.Literal("coordinator")]),
});
export type BoardTaskWaiting = Static<typeof BoardTaskWaitingSchema>;

/** task-activity: text is canonical and contains no age. Render since locally; refs are source IDs. */
export const BoardActivityActorSchema = Type.Object({
 id: Type.String({ description: "Project-local thread + conversation + run identity; never a worker name alone." }),
 kind: Type.Union([Type.Literal("worker"), Type.Literal("coordinator"), Type.Literal("thread")]),
 name: Type.String(),
 threadId: Type.String(),
 conversationId: Type.Integer(),
 runId: Type.String(),
});
export type BoardActivityActor = Static<typeof BoardActivityActorSchema>;
export const BoardTaskActivitySchema = Type.Object({
 kind: Type.Union([Type.Literal("failure"), Type.Literal("question"), Type.Literal("deploy"), Type.Literal("working"), Type.Literal("feedback"), Type.Literal("blocked"), Type.Literal("waiting"), Type.Literal("review"), Type.Literal("delivery"), Type.Literal("done"), Type.Literal("dropped"), Type.Literal("not_started"), Type.Literal("idle"), Type.Literal("unknown")]),
 text: Type.String(),
 since: Type.String({ description: "ISO phase/state start; not a heartbeat. Tick elapsed time locally, not by server writes." }),
 refs: Type.Array(Type.String()),
 actor: Type.Optional(BoardActivityActorSchema),
 count: Type.Optional(Type.Integer({ minimum: 0 })),
 ageFormat: Type.Optional(Type.Union([Type.Literal("duration"), Type.Literal("none")])),
 agePrefix: Type.Optional(Type.String({ description: "Sentence connector before the locally formatted duration; defaults to a middle dot." })),
});
export type BoardTaskActivity = Static<typeof BoardTaskActivitySchema>;

/** task-state: derived at emission, never persisted on the task. */
export const BoardTaskStateSchema = Type.Object({
 group: Type.Union([Type.Literal("needs_you"), Type.Literal("in_progress"), Type.Literal("waiting"), Type.Literal("todo"), Type.Literal("closed")]),
 kind: Type.Union([Type.Literal("failed"), Type.Literal("answer_needed"), Type.Literal("steps_needed"), Type.Literal("clarifying"), Type.Literal("review"), Type.Literal("working"), Type.Literal("paused"), Type.Literal("blocked_by_task"), Type.Literal("waiting_outside"), Type.Literal("todo"), Type.Literal("done"), Type.Literal("dropped")]),
 since: Type.String(),
 refs: Type.Array(Type.String()),
 sentence: Type.Optional(BoardTaskActivitySchema),
 runningWork: Type.Optional(BoardTaskActivitySchema),
 checkingFeedbackId: Type.Optional(Type.String({ description: "The task note the coordinator is checking against an open question." })),
 liveWorkSince: Type.Optional(Type.String({ description: "Start of live work on this task or a required descendant, independent of owner attention." })),
 fromPartId: Type.Optional(Type.String({ description: "request-attention: the part that raised this request's state." })),
 fromPartTitle: Type.Optional(Type.String({ description: "request-attention: title of the part that raised this state." })),
});
export type BoardTaskState = Static<typeof BoardTaskStateSchema>;

/** task-live: chronological, oldest first. Clients skip line kinds they do not recognize. */
export const BoardLiveLineSchema = Type.Object({
 id: Type.String(),
 at: Type.String({ description: "ISO time the line was recorded." }),
 kind: Type.String({ description: "Phase, result, recorded fact or auto. More kinds may be added." }),
 text: Type.String(),
 actor: BoardActivityActorSchema,
 picker: Type.Optional(Type.String({ description: 'most_steps or model:<provider>/<modelId> for auto lines.' })),
 evidence: Type.Optional(Type.Object({
  conversationId: Type.Integer({ minimum: 1 }),
  steps: Type.Array(Type.Object({ entryId: Type.String(), description: Type.String({ maxLength: 120 }) }), { maxItems: 16 }),
 })),
 wrong: Type.Optional(Type.Object({ by: Type.String(), at: Type.String() })),
});
export type BoardLiveLine = Static<typeof BoardLiveLineSchema>;
export const BoardLivePulseSchema = Type.Object({
 label: Type.String(),
 tool: Type.Optional(Type.String()),
 since: Type.String(),
});
export type BoardLivePulse = Static<typeof BoardLivePulseSchema>;
export const BoardLiveCountersSchema = Type.Object({
 steps: Type.Integer({ minimum: 0 }),
 filesChanged: Type.Integer({ minimum: 0 }),
 filesSaved: Type.Integer({ minimum: 0 }),
 commits: Type.Integer({ minimum: 0 }),
 checks: Type.Integer({ minimum: 0 }),
});
export type BoardLiveCounters = Static<typeof BoardLiveCountersSchema>;
export const LIVE_PLAN_MIN_STEPS = 3;
export const LIVE_PLAN_MAX_STEPS = 7;
export const LIVE_PLAN_STEP_MAX_CHARS = 80;
export const BoardLivePlanStatusSchema = Type.Union([Type.Literal("todo"), Type.Literal("doing"), Type.Literal("done")]);
export const BoardLivePlanStepSchema = Type.Object({
 text: Type.String({ minLength: 1, maxLength: LIVE_PLAN_STEP_MAX_CHARS }),
 status: BoardLivePlanStatusSchema,
});
export type BoardLivePlanStep = Static<typeof BoardLivePlanStepSchema>;

export function livePlanProgress(plan: readonly BoardLivePlanStep[]): string {
 return `${plan.filter(step => step.status === "done").length} of ${plan.length}`;
}

export const BoardTaskLiveSchema = Type.Object({
 lines: Type.Array(BoardLiveLineSchema, { maxItems: 30 }),
 pulse: Type.Optional(BoardLivePulseSchema),
 counters: Type.Optional(BoardLiveCountersSchema),
 plan: Type.Optional(Type.Array(BoardLivePlanStepSchema, { minItems: 1, maxItems: LIVE_PLAN_MAX_STEPS })),
});

export function liveCounterLabels(counters: BoardLiveCounters | undefined): string[] {
 if (!counters) return [];
 return ([[counters.steps, "step", ""], [counters.filesChanged, "file", " changed"],
  [counters.filesSaved, "file", " saved"], [counters.commits, "commit", ""], [counters.checks, "check", ""]] as const)
  .flatMap(([count, noun, suffix]) => count > 0 ? [`${count} ${noun}${count === 1 ? "" : "s"}${suffix}`] : []);
}
export type BoardTaskLive = Static<typeof BoardTaskLiveSchema>;

const DigestCount = Type.Integer({ minimum: 0 });

const PartDigestSchema = Type.Object({
 id: Type.String(),
 parentId: Type.String(),
 title: Type.String(),
 state: BoardTaskStateSchema.properties.kind,
 summary: Type.String(),
 checks: Type.Object({ passed: DigestCount, failed: DigestCount, total: DigestCount }),
 notDoneCount: DigestCount,
 closedAt: Type.Optional(Type.String()),
 closedBy: Type.Optional(BoardAuthorSchema),
 dropReason: Type.Optional(Type.String()),
});

export const PartsDigestSchema = Type.Object({
 parts: Type.Array(PartDigestSchema, { description: "Parts in depth-first board order, with parentId for nesting. Includes archived and dropped parts." }),
 done: DigestCount,
 total: DigestCount,
 working: DigestCount,
 needsOwner: DigestCount,
}, { description: "Progress totals cover direct parts, excluding dropped, like the parts bar." });
export type PartsDigest = Static<typeof PartsDigestSchema>;

export const BoardTaskSchema = Type.Object({
 partsDigest: Type.Optional(PartsDigestSchema),
 derivedNotDone: Type.Optional(Type.Array(Type.Object({ partId: Type.String(), text: Type.String() }), {
  description: "request-digest: read-time Not done lines. Append to the request report for display; never write them back.",
 })),
 requestId: Type.Optional(Type.String({ description: "request-attention: the root request of a part." })),
 live: Type.Optional(BoardTaskLiveSchema),
 state: Type.Optional(BoardTaskStateSchema),
 activity: Type.Optional(BoardTaskActivitySchema),
	eventSeq: Type.Optional(Type.Integer({ minimum: 0, description: "Persisted per-task sequence of meaningful facts. Pass the value read by show_task as coveredEventSeq when rewriting; never use a newer unread value." })),

	id: Type.String({ minLength: 1, description: 'Short and stable, e.g. "T12".' }),
	revision: Revision,
	title: Type.String({ minLength: 1, description: 'A short, plain outcome, e.g. "Complete the example change".' }),
	description: Type.String(),
	acceptance: Type.Union([Type.String(), Type.Null()], { description: "Done when\u2026" }),
	refs: Type.Array(Type.String(), {
		description:
			'What the task is about elsewhere: links to its tickets and pull requests, or their keys and numbers ("EX-1234", "#1234"), which the project\'s link settings resolve. Empty on tasks saved before refs.',
	}),
	inProgressMinutes: Type.Optional(
		Type.Integer({ minimum: 0, description: "Minutes spent in_progress so far, across every time it was in_progress." }),
	),
	status: BoardTaskStatusSchema,
	waiting: Type.Optional(BoardTaskWaitingSchema),
	blockedBy: Type.Array(Type.String(), { description: "Task IDs this one waits for; acyclic." }),
	blockedReason: Type.Union([Type.String(), Type.Null()], { description: "Why it is blocked, besides its dependencies." }),
	parent: Type.Optional(
		Type.Union([Type.String(), Type.Null()], {
			description: "The task this is a required part of; the parent cannot be ahead of its parts. At most one; never a cycle. Absent on tasks saved before links.",
		}),
	),
	foundWhile: Type.Optional(
		Type.Union([Type.String(), Type.Null()], {
			description: "The task whose work led to finding this one (its origin). At most one.",
		}),
	),
	fromAnswer: Type.Optional(Type.String({ description: "The answer this request was made from." })),
	related: Type.Optional(Type.Array(Type.String(), { description: "Tasks to see also; symmetric (each lists the other)." })),
	subtasks: Type.Optional(Type.Array(Type.String(), { description: "Derived: the tasks whose `parent` is this one, by order." })),
	ledTo: Type.Optional(Type.Array(Type.String(), { description: "Derived: the tasks whose `foundWhile` is this one." })),
	blocks: Type.Optional(Type.Array(Type.String(), { description: "Derived: the tasks that list this one in `blockedBy`." })),
	subtaskCount: Type.Optional(BoardSubtaskCountSchema),
 subtaskStates: Type.Optional(Type.Array(BoardTaskStateSchema.properties.kind, { description: "task-part-states: derived kinds of direct parts in task order, excluding dropped; matches subtaskCount.total." })),
	feedback: Type.Optional(BoardFeedbackCountsSchema),
	timelineRevision: Type.Optional(
		Type.Integer({ minimum: 0, description: "Bumped whenever the task's timeline gains an entry the board itself does not carry, so a reader knows to read it again." }),
	),
	writeScopes: Type.Array(Type.String(), {
		description: "Paths (relative to the project) the task will change. Overlaps between running shared workers warn.",
	}),
	workerIds: Type.Array(Type.String(), { description: "Workers that ran this task, oldest first." }),
	scheduleId: Type.Union([Type.String(), Type.Null()], { description: "The schedule whose failed run opened it." }),
	coordinatorId: Type.Optional(Type.String({ description: "Derived coordinator of this task, including tasks held by its jobs." })),
	ownerThreadId: Type.Optional(
		Type.Union([Type.String(), Type.Null()], {
			description: 'The thread that claimed it ("main" for main); null when unclaimed. A thread claims a task before working on it.',
		}),
	),
	report: BoardTaskReportSchema,
	snapshots: Type.Integer({ minimum: 0, description: "How many snapshots board.task.history lists for it." }),
	order: Type.Number({ description: "Position among the tasks; lower first." }),
	createdBy: BoardAuthorSchema,
	updatedBy: BoardAuthorSchema,
	createdAt: Type.String(),
	updatedAt: Type.String(),
	settledAt: Type.Union([Type.String(), Type.Null()], { description: "When it became done or dropped." }),
	archived: Type.Boolean(),
	goal: BoardTaskGoalSchema,
});
export type BoardTask = Static<typeof BoardTaskSchema>;

export const BoardQuestionChoiceSchema = Type.Object({
	label: Type.String({ minLength: 1, description: "The suggested answer sent when picked." }),
	effect: Type.Optional(Type.String({ description: "What happens if this choice is picked." })),
	recommended: Type.Optional(Type.Boolean()),
});
export type BoardQuestionChoice = Static<typeof BoardQuestionChoiceSchema>;
const BoardQuestionChoicesSchema = Type.Optional(Type.Array(BoardQuestionChoiceSchema, { description: "Structured choices; options mirrors the labels. At most one is recommended." }));

export const BoardQuestionExchangeSchema = Type.Object({
 author: BoardWriterSchema,
 text: Type.String({ minLength: 1 }),
 at: Type.String(),
 feedbackId: Type.Optional(Type.String({ description: "Task note that started this question check." })),
 previousWording: Type.Optional(Type.Object({ revision: Revision, text: Type.String(), options: Type.Array(Type.String()), choices: BoardQuestionChoicesSchema })),
 previousAnswer: Type.Optional(Type.Object({ text: Type.String(), at: Type.String() })),
});
export type BoardQuestionExchange = Static<typeof BoardQuestionExchangeSchema>;

export const BoardQuestionSchema = Type.Object({
 requestId: Type.Optional(Type.String({ description: "request-attention: the root request of the part this question or warning is on." })),
 waitingOn: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("agent")], { description: "Open questions only; absent means user. Agent-waiting questions are not Needs you." })),
 exchanges: Type.Optional(Type.Array(BoardQuestionExchangeSchema, { description: "Oldest first; revisions retain earlier wording on the reply." })),
 noReplyYet: Type.Optional(Type.Boolean({ description: "Returned to the owner after an unanswered reminder or failed run." })),
 reopened: Type.Optional(Type.Boolean({ description: "The agent has used this question's one allowed reopening." })),
 usageDrainIncident: Type.Optional(Type.String({ description: "Automatic drain decision; only the owner can pick a listed choice." })),
 outsideModelApproval: Type.Optional(Type.Literal(true, { description: "A run approval: offer only the listed choices, with no clarification or reopen." })),
 mcpApproval: Type.Optional(Type.Boolean({ description: "Tool approval: never offer Ask back or reopen." })),
 blocksWork: Type.Optional(Type.Boolean({ description: "Questions default true, warnings false. Only blocking open entries replace task activity." })),
 activitySourceId: Type.Optional(Type.String({ description: "Warning acknowledgement clears only this linked failure source." })),
	id: Type.String({ minLength: 1, description: 'e.g. "Q3".' }),
	revision: Revision,
	kind: Type.Optional(
		Type.Union([Type.Literal("question"), Type.Literal("warning")], {
			description:
				'Default "question". A warning is something the user must not miss; it stays open until the user acknowledges it (answers it, with any text) and has no options.',
		}),
	),
	text: Type.String({ minLength: 1 }),
	options: Type.Array(Type.String(), { description: "Suggested answers; the user may answer anything." }),
	taskId: Type.Union([Type.String(), Type.Null()]),
	threadId: Type.Optional(Type.String({ description: 'The thread that asked; "main" for main.' })),
	status: Type.Union([Type.Literal("open"), Type.Literal("answered"), Type.Literal("withdrawn")]),
	answer: Type.Union([Type.String(), Type.Null()]),
	askedAt: Type.String(),
	answeredAt: Type.Union([Type.String(), Type.Null()]),
	choices: BoardQuestionChoicesSchema,
});
export type BoardQuestion = Static<typeof BoardQuestionSchema>;

/** A task as it was at one point: saved when a report write names a milestone and on every status change. */
export const BoardTaskSnapshotSchema = Type.Object({
	seq: Type.Integer({ minimum: 1, description: "1 for the task's first snapshot, then increasing." }),
	at: Type.String(),
	label: Type.String({ description: 'The milestone, e.g. "First version merged", or the status change, e.g. "in_progress → review".' }),
	by: BoardWriterSchema,
	title: Type.String(),
	status: BoardTaskStatusSchema,
	state: Type.Optional(BoardTaskStateSchema),
	waiting: Type.Optional(BoardTaskWaitingSchema),
	report: Type.Object({ now: Type.String(), results: Type.String(), next: Type.String(), steps: BoardReportStepsSchema, ...BoardReportOutcomeSchema }),
	goal: BoardTaskGoalSchema,
	questionChoices: Type.Optional(Type.Array(Type.Object({ questionId: Type.String(), choices: Type.Array(BoardQuestionChoiceSchema) }))),
});
export type BoardTaskSnapshot = Static<typeof BoardTaskSnapshotSchema>;

export const BoardDecisionSchema = Type.Object({
	id: Type.String({ minLength: 1, description: 'e.g. "D5".' }),
	text: Type.String({ minLength: 1 }),
	why: Type.Union([Type.String(), Type.Null()]),
	taskId: Type.Union([Type.String(), Type.Null()]),
	threadId: Type.Optional(Type.String({ description: 'The thread that decided; "main" for main.' })),
	at: Type.String(),
});
export type BoardDecision = Static<typeof BoardDecisionSchema>;

/** What a link to a task the board view leaves out (an archived one) still shows. */
export const BoardTaskBriefSchema = Type.Object({
	id: Type.String(),
	title: Type.String(),
	status: BoardTaskStatusSchema,
	archived: Type.Boolean(),
});
export type BoardTaskBrief = Static<typeof BoardTaskBriefSchema>;

export const BoardSchema = Type.Object({
	tasks: Type.Array(BoardTaskSchema, { description: "By order. Archived ones only when asked for." }),
	archivedLinks: Type.Optional(
		Type.Array(BoardTaskBriefSchema, { description: "Archived tasks that a task in `tasks` links to (and that `tasks` leaves out), so the link can still show them." }),
	),
	questions: Type.Array(BoardQuestionSchema, { description: "Open ones first, then the newest answered." }),
	decisions: Type.Array(BoardDecisionSchema, { description: "Newest first." }),
	updatedAt: Type.Union([Type.String(), Type.Null()]),
});
export type Board = Static<typeof BoardSchema>;

/** What the user may set on a task; the harness owns workerIds, scheduleId and the timestamps. */
export const BoardTaskInputSchema = Type.Object({
	title: Type.String({ minLength: 1 }),
	description: Type.String(),
	acceptance: Type.Union([Type.String(), Type.Null()]),
	refs: Type.Optional(Type.Array(Type.String(), { description: "Replaces the task's refs; left out, they stay as they are (none on a new task)." })),
	status: BoardTaskStatusSchema,
	waitingFor: Type.Optional(Type.String({ maxLength: 2000 })),
	waitUntil: Type.Optional(Type.String({ description: "ISO date or timestamp; absent means no automatic return." })),
	blockedBy: Type.Array(Type.String()),
	blockedReason: Type.Union([Type.String(), Type.Null()]),
	writeScopes: Type.Array(Type.String()),
	parent: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Sets the parent (null clears it); left out, it stays as it is." })),
	foundWhile: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Sets the origin (null clears it); left out, it stays as it is." })),
	related: Type.Optional(Type.Array(Type.String(), { description: "Replaces the related tasks; left out, they stay as they are." })),
	goal: BoardTaskGoalSchema,
});
export type BoardTaskInput = Static<typeof BoardTaskInputSchema>;

/** The kinds of entry a task's timeline holds. */
export const BoardTimelineKindSchema = Type.Union([
	Type.Literal("feedback"),
	Type.Literal("status"),
	Type.Literal("worker"),
	Type.Literal("question"),
	Type.Literal("decision"),
	Type.Literal("milestone"),
	Type.Literal("link"),
]);
export type BoardTimelineKind = Static<typeof BoardTimelineKindSchema>;

/**
 * One thing that happened to a task. `label` reads on its own ("F3 → addressed", "in_progress → review", "worker w1
 * started", "Q2 asked", "Subtask of T8"); `detail` carries the text behind it (the feedback, the question, the note);
 * `ref` is what the entry is about: a feedback ID, a question ID, a decision ID, a worker ID or a task ID (link).
 */
export const BoardTimelineEntrySchema = Type.Object({
 live: Type.Optional(BoardTaskLiveSchema),
	at: Type.String(),
	kind: BoardTimelineKindSchema,
	label: Type.String(),
	detail: Type.Optional(Type.String()),
	ref: Type.Optional(Type.String()),
	state: Type.Optional(BoardFeedbackStateSchema),
	by: Type.Optional(BoardWriterSchema),
});
export type BoardTimelineEntry = Static<typeof BoardTimelineEntrySchema>;

/** task-timeline-groups: entries stay in their UTC starting hour, even when endAt advances. */
export const BoardTimelineGroupKindSchema = Type.Union([Type.Literal("work"), Type.Literal("decisions"), Type.Literal("delivery")]);
export type BoardTimelineGroupKind = Static<typeof BoardTimelineGroupKindSchema>;
export const BoardTimelineFactSchema = Type.Object({
 ...BoardTimelineEntrySchema.properties,
 id: Type.String(),
 endAt: Type.String(),
 endAtForLive: Type.Optional(Type.String({ description: "Run end before any later report delivery." })),
 revision: Type.Integer({ minimum: 1 }),
 group: BoardTimelineGroupKindSchema,
 outcome: Type.String({ description: "Latest source outcome, e.g. running, reported, failed, open, answered, addressed, ok." }),
 factCount: Type.Integer({ minimum: 1, description: "Meaningful lifecycle facts, not phase/progress updates." }),
 source: Type.Optional(Type.String({ description: "Source category: worker, thread, check, change, deploy, ownership." })),
 actor: Type.Optional(BoardActivityActorSchema),
});
export type BoardTimelineFact = Static<typeof BoardTimelineFactSchema>;
export const BoardTimelineGroupSchema = Type.Object({
 id: Type.String(),
 kind: BoardTimelineGroupKindSchema,
 hour: Type.String({ description: "UTC clock-hour start; group identity never depends on endAt." }),
 range: Type.Object({ start: Type.String(), end: Type.String() }),
 revision: Type.Integer({ minimum: 1 }),
 factCount: Type.Integer({ minimum: 1 }),
 label: Type.String(),
 entries: Type.Array(BoardTimelineFactSchema),
});
export type BoardTimelineGroup = Static<typeof BoardTimelineGroupSchema>;

// --- requests ----------------------------------------------------------------------------------------------------

export const BoardGetRequestSchema = Type.Object({
	type: Type.Literal("board.get"),
	id: RequestIdSchema,
	projectId: ProjectIdSchema,
	includeArchived: Type.Optional(Type.Boolean({ description: "Default false." })),
});
export type BoardGetRequest = Static<typeof BoardGetRequestSchema>;

/** Create a task (no `taskId`), or change one made on `expectedRevision`. */
export const BoardTaskSaveRequestSchema = Type.Object({
	type: Type.Literal("board.task.save"),
 openParts: Type.Optional(Type.Union([Type.Literal("close"), Type.Literal("follow_up")], { description: "Required when closing a parent with open direct parts; otherwise error open_parts. Close recursively, or preserve direct parts as follow-ups." })),
	id: RequestIdSchema,
	projectId: ProjectIdSchema,
	taskId: Type.Optional(Type.String({ minLength: 1 })),
	expectedRevision: Type.Optional(Revision),
	task: BoardTaskInputSchema,
	ownerThreadId: Type.Optional(Type.Union([Type.String({ minLength: 1 }), Type.Null()])),
	note: Type.Optional(
		Type.String({
			maxLength: 2000,
			description:
				'Why the user made this change, in their words (e.g. why a task goes back from review to in_progress). It reaches the coordinator with the change. Needs the "board-moves" feature; older servers ignore it.',
		}),
	),
});
export type BoardTaskSaveRequest = Static<typeof BoardTaskSaveRequestSchema>;

/** Put tasks in this order; tasks not named keep their place after them. */
export const BoardTasksReorderRequestSchema = Type.Object({
	type: Type.Literal("board.tasks.reorder"),
	id: RequestIdSchema,
	projectId: ProjectIdSchema,
	taskIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});
export type BoardTasksReorderRequest = Static<typeof BoardTasksReorderRequestSchema>;

/** question-clarify: ask back without settling a question or warning. */
export const BoardQuestionClarifyRequestSchema = Type.Object({
 type: Type.Literal("board.question.clarify"), id: RequestIdSchema, projectId: ProjectIdSchema,
 questionId: Type.String({ minLength: 1 }), expectedRevision: Revision, text: Type.String({ minLength: 1 }),
});
export type BoardQuestionClarifyRequest = Static<typeof BoardQuestionClarifyRequestSchema>;
export const BoardQuestionClarifyResponseSchema = Type.Object({
 type: Type.Literal("board.question.clarify"), id: RequestIdSchema, question: BoardQuestionSchema,
});
export type BoardQuestionClarifyResponse = Static<typeof BoardQuestionClarifyResponseSchema>;

export const BoardQuestionAnswerRequestSchema = Type.Object({
	type: Type.Literal("board.question.answer"),
	id: RequestIdSchema,
	projectId: ProjectIdSchema,
	questionId: Type.String({ minLength: 1 }),
	expectedRevision: Revision,
	answer: Type.String({ minLength: 1 }),
});
export type BoardQuestionAnswerRequest = Static<typeof BoardQuestionAnswerRequestSchema>;

/** A task's snapshots, oldest first. */
export const BoardTaskHistoryRequestSchema = Type.Object({
	type: Type.Literal("board.task.history"),
	id: RequestIdSchema,
	projectId: ProjectIdSchema,
	taskId: Type.String({ minLength: 1 }),
});
export type BoardTaskHistoryRequest = Static<typeof BoardTaskHistoryRequestSchema>;

/**
 * A task's timeline, oldest first: feedback and its state changes, status moves, workers started and reported or
 * failed, questions asked and answered, decisions, report milestones and link changes. `kinds` keeps only those kinds.
 * The answer also carries the task's feedback entries (open first), which the timeline shows only as events.
 */
export const BoardTaskTimelineRequestSchema = Type.Object({
	type: Type.Literal("board.task.timeline"),
	id: RequestIdSchema,
	projectId: ProjectIdSchema,
	taskId: Type.String({ minLength: 1 }),
	kinds: Type.Optional(Type.Array(BoardTimelineKindSchema)),
 grouped: Type.Optional(Type.Boolean({ description: "Request groups with task-timeline-groups; legacy entries remain unchanged." })),
	delivery: Type.Optional(Type.Boolean({ description: "Request the change ledger and deploy outcome with task-delivery." })),
});
export type BoardTaskTimelineRequest = Static<typeof BoardTaskTimelineRequestSchema>;

/** Set the state of a feedback entry (the user dismisses or reopens one). Answers the entry as stored. */
export const BoardFeedbackSetRequestSchema = Type.Object({
	type: Type.Literal("board.feedback.set"),
	id: RequestIdSchema,
	projectId: ProjectIdSchema,
	taskId: Type.String({ minLength: 1 }),
	feedbackId: Type.String({ minLength: 1 }),
	state: BoardFeedbackStateSchema,
	note: Type.Optional(Type.String({ maxLength: 2000 })),
});
export type BoardFeedbackSetRequest = Static<typeof BoardFeedbackSetRequestSchema>;

/** Feature task-freshness. Marks prose stale, queues one rewrite nudge, never changes status. */
export const BoardLiveMarkWrongRequestSchema = Type.Object({
 type: Type.Literal("board.live.mark_wrong"), id: Type.String(), projectId: Type.String(), taskId: Type.String(), lineId: Type.String(),
});
export type BoardLiveMarkWrongRequest = Static<typeof BoardLiveMarkWrongRequestSchema>;
export const BoardLiveMarkWrongResponseSchema = Type.Object({ type: Type.Literal("board.live.mark_wrong"), id: Type.String() });
export type BoardLiveMarkWrongResponse = Static<typeof BoardLiveMarkWrongResponseSchema>;

export const BoardReportStaleRequestSchema = Type.Object({
	type: Type.Literal("board.report.stale"),
	id: RequestIdSchema,
	projectId: ProjectIdSchema,
	taskId: Type.String({ minLength: 1 }),
	sections: Type.Optional(Type.Array(Type.Union([Type.Literal("results"), Type.Literal("next")]), { minItems: 1, uniqueItems: true, description: "Omitted means both sections." })),
	reason: Type.Optional(Type.String({ minLength: 1, maxLength: 160, description: "Optional short explanation; plain text, never an instruction." })),
});
export type BoardReportStaleRequest = Static<typeof BoardReportStaleRequestSchema>;
export const BoardReportStaleResponseSchema = Type.Object({
	type: Type.Literal("board.report.stale"),
	id: RequestIdSchema,
	task: BoardTaskSchema,
});
export type BoardReportStaleResponse = Static<typeof BoardReportStaleResponseSchema>;

// --- responses ---------------------------------------------------------------------------------------------------

/** The position of a full live snapshot on this connection, never present on an archived read. */
export const BoardStreamPositionSchema = Type.Object({
	projectId: ProjectIdSchema,
	sequence: Type.Integer({ minimum: 1 }),
});

export const BoardGetResponseSchema = Type.Object({
	type: Type.Literal("board.get"),
	id: RequestIdSchema,
	board: BoardSchema,
	stream: Type.Optional(BoardStreamPositionSchema),
});
export type BoardGetResponse = Static<typeof BoardGetResponseSchema>;

export const BoardTaskSaveResponseSchema = Type.Object({
	type: Type.Literal("board.task.save"),
 openParts: Type.Optional(Type.Union([Type.Literal("close"), Type.Literal("follow_up")], { description: "Required when closing a parent with open direct parts; otherwise error open_parts. Close recursively, or preserve direct parts as follow-ups." })),
	id: RequestIdSchema,
	task: BoardTaskSchema,
});
export type BoardTaskSaveResponse = Static<typeof BoardTaskSaveResponseSchema>;

export const BoardTasksReorderResponseSchema = Type.Object({
	type: Type.Literal("board.tasks.reorder"),
	id: RequestIdSchema,
});
export type BoardTasksReorderResponse = Static<typeof BoardTasksReorderResponseSchema>;

export const BoardQuestionAnswerResponseSchema = Type.Object({
	type: Type.Literal("board.question.answer"),
	id: RequestIdSchema,
	question: BoardQuestionSchema,
});
export type BoardQuestionAnswerResponse = Static<typeof BoardQuestionAnswerResponseSchema>;

export const BoardTaskHistoryResponseSchema = Type.Object({
	type: Type.Literal("board.task.history"),
	id: RequestIdSchema,
	taskId: Type.String(),
	snapshots: Type.Array(BoardTaskSnapshotSchema),
});
export type BoardTaskHistoryResponse = Static<typeof BoardTaskHistoryResponseSchema>;

/** Delivery only exists when the ledger attributes at least one commit to the task. */
const TaskDeliverySchema = Type.Object({
	commits: Type.Array(Type.String(), { minItems: 1 }),
	integration: Type.Optional(Type.Object({ ref: Type.String(), landed: Type.Integer({ minimum: 0 }) })),
	partCommits: Type.Optional(Type.Array(Type.Object({ partId: Type.String(), commits: Type.Array(Type.String()) }), {
  description: "request-digest: commit hashes grouped by contributing part, in digest order. The top-level commits array is deduplicated.",
 })),
	deployment: Type.Optional(Type.Union([Type.Literal("live"), Type.Literal("pending"), Type.Literal("failed"), Type.Literal("unknown")])),
});

export const BoardTaskTimelineResponseSchema = Type.Object({
	type: Type.Literal("board.task.timeline"),
	id: RequestIdSchema,
	taskId: Type.String(),
	entries: Type.Array(BoardTimelineEntrySchema),
 groups: Type.Optional(Type.Array(BoardTimelineGroupSchema)),
 timelineRevision: Type.Optional(Type.Integer({ minimum: 0 })),
	feedback: Type.Array(BoardFeedbackSchema, { description: "Open and handling ones first (oldest first), then the rest, newest first." }),
	delivery: Type.Optional(TaskDeliverySchema),
});
export type BoardTaskTimelineResponse = Static<typeof BoardTaskTimelineResponseSchema>;

export const BoardFeedbackSetResponseSchema = Type.Object({
	type: Type.Literal("board.feedback.set"),
	id: RequestIdSchema,
	feedback: BoardFeedbackSchema,
});
export type BoardFeedbackSetResponse = Static<typeof BoardFeedbackSetResponseSchema>;

// --- server events -----------------------------------------------------------------------------------------------

/** The project's board without archived tasks, pushed to every connection whenever it changes. */
export const BoardStateEventSchema = Type.Object({
	type: Type.Literal("board.state"),
	projectId: ProjectIdSchema,
	board: BoardSchema,
	sequence: Type.Optional(Type.Integer({ minimum: 1 })),
	liveOnly: Type.Optional(Type.Boolean({ description: "An update that only changes the live trail or pulse, not archived data." })),
});
export type BoardStateEvent = Static<typeof BoardStateEventSchema>;

/** Update rows by ID, keeping surviving rows in place and appending new rows in upsert order.
 * When that implicit order differs from the board, `order` lists the final IDs. */
function boardRowsDelta<T extends TSchema>(row: T) {
	return Type.Object({
		upsert: Type.Optional(Type.Array(row)),
		remove: Type.Optional(Type.Array(Type.String())),
		order: Type.Optional(Type.Array(Type.String())),
	});
}

export const BoardTasksDeltaSchema = boardRowsDelta(BoardTaskSchema);
export const BoardQuestionsDeltaSchema = boardRowsDelta(BoardQuestionSchema);
export const BoardDecisionsDeltaSchema = boardRowsDelta(BoardDecisionSchema);
export const BoardArchivedLinksDeltaSchema = boardRowsDelta(BoardTaskBriefSchema);
export const BoardLiveLinesDeltaSchema = boardRowsDelta(BoardLiveLineSchema);

/** Replace the live metadata (omission clears it), but patch the trail by line ID. */
export const BoardTaskLiveDeltaSchema = Type.Object({
	taskId: Type.String(),
	pulse: BoardTaskLiveSchema.properties.pulse,
	counters: BoardTaskLiveSchema.properties.counters,
	plan: BoardTaskLiveSchema.properties.plan,
	lines: Type.Optional(BoardLiveLinesDeltaSchema),
});

/** Applies only to the specified live snapshot on the same connection. On a gap, read board.get again. */
export const BoardDeltaEventSchema = Type.Object({
	type: Type.Literal("board.delta"),
	projectId: ProjectIdSchema,
	baseSequence: Type.Integer({ minimum: 1 }),
	sequence: Type.Integer({ minimum: 2 }),
	tasks: Type.Optional(BoardTasksDeltaSchema),
	questions: Type.Optional(BoardQuestionsDeltaSchema),
	decisions: Type.Optional(BoardDecisionsDeltaSchema),
	archivedLinks: Type.Optional(BoardArchivedLinksDeltaSchema),
	taskLive: Type.Optional(Type.Array(BoardTaskLiveDeltaSchema)),
	updatedAt: BoardSchema.properties.updatedAt,
});
export type BoardDeltaEvent = Static<typeof BoardDeltaEventSchema>;
