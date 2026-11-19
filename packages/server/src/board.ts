import { DEFAULT_TASK_WATCHER, type TaskWatcherSettings, type TaskWatcherStatus } from "@kemiri/protocol";
import { evaluateWatcherRun, markWatcherLineWrong, publishWatcherAnswer, TaskWatcherLiveService, TaskWatcherRun, watcherCanPublish, type WatcherJob, type WatcherPublication } from "./task-watcher-live.ts";
import { describeLivePlan, type LivePlanUpdate } from "./task-live-plan.ts";
import { TaskLiveRun } from "./task-live-run.ts";
import { TaskLiveWatch } from "./task-live-watch.ts";
import type { TaskArtifactSave } from "./artifacts.ts";
import { appendLiveFact, foldedLiveEntries, liveRunFacts, mergeLiveLines, recordLiveReport, runningLiveSources, takeLiveTrail, taskLive } from "./task-live.ts";
import { buildTimelineGroups, recordTimelineRun, timelineId, upsertTimelineFact } from "./task-timeline.ts";
import { deploySummary, type TaskDeployFact } from "./task-deploys.ts";
import { activityTracking, taskActivity, endActivitySource, type TaskActivityTracking, DELIVERY_ACTIVITY_MS, taskState, taskQuietSince, TASK_PAUSED_MS, openTaskBlockers, pauseEpisode } from "./task-activity.ts";
import type { Models } from "@earendil-works/pi-ai";
import { DEFAULT_REPORT_AUDIT } from "@kemiri/protocol";
import { ReportAuditService, type ReportAuditRecord } from "./report-audit.ts";
import { initializeTaskFreshness, coverReportSection, noteTaskFact, markReportStale, prepareReportNudges, acknowledgeReportNudge, reportDueAt, sweepReportAge, substantiveTaskMentions, reportChatUserTasks, isReportHarnessInput, chatDetailTaskMentions, REPORT_SECTIONS, REPORT_SWEEP_MS, type ReportSection, type TaskFact, type TaskReportTracking, type ReportOutbox } from "./task-freshness.ts";
import { stateKind } from "./state-identity.ts";
import { pointsAtChat } from "./task-chat-pointer.ts";
import { taskTextWarnings } from "./task-text-style.ts";
import { countChatDetailTurn, detectMissingChatDetail, missingChatDetailLabel, type ChatDetailCounts } from "./task-chat-detail.ts";
import { splitTaskReference } from "./queued-inputs.ts";
import { OWNER_CHAT_ENTRY } from "./wire.ts";
/**
 * The board: the coordinator's tasks, questions for the user and decisions, kept as a durable document on the
 * coordinator conversation (`aiki.board`) so it never has to be recalled from a summary. The contract is
 * `packages/protocol/src/board.ts`.
 *
 * Three writers share the same pure mutators below, each run inside one commit: the coordinator's `board` tool, the user
 * (protocol requests) and, later, the harness itself. A row change names the revision it was made on and is refused with
 * `board_conflict` when the row moved on. Reordering does not bump revisions: dragging one task would otherwise conflict
 * every edit of every task below it.
 *
 * The board is the project's, shared by main and its background threads (`threads.ts`): the document stays on main's
 * conversation, any coordinator thread changes it with the same tool, a thread claims a task (`ownerThreadId`, with the
 * same revision check) before working on it, and a question or decision carries the thread that made it.
 *
 * The user's edits reach the coordinator as one coalesced `[board]` input after a short quiet period; an answer reaches
 * the thread that asked at once as a steer. `done` and `dropped` tasks are archived 7 days after they settle; the view applies that by the
 * clock and every write or `get` persists it, so nothing depends on a timer.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type { Conversation, ConversationId, EntryId, Extension, Harness, JsonObject, ToolRegistration, Tx } from "@earendil-works/pi-durable";
import { LiveDoc, type LiveState, GenerationTask, hook, defineDoc, defineDocFamily, defineExtension, defineTool } from "@earendil-works/pi-durable";
import {
	BOARD_PREFIX,
	type InputContent,
	TASK_REFERENCE_PREFIX,
	type Board,
	type BoardAuthor,
	type BoardDecision,
	type BoardFeedback,
	type BoardFeedbackCounts,
	type BoardFeedbackState,
	type BoardLinkKind,
	BoardQuestionChoiceSchema,
	BoardReportCheckSchema,
	BoardTaskGoalSchema,
	type BoardQuestion,
	type BoardQuestionChoice,
	type BoardReportCheck,
	type BoardTask,
	type BoardTaskBrief,
	type BoardTaskInput,
	type BoardTaskReport,
	type BoardTaskSnapshot,
	type BoardTimelineEntry,
	type BoardTimelineKind,
	type BoardWriter,
} from "@kemiri/protocol";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { createHash } from "node:crypto";
import { type Static, Type } from "typebox";
import type { Coordinators } from "./coordinators.ts";
import { ServerError, errorMessage } from "./errors.ts";
import { type Notifier, boardQuestionNotification, taskReviewNotification } from "./notifications.ts";
import type { Project } from "./projects.ts";

/** How long a done or dropped task stays in the coordinator's view. */
export const ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** How long the user's edits wait for a further edit before they reach the coordinator as one input. */
export const BOARD_EDIT_DEBOUNCE_MS = 3_000;
/** Answered and withdrawn questions the view keeps after the open ones. */
const KEPT_SETTLED_QUESTIONS = 20;
const LIST_DESCRIPTION_CHARS = 200;
/** How many harness change keys the board remembers; far more than the changes a restart can rerun. */
const KEPT_HARNESS_KEYS = 500;
/** What the board's view in a compaction summary may take, in tokens. */
export const SUMMARY_BOARD_TOKENS = 1_500;
/** Todo tasks the summary view lists before "+N more", and decisions it keeps. */
const SUMMARY_TODO_TASKS = 20;
const SUMMARY_DECISIONS = 10;
/** How much of an open task's report `now` the compaction view shows: a line, not the report. */
const SUMMARY_NOW_CHARS = 200;

type ChatDetailWrite = { chars: number; feedbackIds?: string[]; questionIds?: string[] };
type ChatDetailRun = { conversationId: ConversationId; first: number; last: number; ownerInputs: string[] | undefined; reply: string };

export type BoardState = {
	taskFreshnessEnabled?: boolean;
 taskActivityEnabled?: boolean;
 taskStateEnabled?: boolean;
 taskPartStatesEnabled?: boolean;
 taskLiveEnabled?: boolean;
 taskWatcherSettings?: TaskWatcherSettings;
 taskWatcherStatus?: TaskWatcherStatus;
 taskWatcherJobs?: Record<string, WatcherJob>;
 taskWatcherPublications?: Record<string, WatcherPublication>;
 taskStateMigrated?: boolean;
 pausedNotices?: { taskId: string; episode: string; owner: string }[];
 taskActivity?: Record<string, TaskActivityTracking>;
 taskFocus?: Record<string, string>;
	reportTracking?: Record<string, TaskReportTracking>;
	reportOutbox?: ReportOutbox[];
	reportInFlight?: Record<string, number>;
	chatDetailCounts?: ChatDetailCounts;
	chatDetailWrites?: Record<string, { first: number; tasks: Record<string, ChatDetailWrite> }>;
	reportChatCandidates?: Record<string, { text: string; key: string }[]>;
	lastReportSweep?: number;
	deployFeedConfigured?: boolean;
	deploySequences?: Record<string, number>;
	latestTaskDeploy?: Record<string, { scope: string; order: number; attemptId: string; outcome?: "live" | "pending" | "failed" }>;
	reportAudit?: ReportAuditRecord;
	tasks: BoardTask[];
	questions: BoardQuestion[];
 clarificationReminders?: Record<string, { revision: number; reminded: boolean; pending?: boolean }>;
	decisions: BoardDecision[];
	/** The last number given to a task, question and decision; IDs are never reused. */
	counters: { task: number; question: number; decision: number; /** Absent on boards written before feedback. */ feedback?: number };
	updatedAt: string | null;
	/** Durable return notices, removed only after delivery; request IDs make replay harmless. */
	waitingReturns?: { task: BoardTask; note: string }[];
	/**
	 * The harness's own changes already applied, by the request ID they derive from (the spawn's tool call, the report's
	 * message, the schedule's run), so a rerun after a restart finds its change instead of applying it again. Newest last,
	 * capped; absent on boards written before the harness changed them.
	 */
	harnessKeys?: string[];
	/**
	 * Time each task spent in_progress, by task ID: finished spells in `ms`, and when the current spell began in `since`
	 * (null when it is not in_progress). Kept here rather than on the task, so the view derives `inProgressMinutes` at
	 * read time and a restart loses nothing. Absent on boards written before the clock.
	 */
	inProgress?: Record<string, { ms: number; since: string | null }>;
};

export const BoardDoc = defineDoc<BoardState>({
	kind: stateKind("board"),
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	checkpointWhen: () => false,
	initial: () => emptyBoardState(),
});

export function emptyBoardState(): BoardState {
	return { tasks: [], questions: [], decisions: [], counters: { task: 0, question: 0, decision: 0 }, updatedAt: null };
}

/**
 * The task reference a message starts with: `[task T12] `, or `[task T12, feedback F3] ` when the message was recorded as
 * feedback on the task.
 */
export function taskReference(taskId: string, feedbackId?: string): string {
	return `${TASK_REFERENCE_PREFIX}${taskId}${feedbackId === undefined ? "" : `, feedback ${feedbackId}`}] `;
}

/**
 * A message's content with the task reference in front, unless it is already there. A content without text up front gets
 * a text block of its own.
 */
export function withTaskReference(content: InputContent, taskId: string, feedbackId?: string): InputContent {
	const prefix = taskReference(taskId, feedbackId);
	const named = `${TASK_REFERENCE_PREFIX}${taskId}`;
	const has = (text: string): boolean => text.startsWith(`${named}]`) || text.startsWith(`${named},`);
	if (typeof content === "string") return has(content) ? content : `${prefix}${content}`;
	const first = content[0];
	if (first?.type === "text") {
		return has(first.text) ? content : [{ ...first, text: `${prefix}${first.text}` }, ...content.slice(1)];
	}
	return [{ type: "text", text: prefix.trimEnd() }, ...content];
}

export function emptyReport(): BoardTaskReport {
	return { now: "", results: "", next: "", revision: 0, updatedAt: null, updatedBy: null };
}

/** Give every task of a board written before reports, snapshots and refs the empty ones. Changes `state` in place. */
export function normalizeBoard<T extends BoardState>(state: T): T {
 // Pre-clarification MCP cards used this fixed envelope rather than an explicit discriminant.
 for (const question of state.questions) if (question.mcpApproval === undefined && question.text.startsWith("MCP approval: ") && JSON.stringify(question.options) === JSON.stringify(["Approve once", "Always allow this tool", "Deny"])) question.mcpApproval = true;
	for (const task of state.tasks) {
		task.report ??= emptyReport();
		task.snapshots ??= 0;
		task.refs ??= [];
		task.parent ??= null;
		task.foundWhile ??= null;
		if (task.parent !== null && task.foundWhile === task.parent) task.foundWhile = null;
		task.related ??= [];
		initializeTaskFreshness(state, task);
	}
 return state;
}

/** A task's snapshots, kept outside the board document so its every rewrite stays small. One document per task. */
export type TaskHistoryState = {
	snapshots: BoardTaskSnapshot[];
	/** Snapshot keys already saved (a tool call's, a worker report's), so a rerun after a restart saves nothing twice. */
	keys: string[];
	/** What happened that nothing else on the board records: workers started and reported, link changes. Oldest first. Absent before links. */
	events?: BoardTimelineEntry[];
 /** Stable evolving entries; legacy events/snapshots are folded only on read. */
 timelineEntries?: import("@kemiri/protocol").BoardTimelineFact[];
	/** The task's feedback entries, oldest first. Absent before feedback. */
	feedback?: BoardFeedback[];
	/** Request IDs of messages already recorded as feedback, with the entry each made, so a re-sent message adds none. */
	feedbackKeys?: { key: string; id: string }[];
	/** Bumped on every change of the above, snapshots included; the task carries it as `timelineRevision`. */
	revision?: number;
};

/** The newest snapshots a task keeps, and the keys remembered; far more than a rerun can repeat. */
const KEPT_SNAPSHOTS = 200;
const KEPT_SNAPSHOT_KEYS = 100;
/** Timeline events and feedback entries a task keeps; the oldest settled feedback goes first. */
const KEPT_EVENTS = 500;
const KEPT_FEEDBACK = 300;
const KEPT_FEEDBACK_KEYS = 100;

export const TaskHistoryDoc = defineDocFamily<TaskHistoryState, null>({
	kind: stateKind("board-history"),
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	family: true,
	checkpointWhen: () => false,
	initial: () => ({ snapshots: [], keys: [] }),
});

export const USER_WRITER: BoardWriter = { author: "user", threadId: null, workerId: null };
export const HARNESS_WRITER: BoardWriter = { author: "harness", threadId: null, workerId: null };

export function coordinatorWriter(threadId: string): BoardWriter {
	return { author: "coordinator", threadId, workerId: null };
}

export function workerWriter(threadId: string, workerId: string): BoardWriter {
	return { author: "worker", threadId, workerId };
}

/**
 * Open the project's board in a commit, with every task given a report: the board is main's document, whichever thread
 * or worker changes it.
 */
export async function openBoard(tx: Tx, mainId: ConversationId): Promise<BoardState> {
	return normalizeBoard((await tx.doc(BoardDoc, mainId)) as BoardState);
}

/**
 * Open a task's history in a commit. Open it before the commit's first table write (a created task, conversation or
 * submission) when a snapshot may follow.
 */
export function openTaskHistory(tx: Tx, mainId: ConversationId, taskId: string): Promise<TaskHistoryState> {
	return tx.doc(TaskHistoryDoc, mainId, taskId, null) as Promise<TaskHistoryState>;
}

/**
 * Save a snapshot of `task` as it is now, labelled and credited, unless one with `key` was saved already. Counts it on
 * the task. Returns whether one was saved.
 */
export function addSnapshot(
	history: TaskHistoryState,
	task: BoardTask,
	input: { label: string; by: BoardWriter; at: string; key?: string | undefined; questions?: readonly BoardQuestion[] },
): boolean {
	if (input.key !== undefined) {
		if (history.keys.includes(input.key)) return false;
		history.keys.push(input.key);
		if (history.keys.length > KEPT_SNAPSHOT_KEYS) history.keys.splice(0, history.keys.length - KEPT_SNAPSHOT_KEYS);
	}
	const last = history.snapshots[history.snapshots.length - 1];
	const questionChoices = (input.questions ?? []).flatMap(question =>
		question.taskId === task.id && question.choices !== undefined ? [{ questionId: question.id, choices: plain(question.choices) }] : [],
	);
	history.snapshots.push({
		seq: (last?.seq ?? 0) + 1,
		at: input.at,
		label: input.label,
		by: input.by,
		title: task.title,
		status: task.status,
		...(task.waiting === undefined ? {} : { waiting: plain(task.waiting) }),
		report: {
			now: task.report.now, results: task.report.results, next: task.report.next,
			...(task.report.steps ? { steps: task.report.steps } : {}),
			...(task.report.summary === undefined ? {} : { summary: task.report.summary }),
			...(task.report.notDone === undefined ? {} : { notDone: task.report.notDone }),
			...(task.report.checks === undefined ? {} : { checks: plain(task.report.checks) }),
		},
		...(task.goal === undefined ? {} : { goal: task.goal }),
		...(questionChoices.length === 0 ? {} : { questionChoices }),
	});
	if (history.snapshots.length > KEPT_SNAPSHOTS) history.snapshots.splice(0, history.snapshots.length - KEPT_SNAPSHOTS);
	task.snapshots = history.snapshots.length;
	bumpTimeline(history, task);
	return true;
}

/** Note that the task's timeline gained something the board document does not carry, so readers read it again. */
function bumpTimeline(history: TaskHistoryState, task: BoardTask): void {
	history.revision = Math.max(history.revision ?? 0, task.timelineRevision ?? 0) + 1;
	task.timelineRevision = history.revision;
}

/** Add an entry to a task's own timeline, once per `key` when one is given. Returns whether it was added. */
export function addTimelineEvent(history: TaskHistoryState, task: BoardTask, entry: BoardTimelineEntry, key?: string): boolean {
	if (key !== undefined) {
		const eventKey = `${key}:event`;
		if (history.keys.includes(eventKey)) return false;
		history.keys.push(eventKey);
		if (history.keys.length > KEPT_SNAPSHOT_KEYS) history.keys.splice(0, history.keys.length - KEPT_SNAPSHOT_KEYS);
	}
	history.events ??= [];
	// Read the list back from the history: inside a commit it is the document's own, which tracks the push.
	const events = history.events;
	events.push(entry);
	if (events.length > KEPT_EVENTS) events.splice(0, events.length - KEPT_EVENTS);
	bumpTimeline(history, task);
	return true;
}

/** Mutable attempt projection: one legacy milestone per attempt, never one row per target. */
export function applyTaskDeploy(state: BoardState, history: TaskHistoryState, task: BoardTask, fact: TaskDeployFact): void {
 const summary = deploySummary(fact);
 const ref = `deploy:${fact.scope}:${fact.attemptId}`;
 const detail = [`Attempted ${fact.intendedCommit.slice(0, 12)}`, ...fact.expectedTargets.map(name => {
  const target = fact.targets[name]!;
  const serving = target.servingCommit ?? (target.state === "ok" && !target.backendUnchanged ? fact.intendedCommit : target.previousCommit);
  return `${name}: ${target.state}${target.backendUnchanged ? " (backend unchanged)" : ""}${serving ? ` · serving ${serving.slice(0, 12)}` : ""}${target.message ? ` · ${target.message}` : ""}`;
 })].join("\n");
 const entry = history.events?.find(entry => entry.ref === ref);
 const priorEntry = entry ? { ...entry } : undefined;
 const ready = fact.expectedTargets.filter(name => fact.targets[name]?.state === "ok").length;
 const failed = fact.expectedTargets.some(name => ["failed", "rolled_back"].includes(fact.targets[name]!.state));
 const outcome = failed ? "failed" : ready === fact.expectedTargets.length ? "ok" : "running";
 const unchanged = entry?.detail === detail && entry?.label === summary.text;
 if (entry && !unchanged) { entry.label = summary.text; entry.detail = detail; bumpTimeline(history, task); }
 else if (!entry) addTimelineEvent(history, task, { kind: "milestone", at: fact.observedAt, label: summary.text, detail, ref, by: HARNESS_WRITER });
 if (!unchanged || !history.timelineEntries?.some(entry => entry.id === timelineId(task.id, ref))) {
  if (priorEntry && !history.timelineEntries?.some(entry => entry.id === timelineId(task.id, ref))) upsertTimelineFact(history, task, { ...priorEntry, id: timelineId(task.id, ref), endAt: priorEntry.at, group: "delivery", source: "deploy", outcome: /failed|rolled.back/i.test(priorEntry.label) ? "failed" : /live on/i.test(priorEntry.label) ? "ok" : "running" });
  upsertTimelineFact(history, task, { id: timelineId(task.id, ref), at: entry?.at ?? fact.observedAt, endAt: fact.observedAt, kind: "milestone", group: "delivery", source: "deploy", outcome,
   label: outcome === "ok" ? `live on ${ready}/${fact.expectedTargets.length} targets` : summary.text, detail, ref, by: HARNESS_WRITER });
 }
 state.latestTaskDeploy ??= {};
 const latest = state.latestTaskDeploy[task.id];
 // A late catch-up updates its own history only; it cannot revive an older attempt in Now.
 if (latest?.scope === fact.scope && latest.order > fact.order) return;
 state.latestTaskDeploy[task.id] = { scope: fact.scope, order: fact.order, attemptId: fact.attemptId, outcome: outcome === "ok" ? "live" : outcome === "running" ? "pending" : "failed" };
 const tracking = activityTracking(state, task.id);
 const old = tracking.deploy;
 const unresolved = new Set(tracking.deployFailure?.targets ?? []);
 for (const name of fact.expectedTargets) {
  const target = fact.targets[name]!;
  if (target.state === "ok") unresolved.delete(name);
  else if (target.state === "failed" || target.state === "rolled_back") unresolved.add(name);
 }
 if (unresolved.size) {
  const total = Math.max(fact.expectedTargets.length, tracking.deployFailure?.total ?? 0);
  const text = `Deploy failed on ${unresolved.size} of ${total} targets`;
  tracking.deployFailure = { text, since: tracking.deployFailure?.text === text ? tracking.deployFailure.since : fact.observedAt, refs: [ref], targets: [...unresolved], total };
 } else delete tracking.deployFailure;
 if (summary.state === "delivered") {
  delete tracking.deploy;
  if (old?.state === "active") tracking.lastEndedAt = fact.observedAt;
  if (tracking.delivery?.text !== summary.text || latest?.attemptId !== fact.attemptId) tracking.delivery = { text: summary.text, at: fact.observedAt, refs: [ref], count: fact.expectedTargets.length };
 } else {
  tracking.deploy = { state: summary.state, text: summary.text, since: old?.text === summary.text && latest?.attemptId === fact.attemptId ? old.since : fact.observedAt, refs: [ref] };
  // No old success while a retry is in flight.
  delete tracking.delivery;
 }
 if (unchanged) return;
 noteTaskFact(state, task.id, { actor: "harness", kind: "deploy", reason: summary.text, at: fact.observedAt, ref, ...(summary.outcome ? {} : { sections: ["next"] }) });
}

/** Each task's status, to compare with after a change. */
export function statusesOf(state: Readonly<BoardState>): Map<string, BoardTask["status"]> {
	return new Map(state.tasks.map((task) => [task.id, task.status]));
}

/**
 * Snapshot every task whose status differs from `before` (a task that did not exist then is new, not changed), labelled
 * `old → new`. `key` names the change that did it, so a rerun saves nothing twice; absent for the user's, which never rerun.
 */
export async function snapshotStatusChanges(
	tx: Tx,
	mainId: ConversationId,
	state: BoardState,
	before: ReadonlyMap<string, BoardTask["status"]>,
	input: { by: BoardWriter; at: string; key?: string | undefined },
): Promise<void> {
	for (const task of state.tasks) {
		const was = before.get(task.id);
		if ((was === undefined && task.waiting === undefined) || was === task.status) continue;
		const history = await openTaskHistory(tx, mainId, task.id);
		addSnapshot(history, task, {
			label: `${was ?? "new"} → ${task.status}`,
			questions: state.questions,
			by: task.updatedBy === "harness" ? HARNESS_WRITER : input.by,
			at: input.at,
			key: input.key === undefined ? undefined : `${input.key}:${task.id}:status`,
		});
	}
}

export const ReportCheckInputSchema = Type.Object({
	...BoardReportCheckSchema.properties,
	at: Type.Optional(Type.String({ description: "ISO timestamp; defaults to the time of the write." })),
});
type ReportCheckInput = Static<typeof ReportCheckInputSchema>;

export type ReportWrite = {
	taskId: string;
	/** Replace these sections whole; empty text or an empty list clears one. */
	sections: {
		now?: string | undefined; results?: string | undefined; next?: string | undefined; steps?: string | undefined;
		summary?: string | undefined; notDone?: string | undefined; checks?: ReportCheckInput[] | undefined;
	};
	/** Workers replace only the checks they name. */
	mergeChecks?: ReportCheckInput[] | undefined;
	planUpdate?: LivePlanUpdate | undefined;
	/** A line added to the end of `results`, as a bullet. */
	addResult?: string | undefined;
	by: BoardWriter;
	now: string;
	coveredEventSeq?: number | undefined;
	waitsOn?: string[] | undefined;
};

/**
 * Rewrite the named sections of a task's report. Bumps only the report's revision, never the task's, so the user's edits
 * of the task do not conflict with it.
 */
export function writeReport(state: BoardState, input: ReportWrite, liveWriteKey?: string): BoardTask {
	const task = state.tasks.find((candidate) => candidate.id === input.taskId);
	if (task === undefined) throw unknownTask(input.taskId);
	const { now, results, next, steps, summary, notDone, checks } = input.sections;
	const { mergeChecks } = input;
	if (Object.values(input.sections).every(value => value === undefined) && input.addResult === undefined && !mergeChecks?.length && !input.planUpdate) {
		throw new ServerError("bad_request", "A report write names at least one of now, results, next, steps, summary, notDone and checks");
	}
	const report = (task.report ??= emptyReport());
	initializeTaskFreshness(state, task);
	const previous = { results: report.results, next: report.next, steps: report.steps, summary: report.summary, notDone: report.notDone };
	let checksChanged = false;
 let recordedChecks: BoardReportCheck[] = [];
 if (now !== undefined && !state.taskActivityEnabled) report.now = now.trim();
	if (results !== undefined) report.results = results.trim();
	if (next !== undefined) report.next = next.trim();
	if (steps !== undefined) {
		const markdown = steps.trim();
		if (!markdown) {
			delete report.steps;
			delete report.stepsWrittenAt;
		} else if (markdown !== report.steps) {
			report.steps = markdown;
			report.stepsWrittenAt = input.now;
		}
	}
	for (const [name, text] of [["summary", summary], ["notDone", notDone]] as const) {
		if (text === undefined) continue;
		const markdown = text.trim();
		if (markdown) report[name] = markdown;
		else delete report[name];
	}
	if (checks !== undefined || mergeChecks?.length) {
		const checkWithTimestamp = ({ name, result, count, note, at }: ReportCheckInput): BoardReportCheck => ({
			name, result, ...(count === undefined ? {} : { count }), ...(note === undefined ? {} : { note }), at: at ?? input.now,
		});
		const writtenChecks = (checks ?? mergeChecks ?? []).map(checkWithTimestamp);
  recordedChecks = [...new Map(writtenChecks.map(check => [check.name, check])).values()];
		const nextChecks = checks !== undefined ? writtenChecks : [...new Map(
			[...plain(report.checks ?? []), ...writtenChecks].map(check => [check.name, check] as const),
		).values()];
		checksChanged = JSON.stringify(report.checks ?? []) !== JSON.stringify(nextChecks);
		if (!nextChecks.length) delete report.checks;
		else if (checksChanged) report.checks = nextChecks;
	}
 let addedResult: string | undefined;
 if (input.addResult !== undefined) {
  const line = input.addResult.trim();
  const bullet = /^[-*] /.test(line) ? line : `- ${line}`;
  // The same line twice in a row is a rerun after a restart, not two results.
  if (report.results.split("\n").pop() !== bullet) {
   report.results = report.results ? `${report.results}\n${bullet}` : bullet;
   addedResult = line.replace(/^[-*] /, "");
  }
 }
 if (state.taskActivityEnabled || input.planUpdate) recordLiveReport(state, task.id, input.by, input.now, now, addedResult, liveWriteKey, checksChanged ? recordedChecks : [], input.planUpdate);
	for (const name of ["results", "next"] as const) {
		coverReportSection(state, task, name, { previous: previous[name], by: input.by, at: input.now, coveredEventSeq: input.coveredEventSeq, waitsOn: input.waitsOn });
	}
	if (state.taskActivityEnabled && (Object.keys(previous) as (keyof typeof previous)[]).every(name => previous[name] === report[name]) && !checksChanged) return plain(boardView(state, Date.parse(input.now), true).tasks.find(row => row.id === task.id)!);
 report.revision += 1;
	report.updatedAt = input.now;
	report.updatedBy = { ...input.by };
	state.updatedAt = input.now;
 return state.taskActivityEnabled ? plain(boardView(state, Date.parse(input.now), true).tasks.find(row => row.id === task.id)!) : plain(task);
}

/** Task-linked coordinator actions imply activity for the rest of this turn, not ownership. */
export async function inferCoordinatorTaskFocusIn(tx: Tx, mainId: ConversationId, conversationId: ConversationId, threadId: string, taskId: string, at: string, threadTitle?: string): Promise<void> {
 const live = await tx.doc(LiveDoc, conversationId);
 if (!live.run || live.run.afterRun) return;
 const state = await openBoard(tx, mainId);
 const task = state.tasks.find(task => task.id === taskId);
 if (!state.taskActivityEnabled || !task) return;
 const runId = String(live.run.first ?? live.run.taskId);
 const id = `${threadId}:${conversationId}:${runId}`;
 const tracking = activityTracking(state, taskId);
 if (tracking.sources[id]?.state === "running") return;
 tracking.sources[id] = { actor: { id, kind: threadId === "main" ? "coordinator" : "thread", name: threadId === "main" ? "Coordinator" : (threadTitle ?? threadId), threadId, conversationId, runId }, state: "running", since: at, title: task.title };
 if (threadId !== "main") recordTimelineRun(await openTaskHistory(tx, mainId, taskId), task, tracking.sources[id]!.actor, "running", at, task.title);
}

/**
 * One report write in a commit: rewrite the sections, then snapshot the task when a milestone is named. `key` names the
 * call that does it, so a rerun after a restart saves the snapshot once.
 */
export async function writeReportIn(
	tx: Tx,
	mainId: ConversationId,
	input: Omit<ReportWrite, "now"> & { milestone?: string | undefined },
	key: string,
	at: string,
): Promise<BoardTask> {
	const state = await openBoard(tx, mainId);
	let coverage = input.coveredEventSeq;
	if (input.milestone?.trim()) {
		const task = state.tasks.find((task) => task.id === input.taskId);
		const before = task?.eventSeq ?? 0;
		const unchanged = (["results", "next"] as const).filter((name) => {
			const prose = input.sections[name]?.trim() ?? task?.report[name] ?? "";
			if (prose !== task?.report[name]) return false;
			if (name !== "results" || input.addResult === undefined) return true;
			const line = input.addResult.trim();
			const bullet = /^[-*] /.test(line) ? line : `- ${line}`;
			return prose.split("\n").pop() === bullet;
		});
		noteTaskFact(state, input.taskId, { actor: input.by.author, writer: input.by, kind: "milestone", reason: input.milestone, at, sections: unchanged });
		if (coverage === before) coverage += 1; // The writer authored this fact, but cannot cover an earlier unseen gap.
	}
	const written = writeReport(state, { ...input, coveredEventSeq: coverage, now: at }, key);
	const label = input.milestone?.trim() ?? "";
	if (label === "") return written;
	return snapshotMilestone(tx, mainId, state, { taskId: input.taskId, label, by: input.by, at, key });
}

/** Fold only as part of a run's existing lifecycle commit. No history document is opened for an empty trail. */
export async function foldTaskLiveIn(tx: Tx, mainId: ConversationId, state: BoardState, taskId: string, sourceId: string, outcome: string, at: string, detail = "", saves: readonly TaskArtifactSave[] = []): Promise<boolean> {
 if (!state.taskLiveEnabled) return false;
 const tracking = state.taskActivity?.[taskId];
 const source = tracking?.sources[sourceId];
 const task = state.tasks.find(task => task.id === taskId);
 if (!tracking || !source || !task) return false;
 if (source.liveFolded) return false;
 const runSaves = saves.filter(save => save.taskId === taskId && save.conversationId === source.actor.conversationId && save.runId === source.actor.runId);
 const endingAt = Date.parse(at);
 const watcher = source.actor.kind === "worker" && watcherCanPublish(state, taskId, endingAt) ? new TaskWatcherRun() : undefined;
 if (source.actor.kind !== "worker" && !watcher && !tracking.liveLines?.some(line => line.actor.id === sourceId) && !source.livePlan && !runSaves.length) return false;
 const run = new TaskLiveRun();
 const first = Number(source.actor.runId);
 if (Number.isSafeInteger(first) && first > 0) {
  const conversationId = source.actor.conversationId as ConversationId;
  const belongsToConversation = (await tx.entry(first as EntryId))?.conversationId === conversationId;
  if (belongsToConversation) {
   const nextRunFirst = (await tx.doc(LiveDoc, conversationId)).run?.first;
   const maxEntryId = nextRunFirst !== undefined && nextRunFirst > first ? (nextRunFirst - 1) as EntryId : undefined;
   let cursor: Parameters<Tx["scanEntries"]>[2];
   do {
    const page = await tx.scanEntries({ conversationId, minEntryId: first as EntryId, order: "ascending", ...(maxEntryId === undefined ? {} : { maxEntryId }) }, 200, cursor);
    for (const entry of page.items) { run.add(entry); watcher?.add(entry); }
    cursor = page.next;
   } while (cursor !== undefined);
  }
 }
 const queued = watcher && evaluateWatcherRun(state, taskId, tracking, source, watcher, endingAt, true);
 const trail = takeLiveTrail(tracking, source);
 const pending = Object.values(state.taskWatcherJobs ?? {}).some(job => job.taskId === taskId && job.source.id === sourceId);
 const { lines, counters } = liveRunFacts(taskId, source, run, runSaves);
 if (!trail && !lines.length && !queued && !pending) return false;
 const live = { ...trail, lines: mergeLiveLines(trail?.lines ?? [], lines), ...(counters ? { counters } : {}) };
 delete source.liveChecks;
 delete source.liveCheckWrites;
 delete source.liveCommits;
 source.liveFolded = true;
 recordTimelineRun(await openTaskHistory(tx, mainId, taskId), task, source.actor, outcome, at, detail, live, source.liveStartedAt);
 return true;
}

/** Snapshot a task under `label` because a report write named a milestone; opens its history in the commit. */
export async function snapshotMilestone(
	tx: Tx,
	mainId: ConversationId,
	state: BoardState,
	input: { taskId: string; label: string; by: BoardWriter; at: string; key?: string | undefined },
): Promise<BoardTask> {
	const task = state.tasks.find((candidate) => candidate.id === input.taskId);
	if (task === undefined) throw unknownTask(input.taskId);
	addSnapshot(await openTaskHistory(tx, mainId, task.id), task, {
		label: input.label.trim(),
		questions: state.questions,
		by: input.by,
		at: input.at,
		key: input.key === undefined ? undefined : `${input.key}:${task.id}:milestone`,
	});
	return plain(task);
}

// --- feedback ----------------------------------------------------------------------------------------------------

/** The longest user message a feedback entry keeps whole. */
const FEEDBACK_TEXT_CHARS = 8_000;
/** What the user may do with an entry from the app; the coordinator may not dismiss. */
export const COORDINATOR_FEEDBACK_STATES: readonly BoardFeedbackState[] = ["open", "handling", "addressed"];

export function feedbackCounts(entries: readonly BoardFeedback[]): BoardFeedbackCounts {
	const counts = { open: 0, handling: 0, addressed: 0, dismissed: 0 };
	for (const entry of entries) counts[entry.state] += 1;
	return counts;
}

function unknownFeedback(taskId: string, feedbackId: string): ServerError {
	return new ServerError("unknown_task", `No feedback "${feedbackId}" on task ${taskId}`, { taskId, feedbackId });
}

/**
 * Record a user message about a task as a feedback entry, `open`. `key` is the message's request ID: a re-sent message finds
 * its entry instead of adding another. Returns the entry. Counts it on the task.
 */
export function recordFeedback(
	state: BoardState,
	history: TaskHistoryState,
	input: { taskId: string; text: string; images: number; threadId: string; key: string; now: string },
): BoardFeedback {
	const task = state.tasks.find((candidate) => candidate.id === input.taskId);
	if (task === undefined) throw unknownTask(input.taskId);
	history.feedback ??= [];
	history.feedbackKeys ??= [];
	// Read the lists back from the history: inside a commit they are the document's own, which tracks the pushes.
	const entries = history.feedback;
	const keys = history.feedbackKeys;
	const known = keys.find((entry) => entry.key === input.key);
	const existing = known === undefined ? undefined : entries.find((entry) => entry.id === known.id);
	if (existing !== undefined) return plain(existing);
	state.counters.feedback = (state.counters.feedback ?? 0) + 1;
	const text = input.text.trim();
	const entry: BoardFeedback = {
		id: `F${state.counters.feedback}`,
		text: text.length <= FEEDBACK_TEXT_CHARS ? text : `${text.slice(0, FEEDBACK_TEXT_CHARS - 1)}…`,
		...(input.images > 0 ? { images: input.images } : {}),
		threadId: input.threadId,
		at: input.now,
		state: "open",
		note: null,
		updatedAt: input.now,
		changes: [],
	};
	entries.push(entry);
	keys.push({ key: input.key, id: entry.id });
	if (keys.length > KEPT_FEEDBACK_KEYS) keys.splice(0, keys.length - KEPT_FEEDBACK_KEYS);
	if (entries.length > KEPT_FEEDBACK) {
		const closed = entries.findIndex((candidate) => candidate.state === "addressed" || candidate.state === "dismissed");
		entries.splice(closed < 0 ? 0 : closed, 1);
	}
	task.feedback = feedbackCounts(entries);
 activityTracking(state, task.id).feedback = entries.filter(f => f.state === "open").map(f => ({ id: f.id, at: f.at }));
	state.updatedAt = input.now;
	noteTaskFact(state, task.id, { actor: "user", kind: "feedback", reason: `${entry.id} received`, at: input.now });
	bumpTimeline(history, task);
	return plain(entry);
}

/**
 * Move a feedback entry to `state`, with a note (what addressed it, what is being done). The same state with a new note
 * rewrites the note; the same state and note changes nothing. Returns the entry and whether anything changed.
 */
export function setFeedbackState(
	state: BoardState,
	history: TaskHistoryState,
	input: { taskId: string; feedbackId: string; state: BoardFeedbackState; note: string | null; by: BoardWriter; now: string },
): { feedback: BoardFeedback; changed: boolean; before: BoardFeedbackState } {
	const task = state.tasks.find((candidate) => candidate.id === input.taskId);
	if (task === undefined) throw unknownTask(input.taskId);
	const entry = (history.feedback ?? []).find((candidate) => candidate.id === input.feedbackId);
	if (entry === undefined) throw unknownFeedback(input.taskId, input.feedbackId);
	const note = input.note === null || input.note.trim() === "" ? null : input.note.trim();
	if (input.state === "addressed" && note === null) {
		throw new ServerError("bad_request", `Marking ${entry.id} addressed needs a note with the answer or what addressed it (a commit or result).`);
	}
	const before = entry.state;
	// Leaving a state without saying why must not keep the old reason: a note belongs to the change that wrote it.
	const nextNote = note ?? (input.state === entry.state ? entry.note : null);
	if (input.state === entry.state && nextNote === entry.note) return { feedback: plain(entry), changed: false, before };
	entry.state = input.state;
	entry.note = nextNote;
	entry.updatedAt = input.now;
	entry.changes.push({ state: input.state, at: input.now, by: input.by, note });
	if (input.state === "addressed") noteTaskFact(state, task.id, { actor: input.by.author, kind: "feedback_addressed", reason: `${entry.id} addressed`, at: input.now });
	task.feedback = feedbackCounts(history.feedback ?? []);
 activityTracking(state, task.id).feedback = (history.feedback ?? []).filter(f => f.state === "open").map(f => ({ id: f.id, at: f.at }));
	state.updatedAt = input.now;
	bumpTimeline(history, task);
	return { feedback: plain(entry), changed: true, before };
}

/** Open and handling entries first (oldest first), then the settled ones, newest first. */
export function sortFeedback(entries: readonly BoardFeedback[]): BoardFeedback[] {
	const live = (entry: BoardFeedback): boolean => entry.state === "open" || entry.state === "handling";
	const byTime = (left: BoardFeedback, right: BoardFeedback): number => left.at.localeCompare(right.at) || compareIds(left.id, right.id);
	return [
		...entries.filter(live).sort(byTime),
		...entries.filter((entry) => !live(entry)).sort((left, right) => byTime(right, left)),
	];
}

// --- links -------------------------------------------------------------------------------------------------------

/** What each kind of link says from the task that stores it, and from the task it points at. */
export const LINK_WORDS: Record<BoardLinkKind, { out: string; in: string }> = {
	parent: { out: "subtask of", in: "has subtask" },
	foundWhile: { out: "found while working on", in: "led to" },
	related: { out: "related to", in: "related to" },
	blockedBy: { out: "blocked by", in: "blocks" },
};

type TaskLinks = { parent: string | null; foundWhile: string | null; related: string[]; blockedBy: string[] };

function linksOfTask(task: BoardTask): TaskLinks {
	return {
		parent: task.parent ?? null,
		foundWhile: task.foundWhile ?? null,
		related: [...(task.related ?? [])],
		blockedBy: [...task.blockedBy],
	};
}

/** Each task's links, to compare with after a change. */
export function linksOfBoard(state: Readonly<BoardState>): Map<string, TaskLinks> {
	return new Map(state.tasks.map((task) => [task.id, linksOfTask(task)]));
}

/** The links a task stores, as `[kind, target]` pairs. */
function linkPairs(links: TaskLinks): [BoardLinkKind, string][] {
	const pairs: [BoardLinkKind, string][] = [];
	if (links.parent !== null) pairs.push(["parent", links.parent]);
	if (links.foundWhile !== null) pairs.push(["foundWhile", links.foundWhile]);
	for (const id of links.related) pairs.push(["related", id]);
	for (const id of links.blockedBy) pairs.push(["blockedBy", id]);
	return pairs;
}

/**
 * Add a timeline entry to both ends of every link a change added or removed: "Subtask of T8" on the subtask, "Has subtask
 * T5" on T8. `related` is stored on both tasks, so each end logs its own diff. Opens the histories it needs in `tx`.
 */
export async function logLinkChanges(
	tx: Tx,
	mainId: ConversationId,
	state: BoardState,
	before: ReadonlyMap<string, TaskLinks>,
	input: { by: BoardWriter; at: string },
): Promise<void> {
	const empty: TaskLinks = { parent: null, foundWhile: null, related: [], blockedBy: [] };
	const changes: { task: BoardTask; kind: BoardLinkKind; other: string; added: boolean; out: boolean }[] = [];
	for (const task of state.tasks) {
		const was = linkPairs(before.get(task.id) ?? empty).map(([kind, id]) => `${kind}:${id}`);
		const now = linkPairs(linksOfTask(task)).map(([kind, id]) => `${kind}:${id}`);
		for (const entry of now.filter((key) => !was.includes(key))) changes.push(split(task, entry, true));
		for (const entry of was.filter((key) => !now.includes(key))) changes.push(split(task, entry, false));
	}
	function split(task: BoardTask, key: string, added: boolean): (typeof changes)[number] {
		const [kind, other] = key.split(":") as [BoardLinkKind, string];
		return { task, kind, other: other as string, added, out: true };
	}
	for (const change of changes) {
		const ends = [{ task: change.task, other: change.other, out: true }];
		if (change.kind !== "related") {
			const target = state.tasks.find((candidate) => candidate.id === change.other);
			if (target !== undefined) ends.push({ task: target, other: change.task.id, out: false });
		}
		for (const end of ends) {
			const words = LINK_WORDS[change.kind][end.out ? "out" : "in"];
			const history = await openTaskHistory(tx, mainId, end.task.id);
			addTimelineEvent(history, end.task, {
				at: input.at,
				kind: "link",
				label: change.added ? `${capitalize(words)} ${end.other}` : `No longer ${words} ${end.other}`,
				ref: end.other,
				by: { ...input.by },
			});
		}
	}
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Whether following `kind` links up from `from` reaches `taskId`. */
function chainReaches(state: Readonly<BoardState>, kind: "parent" | "foundWhile", from: string, taskId: string): boolean {
	const seen = new Set<string>();
	let current: string | null = from;
	while (current !== null && !seen.has(current)) {
		if (current === taskId) return true;
		seen.add(current);
		current = state.tasks.find((task) => task.id === current)?.[kind] ?? null;
	}
	return false;
}

/**
 * Refuse links that cannot hold: a task that does not exist, a link to itself, a parent or origin chain that comes back to
 * the task. Links to settled or archived tasks are fine. `taskId` is null for a task not made yet.
 */
function checkLinks(
	state: Readonly<BoardState>,
	taskId: string | null,
	links: { parent?: string | null | undefined; foundWhile?: string | null | undefined; related?: readonly string[] | undefined },
): void {
	const ids = new Set(state.tasks.map((task) => task.id));
	const known = (id: string, link: string): void => {
		if (!ids.has(id)) throw unknownTask(id);
		if (id === taskId) throw new ServerError("bad_request", `Task ${id} cannot be ${link} itself`);
	};
	for (const kind of ["parent", "foundWhile"] as const) {
		const target = links[kind];
		if (target === undefined || target === null) continue;
		known(target, LINK_WORDS[kind].out);
		if (taskId !== null && chainReaches(state, kind, target, taskId)) {
			throw new ServerError(
				"bad_request",
				kind === "parent"
					? `${taskId} cannot be a subtask of ${target}: ${target} is already ${taskId}'s own subtask, or below it. Subtasks cannot form a cycle.`
					: `${taskId} cannot be found while working on ${target}: ${target} was itself found through ${taskId}.`,
			);
		}
	}
	for (const id of links.related ?? []) known(id, LINK_WORDS.related.out);
}

/** Make `task`'s related list `ids`, and keep each other task's list in step. Does not touch revisions. */
function setRelated(state: BoardState, task: BoardTask, ids: readonly string[]): void {
	const next = unique(ids);
	const previous = task.related ?? [];
	for (const id of previous.filter((other) => !next.includes(other))) {
		const other = state.tasks.find((candidate) => candidate.id === id);
		if (other !== undefined) other.related = (other.related ?? []).filter((back) => back !== task.id);
	}
	for (const id of next.filter((other) => !previous.includes(other))) {
		const other = state.tasks.find((candidate) => candidate.id === id);
		if (other !== undefined && !(other.related ?? []).includes(task.id)) other.related = [...(other.related ?? []), task.id];
	}
	task.related = next;
}

/**
 * Add or remove one link on a task. It bumps no revision (links are not part of what the user edits), so a coordinator
 * links without reading the task first. A second parent or origin is refused: unlink the first, or change it with
 * `update_task`.
 */
export function changeLink(
	state: BoardState,
	input: { taskId: string; link: BoardLinkKind; to: string | undefined; remove: boolean; now: string },
): TaskChange {
	const task = state.tasks.find((candidate) => candidate.id === input.taskId);
	if (task === undefined) throw unknownTask(input.taskId);
	const before = plain(task);
	const { link, to } = input;
	if (link === "parent" || link === "foundWhile") {
		const words = LINK_WORDS[link].out;
		if (input.remove) {
			if (to !== undefined && task[link] !== to) throw new ServerError("bad_request", `${task.id} is not ${words} ${to}`);
			task[link] = null;
		} else {
			const target = need(to, "link", "to");
			// Ignore a duplicate origin without replacing any other valid link.
			if (link === "foundWhile" && target === task.parent) return { before, after: plain(task) };
			checkLinks(state, task.id, { [link]: target });
			const current = task[link] ?? null;
			if (current !== null && current !== target) {
				throw new ServerError("bad_request", `${task.id} is already ${words} ${current}: a task has at most one. Unlink it first, or change it with update_task.`);
			}
			if (link === "parent") checkTaskRules(state, { ...task, parent: target }, task);
   task[link] = target;
		}
	} else if (link === "related") {
		const target = need(to, input.remove ? "unlink" : "link", "to");
		if (input.remove) setRelated(state, task, (task.related ?? []).filter((id) => id !== target));
		else {
			checkLinks(state, task.id, { related: [target] });
			setRelated(state, task, [...(task.related ?? []), target]);
		}
	} else {
		const target = need(to, input.remove ? "unlink" : "link", "to");
		if (input.remove) task.blockedBy = task.blockedBy.filter((id) => id !== target);
		else {
			const blockedBy = unique([...task.blockedBy, target]);
			checkBlockedBy(state, task.id, blockedBy);
			checkTaskRules(state, { ...task, blockedBy }, task);
   task.blockedBy = blockedBy;
		}
	}
	if (task.parent != null && task.foundWhile === task.parent) task.foundWhile = null;
	state.updatedAt = input.now;
	if (before.blockedBy.some((id) => !task.blockedBy.includes(id))) noteTaskFact(state, task.id, { actor: "coordinator", kind: "blocker_resolved", reason: "blocker resolved", at: input.now });
	const notices = repairTaskParts(state, input.now);
 return { before, after: plain(task), notices };
}

/** Explain canonicalization without claiming an ignored origin link was added. */
function duplicateOriginNotice(change: TaskChange, requested?: string | null): string {
	const repairs = change.notices?.length ? ` ${change.notices.join(" ")}` : "";
 const origin = requested === undefined ? change.before?.foundWhile : requested;
	return origin != null && origin === change.after.parent && change.after.foundWhile !== origin
		? ` Dropped duplicate foundWhile ${origin}; kept parent only for that task.${repairs}` : repairs;
}

function need<T>(value: T | undefined, action: string, field: string): T {
	if (value === undefined) throw new ServerError("bad_request", `${action} needs \`${field}\``);
	return value;
}

// --- the timeline ------------------------------------------------------------------------------------------------

/** A snapshot label of the form "in_progress → review" is a status move; any other label names a report milestone. */
function isStatusLabel(label: string): boolean {
	return /^[a-z_]+ → [a-z_]+$/.test(label);
}

/**
 * Everything that happened to a task, oldest first, from what the board and the task's own history hold: feedback and
 * its state changes, status moves and milestones (snapshots), workers and link changes (events), the task's questions
 * and warnings, and its decisions. Entries with the same time keep that order. `kinds` keeps only those kinds.
 */
export function buildTimeline(
	task: Pick<BoardTask, "id">,
	state: Readonly<BoardState>,
	history: Readonly<TaskHistoryState> | undefined,
	kinds?: readonly BoardTimelineKind[],
): { entries: BoardTimelineEntry[]; feedback: BoardFeedback[] } {
	const entries: BoardTimelineEntry[] = [];
	const feedback = history?.feedback ?? [];
	for (const entry of feedback) {
		const images = entry.images === undefined ? "" : ` (${entry.images} image${entry.images === 1 ? "" : "s"})`;
		entries.push({
			at: entry.at,
			kind: "feedback",
			label: `Feedback ${entry.id}`,
			detail: `${entry.text}${images}`,
			ref: entry.id,
			state: "open",
			by: USER_WRITER,
		});
		for (const change of entry.changes) {
			entries.push({
				at: change.at,
				kind: "feedback",
				label: `${entry.id} → ${change.state}`,
				...(change.note === null ? {} : { detail: change.note }),
				ref: entry.id,
				state: change.state,
				by: change.by,
			});
		}
	}
	for (const snapshot of history?.snapshots ?? []) {
		entries.push({
			at: snapshot.at,
			kind: isStatusLabel(snapshot.label) ? "status" : "milestone",
			label: snapshot.label,
			...(snapshot.waiting === undefined ? {} : { detail: `Waiting for ${snapshot.waiting.note}${snapshot.waiting.until === undefined ? "" : ` · back on ${snapshot.waiting.until}`}` }),
			ref: String(snapshot.seq),
			by: snapshot.by,
		});
	}
	entries.push(...(state.taskLiveEnabled ? foldedLiveEntries(history) : history?.events ?? []));
	for (const question of state.questions.filter((candidate) => candidate.taskId === task.id)) {
		for (const exchange of question.exchanges ?? []) entries.push({ at: exchange.at, kind: "question", label: `${question.id}${exchange.author.author === "user" ? ": you asked back" : exchange.previousWording ? " revised" : " clarified"}`, detail: exchange.text, ref: question.id, by: exchange.author });
  const word = question.kind === "warning" ? "Warning" : "Question";
		entries.push({ at: question.askedAt, kind: "question", label: `${word} ${question.id}`, detail: question.text, ref: question.id });
		if (question.status !== "open" && question.answeredAt !== null) {
			entries.push({
				at: question.answeredAt,
				kind: "question",
				label: `${question.id} ${question.status === "answered" ? (question.kind === "warning" ? "acknowledged" : "answered") : "withdrawn"}`,
				...(question.answer === null ? {} : { detail: question.answer }),
				ref: question.id,
				by: question.status === "answered" ? USER_WRITER : undefined,
			});
		}
	}
	for (const decision of state.decisions.filter((candidate) => candidate.taskId === task.id)) {
		entries.push({
			at: decision.at,
			kind: "decision",
			label: `Decision ${decision.id}`,
			detail: decision.why === null ? decision.text : `${decision.text} — ${decision.why}`,
			ref: decision.id,
		});
	}
	const ordered = entries
		.map((entry, index) => ({ entry: stripUndefined(entry), index }))
		.sort((left, right) => left.entry.at.localeCompare(right.entry.at) || left.index - right.index)
		.map(({ entry }) => entry);
	return {
		entries: kinds === undefined || kinds.length === 0 ? ordered : ordered.filter((entry) => kinds.includes(entry.kind)),
		feedback: sortFeedback(feedback),
	};
}

function stripUndefined(entry: BoardTimelineEntry): BoardTimelineEntry {
	return Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined)) as BoardTimelineEntry;
}

const SETTLED = new Set(["done", "dropped"]);

function isSettled(task: BoardTask): boolean {
	return SETTLED.has(task.status);
}

function isArchivedAt(task: BoardTask, now: number): boolean {
	return task.settledAt !== null && isSettled(task) && Date.parse(task.settledAt) + ARCHIVE_AFTER_MS <= now;
}

/** Account for a status change in the task's in_progress clock, before the status is set. */
function clockStatus(state: BoardState, task: BoardTask | { id: string; status: null }, status: BoardTask["status"], now: string): void {
 if (task.status !== status) { const tracking = activityTracking(state, task.id); tracking.status = status; tracking.statusSince = now; tracking.statusChanges = (tracking.statusChanges ?? 0) + 1; }
	if (task.status === status) return;
	const clocks = (state.inProgress ??= {});
	const clock = clocks[task.id] ?? { ms: 0, since: null };
	if (clock.since !== null && status !== "in_progress") {
		clock.ms += Math.max(0, Date.parse(now) - Date.parse(clock.since));
		clock.since = null;
	}
	if (status === "in_progress" && clock.since === null) clock.since = now;
	if (clock.ms > 0 || clock.since !== null) clocks[task.id] = clock;
}

/** Minutes a task spent in_progress so far, the current spell included; undefined when it never was. */
export function inProgressMinutes(state: Readonly<BoardState>, taskId: string, now: number): number | undefined {
	const clock = state.inProgress?.[taskId];
	if (clock === undefined) return undefined;
	const running = clock.since === null ? 0 : Math.max(0, now - Date.parse(clock.since));
	return Math.floor((clock.ms + running) / 60_000);
}

/** Persist the archive flag on every task whose 7 days passed. Returns whether anything changed. */
export function sweepArchive(state: BoardState, now: number): boolean {
	let changed = false;
	for (const task of state.tasks) {
		if (!task.archived && isArchivedAt(task, now)) {
			task.archived = true;
			changed = true;
		}
	}
	return changed;
}

/** The board as the protocol shows it: by order, archived tasks only when asked for, questions open first. */
export function boardView(state: Readonly<BoardState>, now: number, includeArchived: boolean): Board {
	const byOrder = (left: { order: number; id: string }, right: { order: number; id: string }): number =>
		left.order - right.order || compareIds(left.id, right.id);
	// Links are derived over every task, archived ones too: a link to a closed task stays.
	const ordered = [...state.tasks].sort(byOrder);
	const reverse = (pick: (task: BoardTask) => readonly string[]): Map<string, string[]> => {
		const map = new Map<string, string[]>();
		for (const task of ordered) for (const target of pick(task)) map.set(target, [...(map.get(target) ?? []), task.id]);
		return map;
	};
	const children = reverse((task) => (task.parent == null ? [] : [task.parent]));
	const found = reverse((task) => (task.foundWhile == null || task.foundWhile === task.parent ? [] : [task.foundWhile]));
	const blocking = reverse((task) => task.blockedBy);
	const byId = new Map(state.tasks.map((task) => [task.id, task]));
 const trackingFor = (task: BoardTask): TaskActivityTracking | undefined => {
  const tracking = state.taskActivity?.[task.id];
  return tracking && !state.deployFeedConfigured ? { ...tracking, deploy: undefined, deployFailure: undefined, deployUnknownSince: undefined, delivery: tracking.delivery?.text.startsWith("Live on") ? undefined : tracking.delivery } : tracking;
 };
 const derivedStates = new Map<string, NonNullable<BoardTask["state"]>>();
 const deriving = new Set<string>();
 const stateFor = (task: BoardTask): NonNullable<BoardTask["state"]> => {
  const cached = derivedStates.get(task.id);
  if (cached) return cached;
  deriving.add(task.id);
  const parts = (children.get(task.id) ?? []).flatMap(id => {
   const child = byId.get(id);
   return child && child.status !== "dropped" && !deriving.has(id) ? [{ id, state: stateFor(child) }] : [];
  });
  const derived = taskState(task, state.questions, state.tasks, trackingFor(task), now, parts);
  deriving.delete(task.id);
  derivedStates.set(task.id, derived);
  return derived;
 };
	const all = state.tasks
		.map((task) => {
   const tracking = trackingFor(task);
			let activity = state.taskActivityEnabled ? taskActivity(task, state.questions, state.tasks, tracking, now) : undefined;
   const minutes = inProgressMinutes(state, task.id, now);
			const subtasks = children.get(task.id) ?? [];
			const counted = subtasks.map((id) => byId.get(id)).filter((child): child is BoardTask => child !== undefined && child.status !== "dropped");
   const derived = state.taskStateEnabled ? stateFor(task) : undefined;
   const subtaskStates = state.taskPartStatesEnabled && derived && subtasks.length ? counted.map(child => stateFor(child).kind) : undefined;
   const live = state.taskLiveEnabled && !isSettled(task) ? taskLive(tracking, activity?.actor) : undefined;
   let shown = derived;
   if (activity && subtaskStates?.length && derived && derived.kind !== "clarifying" && (derived.group === "in_progress" || derived.group === "todo")) {
    const done = subtaskStates.filter(kind => kind === "done").length;
    const working = subtaskStates.filter(kind => kind === "working").length;
    const needsYou = subtaskStates.filter(kind => ["failed", "answer_needed", "steps_needed", "review"].includes(kind)).length;
    activity = { kind: derived.kind === "working" ? "working" : derived.kind === "todo" ? "not_started" : "idle", text: `${done} of ${subtaskStates.length} parts done${working ? ` · ${working} working` : ""}${needsYou ? ` · ${needsYou} needs you` : ""}`, since: derived.since, refs: derived.refs };
    shown = { ...derived, sentence: { ...activity, ageFormat: "none" } };
   }
			return {
				...task,
				report: { ...(task.report ?? emptyReport()), ...(activity ? { now: activity.text } : {}) },
    ...(activity ? { activity } : {}),
    ...(shown ? { state: shown } : {}),
    ...(live ? { live } : {}),
    ...(subtaskStates ? { subtaskStates } : {}),
				snapshots: task.snapshots ?? 0,
				refs: task.refs ?? [],
				parent: task.parent ?? null,
				foundWhile: task.foundWhile === task.parent ? null : task.foundWhile ?? null,
				related: task.related ?? [],
				subtasks,
				ledTo: found.get(task.id) ?? [],
				blocks: blocking.get(task.id) ?? [],
				...(subtasks.length === 0 ? {} : { subtaskCount: { total: counted.length, done: counted.filter((child) => child.status === "done").length } }),
				...(task.feedback === undefined ? {} : { feedback: { ...task.feedback } }),
				archived: task.archived || isArchivedAt(task, now),
				...(minutes === undefined ? {} : { inProgressMinutes: minutes }),
			};
		});
	const tasks = all.filter((task) => includeArchived || !task.archived).sort(byOrder);
	const shown = new Set(tasks.map((task) => task.id));
	const wanted = new Set<string>();
	for (const task of tasks) {
		for (const id of [task.parent, task.foundWhile, ...task.related, ...task.blockedBy, ...task.subtasks, ...task.ledTo, ...task.blocks]) {
			if (id != null && !shown.has(id)) wanted.add(id);
		}
	}
	const archivedLinks: BoardTaskBrief[] = all
		.filter((task) => wanted.has(task.id))
		.sort(byOrder)
		.map((task) => ({ id: task.id, title: task.title, status: task.status, archived: task.archived }));
	const open = state.questions.filter((question) => question.status === "open");
	const settled = state.questions
		.filter((question) => question.status !== "open")
		.sort((left, right) => (right.answeredAt ?? right.askedAt).localeCompare(left.answeredAt ?? left.askedAt))
		.slice(0, KEPT_SETTLED_QUESTIONS);
	return {
		tasks,
		...(archivedLinks.length === 0 ? {} : { archivedLinks }),
		questions: [...open.sort((left, right) => compareIds(left.id, right.id)), ...settled],
		decisions: [...state.decisions].reverse(),
		updatedAt: state.updatedAt,
	};
}

export function openQuestionCount(state: Readonly<BoardState> | undefined): number {
	return state === undefined ? 0 : state.questions.filter((question) => question.status === "open" && question.waitingOn !== "agent").length;
}

function compareIds(left: string, right: string): number {
	return Number(left.slice(1)) - Number(right.slice(1));
}

// --- mutators: each runs inside one commit and throws a ServerError to abort it ----------------------------------

export type TaskChange = {
	/** What a reader sees of the change, for the coordinator's `[board]` input. */
	before: BoardTask | null;
	after: BoardTask;
 notices?: string[];
};

function unknownTask(id: string): ServerError {
	return new ServerError("unknown_task", `No task "${id}" on the board`, { taskId: id });
}

function conflict(kind: string, id: string, current: number, expected: number): ServerError {
	return new ServerError(
		"board_conflict",
		`${kind} ${id} changed since you read it: it is at revision ${current}, not ${expected}. Read it again before editing.`,
		{ id, revision: current },
	);
}

function checkBlockedBy(state: BoardState, taskId: string | null, blockedBy: readonly string[]): void {
	const ids = new Set(state.tasks.map((task) => task.id));
	for (const blocker of blockedBy) {
		if (!ids.has(blocker)) throw unknownTask(blocker);
		if (blocker === taskId) throw new ServerError("bad_request", `Task ${blocker} cannot wait for itself`);
	}
	if (taskId === null) return;
	// A cycle exists when a task reachable through the new edges is the task itself.
	const edges = new Map<string, readonly string[]>(state.tasks.map((task) => [task.id, task.blockedBy]));
	edges.set(taskId, blockedBy);
	const seen = new Set<string>();
	const stack = [...blockedBy];
	while (stack.length > 0) {
		const next = stack.pop() as string;
		if (next === taskId) throw new ServerError("bad_request", `Task ${taskId} would wait for itself through ${blockedBy.join(", ")}: dependencies cannot form a cycle`);
		if (seen.has(next)) continue;
		seen.add(next);
		stack.push(...(edges.get(next) ?? []));
	}
}

/** A copy outside the transaction's draft, which cannot leave the commit. */
function plain<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function unique(values: readonly string[]): string[] {
	return [...new Set(values)];
}

/** Refs trimmed, without empties or repeats. */
function cleanRefs(refs: readonly string[]): string[] {
	return unique(refs.map((ref) => ref.trim()).filter((ref) => ref.length > 0));
}


const OPEN_FOR_REVIEW = new Set(["todo", "in_progress", "blocked"]);
const statusWords = (status: string): string => ({ todo: "to do", in_progress: "in progress", review: "in review" }[status] ?? status);
const namedParts = (parts: readonly BoardTask[]): string => parts.map(t => `${t.id} (${statusWords(t.status)})`).join(" and ");

export function refuseOpenBlockers(task: Pick<BoardTask, "id" | "blockedBy">, tasks: readonly BoardTask[], status = "in_progress"): void {
 const blockers = openTaskBlockers(task, tasks);
 if (!blockers.length) return;
 throw new ServerError("bad_request", `${task.id} is blocked by ${namedParts(blockers)}. Wait for ${blockers.map(t => t.id).join(" and ")} to close, or if ${task.id} no longer needs it, remove the blocker in the same call: update_task id=${task.id} status=${status} blockedBy=[]`);
}

function checkTaskRules(state: BoardState, task: Pick<BoardTask, "id" | "status" | "blockedBy" | "blockedReason" | "parent">, before?: BoardTask): void {
 if (task.status === "blocked" && !task.blockedReason?.trim()) throw new ServerError("bad_request", "Status blocked is for a failure or being stuck; give blockedReason. To wait for another task, keep status todo and set blockedBy.");
 if ((before?.status === task.status || task.status === "waiting") && ["in_progress", "review", "waiting"].includes(task.status) && task.blockedBy.some(id => !before?.blockedBy.includes(id) && openTaskBlockers({ blockedBy: [id] }, state.tasks).length)) {
  throw new ServerError("bad_request", `${task.id} can't add an open blocker while ${statusWords(task.status)}. Move it to todo in the same call: update_task id=${task.id} status=todo blockedBy=[${task.blockedBy.join(",")}].`);
 }
 if (["in_progress", "review"].includes(task.status)) refuseOpenBlockers(task, state.tasks, task.status);
 if (["review", "waiting"].includes(task.status)) {
  const parts = state.tasks.filter(t => t.parent === task.id && OPEN_FOR_REVIEW.has(t.status));
  if (parts.length) throw new ServerError("bad_request", `${task.id} can't go to ${task.status}: its parts ${namedParts(parts)} are not finished. Finish them first. If one is a follow-up rather than a part of ${task.id}, make it one: update_task id=${parts[0]!.id} parent=null foundWhile=${task.id}.`);
 }
 if (task.parent && task.parent !== before?.parent && !SETTLED.has(task.status)) {
  const parent = state.tasks.find(t => t.id === task.parent);
  if (parent && ["review", "waiting", "done", "dropped"].includes(parent.status)) throw new ServerError("bad_request", `${task.id} can't become an open part of ${parent.id} (${statusWords(parent.status)}). Use foundWhile=${parent.id} for follow-up work${isSettled(parent) ? "." : `, or move ${parent.id} back to in_progress first.`}`);
 }
}

/** Preserve existing discovery origins; never overwrite one to detach a required part. */
function makeFollowUp(state: BoardState, part: BoardTask, parentId: string, now: string): void {
 part.parent = null;
 if (!part.foundWhile) part.foundWhile = parentId;
 else if (part.foundWhile !== parentId) setRelated(state, part, [...(part.related ?? []), parentId]);
 touchByHarness(state, part, part.status, now);
}

/** Repairs climb direct links only. Also called by transaction snapshotting for harness writers. */
export function repairTaskParts(state: BoardState, now: string): string[] {
 const notices: string[] = [];
 let changed = true;
 while (changed) {
  changed = false;
  for (const part of state.tasks) {
   if (!part.parent || isSettled(part)) continue;
   const parent = state.tasks.find(t => t.id === part.parent);
   if (!parent) continue;
   if (isSettled(parent)) {
    makeFollowUp(state, part, parent.id, now);
    notices.push(`${part.id} is now a follow-up of closed ${parent.id}.`); changed = true;
   } else if ((parent.status === "todo" && part.status === "in_progress") || (["review", "waiting"].includes(parent.status) && OPEN_FOR_REVIEW.has(part.status))) {
    touchByHarness(state, parent, "in_progress", now);
    notices.push(`${parent.id} moved back to in_progress for its part ${part.id}.`); changed = true;
   }
  }
 }
 return notices;
}

/** One-time, lossless repair of historical combinations, including archived tasks. */
export function migrateTaskStates(state: BoardState, now: string): string[] {
 if (state.taskStateMigrated) return [];
 const notices: string[] = [];
 for (const part of state.tasks) {
  const parent = state.tasks.find(t => t.id === part.parent);
  if (!parent) continue;
  if ((!isSettled(part) && isSettled(parent)) || (OPEN_FOR_REVIEW.has(part.status) && ["review", "waiting"].includes(parent.status))) {
   makeFollowUp(state, part, parent.id, now); notices.push(`${part.id}: parent ${parent.id} became a follow-up link`);
  }
 }
 let changed = true;
 while (changed) {
  changed = false;
  for (const parent of state.tasks) if (parent.status === "todo" && state.tasks.some(t => t.parent === parent.id && ["in_progress", "review", "waiting", "done"].includes(t.status))) {
   touchByHarness(state, parent, "in_progress", now); notices.push(`${parent.id}: todo → in_progress`); changed = true;
  }
 }
 for (const task of state.tasks) if (["review", "waiting"].includes(task.status)) {
  const open = openTaskBlockers(task, state.tasks).map(t => t.id);
  if (!open.length) continue;
  setRelated(state, task, [...(task.related ?? []), ...open]);
  task.blockedBy = task.blockedBy.filter(id => !open.includes(id));
  touchByHarness(state, task, task.status, now); notices.push(`${task.id}: blockers ${open.join(", ")} became related`);
 }
 state.taskStateMigrated = true;
 return notices;
}

function closeTaskParts(state: BoardState, task: BoardTask, status: BoardTask["status"], choice: "close" | "follow_up", now: string): string[] {
 const notices: string[] = [];
 for (const part of state.tasks.filter(t => t.parent === task.id && !isSettled(t))) {
  if (choice === "follow_up") { makeFollowUp(state, part, task.id, now); notices.push(`${part.id} kept as a follow-up of ${task.id}.`); }
  else {
   notices.push(...closeTaskParts(state, part, status, choice, now));
   touchByHarness(state, part, status, now);
   const running = Object.values(state.taskActivity?.[part.id]?.sources ?? {}).filter(s => s.state === "running" && s.actor.kind === "worker").map(s => s.actor.name);
   notices.push(`${part.id} closed as ${status}.${running.length ? ` Workers still running on ${part.id}: ${running.join(", ")}; stop them or explain why not.` : ""}`);
  }
 }
 return notices;
}

/** Create a task (no `taskId`) or change one made on `expectedRevision`. */
export function saveTask(
	state: BoardState,
	input: {
		taskId?: string | undefined;
		expectedRevision?: number | undefined;
		task: BoardTaskInput;
  openParts?: "close" | "follow_up" | undefined;
		author: BoardAuthor;
		now: string;
	},
): TaskChange {
	const { task: requested, author, now } = input;
	const current = state.tasks.find((task) => task.id === input.taskId);
 if (input.taskId !== undefined) {
  if (!current) throw unknownTask(input.taskId);
  if (input.expectedRevision === undefined) throw new ServerError("bad_request", `Changing task ${current.id} needs the revision it was made on`);
  if (current.revision !== input.expectedRevision) throw conflict("Task", current.id, current.revision, input.expectedRevision);
 }
	const parent = requested.parent === undefined ? current?.parent : requested.parent;
	const foundWhile = requested.foundWhile === undefined ? current?.foundWhile : requested.foundWhile;
	const fields = parent != null && foundWhile === parent ? { ...requested, foundWhile: null } : requested;
	let blockedBy = unique(fields.blockedBy);
 const notices: string[] = [];
 const candidate = { ...fields, id: current?.id ?? `T${state.counters.task + 1}`, parent: parent ?? null, blockedBy };
 if (author !== "user") checkTaskRules(state, candidate, current);
 const override = author === "user" && ["in_progress", "review"].includes(fields.status) ? openTaskBlockers(candidate, state.tasks).map(t => t.id) : [];
 if (override.length) {
  blockedBy = blockedBy.filter(id => !override.includes(id));
  notices.push(`Open blockers ${override.join(", ")} became related links: the user chose to start ${candidate.id} now.`);
 }
 const openParts = current && author === "user" && SETTLED.has(fields.status) && fields.status !== current.status ? state.tasks.filter(t => t.parent === current.id && !isSettled(t)) : [];
 if (openParts.length && !input.openParts) throw new ServerError("open_parts", `${current!.id} has ${openParts.length} open parts (${openParts.map(t => `${t.id} ${statusWords(t.status)}`).join(", ")}). Choose: close them too, or keep them as follow-ups.`, { taskId: current!.id, parts: openParts.map(t => t.id) });
	const previous = state.tasks.find((task) => task.id === input.taskId)?.waiting;
	const note = fields.waitingFor?.trim() ?? previous?.note ?? "";
	if (fields.status === "waiting" && note === "") throw new ServerError("bad_request", 'Waiting requires a "waiting for…" note (waitingFor).');
	if (fields.waitingFor !== undefined && (note === "" || note.length > 2000)) throw new ServerError("bad_request", "waitingFor must be 1–2000 characters.");
	if (fields.waitUntil !== undefined && (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(fields.waitUntil) || !Number.isFinite(Date.parse(fields.waitUntil)))) {
		throw new ServerError("bad_request", "waitUntil must be an ISO date or timestamp.");
	}
	const waiting = fields.status !== "waiting" ? undefined : {
		note, since: previous?.since ?? now,
		...(fields.waitUntil === undefined ? (fields.waitingFor === undefined && previous?.until !== undefined ? { until: previous.until } : {}) : { until: new Date(fields.waitUntil).toISOString() }),
		by: fields.waitingFor === undefined && fields.waitUntil === undefined && previous !== undefined ? previous.by : author === "user" ? "user" as const : "coordinator" as const,
	};
	if (input.taskId === undefined) {
		checkBlockedBy(state, null, blockedBy);
		checkLinks(state, null, fields);
		state.counters.task += 1;
		const id = `T${state.counters.task}`;
		clockStatus(state, { id, status: null }, fields.status, now);
		const created: BoardTask = {
			id,
			revision: 1,
			title: fields.title,
			description: fields.description,
			acceptance: fields.acceptance,
			...(fields.goal === undefined ? {} : { goal: fields.goal?.trim() ?? null }),
			refs: cleanRefs(fields.refs ?? []),
			status: fields.status,
			...(waiting === undefined ? {} : { waiting }),
			blockedBy,
			blockedReason: fields.blockedReason,
			parent: fields.parent ?? null,
			foundWhile: fields.foundWhile ?? null,
			related: [],
			writeScopes: unique(fields.writeScopes),
			workerIds: [],
			scheduleId: null,
			report: emptyReport(),
			snapshots: 0,
			order: Math.max(0, ...state.tasks.map((task) => task.order)) + 1,
			createdBy: author,
			updatedBy: author,
			createdAt: now,
			updatedAt: now,
			settledAt: SETTLED.has(fields.status) ? now : null,
			archived: false,
		};
		state.tasks.push(created);
		// Inside a commit the pushed task is the document's own copy, not `created`: change it through the board.
		const stored = state.tasks.find((task) => task.id === id) as BoardTask;
		setRelated(state, stored, fields.related ?? []);
		initializeTaskFreshness(state, stored);
		if (stored.status === "review" || stored.status === "done") noteTaskFact(state, stored.id, { actor: author, kind: "status", reason: `Results empty at ${stored.status}`, at: now });
		state.updatedAt = now;
		if (override.length) setRelated(state, stored, [...(stored.related ?? []), ...override]);
  notices.push(...repairTaskParts(state, now));
  return { before: null, after: plain(stored), notices };
	}
	const existing = state.tasks.find((task) => task.id === input.taskId);
	if (existing === undefined) throw unknownTask(input.taskId);
	if (input.expectedRevision === undefined) {
		throw new ServerError("bad_request", `Changing task ${existing.id} needs the revision it was made on`);
	}
	if (existing.revision !== input.expectedRevision) {
		throw conflict("Task", existing.id, existing.revision, input.expectedRevision);
	}
	checkBlockedBy(state, existing.id, blockedBy);
	checkLinks(state, existing.id, fields);
	const before = plain(existing);
	if (waiting === undefined) delete existing.waiting;
	else existing.waiting = waiting;
	existing.title = fields.title;
	existing.description = fields.description;
	existing.acceptance = fields.acceptance;
	if (fields.goal !== undefined) existing.goal = fields.goal?.trim() ?? null;
	// Left out (an older app, the Android app) keeps them.
	existing.refs = fields.refs === undefined ? (existing.refs ?? []) : cleanRefs(fields.refs);
	existing.blockedBy = blockedBy;
	existing.blockedReason = fields.blockedReason;
	existing.writeScopes = unique(fields.writeScopes);
	// Left out keeps them; null clears the parent or the origin.
	if (fields.parent !== undefined) existing.parent = fields.parent;
	if (fields.foundWhile !== undefined) existing.foundWhile = fields.foundWhile;
	if (fields.related !== undefined || override.length) setRelated(state, existing, [...(fields.related ?? existing.related ?? []), ...override]);
 if (openParts.length) notices.push(...closeTaskParts(state, existing, fields.status, input.openParts!, now));
	if (fields.status !== existing.status) {
		clockStatus(state, existing, fields.status, now);
		existing.status = fields.status;
		existing.settledAt = SETTLED.has(fields.status) ? now : null;
		existing.archived = false;
	}
	existing.revision += 1;
	existing.updatedBy = author;
	existing.updatedAt = now;
	state.updatedAt = now;
	if (before.status !== existing.status) {
		noteTaskFact(state, existing.id, { actor: author, ...(SETTLED.has(before.status) ? { sections: [] } : {}), kind: "status", reason: `stage changed to ${existing.status}`, at: now });
		if (SETTLED.has(existing.status)) for (const dependent of state.tasks.filter((task) => task.blockedBy.includes(existing.id))) noteTaskFact(state, dependent.id, { actor: author, kind: "blocker_resolved", reason: `${existing.id} resolved`, ref: existing.id, at: now });
	}
	if (before.status === existing.status && JSON.stringify(before.waiting) !== JSON.stringify(existing.waiting)) noteTaskFact(state, existing.id, { actor: author, kind: "status", reason: "waiting stage changed", at: now });
	if (before.blockedBy.some((id) => !existing.blockedBy.includes(id)) || (before.blockedReason !== null && existing.blockedReason === null)) noteTaskFact(state, existing.id, { actor: author, kind: "blocker_resolved", reason: "blocker resolved", at: now });
	notices.push(...repairTaskParts(state, now));
 return { before, after: plain(existing), notices };
}

/** Put the named tasks first, in that order; the others keep their relative order after them. */
export function reorderTasks(state: BoardState, taskIds: readonly string[], now: string): string[] {
	const ids = unique(taskIds);
	for (const id of ids) if (!state.tasks.some((task) => task.id === id)) throw unknownTask(id);
	const named = new Set(ids);
	const rest = state.tasks
		.filter((task) => !named.has(task.id))
		.sort((left, right) => left.order - right.order || compareIds(left.id, right.id))
		.map((task) => task.id);
	const sequence = [...ids, ...rest];
	for (const task of state.tasks) task.order = sequence.indexOf(task.id) + 1;
	state.updatedAt = now;
	return ids;
}

export function askQuestion(
	state: BoardState,
	input: { text: string; options: readonly string[]; choices?: readonly BoardQuestionChoice[] | undefined; taskId: string | null; now: string; threadId?: string; kind?: "question" | "warning"; blocksWork?: boolean | undefined; activitySourceId?: string | undefined },
): BoardQuestion {
	if (input.taskId !== null && !state.tasks.some((task) => task.id === input.taskId)) throw unknownTask(input.taskId);
	const warning = input.kind === "warning";
	const choices = warning ? undefined : input.choices;
	if (choices && choices.filter(choice => choice.recommended === true).length > 1) {
		throw new ServerError("bad_request", "At most one choice can be recommended.");
	}
	state.counters.question += 1;
	const question: BoardQuestion = {
		id: `Q${state.counters.question}`,
		revision: 1,
		...(warning ? { kind: "warning" as const } : {}),
  ...(input.blocksWork === undefined ? {} : { blocksWork: input.blocksWork }),
  ...(input.activitySourceId === undefined ? {} : { activitySourceId: input.activitySourceId }),
		text: input.text,
		options: warning ? [] : choices?.map(choice => choice.label) ?? [...input.options],
		...(choices === undefined ? {} : { choices: plain([...choices]) }),
		taskId: input.taskId,
		...(input.threadId === undefined ? {} : { threadId: input.threadId }),
		status: "open",
		answer: null,
		askedAt: input.now,
		answeredAt: null,
	};
	state.questions.push(question);
 if (question.taskId) { const task = state.tasks.find(task => task.id === question.taskId)!; task.timelineRevision = (task.timelineRevision ?? 0) + 1; }
	if (input.taskId !== null) noteTaskFact(state, input.taskId, { actor: "coordinator", kind: "question_asked", reason: `${question.id} asked`, ref: question.id, at: input.now });
	state.updatedAt = input.now;
	return plain(question);
}

/** Answer an open question (the user's answer, or the coordinator's when the user answered in the chat), or withdraw it. */
export function settleQuestion(
	state: BoardState,
	input: { questionId: string; expectedRevision?: number | undefined; answer: string | null; now: string; actor?: TaskFact["actor"] },
): BoardQuestion {
	const question = state.questions.find((candidate) => candidate.id === input.questionId);
	if (question === undefined) throw new ServerError("unknown_task", `No question "${input.questionId}" on the board`, { questionId: input.questionId });
	if (input.expectedRevision !== undefined && question.revision !== input.expectedRevision) {
		throw conflict("Question", question.id, question.revision, input.expectedRevision);
	}
	if (question.status !== "open") {
		throw new ServerError("board_conflict", `Question ${question.id} is already ${question.status}`, {
			id: question.id,
			revision: question.revision,
		});
	}
	delete question.waitingOn;
 delete question.noReplyYet;
 if (state.clarificationReminders) delete state.clarificationReminders[question.id];
 question.status = input.answer === null ? "withdrawn" : "answered";
	question.answer = input.answer;
	question.answeredAt = input.now;
	question.revision += 1;
 if (question.taskId) { const task = state.tasks.find(task => task.id === question.taskId)!; task.timelineRevision = (task.timelineRevision ?? 0) + 1; }
 if (question.kind === "warning" && question.taskId && question.activitySourceId && input.answer !== null) {
  const tracking = state.taskActivity?.[question.taskId];
  for (const source of Object.values(tracking?.sources ?? {})) if (source.state === "failed" && source.actor.id === question.activitySourceId) source.state = "ended";
 }
	if (question.taskId !== null) noteTaskFact(state, question.taskId, { actor: input.actor ?? "user", kind: "question_settled", reason: `${question.id} ${question.status}`, ref: question.id, at: input.now });
	state.updatedAt = input.now;
	return plain(question);
}

/** Shared revision and approval guards for owner/agent clarification writes. */
function requireClarifiableQuestion(state: BoardState, id: string, revision: number): BoardQuestion {
 const question = state.questions.find(q => q.id === id);
 if (!question) throw new ServerError("unknown_task", `No question "${id}" on the board`);
 if (question.revision !== revision) throw conflict("Question", id, question.revision, revision);
 if (question.mcpApproval) throw new ServerError("bad_request", "MCP approvals cannot be clarified or reopened.");
 return question;
}

function advanceQuestionRevision(state: BoardState, question: BoardQuestion, now: string): BoardQuestion {
 question.revision += 1;
 if (question.taskId) {
  const task = state.tasks.find(task => task.id === question.taskId)!;
  task.timelineRevision = (task.timelineRevision ?? 0) + 1;
 }
 state.updatedAt = now;
 return plain(question);
}

export function clarifyQuestion(state: BoardState, input: { questionId: string; expectedRevision: number; text: string; now: string }): BoardQuestion {
 const question = requireClarifiableQuestion(state, input.questionId, input.expectedRevision);
 if (question.status !== "open") throw new ServerError("board_conflict", `Question ${question.id} is already ${question.status}`);
 if (!input.text.trim()) throw new ServerError("bad_request", "A clarification needs text.");
 question.exchanges ??= [];
 question.exchanges.push({ author: USER_WRITER, text: input.text, at: input.now });
 question.waitingOn = "agent";
 delete question.noReplyYet;
 if (question.taskId) noteTaskFact(state, question.taskId, { actor: "user", kind: "question_clarification", reason: `${question.id}: asked back`, ref: question.id, at: input.now });
 const changed = advanceQuestionRevision(state, question, input.now);
 state.clarificationReminders ??= {};
 state.clarificationReminders[question.id] = { revision: question.revision, reminded: false };
 return changed;
}

export function replyQuestion(state: BoardState, input: { questionId: string; expectedRevision: number; text: string; revisedText?: string | undefined; revisedOptions?: string[] | undefined; reopen?: boolean | undefined; by: BoardWriter; now: string }): BoardQuestion {
 const question = requireClarifiableQuestion(state, input.questionId, input.expectedRevision);
 if (!input.text.trim() || (input.revisedText !== undefined && !input.revisedText.trim())) throw new ServerError("bad_request", "A reply and revised question must not be blank.");
 if (input.reopen ? question.status !== "answered" || question.reopened : question.status !== "open" || !question.exchanges?.length) throw new ServerError("board_conflict", "Reply to an open clarification, or reopen an answered question once.");
 const previousAnswer = input.reopen && question.answer !== null ? { text: question.answer, at: question.answeredAt! } : undefined;
 const optionsChanged = input.revisedOptions !== undefined && JSON.stringify(input.revisedOptions) !== JSON.stringify(question.options);
 const revised = (input.revisedText !== undefined && input.revisedText !== question.text) || optionsChanged;
 if (question.kind === "warning" && input.revisedOptions?.length) throw new ServerError("bad_request", "Warnings have no options.");
 question.exchanges ??= [];
 question.exchanges.push({ author: input.by, text: input.text, at: input.now,
  ...(revised ? { previousWording: { revision: question.revision, text: question.text, options: [...question.options], ...(question.choices === undefined ? {} : { choices: plain(question.choices) }) } } : {}),
  ...(previousAnswer ? { previousAnswer } : {}),
 });
 if (input.revisedText !== undefined) question.text = input.revisedText;
 if (optionsChanged) {
  question.options = [...input.revisedOptions!];
  delete question.choices; // Old clients/tools can revise labels; effects may no longer apply.
 }
 if (input.reopen) { question.reopened = true; question.status = "open"; question.answer = null; question.answeredAt = null; }
 question.waitingOn = "user";
 delete question.noReplyYet;
 if (state.clarificationReminders) delete state.clarificationReminders[question.id];
 if (question.taskId) noteTaskFact(state, question.taskId, { actor: "coordinator", kind: "question_clarification", reason: `${question.id} ${input.reopen ? "reopened" : "clarified"}`, ref: question.id, at: input.now });
 return advanceQuestionRevision(state, question, input.now);
}

/** No timer: the first unanswered turn reminds; the second (or a failure) hands back to the owner. */
export function endQuestionClarification(state: BoardState, input: { questionId: string; expectedRevision: number; now: string; failed?: boolean }): "remind" | "returned" | undefined {
 const question = state.questions.find(q => q.id === input.questionId);
 if (!question || question.status !== "open" || question.waitingOn !== "agent" || question.revision !== input.expectedRevision) return;
 state.clarificationReminders ??= {};
 state.clarificationReminders[question.id] ??= { revision: question.revision, reminded: false };
 const reminder = state.clarificationReminders[question.id]!;
 if (!input.failed && !reminder.reminded) { reminder.reminded = true; reminder.pending = true; return "remind"; }
 question.waitingOn = "user";
 question.noReplyYet = true;
 delete state.clarificationReminders[question.id];
 advanceQuestionRevision(state, question, input.now);
 return "returned";
}

export function addDecision(
	state: BoardState,
	input: { text: string; why: string | null; taskId: string | null; now: string; threadId?: string },
): BoardDecision {
	if (input.taskId !== null && !state.tasks.some((task) => task.id === input.taskId)) throw unknownTask(input.taskId);
	state.counters.decision += 1;
	const decision: BoardDecision = {
		id: `D${state.counters.decision}`,
		text: input.text,
		why: input.why,
		taskId: input.taskId,
		...(input.threadId === undefined ? {} : { threadId: input.threadId }),
		at: input.now,
	};
	state.decisions.push(decision);
 if (decision.taskId) { const task = state.tasks.find(task => task.id === decision.taskId)!; task.timelineRevision = (task.timelineRevision ?? 0) + 1; }
	if (input.taskId !== null) noteTaskFact(state, input.taskId, { actor: "coordinator", kind: "decision", reason: `${decision.id} recorded`, ref: decision.id, at: input.now });
	state.updatedAt = input.now;
	return plain(decision);
}

/**
 * Who owns a task now and who may take it. Claiming is a compare-and-set on the task's revision: a task another thread
 * holds is refused, so two threads cannot work on the same task.
 *
 * - `claim`: an unowned task (or one the caller already holds) becomes the caller's.
 * - `release`: the owner (or main, which supervises every thread) gives it up.
 * - `handoff`: the owner (or main) passes it to another thread, which may be main.
 */
export type OwnershipChange =
	| { kind: "claim"; threadId: string }
	| { kind: "release"; threadId: string }
	| { kind: "handoff"; threadId: string; to: string };

export function changeOwner(
	state: BoardState,
	input: { taskId: string; expectedRevision: number; change: OwnershipChange; now: string },
): TaskChange {
	const task = state.tasks.find((candidate) => candidate.id === input.taskId);
	if (task === undefined) throw unknownTask(input.taskId);
	if (task.revision !== input.expectedRevision) throw conflict("Task", task.id, task.revision, input.expectedRevision);
	const owner = task.ownerThreadId ?? null;
	const { change } = input;
	const supervises = change.threadId === "main";
	if (change.kind === "claim") {
		if (owner !== null && owner !== change.threadId) {
			throw new ServerError(
				"board_conflict",
				`Task ${task.id} is claimed by thread "${owner}". Leave it to that thread, ask it with thread_send, or have it hand the task over.`,
				{ id: task.id, revision: task.revision, ownerThreadId: owner },
			);
		}
	} else if (owner !== change.threadId && !supervises) {
		throw new ServerError(
			"board_conflict",
			owner === null
				? `Task ${task.id} is not claimed by anyone; claim it first.`
				: `Task ${task.id} is claimed by thread "${owner}", not you; only its owner or main can ${change.kind === "release" ? "release" : "hand over"} it.`,
			{ id: task.id, revision: task.revision, ownerThreadId: owner },
		);
	}
	const before = plain(task);
	task.ownerThreadId = change.kind === "claim" ? change.threadId : change.kind === "release" ? null : change.to;
 if (change.kind !== "claim") {
  const tracking = activityTracking(state, task.id);
  for (const source of Object.values(tracking.sources)) if (source.actor.kind !== "worker" && source.actor.threadId === owner) endActivitySource(tracking, source.actor.id, input.now);
  if (owner && state.taskFocus?.[owner] === task.id) delete state.taskFocus[owner];
 }
	if (owner !== task.ownerThreadId) noteTaskFact(state, task.id, { actor: "coordinator", kind: "thread_handoff", reason: "thread handoff", at: input.now });
	task.revision += 1;
	task.updatedBy = "coordinator";
	task.updatedAt = input.now;
	state.updatedAt = input.now;
	return { before, after: plain(task) };
}

// --- the harness's own changes -----------------------------------------------------------------------------------

/** Whether the change named `key` is new; records it when it is. */
function claimHarnessKey(state: BoardState, key: string): boolean {
	const keys = (state.harnessKeys ??= []);
	if (keys.includes(key)) return false;
	keys.push(key);
	if (keys.length > KEPT_HARNESS_KEYS) keys.splice(0, keys.length - KEPT_HARNESS_KEYS);
	return true;
}

function touchByHarness(state: BoardState, task: BoardTask, status: BoardTask["status"], now: string, actor: NonNullable<TaskFact["actor"]> = "harness"): void {
	if (status !== "waiting") delete task.waiting;
	if (status !== task.status) {
		clockStatus(state, task, status, now);
		task.status = status;
		noteTaskFact(state, task.id, { actor, kind: "status", reason: `stage changed to ${status}`, at: now });
		task.settledAt = SETTLED.has(status) ? now : null;
		task.archived = false;
	}
	task.revision += 1;
	task.updatedBy = "harness";
	task.updatedAt = now;
	state.updatedAt = now;
}

/** What became of a worker that runs a task. */
export type WorkerMove = { kind: "spawned"; workerId: string } | { kind: "failed"; workerId: string; reason: string };

/**
 * Move a task for its worker: a spawn takes it to `in_progress` (and records the worker), a failure to `blocked` with
 * the reason. A worker's report moves nothing: the coordinator checks the work and moves the task to `review` itself. A
 * failure leaves a task the coordinator or the user already settled alone. Applied once per `key`; undefined when
 * nothing changed.
 */
export function moveTaskForWorker(
	state: BoardState,
	input: { key: string; taskId: string; move: WorkerMove; now: string },
): TaskChange | undefined {
	const task = state.tasks.find((candidate) => candidate.id === input.taskId);
	if (task === undefined) return undefined;
 const { move, now } = input;
 if (move.kind === "spawned") refuseOpenBlockers(task, state.tasks);
 if (!claimHarnessKey(state, input.key)) return undefined;
	noteTaskFact(state, task.id, { actor: move.kind === "spawned" ? "coordinator" : "worker", kind: move.kind === "spawned" ? "worker_start" : "worker_fail", reason: move.kind === "spawned" ? "work advanced" : "worker failed", at: now });
	if (move.kind !== "spawned" && isSettled(task)) return undefined;
	const before = plain(task);
	if (move.kind === "spawned") {
  refuseOpenBlockers(task, state.tasks);
		if (!task.workerIds.includes(move.workerId)) task.workerIds.push(move.workerId);
		task.blockedReason = null;
		touchByHarness(state, task, "in_progress", now, "coordinator");
	} else {
		task.blockedReason = move.reason;
		touchByHarness(state, task, "blocked", now);
	}
	const notices = repairTaskParts(state, now);
 return { before, after: plain(task), notices };
}

/**
 * A `record` clock run's worker reported and nobody will review it: put the run into the schedule's task the way the
 * coordinator would. `results` becomes this run (the time, the worker and the start of its report; the full report stays
 * on the worker), `now` is cleared, and a task still `in_progress` goes to `review` so it does not read as working until
 * the next run. A task the coordinator or the user already moved is not moved. Applied once per `key`; undefined when
 * it was already applied. An event run's task is not the schedule's, so it is left alone.
 */
export function recordScheduledReport(
	state: BoardState,
	input: { key: string; scheduleId: string; taskId: string; workerId: string; text: string; now: string },
): TaskChange | undefined {
	const task = state.tasks.find((candidate) => candidate.id === input.taskId);
	// Only the schedule's own collecting task: an event run's task (no `scheduleId`) is the coordinator's and the user's.
	if (task === undefined || task.scheduleId !== input.scheduleId || isSettled(task) || !claimHarnessKey(state, input.key)) return undefined;
	const before = plain(task);
	noteTaskFact(state, task.id, { actor: "worker", kind: "worker_report", reason: "worker reported; work advanced", at: input.now });
	// One line of plain words: the report's own headings (`## Report`) would read as stray hashes inside a bullet.
	const summary = input.text.replace(/(^|\s)#{1,6}\s+/g, "$1").replace(/\s+/g, " ").trim();
	const clipped = summary.length <= 300 ? summary : `${summary.slice(0, 299)}…`;
	writeReport(state, {
		taskId: task.id,
		sections: { now: "", results: `- ${input.now.slice(0, 16).replace("T", " ")} UTC, worker ${input.workerId} reported: ${clipped}` },
		by: HARNESS_WRITER,
		coveredEventSeq: task.eventSeq,
		now: input.now,
	});
	if (task.status === "in_progress") { checkTaskRules(state, { ...task, status: "review" }, task); touchByHarness(state, task, "review", input.now); }
	return { before, after: plain(task) };
}

/**
 * A background thread takes the task it was started for: it becomes the thread's and goes to `in_progress`. A task a
 * different background thread holds is refused; main's or an unclaimed one is the thread's now. Applied once per `key`;
 * undefined when it already was.
 */
export function claimTaskForThread(
	state: BoardState,
	input: { key: string; taskId: string; threadId: string; now: string },
): TaskChange | undefined {
	const task = state.tasks.find((candidate) => candidate.id === input.taskId);
	if (task === undefined) throw unknownTask(input.taskId);
	const owner = task.ownerThreadId ?? null;
	if (owner !== null && owner !== "main" && owner !== input.threadId) {
		throw new ServerError("board_conflict", `Task ${task.id} is claimed by thread "${owner}". Give the new thread another task.`, {
			id: task.id,
			revision: task.revision,
			ownerThreadId: owner,
		});
	}
	if (isSettled(task)) {
		throw new ServerError("bad_request", `Task ${task.id} is ${task.status}: only the user reopens a closed task. Start the thread on another task.`, {
			id: task.id,
		});
	}
	refuseOpenBlockers(task, state.tasks);
 if (!claimHarnessKey(state, input.key)) return undefined;
	const before = plain(task);
	task.ownerThreadId = input.threadId;
 state.taskFocus ??= {};
 state.taskFocus[input.threadId] = task.id;
	noteTaskFact(state, task.id, { actor: "coordinator", kind: "thread_handoff", reason: "thread started work", at: input.now });
	task.blockedReason = null;
	touchByHarness(state, task, "in_progress", input.now, "coordinator");
 const notices = repairTaskParts(state, input.now);
 return { before, after: plain(task), notices };
}

/** The title of a schedule's board task: what it is, so the board reads "Scheduled: Nightly check". */
export function scheduleTaskTitle(scheduleTitle: string): string {
	return `Scheduled: ${scheduleTitle.trim()}`.slice(0, 120);
}

function scheduleTaskDescription(scheduleId: string, title: string): string {
	return [
		`Collects every run of the schedule "${title.trim()}": each run's worker or thread is listed here, and the report shows the latest run.`,
		`Settings → Scheduled tasks (\`settings#schedule-${scheduleId}\`) edits or pauses the schedule.`,
		"Close this task to start a fresh one on the next run; the harness never closes it.",
	].join("\n\n");
}

function createScheduleTask(
	state: BoardState,
	input: { scheduleId: string; title: string; status: "todo" | "in_progress" | "blocked"; blockedReason: string | null; now: string },
): BoardTask {
	const change = saveTask(state, {
		task: {
			title: scheduleTaskTitle(input.title),
			description: scheduleTaskDescription(input.scheduleId, input.title),
			acceptance: null,
			status: input.status,
			blockedBy: [],
			blockedReason: input.blockedReason,
			writeScopes: [],
		},
		author: "harness",
		now: input.now,
	});
	const created = state.tasks.find((task) => task.id === change.after.id) as BoardTask;
	created.scheduleId = input.scheduleId;
	return created;
}

/**
 * The one board task of a clock schedule, for a run that is about to start a worker: the open one (todo, in_progress,
 * blocked or review; a run's problem task counts), else a new `todo` task. The worker's spawn then moves it to
 * `in_progress`, so the status change is the spawn's. A task the user closed (done, dropped) or deleted gives a new one.
 */
export function scheduleTaskForRun(state: BoardState, input: { scheduleId: string; title: string; now: string }): BoardTask {
	const open = state.tasks.find((task) => task.scheduleId === input.scheduleId && !isSettled(task));
	if (open !== undefined) return plain(open);
	return plain(createScheduleTask(state, { ...input, status: "todo", blockedReason: null }));
}

/**
 * The task a `thread` schedule's runs report on: the schedule's one task, the open one if there is, else a new one. Each
 * run puts it back to `in_progress` and unclaims it for the new thread.
 */
export function taskForSchedule(state: BoardState, input: { scheduleId: string; title: string; now: string }): TaskChange {
	const open = state.tasks.find((task) => task.scheduleId === input.scheduleId && !isSettled(task));
	if (open !== undefined) {
		const before = plain(open);
		open.blockedReason = null;
		open.ownerThreadId = null;
		touchByHarness(state, open, "in_progress", input.now);
		return { before, after: plain(open) };
	}
	return { before: null, after: plain(createScheduleTask(state, { ...input, status: "in_progress", blockedReason: null })) };
}

/**
 * A scheduled run failed or was skipped: open one `blocked` task for the schedule, or update the one still open (not
 * done or dropped) instead of adding another. Applied once per `key`; undefined when it was already applied.
 */
export function recordScheduleProblem(
	state: BoardState,
	input: { key: string; scheduleId: string; title: string; reason: string; now: string },
): TaskChange | undefined {
	if (!claimHarnessKey(state, input.key)) return undefined;
	const open = state.tasks.find((task) => task.scheduleId === input.scheduleId && !isSettled(task));
	if (open !== undefined) {
		const before = plain(open);
		open.blockedReason = input.reason;
		touchByHarness(state, open, "blocked", input.now);
		return { before, after: plain(open) };
	}
	return { before: null, after: plain(createScheduleTask(state, { ...input, status: "blocked", blockedReason: input.reason })) };
}

/**
 * The task of one event run (a GitHub review request): found by its marker line when this run was retried, else a new
 * `todo` task made by the harness with the pull request's URL in its refs. It has no `scheduleId`: that link belongs to
 * the one task per schedule that clock runs and failed runs share.
 */
export function taskForEvent(
	state: BoardState,
	input: { title: string; description: string; marker: string; ref: string; now: string },
): TaskChange {
	const existing = state.tasks.find(
		(task) => task.createdBy === "harness" && (task.refs ?? []).includes(input.ref) && task.description.split("\n").includes(input.marker),
	);
	if (existing !== undefined) return { before: plain(existing), after: plain(existing) };
	return saveTask(state, {
		task: {
			title: input.title,
			description: input.description,
			acceptance: null,
			refs: [input.ref],
			status: "todo",
			blockedBy: [],
			blockedReason: null,
			writeScopes: [],
		},
		author: "harness",
		now: input.now,
	});
}

/** The tasks a change to `done` left with every blocker done: the ones the coordinator can start now. */
export function unblockedBy(state: Readonly<BoardState>, change: TaskChange): BoardTask[] {
	if (!isSettled(change.after) || (change.before && isSettled(change.before))) return [];
	const done = new Set(state.tasks.filter(isSettled).map((task) => task.id));
	return state.tasks
		.filter((task) => !isSettled(task) && task.blockedBy.includes(change.after.id) && task.blockedBy.every((id) => done.has(id)))
		.map((task) => plain(task));
}

/** Whether two advisory write scopes can touch the same files: equal paths, or one inside the other. */
export function scopesOverlap(left: readonly string[], right: readonly string[]): boolean {
	const normalize = (scope: string): string => scope.trim().replace(/^\.\//, "").replace(/\/+$/, "");
	return left.some((a) =>
		right.some((b) => {
			const one = normalize(a);
			const other = normalize(b);
			if (one === "" || one === "." || other === "" || other === ".") return true;
			return one === other || one.startsWith(`${other}/`) || other.startsWith(`${one}/`);
		}),
	);
}

// --- text the coordinator reads ----------------------------------------------------------------------------------

function clip(text: string, limit: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}

export function describeTask(task: BoardTask): string {
	const parts = [`${task.id} r${task.revision} [${task.status}${task.state ? ` · ${task.state.kind === "blocked_by_task" ? `blocked by ${task.state.refs.join(", ")}` : task.state.kind}` : ""}] ${task.title}${task.archived ? " (archived)" : ""}`];
	if ((task.refs ?? []).length > 0) parts.push(`refs ${task.refs.join(",")}`);
	if ((task.parent ?? null) !== null) parts.push(`↳${task.parent}`);
	if ((task.foundWhile ?? null) !== null) parts.push(`found while ${task.foundWhile}`);
	if ((task.ledTo ?? []).length > 0) parts.push(`led to ${(task.ledTo ?? []).join(",")}`);
	if (task.subtaskCount !== undefined && (task.subtasks ?? []).length > 0) {
		const total = (task.subtasks ?? []).length;
		parts.push(`${total} subtask${total === 1 ? "" : "s"} (${task.subtaskCount.done} done)`);
	}
	if ((task.related ?? []).length > 0) parts.push(`related ${(task.related ?? []).join(",")}`);
	if (task.blockedBy.length > 0) parts.push(`after ${task.blockedBy.join(",")}`);
	if ((task.blocks ?? []).length > 0) parts.push(`blocks ${(task.blocks ?? []).join(",")}`);
	const waiting = (task.feedback?.open ?? 0) + (task.feedback?.handling ?? 0);
	if (waiting > 0) parts.push(`${waiting} open feedback`);
	if (task.waiting !== undefined) parts.push(`waiting for: ${task.waiting.note}; since ${task.waiting.since}${task.waiting.until === undefined ? "" : `; until ${task.waiting.until}`}`);
	if (task.blockedReason !== null) parts.push(`blocked: ${clip(task.blockedReason, 120)}`);
	if (task.writeScopes.length > 0) parts.push(`writes ${task.writeScopes.join(",")}`);
	const time = taskTime(task);
	if (time !== undefined) parts.push(time);
	if (task.workerIds.length > 0) parts.push(`workers ${task.workerIds.join(",")}`);
	if (task.scheduleId !== null) parts.push(`schedule ${task.scheduleId}`);
	if ((task.ownerThreadId ?? null) !== null) parts.push(`owner ${task.ownerThreadId}`);
	const lines = [parts.join(" | ")];
	if (task.description.trim() !== "") lines.push(`  ${clip(task.description, LIST_DESCRIPTION_CHARS)}`);
	if (task.acceptance !== null) lines.push(`  done when: ${clip(task.acceptance, LIST_DESCRIPTION_CHARS)}`);
	return lines.join("\n");
}

/** "42m in progress", or undefined for a task that never was. */
export function taskTime(task: Pick<BoardTask, "inProgressMinutes">): string | undefined {
	return task.inProgressMinutes === undefined ? undefined : `${task.inProgressMinutes}m in progress`;
}

function describeChoices(choices: readonly BoardQuestionChoice[]): string {
	return choices.map(({ label, effect, recommended }) => `${label}${recommended ? " (recommended)" : ""}${effect ? ` — ${effect}` : ""}`).join(" / ");
}

export function describeQuestion(question: BoardQuestion): string {
	const asker = question.threadId === undefined || question.threadId === "main" ? "" : ` from ${question.threadId}`;
	const label = question.kind === "warning" ? " warning" : "";
	const head = `${question.id} r${question.revision}${label} [${question.status}]${question.taskId === null ? "" : ` (${question.taskId})`}${asker} ${question.text}`;
	const options = question.choices?.length ? ` choices: ${describeChoices(question.choices)}`
		: question.status === "open" && question.options.length ? ` options: ${question.options.join(" / ")}` : "";
	const tail = options + (question.answer === null ? "" : ` -> ${clip(question.answer, 300)}`);
	const exchange = (question.exchanges ?? []).map(e => `\n  ${e.author.author} ${e.at}: ${e.text}${e.previousWording ? ` (earlier wording r${e.previousWording.revision}: ${e.previousWording.text}; options: ${e.previousWording.choices ? describeChoices(e.previousWording.choices) : e.previousWording.options.join(" / ")})` : ""}${e.previousAnswer ? ` (earlier answer: ${e.previousAnswer.text})` : ""}`).join("");
 return head + tail + (question.waitingOn === "agent" ? " [waiting for agent]" : question.noReplyYet ? " [No reply yet]" : "") + exchange;
}

/** How many of a task's latest timeline entries `show_task` prints. */
const SHOWN_TIMELINE_ENTRIES = 15;

/** The task a link names, as a line: its ID, status and title, with "(archived)" when the board view leaves it out. */
function linkTarget(board: Board, id: string): string {
	const task = board.tasks.find((candidate) => candidate.id === id) ?? board.archivedLinks?.find((candidate) => candidate.id === id);
	return task === undefined ? id : `${id} [${task.status}] ${clip(task.title, 80)}${task.archived ? " (archived)" : ""}`;
}

/** A task's links grouped by kind, each target on its own line; empty when it has none. */
function describeLinks(task: BoardTask, board: Board): string[] {
	const groups: [string, readonly string[]][] = [
		["subtask of", task.parent == null ? [] : [task.parent]],
		["has subtasks", task.subtasks ?? []],
		["found while working on", task.foundWhile == null ? [] : [task.foundWhile]],
		["led to", task.ledTo ?? []],
		["blocked by", task.blockedBy],
		["blocks", task.blocks ?? []],
		["related to", task.related ?? []],
	];
	return groups.filter(([, ids]) => ids.length > 0).map(([label, ids]) => `  ${label}: ${ids.map((id) => linkTarget(board, id)).join("; ")}`);
}

function feedbackLine(entry: BoardFeedback): string {
	const images = entry.images === undefined ? "" : ` (+${entry.images} image${entry.images === 1 ? "" : "s"})`;
	const note = entry.note === null ? "" : ` -> ${clip(entry.note, 200)}`;
	return `${entry.id} [${entry.state}] ${entry.at}${entry.threadId === "main" ? "" : ` in ${entry.threadId}`}: ${clip(entry.text, 600)}${images}${note}`;
}

/** What `show_task` adds to a task: its feedback entries and its timeline. */
export type TaskExtras = { feedback: readonly BoardFeedback[]; timeline: readonly BoardTimelineEntry[] };

/** One task in full: its fields, links, report, feedback, the questions, warnings and decisions about it, its workers, snapshots and latest timeline. */
export function describeTaskInFull(task: BoardTask, board: Board, snapshots: readonly BoardTaskSnapshot[], extras?: TaskExtras): string {
	const lines = [describeTask(task).split("\n")[0] as string];
	const links = describeLinks(task, board);
	if (links.length > 0) lines.push(`Links:\n${links.join("\n")}`);
	if (task.goal?.trim()) lines.push(`goal: ${task.goal}`);
	if (task.description.trim() !== "") lines.push(`description: ${task.description.trim()}`);
	if (task.acceptance !== null) lines.push(`done when: ${task.acceptance.trim()}`);
	const report = task.report;
	lines.push(`Report (r${report.revision}${report.updatedAt === null ? ", never written" : `, updated ${report.updatedAt}`}):`);
	if (task.eventSeq !== undefined) lines.push(`eventSeq: ${task.eventSeq} (pass as coveredEventSeq after reading this task; only rewritten sections cover it)`);
	if (report.freshness !== undefined) for (const name of ["results", "next"] as const) lines.push(`${name} freshness: ${JSON.stringify(report.freshness[name])}`);
	lines.push(`now: ${report.now === "" ? "(empty)" : report.now}`);
	if (task.live?.plan) lines.push(describeLivePlan(task.live.plan));
	if (report.steps?.trim()) lines.push(`Your steps:\n${report.steps}`);
	if (report.summary) lines.push(`summary: ${report.summary}`);
	lines.push(`results: ${report.results === "" ? "(empty)" : report.results}`);
	if (report.notDone) lines.push(`Not done:\n${report.notDone}`);
	lines.push(`next: ${report.next === "" ? "(empty)" : report.next}`);
	if (report.checks?.length) lines.push(`Checks:\n${report.checks.map(check =>
		`- ${check.name}: ${check.result}${check.count === undefined ? "" : ` (${check.count})`} at ${check.at}${check.note ? ` — ${check.note}` : ""}`,
	).join("\n")}`);
	if (extras !== undefined) {
		const feedback = sortFeedback(extras.feedback);
		lines.push(
			feedback.length === 0
				? "Feedback: none"
				: `Feedback (open first; mark each with the board action feedback):\n${feedback.map(feedbackLine).join("\n")}`,
		);
	}
	const questions = board.questions.filter((question) => question.taskId === task.id);
	lines.push(questions.length === 0 ? "Questions and warnings: none" : `Questions and warnings:\n${questions.map(describeQuestion).join("\n")}`);
	const decisions = board.decisions.filter((decision) => decision.taskId === task.id);
	lines.push(decisions.length === 0 ? "Decisions: none" : `Decisions:\n${decisions.map(decisionLine).join("\n")}`);
	lines.push(`Workers: ${task.workerIds.length === 0 ? "none" : task.workerIds.join(", ")}`);
	lines.push(
		snapshots.length === 0
			? "Snapshots: none"
			: `Snapshots:\n${snapshots.map((snapshot) => `#${snapshot.seq} ${snapshot.at} ${snapshot.label}`).join("\n")}`,
	);
	if (extras !== undefined && extras.timeline.length > 0) {
		const shownEntries = extras.timeline.slice(-SHOWN_TIMELINE_ENTRIES);
		const earlier = extras.timeline.length - shownEntries.length;
		const entryLine = (entry: BoardTimelineEntry): string =>
			`${entry.at} [${entry.kind}] ${entry.label}${entry.detail === undefined ? "" : `: ${clip(entry.detail, 160)}`}`;
		lines.push(`Timeline (latest ${shownEntries.length}${earlier > 0 ? `, ${earlier} earlier not shown` : ""}):\n${shownEntries.map(entryLine).join("\n")}`);
	}
	return lines.join("\n");
}

export function describeBoard(board: Board): string {
	if (board.tasks.length + board.questions.length + board.decisions.length === 0) {
		return "The board is empty. Add tasks with add_task, ask the user with ask, record a decision with decide.";
	}
	const sections: string[] = [];
	sections.push(board.tasks.length === 0 ? "Tasks: none" : `Tasks:\n${board.tasks.map(describeTask).join("\n")}`);
	sections.push(
		board.questions.length === 0 ? "Questions: none" : `Questions:\n${board.questions.map(describeQuestion).join("\n")}`,
	);
	if (board.decisions.length > 0) {
		const lines = board.decisions
			.slice(0, 10)
			.map((decision) => `${decision.id}${decision.taskId === null ? "" : ` (${decision.taskId})`} ${decision.text}${decision.why === null ? "" : ` — ${clip(decision.why, 200)}`}`);
		const more = board.decisions.length > 10 ? `\n(+${board.decisions.length - 10} older)` : "";
		sections.push(`Decisions, newest first:\n${lines.join("\n")}${more}`);
	}
	return sections.join("\n\n");
}

function taskLine(task: BoardTask): string {
	return `${task.id} ${task.title}${task.blockedBy.length > 0 ? ` (after ${task.blockedBy.join(",")})` : ""}`;
}

function decisionLine(decision: BoardDecision): string {
	return `${decision.id}${decision.taskId === null ? "" : ` (${decision.taskId})`} ${decision.text}${decision.why === null ? "" : ` — ${clip(decision.why, 200)}`}`;
}

/**
 * The board as a compaction summary carries it, within about `budgetTokens`: active tasks (in progress, in review,
 * blocked) and open questions in full; todo tasks one line each, the newest 20 then "+N more"; the latest 10
 * decisions; tasks done since `since` (the last compaction) one line each; nothing archived. Each open task shown also
 * carries its report's `now`, clipped to a line. Over budget the `now` lines go first (the last tasks' first), then the
 * todo list shrinks, then the done list; active tasks and questions are never cut.
 */
export function summaryBoardView(
	state: Readonly<BoardState> | undefined,
	options: { now: number; since: number | null; budgetTokens?: number },
): string {
	const board = boardView(state ?? emptyBoardState(), options.now, false);
	const active = board.tasks.filter((task) => task.status === "in_progress" || task.status === "review" || task.status === "waiting" || task.status === "blocked");
	const questions = board.questions.filter((question) => question.status === "open");
	const todo = board.tasks
		.filter((task) => task.status === "todo")
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || compareIds(right.id, left.id));
	const done = board.tasks
		.filter((task) => task.status === "done" && (options.since === null || (task.settledAt !== null && Date.parse(task.settledAt) >= options.since)))
		.sort((left, right) => (right.settledAt ?? "").localeCompare(left.settledAt ?? ""));
	const decisions = board.decisions.slice(0, SUMMARY_DECISIONS);
	// The open tasks shown with a report `now`, in the order they are rendered: active ones, then todo.
	const withNow = [...active, ...todo.slice(0, SUMMARY_TODO_TASKS)].filter((task) => task.report.now.trim() !== "");
	const closing = "This is a compact view. The full board, with every description and the archive, is always available through the `board` tool (action `list`).";
	const render = (todoShown: number, doneShown: number, nowShown: number): string => {
		const nowOf = new Set(withNow.slice(0, nowShown).map((task) => task.id));
		const withNowLine = (task: BoardTask, line: string): string =>
			nowOf.has(task.id) ? `${line}\n  now: ${clip(task.report.now.replace(/\s+/g, " ").trim(), SUMMARY_NOW_CHARS)}` : line;
		const sections: string[] = [];
		sections.push(
			active.length === 0 ? "Active tasks: none" : `Active tasks:\n${active.map((task) => withNowLine(task, describeTask(task))).join("\n")}`,
		);
		sections.push(questions.length === 0 ? "Open questions: none" : `Open questions:\n${questions.map(describeQuestion).join("\n")}`);
		if (todo.length > 0) {
			const more = todo.length - todoShown;
			const lines = todo.slice(0, todoShown).map((task) => withNowLine(task, taskLine(task)));
			if (more > 0) lines.push(`+${more} more`);
			sections.push(`To do, newest first:\n${lines.join("\n")}`);
		}
		if (decisions.length > 0) sections.push(`Decisions, newest first:\n${decisions.map(decisionLine).join("\n")}`);
		if (done.length > 0) {
			const more = done.length - doneShown;
			const lines = done.slice(0, doneShown).map(taskLine);
			if (more > 0) lines.push(`+${more} more`);
			sections.push(`Done since the last summary:\n${lines.join("\n")}`);
		}
		sections.push(closing);
		return sections.join("\n\n");
	};
	const budget = options.budgetTokens ?? SUMMARY_BOARD_TOKENS;
	let todoShown = Math.min(SUMMARY_TODO_TASKS, todo.length);
	let doneShown = done.length;
	let nowShown = withNow.length;
	let text = render(todoShown, doneShown, nowShown);
	while (estimateTextTokens(text) > budget && (nowShown > 0 || todoShown > 0 || doneShown > 0)) {
		if (nowShown > 0) nowShown -= 1;
		else if (todoShown > 0) todoShown -= 1;
		else doneShown -= 1;
		text = render(todoShown, doneShown, nowShown);
	}
	return text;
}

const TRACKED_FIELDS = ["title", "status", "description", "acceptance", "refs", "blockedBy", "blockedReason", "writeScopes", "parent", "foundWhile", "related", "waiting"] as const;

/** A task's `waiting` field: what it waits for, and when to check again. */
function isWaiting(value: unknown): value is { note: string; until?: string } {
	return typeof value === "object" && value !== null && typeof (value as { note?: unknown }).note === "string";
}

function shown(value: unknown): string {
	if (Array.isArray(value)) return `[${value.join(",")}]`;
	if (value === null) return "none";
	if (isWaiting(value)) return JSON.stringify(clip(`${value.note}${value.until === undefined ? "" : `, until ${value.until}`}`, 200));
	return typeof value === "string" ? JSON.stringify(clip(value, 120)) : String(value);
}

function describeChange(before: BoardTask | null, after: BoardTask): string | undefined {
	if (before === null) return `${after.id} added: ${JSON.stringify(after.title)} [${after.status}]`;
	const parts: string[] = [];
	for (const field of TRACKED_FIELDS) {
		const from = before[field] ?? null;
		const to = after[field] ?? null;
		if (JSON.stringify(from) === JSON.stringify(to)) continue;
		parts.push(field === "description" ? "description changed" : `${field} ${shown(from)} -> ${shown(to)}`);
	}
	return parts.length === 0 ? undefined : `${after.id} ${JSON.stringify(after.title)} (r${after.revision}): ${parts.join("; ")}`;
}

/** A user's edit as one `[board]` line: the change, then what they said about it ("the user says: ..."). */
function describeEdit(edit: PendingEdit): string | undefined {
	const change = describeChange(edit.before, edit.after);
	if (edit.notes.length === 0) return change;
	const said = `the user says: ${edit.notes.map((note) => JSON.stringify(clip(note, 1000))).join(", then ")}`;
	return change === undefined ? `${edit.after.id} ${JSON.stringify(edit.after.title)} (r${edit.after.revision}): ${said}` : `${change}; ${said}`;
}

// --- the service -------------------------------------------------------------------------------------------------

export type BoardServiceOptions = {
	project(): Project;
	harness: Harness;
	/** The coordinator conversation; its ID owns the board document. */
	coordinator: Conversation;
	/** Every coordinator thread of the project; each may use the board. Default: main only. */
	coordinators?: Coordinators;
	notifications?: Notifier;
	now(): number;
	/** Quiet period before the user's edits reach the coordinator. Default `BOARD_EDIT_DEBOUNCE_MS`. */
	editDebounceMs?: number;
	taskFreshness?: boolean;
 taskActivity?: boolean;
 taskState?: boolean;
 taskPartStates?: boolean;
 taskLive?: boolean;
 watcherModels?: Models;
 watcherStatusChanged?: (status: TaskWatcherStatus) => Promise<void>;
 taskArtifactSaves?: { read: () => Promise<readonly TaskArtifactSave[]>; watch: (listener: () => void) => () => void };
	auditModels?: Models;
	auditStatusChanged?: (record: ReportAuditRecord) => Promise<void>;
 threadTitle?: (threadId: string) => Promise<string | undefined>;
	threadIsLive?: (threadId: string) => Promise<boolean>;
	reportTimings?: { trailingMs?: number; maxBurstMs?: number; ageMs?: number; sweepMs?: number; maxTokens?: number };
	/** Called after an input reached a background thread, so a finished or stopped one counts as working again. */
	wakeThread?: (threadId: string) => Promise<void>;
	log(message: string): void;
};

/** A task the user changed since the last `[board]` input: where it started, where it is now, and what they said about it. */
type PendingEdit = { before: BoardTask | null; after: BoardTask; notes: string[] };

export class BoardService {
 onMcpAnswer: ((questionId: string, answer: string) => Promise<void>) | undefined;
	readonly #options: BoardServiceOptions;
 #liveWatch: TaskLiveWatch | undefined;
 readonly #watcher: TaskWatcherLiveService | undefined;
 #persistWatcherStatus = Promise.resolve();
	readonly audit: ReportAuditService | undefined;
	#extension: Extension | undefined;
	#pending = new Map<string, PendingEdit>();
	#pendingOrder: { ids: string[]; at: string } | undefined;
	#timer: ReturnType<typeof setTimeout> | undefined;
	#flushing: Promise<void> = Promise.resolve();
	#waitingTimer: ReturnType<typeof setTimeout> | undefined;
	#waitingRun: Promise<void> | undefined;
 #pauseRun: Promise<void> | undefined;
	#stopped = false;
	#reportTimer: ReturnType<typeof setTimeout> | undefined;
	#reportRun: Promise<void> | undefined;
	#reportWaiters = new Set<number>();
	#reportOwners = new Map<string, string>();

	constructor(options: BoardServiceOptions) {
		this.#options = options;
  if (options.watcherModels) this.#watcher = new TaskWatcherLiveService(options.watcherModels, options.now, () => this.state(), async change => {
   await options.harness.commit(async tx => {
    const state = await openBoard(tx, this.#mainId);
    await change(state, async (job, answer, picker) => {
     const task = state.tasks.find(task => task.id === job.taskId);
     if (!task) return;
     const tracking = state.taskActivity?.[task.id];
     if (tracking?.sources[job.source.id]?.state === "running") {
      publishWatcherAnswer(state, job, answer, picker, options.now(), tracking.liveLines ?? [], lines => { tracking.liveLines = lines; });
     } else {
      const history = await openTaskHistory(tx, this.#mainId, task.id);
      const run = history.timelineEntries?.find(entry => entry.actor?.id === job.source.id && entry.live);
      if (!run?.live) return;
      publishWatcherAnswer(state, job, answer, picker, options.now(), run.live.lines, lines => {
       const { revision: _revision, factCount: _count, ...fact } = run;
       upsertTimelineFact(history, task, { ...fact, live: { ...run.live!, lines } });
      });
     }
    });
   }, BACKGROUND_CONTEXT);
  }, () => options.log("task watcher: could not process live news"));
		if (options.auditModels) this.audit = new ReportAuditService({
			models: options.auditModels,
			settings: () => options.project().archived || options.taskFreshness === false ? { mode: "off", dailyTokens: 0 } : options.project().reportAudit ?? DEFAULT_REPORT_AUDIT,
			now: options.now,
			state: () => this.state(),
			update: async change => {
				await this.#commit(HARNESS_WRITER, change);
				const record = (await this.state()).reportAudit;
				if (record) await options.auditStatusChanged?.(record);
			},
			timeline: async id => (await this.timeline(id)).entries.slice(-5),
			log: options.log,
		});
	}

	get coordinator(): Conversation {
		return this.#options.coordinator;
	}

	isCoordinator(conversationId: number): boolean {
		const coordinators = this.#options.coordinators;
		return coordinators === undefined ? conversationId === this.coordinator.id : coordinators.isCoordinator(conversationId);
	}

	/** The thread a coordinator conversation is; main when there are no background threads to tell apart. */
	threadIdOf(conversationId: number): string {
		return this.#options.coordinators?.threadIdOf(conversationId) ?? "main";
	}

	/** Whether `threadId` names a thread of this project. */
	knowsThread(threadId: string): boolean {
		if (threadId === "main") return true;
		return this.#options.coordinators?.placeOfThread(threadId) !== undefined;
	}

	/** After an input reached `threadId`: a background thread that had finished works again. */
	async #woke(threadId: string | null | undefined): Promise<void> {
		if (threadId === null || threadId === undefined || threadId === "main" || !this.knowsThread(threadId)) return;
		await this.#options.wakeThread?.(threadId);
	}

	/** A thread's conversation, falling back to main's when the thread is unknown (or main itself). */
	async #conversationOf(threadId: string | null | undefined): Promise<Conversation> {
		if (threadId === null || threadId === undefined || threadId === "main") return this.coordinator;
		const place = this.#options.coordinators?.placeOfThread(threadId);
		if (place === undefined) return this.coordinator;
		return (await this.#options.coordinators?.conversation(place.conversationId)) ?? this.coordinator;
	}

	get extension(): Extension {
		this.#extension ??= createBoardExtension(this);
		return this.#extension;
	}

	#iso(): string {
		return new Date(this.#options.now()).toISOString();
	}

	async state(context: Context = BACKGROUND_CONTEXT): Promise<BoardState> {
		const state = await this.#options.harness.snapshot(BoardDoc, this.coordinator.id, context);
		if (state === undefined) return emptyBoardState();
		const stored = state as BoardState;
		const normalized: BoardState = normalizeBoard({
			...plain(stored),
			tasks: plain(stored.tasks).map((task) => ({
				...task,
				report: task.report ?? emptyReport(),
				snapshots: task.snapshots ?? 0,
				refs: task.refs ?? [],
				parent: task.parent ?? null,
				foundWhile: task.foundWhile === task.parent ? null : task.foundWhile ?? null,
				related: task.related ?? [],
			})),
		});
  if (normalized.taskActivityEnabled) normalized.tasks = boardView(normalized, this.#options.now(), true).tasks;
  return normalized;
	}

	/** Atomically project each ref advance into legacy history and report freshness, deduplicated by fact ID. */
	async recordChangesLanded(fact: import("./task-changes.ts").ChangesLanded): Promise<void> {
		await this.#options.harness.commit(async tx => {
			const state = await openBoard(tx, this.coordinator.id);
			for (const taskId of fact.taskIds) {
				const task = state.tasks.find(task => task.id === taskId);
				if (!task) continue;
				const history = await openTaskHistory(tx, this.coordinator.id, taskId);
				if (history.events?.some(entry => entry.ref === fact.id)) continue;
				const landed = fact.commits.filter(commit => commit.taskIds.includes(taskId));
				const removed = fact.removed.filter(commit => commit.taskIds.includes(taskId));
				const reverted = fact.reverted.filter(commit => commit.taskIds.includes(taskId));
				if (!landed.length && !removed.length && !reverted.length) continue;
				const ref = fact.ref.replace(/^refs\/heads\//, "");
    if (landed.length) activityTracking(state, task.id).delivery = { text: `${landed.length} change${landed.length === 1 ? "" : "s"} landed on ${ref}${state.deployFeedConfigured ? " · not deployed yet" : ""}`,  at: fact.at, refs: landed.map(c => c.hash), count: landed.length };
    else delete activityTracking(state, task.id).delivery;
    if (state.taskLiveEnabled) {
     const sources = runningLiveSources(state.taskActivity?.[taskId]);
     const source = sources.find(source => source.actor.kind === "worker") ?? sources[0];
     if (source) {
      source.liveCommits = [...new Set([...(source.liveCommits ?? []), ...landed.map(commit => commit.hash)])];
      const counts = [landed.length ? `${landed.length} landed` : "", removed.length ? `${removed.length} removed` : "", reverted.length ? `${reverted.length} reverted` : ""].filter(Boolean);
      appendLiveFact(state, taskId, source, fact.at, `ledger:${fact.id}`, `Changes recorded: ${counts.join(", ")}`, "ledger");
     }
    }
				const label = [landed.length ? `${landed.length} change${landed.length === 1 ? "" : "s"} landed on ${ref}` : "",
					removed.length ? `${removed.length} change${removed.length === 1 ? "" : "s"} removed from ${ref}` : "", reverted.length ? `${reverted.length} change${reverted.length === 1 ? "" : "s"} reverted on ${ref}` : ""].filter(Boolean).join("; ");
				noteTaskFact(state, taskId, { kind: "commit", reason: label, at: fact.at, ref: fact.id });
				addTimelineEvent(history, task, { at: fact.at, kind: "milestone", label, ref: fact.id, by: HARNESS_WRITER,
					detail: [...landed.map(commit => `Landed ${commit.hash.slice(0, 12)} ${commit.subject}`), ...removed.map(commit => `Removed ${commit.hash.slice(0, 12)} ${commit.subject}`), ...reverted.map(commit => `Reverted ${commit.hash.slice(0, 12)} ${commit.subject}`)].join("\n") }, fact.id);
    upsertTimelineFact(history, task, { id: timelineId(task.id, fact.id), at: fact.at, endAt: fact.at, kind: "milestone", group: "delivery", source: "change", outcome: removed.length || reverted.length ? "removed" : "landed", label, ref: fact.id, by: HARNESS_WRITER,
     detail: [...landed.map(commit => `Landed ${commit.hash.slice(0, 12)} ${commit.subject}`), ...removed.map(commit => `Removed ${commit.hash.slice(0, 12)} ${commit.subject}`), ...reverted.map(commit => `Reverted ${commit.hash.slice(0, 12)} ${commit.subject}`)].join("\n") });
			}
		}, BACKGROUND_CONTEXT);
	}

	/** One transaction/publication for the entire attempt, including closed and archived tasks. */
	async recordDeployAttempt(fact: TaskDeployFact): Promise<void> {
		await this.#options.harness.commit(async tx => {
			const state = await openBoard(tx, this.coordinator.id);
			if ((state.deploySequences?.[fact.scope] ?? 0) >= fact.sequence) return;
			for (const taskId of fact.taskIds) {
				const task = state.tasks.find(task => task.id === taskId);
				if (!task) continue;
				const history = await openTaskHistory(tx, this.coordinator.id, taskId);
				applyTaskDeploy(state, history, task, fact);
			}
			state.deploySequences ??= {};
			state.deploySequences[fact.scope] = fact.sequence;
		}, BACKGROUND_CONTEXT);
	}

	async configureDeployFeed(configured: boolean): Promise<void> {
		await this.#commit(HARNESS_WRITER, state => {
			if (!!state.deployFeedConfigured === configured) return;
			state.deployFeedConfigured = configured;
			for (const task of state.tasks) {
				const tracking = activityTracking(state, task.id);
				if (tracking.delivery?.text.includes("landed")) tracking.delivery.text = tracking.delivery.text.replace(/ · not deployed yet$/, "") + (configured ? " · not deployed yet" : "");
			}
		});
	}

	async deployFeedAvailability(available: boolean): Promise<void> {
		await this.#commit(HARNESS_WRITER, state => {
			for (const taskId of Object.keys(state.latestTaskDeploy ?? {})) {
				const tracking = activityTracking(state, taskId);
				if (available) delete tracking.deployUnknownSince;
				else tracking.deployUnknownSince ??= this.#iso();
			}
		});
	}

	/** Refuse a task the board does not have, archived ones included, with `unknown_task`. */
	async requireTask(taskId: string): Promise<void> {
		if (!(await this.state()).tasks.some((task) => task.id === taskId)) throw unknownTask(taskId);
	}

	/** Read the latest admitted attempt, not the last timeline row to receive an update. */
	async taskDeployment(taskId: string): Promise<"live" | "pending" | "failed" | "unknown" | undefined> {
		const state = await this.state();
		if (!state.deployFeedConfigured) return undefined;
		const latest = state.latestTaskDeploy?.[taskId];
		if (!latest) return undefined;
		const tracking = state.taskActivity?.[taskId];
		if (tracking?.deployUnknownSince) return "unknown";
		if (tracking?.deployFailure) return "failed";
		if (latest.outcome) return latest.outcome;
		// Older board documents have the attempt identity but no durable outcome.
		const history = await this.#options.harness.snapshot(TaskHistoryDoc, this.coordinator.id, taskId, BACKGROUND_CONTEXT) as TaskHistoryState | undefined;
		const ref = `deploy:${latest.scope}:${latest.attemptId}`;
		const outcome = history?.timelineEntries?.find(entry => entry.source === "deploy" && entry.ref === ref)?.outcome;
		if (outcome === "ok") return "live";
		if (outcome === "failed" || outcome === "rolled_back") return "failed";
		if (outcome === "running") return "pending";
		return "unknown";
	}

	/** A task's snapshots, oldest first. */
	async history(taskId: string): Promise<BoardTaskSnapshot[]> {
		await this.requireTask(taskId);
		const history = await this.#options.harness.snapshot(TaskHistoryDoc, this.coordinator.id, taskId, BACKGROUND_CONTEXT);
		return history === undefined ? [] : plain((history as TaskHistoryState).snapshots);
	}

	/**
	 * A task's timeline, oldest first, and its feedback entries (open ones first). `kinds` keeps only those kinds of entry.
	 * `unknown_task` when the board has no such task.
	 */
	async timeline(taskId: string, kinds?: readonly BoardTimelineKind[], grouped = false): Promise<{ entries: BoardTimelineEntry[]; feedback: BoardFeedback[]; groups?: import("@kemiri/protocol").BoardTimelineGroup[]; timelineRevision?: number }> {
		const state = await this.state();
		if (!state.tasks.some((task) => task.id === taskId)) throw unknownTask(taskId);
		const history = await this.#options.harness.snapshot(TaskHistoryDoc, this.coordinator.id, taskId, BACKGROUND_CONTEXT);
		return plain({ ...buildTimeline({ id: taskId }, state, history as TaskHistoryState | undefined, kinds), ...(grouped ? { groups: buildTimelineGroups({ id: taskId }, state, history as TaskHistoryState | undefined, kinds), timelineRevision: state.tasks.find(task => task.id === taskId)?.timelineRevision ?? 0 } : {}) });
	}

	/**
	 * Record a user's message about a task as an open feedback entry. `requestId` is the message's, so a re-sent message
	 * finds its entry. Returns the entry; the caller puts its ID in the message's task reference.
	 */
	async recordFeedback(input: { taskId: string; text: string; images: number; threadId: string; requestId: string }): Promise<BoardFeedback> {
		const now = this.#iso();
		return this.#options.harness.commit(async (tx) => {
			const state = await openBoard(tx, this.#mainId);
			const history = await openTaskHistory(tx, this.#mainId, input.taskId);
			return recordFeedback(state, history, {
				taskId: input.taskId,
				text: input.text,
				images: input.images,
				threadId: input.threadId,
				key: input.requestId,
				now,
			});
		}, BACKGROUND_CONTEXT);
	}

	/**
	 * The user dismisses, reopens or otherwise sets a feedback entry. The coordinator that holds the task hears of it
	 * (a `[board]` follow-up), since it may be acting on the entry.
	 */
	async setFeedback(input: { taskId: string; feedbackId: string; state: BoardFeedbackState; note?: string | undefined }): Promise<BoardFeedback> {
		const now = this.#iso();
		const { result, owner } = await this.#options.harness.commit(async (tx) => {
			const state = await openBoard(tx, this.#mainId);
			const history = await openTaskHistory(tx, this.#mainId, input.taskId);
			const result = setFeedbackState(state, history, {
				taskId: input.taskId,
				feedbackId: input.feedbackId,
				state: input.state,
				note: input.note ?? null,
				by: USER_WRITER,
				now,
			});
			return { result, owner: state.tasks.find((task) => task.id === input.taskId)?.ownerThreadId ?? null };
		}, BACKGROUND_CONTEXT);
		if (result.changed) await this.#noticeFeedback(input.taskId, result.feedback, result.before, owner);
		return result.feedback;
	}

	/** A coordinator sets a feedback entry inside its tool call's own commit. */
	async setFeedbackFor(
		commit: <R>(change: (tx: Tx) => Promise<R>) => Promise<R>,
		input: { taskId: string; feedbackId: string; state: BoardFeedbackState; note: string | null },
		by: BoardWriter,
	): Promise<BoardFeedback> {
		const now = this.#iso();
		return commit(async (tx) => {
			const state = await openBoard(tx, this.#mainId);
			const history = await openTaskHistory(tx, this.#mainId, input.taskId);
			return setFeedbackState(state, history, { ...input, by, now }).feedback;
		});
	}

	async #noticeFeedback(taskId: string, entry: BoardFeedback, before: BoardFeedbackState, owner: string | null): Promise<void> {
		const what =
			entry.state === "dismissed"
				? "dismissed it (not needed)"
				: entry.state === "open"
					? `reopened it (it was ${before})`
					: `set it to ${entry.state}`;
		const content = `${BOARD_PREFIX} The user ${what}: feedback ${entry.id} on ${taskId}, ${JSON.stringify(clip(entry.text, 200))}${entry.note === null ? "" : ` — they say: ${JSON.stringify(clip(entry.note, 300))}`}`;
		const target = owner !== null && this.knowsThread(owner) ? owner : "main";
		try {
			const conversation = await this.#conversationOf(target);
			await conversation.submit(
				{ type: "input", content, whenBusy: "followUp", requestId: `board-feedback:${entry.id}@${entry.changes.length}` },
				BACKGROUND_CONTEXT,
			);
			await this.#woke(target);
		} catch (error) {
			this.#options.log(`board: could not tell the coordinator about feedback ${entry.id}: ${errorMessage(error)}`);
		}
	}

 #setWatcherSettings(state: BoardState): void {
  if (this.#watcher && state.taskLiveEnabled) state.taskWatcherSettings = this.#options.project().archived ? { mode: "off", dailyTokens: 0 } : this.#options.project().taskWatcher ?? DEFAULT_TASK_WATCHER;
  else delete state.taskWatcherSettings;
 }

 async configureTaskWatcher(): Promise<void> {
  if (!this.#watcher) return;
  await this.#options.harness.commit(async tx => { this.#setWatcherSettings(await openBoard(tx, this.#mainId)); }, BACKGROUND_CONTEXT);
 }

 async markLiveLineWrong(taskId: string, lineId: string, by: string): Promise<void> {
  if (!this.#watcher) throw new ServerError("bad_request", "Live news lines are unsupported.");
  await this.#options.harness.commit(async tx => {
   const state = await openBoard(tx, this.#mainId);
   const task = state.tasks.find(task => task.id === taskId);
   if (!task) throw new ServerError("unknown_task", `No task "${taskId}" on the board.`);
   const active = state.taskActivity?.[taskId]?.liveLines?.find(line => line.kind === "auto" && line.id === lineId);
   if (active) { markWatcherLineWrong(state, active, by, this.#options.now()); return; }
   const history = await openTaskHistory(tx, this.#mainId, taskId);
   const run = history.timelineEntries?.find(entry => entry.live?.lines.some(line => line.kind === "auto" && line.id === lineId));
   const line = run?.live?.lines.find(line => line.id === lineId);
   if (!run || !line) throw new ServerError("bad_request", "This live news line is no longer available.");
   if (line.wrong) return;
   const lines = run.live!.lines.map(item => ({ ...item }));
   markWatcherLineWrong(state, lines.find(item => item.id === lineId)!, by, this.#options.now());
   const { revision: _revision, factCount: _count, ...fact } = run;
   upsertTimelineFact(history, task, { ...fact, live: { ...run.live!, lines } });
  }, BACKGROUND_CONTEXT);
 }

	/** Create the document if this project never had one, so a change watch can attach to it. */
	async ensureDocument(): Promise<void> {
		await this.#options.harness.commit(async (tx) => {
			const state = await openBoard(tx, this.#mainId);
			state.taskFreshnessEnabled = this.#options.taskFreshness !== false;
   state.taskActivityEnabled = this.#options.taskActivity !== false;
   state.taskStateEnabled = this.#options.taskState !== false;
   state.taskPartStatesEnabled = this.#options.taskPartStates !== false;
   state.taskLiveEnabled = this.#options.taskLive !== false;
   this.#setWatcherSettings(state);
   await this.#change(tx, HARNESS_WRITER, "task-state-migration", (doc, now) => {
    const notices = migrateTaskStates(doc, now);
    if (notices.length) this.#options.log(`board task-state migration: ${notices.join("; ")}`);
   });
			state.lastReportSweep ??= this.#options.now();
   if (state.taskActivityEnabled) for (const task of state.tasks) {
    const tracking = activityTracking(state, task.id);
    if (tracking.feedback === undefined) {
     const history = await openTaskHistory(tx, this.#mainId, task.id);
     tracking.feedback = (history.feedback ?? []).filter(f => f.state === "open").map(f => ({ id: f.id, at: f.at }));
    }
   }
		}, BACKGROUND_CONTEXT);
		await this.reconcileActivity();
  await this.checkWaiting();
  await this.checkPaused();
		await this.checkReports();
	}

	/** The board; a task whose 7 days passed is archived in storage on the way. */
	async get(includeArchived = false): Promise<Board> {
		const state = await this.state();
		const now = this.#options.now();
		if (state.tasks.some((task) => !task.archived && isArchivedAt(task, now))) {
			await this.#commit(HARNESS_WRITER, (doc) => {
				sweepArchive(doc, now);
			});
		}
		const board = boardView(state, now, includeArchived);
  return this.#liveWatch?.project(board, state) ?? board;
	}

	get #mainId(): ConversationId {
		return this.coordinator.id as ConversationId;
	}

	async #commit<T>(by: BoardWriter, change: (state: BoardState) => T): Promise<T> {
		return this.#options.harness.commit((tx) => this.#change(tx, by, undefined, (state) => change(state)), BACKGROUND_CONTEXT);
	}

	/** Open the board in `tx`, run `change`, and snapshot each task whose status it changed. */
	async #change<T>(tx: Tx, by: BoardWriter, key: string | undefined, change: (state: BoardState, now: string) => T | Promise<T>): Promise<T> {
		const state = await openBoard(tx, this.#mainId);
		const before = statusesOf(state);
  const threadRunsBefore = this.#threadRunStates(state);
		const waitingBefore = new Map(state.tasks.map((task) => [task.id, JSON.stringify(task.waiting)]));
		const linksBefore = linksOfBoard(state);
 const ownersBefore = new Map(state.tasks.map(task => [task.id, task.ownerThreadId]));
		const now = this.#iso();
		const result = await change(state, now);
  repairTaskParts(state, now);
  for (const task of state.tasks) if (before.get(task.id) !== task.status) {
   const tracking = activityTracking(state, task.id);
   if (tracking.status !== task.status) tracking.statusChanges = (tracking.statusChanges ?? 0) + 1;
   tracking.status = task.status;
   tracking.statusSince = now;
  }
		sweepArchive(state, this.#options.now());
		await snapshotStatusChanges(tx, this.#mainId, state, before, { by, at: now, key });
		for (const task of state.tasks) {
			if (task.status !== "waiting" || before.get(task.id) !== "waiting" || waitingBefore.get(task.id) === JSON.stringify(task.waiting)) continue;
			addSnapshot(await openTaskHistory(tx, this.#mainId, task.id), task, { label: "Waiting updated", questions: state.questions, by, at: now, key: key === undefined ? undefined : `${key}:${task.id}:waiting` });
		}
		await logLinkChanges(tx, this.#mainId, state, linksBefore, { by, at: now });
  await this.#syncThreadTimeline(tx, state, threadRunsBefore);
  for (const task of state.tasks) if ((ownersBefore.get(task.id) ?? null) !== (task.ownerThreadId ?? null)) {
   const from = ownersBefore.get(task.id);
   const to = task.ownerThreadId;
   const history = await openTaskHistory(tx, this.#mainId, task.id);
   upsertTimelineFact(history, task, { id: timelineId(task.id, `ownership:${task.revision}:${now}`), at: now, endAt: now, kind: "milestone", group: "work", source: "ownership", outcome: "recorded", label: to ? (from ? `Handed from ${from} to ${to}` : `Claimed by ${to}`) : `Released by ${from}`, by });
  }
		return result;
	}

	/** Run a coordinator change inside the tool call's own commit; `key` is the call's, so a rerun saves no snapshot twice. */
	async commitFor<T>(
		commit: <R>(change: (tx: Tx) => Promise<R>) => Promise<R>,
		change: (state: BoardState, now: string) => T,
		by: BoardWriter,
		key: string,
  focusTaskId?: string | undefined,
	): Promise<T>;
	async commitFor<T>(
		commit: (change: (tx: Tx) => Promise<NoInfer<T>>) => Promise<NoInfer<T>>,
		change: (state: BoardState, now: string) => T,
		by: BoardWriter,
		key: string,
  focusTaskId?: string | undefined,
	): Promise<T>;
	async commitFor<T>(
		commit: (change: (tx: Tx) => Promise<NoInfer<T>>) => Promise<NoInfer<T>>,
		change: (state: BoardState, now: string) => T,
		by: BoardWriter,
		key: string,
  focusTaskId?: string | undefined,
	): Promise<T> {
  const conversation = focusTaskId && by.author === "coordinator" ? await this.#conversationOf(by.threadId) : undefined;
  const threadTitle = await this.#options.threadTitle?.(by.threadId ?? "main");
  return commit(async tx => {
   const result = await this.#change(tx, by, key, change);
   if (focusTaskId && conversation) await inferCoordinatorTaskFocusIn(tx, this.#mainId, conversation.id, by.threadId ?? "main", focusTaskId, this.#iso(), threadTitle);
   return result;
  });
	}

	/**
	 * Rewrite sections of a task's report inside the tool call's own commit, naming a milestone to snapshot it. `key` is
	 * the call's, so a rerun after a restart saves the snapshot once.
	 */
	async writeReport(
		commit: <R>(change: (tx: Tx) => Promise<R>) => Promise<R>,
		input: Omit<ReportWrite, "now"> & { milestone?: string | undefined },
		key: string,
	): Promise<BoardTask> {
  const conversation = input.by.author === "coordinator" ? await this.#conversationOf(input.by.threadId) : undefined;
  const threadTitle = await this.#options.threadTitle?.(input.by.threadId ?? "main");
  return commit(async tx => {
   if (conversation) await inferCoordinatorTaskFocusIn(tx, this.#mainId, conversation.id, input.by.threadId ?? "main", input.taskId, this.#iso(), threadTitle);
   return writeReportIn(tx, this.#mainId, input, key, this.#iso());
  });
	}

	/** The task a `thread` schedule reports on: its one task, put back to in_progress for this run. */
	async taskForSchedule(input: { scheduleId: string; title: string }): Promise<BoardTask> {
		return this.#commit(HARNESS_WRITER, (state) => taskForSchedule(state, { ...input, now: this.#iso() }).after);
	}

	/** The task a clock schedule's worker run is given: its one open task, or a new one. The worker's spawn moves it. */
	async scheduleTaskForRun(input: { scheduleId: string; title: string }): Promise<BoardTask> {
		return this.#commit(HARNESS_WRITER, (state) => scheduleTaskForRun(state, { ...input, now: this.#iso() }));
	}

	/** The task of one event run, made once however often the run is retried. */
	async taskForEvent(input: { title: string; description: string; marker: string; ref: string }): Promise<BoardTask> {
		return this.#commit(HARNESS_WRITER, (state) => taskForEvent(state, { ...input, now: this.#iso() }).after);
	}

	/** Create or change a task. A user's `note` (why they moved it, in their words) reaches the coordinator with the change. */
	async saveTask(
		input: { taskId?: string | undefined; expectedRevision?: number | undefined; task: BoardTaskInput; openParts?: "close" | "follow_up" | undefined; note?: string | undefined },
		author: BoardAuthor,
	): Promise<BoardTask> {
		const now = this.#iso();
		const writer = author === "user" ? USER_WRITER : author === "harness" ? HARNESS_WRITER : coordinatorWriter("main");
		const { note, ...fields } = input;
		const { change, unblocked, other } = await this.#commit(writer, (state) => {
			const before = new Map(state.tasks.map(t => [t.id, plain(t)]));
   const saved = saveTask(state, { ...fields, author, now });
   const other = state.tasks.filter(t => t.id !== saved.after.id && JSON.stringify(before.get(t.id)) !== JSON.stringify(t)).map(t => ({ before: before.get(t.id) ?? null, after: plain(t) }));
   return { change: saved, unblocked: unblockedBy(state, saved), other };
		});
		if (author === "user") {
   this.#recordEdit(change.before, change.after, [note, ...(change.notices ?? [])].filter(Boolean).join(" "));
   for (const edit of other) this.#recordEdit(edit.before, edit.after);
  }
		else this.noticeReview(change);
		await this.noticeUnblocked(change.after, unblocked);
  const state = await this.state();
  for (const edit of other) await this.noticeUnblocked(edit.after, unblockedBy(state, edit));
		return (await this.get(true)).tasks.find(task => task.id === change.after.id)!;
	}

	/**
	 * Tell the coordinator, once per change, which tasks `done` left with every blocker done. It decides what to start:
	 * the harness never spawns on its own. The request ID derives from the done task's revision.
	 */
	async noticeUnblocked(done: BoardTask, unblocked: readonly BoardTask[]): Promise<void> {
		if (unblocked.length === 0) return;
		// Each thread hears about the tasks it owns; unclaimed ones go to main, which plans for the project.
		const byOwner = new Map<string, BoardTask[]>();
		for (const task of unblocked) {
			const owner = task.ownerThreadId ?? "main";
			const target = this.knowsThread(owner) ? owner : "main";
			byOwner.set(target, [...(byOwner.get(target) ?? []), task]);
		}
		for (const [threadId, tasks] of byOwner) {
			const names = tasks.map((task) => `${task.id} ${JSON.stringify(task.title)}`).join(", ");
			const one = tasks.length === 1;
			const content = `${BOARD_PREFIX} ${done.id} ${JSON.stringify(done.title)} is ${done.status}, so ${names} ${one ? "has all its" : "have all their"} blockers closed and can start.`;
			const suffix = threadId === "main" ? "" : `:${threadId}`;
			try {
				const conversation = await this.#conversationOf(threadId);
				await conversation.submit(
					{ type: "input", content, whenBusy: "followUp", requestId: `board-unblocked:${done.id}@${done.revision}${suffix}` },
					BACKGROUND_CONTEXT,
				);
				await this.#woke(threadId);
			} catch (error) {
				this.#options.log(`board: could not tell the coordinator about unblocked tasks: ${errorMessage(error)}`);
			}
		}
	}

	/** Tell the thread a task was handed to; the request ID derives from the task's new revision. */
	async noticeHandoff(task: BoardTask, from: string): Promise<void> {
		const to = task.ownerThreadId ?? null;
		if (to === null || to === from) return;
		const content = `${BOARD_PREFIX} Thread "${from}" handed ${task.id} ${JSON.stringify(task.title)} (r${task.revision}) to you. It is yours now: read it with the board tool and carry it on.`;
		try {
			const conversation = await this.#conversationOf(to);
			await conversation.submit(
				{ type: "input", content, whenBusy: "followUp", requestId: `board-handoff:${task.id}@${task.revision}` },
				BACKGROUND_CONTEXT,
			);
			await this.#woke(to);
		} catch (error) {
			this.#options.log(`board: could not tell thread ${to} about ${task.id}: ${errorMessage(error)}`);
		}
	}

	/**
	 * A thread stopped or finished: the open tasks it still holds become unclaimed, so main (or another thread) can take
	 * them over. Settled tasks keep their owner as history. Returns the released task IDs.
	 */
	async releaseThread(threadId: string, key?: string, primaryTaskId?: string | null): Promise<string[]> {
		const now = this.#iso();
		return this.#commit(HARNESS_WRITER, (state) => {
   if (state.taskFocus) delete state.taskFocus[threadId];
			const released: string[] = [];
			if (key !== undefined && !claimHarnessKey(state, `report-release:${key}`)) return released;
			for (const task of state.tasks) {
				const tracking = activityTracking(state, task.id);
    for (const source of Object.values(tracking.sources)) if (source.actor.threadId === threadId && source.actor.kind !== "worker") endActivitySource(tracking, source.actor.id, now);
    const owned = task.ownerThreadId === threadId;
				if (!owned && task.id !== primaryTaskId) continue;
				noteTaskFact(state, task.id, { actor: "harness", kind: "thread_finish", reason: "thread finished or stopped", at: now });
				if (!owned || isSettled(task)) continue;
				task.ownerThreadId = null;
				touchByHarness(state, task, task.status, now);
				released.push(task.id);
			}
			return released;
		});
	}

	async noteThreadOutcome(threadId: string, key: string, reason: string, taskId?: string | null): Promise<void> {
		await this.#commit(HARNESS_WRITER, (state) => {
			if (!claimHarnessKey(state, `report-thread:${key}`)) return;
			for (const task of state.tasks) if (task.ownerThreadId === threadId || task.id === taskId) noteTaskFact(state, task.id, { actor: "harness", kind: "thread_finish", reason, at: this.#iso() });
		});
	}

	/** A scheduled run failed or was skipped: open (or update) the schedule's blocked task. */
	async recordScheduleProblem(input: { scheduleId: string; title: string; runAt: string; reason: string }): Promise<void> {
		const now = this.#iso();
		await this.#commit(HARNESS_WRITER, (state) =>
			recordScheduleProblem(state, {
				key: `schedule-run:${input.scheduleId}@${input.runAt}`,
				scheduleId: input.scheduleId,
				title: input.title,
				reason: input.reason,
				now,
			}),
		);
	}

	async reorder(taskIds: readonly string[]): Promise<void> {
		const now = this.#iso();
		const moved = await this.#commit(USER_WRITER, (state) => reorderTasks(state, taskIds, now));
		this.#pendingOrder = { ids: moved, at: now };
		this.#armEditTimer();
	}

async withdrawMcpApproval(questionId: string): Promise<void> {
  await this.#commit(HARNESS_WRITER, state => {
   const question = state.questions.find(question => question.id === questionId);
   if (question?.status === "open") settleQuestion(state, { questionId, expectedRevision: question.revision, answer: null, now: this.#iso(), actor: "coordinator" });
  });
 }

async requestMcpApproval(input: { text: string; options: string[]; threadId: string; key: string }): Promise<string> {
  const pending = (await this.state()).questions.find(question => question.status === "open" && question.text === input.text && question.threadId === input.threadId);
  if (pending) return pending.id;
  const question = await this.commitFor(change => this.#options.harness.commit(change, BACKGROUND_CONTEXT),
   (state, now) => { const q = askQuestion(state, { text: input.text, options: input.options, threadId: input.threadId, taskId: null, now }); state.questions.find(row => row.id === q.id)!.mcpApproval = true; return { ...q, mcpApproval: true }; },
   HARNESS_WRITER, `mcp-approval:${input.key}`);
  this.noticeQuestion(question);
  return question.id;
 }

	async clarify(input: { questionId: string; expectedRevision: number; text: string }): Promise<BoardQuestion> {
  const question = await this.#commit(USER_WRITER, state => clarifyQuestion(state, { ...input, now: this.#iso() }));
  const asker = await this.#conversationOf(question.threadId);
  await asker.submit({ type: "input", content: `${BOARD_PREFIX} The user asked back on ${question.id} (r${question.revision}): ${input.text}\nReply with board reply_question (id, expectedRevision, text; optional revisedText/revisedOptions). Do not ask a new question for the same decision.`, whenBusy: "steer", requestId: `board-clarify:${question.id}@${question.revision}` }, BACKGROUND_CONTEXT);
  await this.#woke(question.threadId);
  return question;
 }

 /** Process only clarification messages this run actually saw; stale rounds cannot remind a later round. */
 async endClarifications(threadId: string, seen: ReadonlyMap<string, number>, key: string, failed = false): Promise<void> {
  const results = await this.#commit(HARNESS_WRITER, state => {
   const first = claimHarnessKey(state, key);
   return state.questions.flatMap(question => {
    const target = this.knowsThread(question.threadId ?? "main") ? question.threadId ?? "main" : "main";
    if (target !== threadId || (!failed && seen.get(question.id) !== question.revision)) return [];
    if (!first) return state.clarificationReminders?.[question.id]?.pending && question.waitingOn === "agent" ? [{ question: plain(question), outcome: "remind" as const }] : [];
    const outcome = endQuestionClarification(state, { questionId: question.id, expectedRevision: question.revision, now: this.#iso(), failed });
    return outcome ? [{ question: plain(question), outcome }] : [];
   });
  });
  for (const { question, outcome } of results) {
   if (outcome === "returned") { this.noticeQuestion(question); continue; }
   const conversation = await this.#conversationOf(question.threadId);
   await conversation.submit({ type: "input", content: `${BOARD_PREFIX} Clarification reminder for ${question.id} (r${question.revision}): reply with board reply_question before ending this turn, or withdraw/resolve it. Otherwise it returns to the owner marked No reply yet.`, whenBusy: "followUp", requestId: `board-clarify-reminder:${question.id}@${question.revision}` }, BACKGROUND_CONTEXT);
   await this.#commit(HARNESS_WRITER, state => {
    const pending = state.clarificationReminders?.[question.id];
    if (pending?.revision === question.revision) delete pending.pending;
   });
  }
 }

 async answer(input: { questionId: string; expectedRevision: number; answer: string }): Promise<BoardQuestion> {
		const now = this.#iso();
		const question = await this.#commit(USER_WRITER, (state) => settleQuestion(state, { ...input, now, actor: "user" }));
		await this.onMcpAnswer?.(question.id, input.answer);
		const text = `${BOARD_PREFIX} The user answered ${question.id} (${JSON.stringify(clip(question.text, 200))}): ${input.answer}`;
		try {
			// The answer goes to the thread that asked; a question from before threads, or from a thread that is gone, to main.
			const asker = await this.#conversationOf(question.threadId);
			await asker.submit(
				{ type: "input", content: text, whenBusy: "steer", requestId: `board-answer:${question.id}@${question.revision}` },
				BACKGROUND_CONTEXT,
			);
			await this.#woke(question.threadId);
		} catch (error) {
			this.#options.log(`board: could not deliver the answer to ${question.id}: ${errorMessage(error)}`);
		}
		return question;
	}

	/** Tell the user's devices once about a question or warning a coordinator asked. */
	noticeQuestion(question: BoardQuestion): void {
		const project = this.#options.project();
		this.#options.notifications?.notify(
			boardQuestionNotification({
				projectId: project.id,
				projectName: project.name,
				questionId: question.id,
				text: question.exchanges?.at(-1)?.author.author === "coordinator" ? question.exchanges.at(-1)!.text : question.text,
				threadId: question.threadId ?? "main",
				taskId: question.taskId,
				warning: question.kind === "warning",
    ...(question.exchanges?.length ? { revision: question.revision, reply: !question.noReplyYet, noReplyYet: question.noReplyYet } : {}),
			}),
		);
	}

	/** Tell the user's devices once that someone but the user moved a task to review. */
	noticeReview(change: TaskChange): void {
		if (change.after.status !== "review" || change.before?.status === "review") return;
		const project = this.#options.project();
		this.#options.notifications?.notify(
			taskReviewNotification({
				projectId: project.id,
				projectName: project.name,
				taskId: change.after.id,
				title: change.after.title,
				revision: change.after.revision,
				...(change.after.ownerThreadId === null || change.after.ownerThreadId === undefined ? {} : { threadId: change.after.ownerThreadId }),
			}),
		);
	}

 #threadRunStates(state: BoardState): Map<string, string> {
  return new Map(state.tasks.flatMap(task => Object.values(state.taskActivity?.[task.id]?.sources ?? {}).map(source => [`${task.id}:${source.actor.id}`, source.state])));
 }

 async taskArtifactSaves(): Promise<readonly TaskArtifactSave[]> {
  return this.#options.taskLive === false ? [] : await this.#options.taskArtifactSaves?.read().catch(error => {
   this.#options.log(`task live saves: ${errorMessage(error)}`);
   return [];
  }) ?? [];
 }

 async #syncThreadTimeline(tx: Tx, state: BoardState, before: ReadonlyMap<string, string>): Promise<void> {
  for (const task of state.tasks) {
   const sources = Object.values(state.taskActivity?.[task.id]?.sources ?? {}).filter(source => source.state !== "running" || source.actor.kind === "thread").filter(source => before.get(`${task.id}:${source.actor.id}`) !== source.state);
   if (!sources.length) continue;
   for (const source of sources) {
    if (source.state === "ended" || source.state === "failed") {
     const folded = await foldTaskLiveIn(tx, this.#mainId, state, task.id, source.actor.id, source.state, source.since, source.failure, await this.taskArtifactSaves());
     if (folded) continue;
    }
    if (source.actor.kind === "thread" && source.state !== "unknown") recordTimelineRun(await openTaskHistory(tx, this.#mainId, task.id), task, source.actor, source.state, source.since, source.failure ?? source.title);
   }
  }
 }

 async endTaskFocus(conversationId: number, runId: string): Promise<void> {
  await this.#commit(HARNESS_WRITER, state => {
   for (const tracking of Object.values(state.taskActivity ?? {})) for (const source of Object.values(tracking.sources)) {
    if (source.actor.kind !== "worker" && source.actor.conversationId === conversationId && source.actor.runId === runId) endActivitySource(tracking, source.actor.id, this.#iso());
   }
  });
 }

 async #updateTaskFocus(conversationId: number, threadId: string, live: Readonly<LiveState> | undefined | null): Promise<void> {
  const threadTitle = await this.#options.threadTitle?.(threadId);
  const taskIds = new Set<string>();
  const run = live?.run?.afterRun ? undefined : live?.run;
  const runId = run ? String(run.first ?? run.taskId) : undefined;
  if (run?.first !== undefined) {
   const conversation = await this.#options.harness.conversation(conversationId as ConversationId, BACKGROUND_CONTEXT);
   let cursor: Parameters<Conversation["entries"]>[2];
   do {
    const page = await conversation?.entries({ minEntryId: run.first }, 200, cursor, BACKGROUND_CONTEXT);
    for (const entry of page?.items ?? []) for (const message of entry.model ?? []) if (message.role === "user") {
     const text = typeof message.content === "string" ? message.content : message.content.filter(b => b.type === "text").map(b => b.text).join("\n");
     const id = /^\[task (T[1-9]\d*)[\],]/.exec(text)?.[1];
     if (id) taskIds.add(id);
    }
    cursor = page?.next;
   } while (cursor !== undefined);
  }
  await this.#options.harness.commit(async tx => {
   const state = await openBoard(tx, this.#mainId);
   if (!state.taskActivityEnabled) return;
   const threadRunsBefore = this.#threadRunStates(state);
   const at = this.#iso();
   const ownTaskId = state.taskFocus?.[threadId];
   if (ownTaskId) taskIds.add(ownTaskId);
   for (const task of state.tasks) {
    const tracking = state.taskActivity?.[task.id];
    if (!tracking) continue;
    for (const source of Object.values(tracking.sources)) {
     if (source.actor.kind === "worker" || source.actor.threadId !== threadId) continue;
     if (runId && source.actor.runId === runId && source.state === "running") continue;
     const failure = live?.runFailure;
     if (!live?.run && failure && failure.reason !== "aborted" && failure.reason !== "reset" && failure.reason !== "nothing_to_answer" && String(failure.first) === source.actor.runId) {
      if (source.state !== "failed") { source.state = "failed"; source.failure = failure.detail ?? failure.reason; source.since = at; delete source.phase; tracking.lastEndedAt = at; }
     } else if (run && taskIds.has(task.id) && source.state === "failed") source.state = "ended";
     else endActivitySource(tracking, source.actor.id, at);
    }
   }
   if (!runId) { await this.#syncThreadTimeline(tx, state, threadRunsBefore); return; }
   const id = `${threadId}:${conversationId}:${runId}`;
   for (const task of state.tasks.filter(task => taskIds.has(task.id))) {
    const tracking = activityTracking(state, task.id);
    if (tracking.sources[id]?.state === "running") continue;
    tracking.sources[id] = { actor: { id, kind: threadId === "main" ? "coordinator" : "thread", name: threadId === "main" ? "Coordinator" : (threadTitle ?? threadId), threadId, conversationId, runId }, state: "running", since: at, title: task.title };
   }
   await this.#syncThreadTimeline(tx, state, threadRunsBefore);
  }, BACKGROUND_CONTEXT);
 }

 async #watchTaskFocus(conversationId: number, threadId: string): Promise<() => Promise<void>> {
  const watch = await this.#options.harness.watchDoc(LiveDoc, conversationId as ConversationId, BACKGROUND_CONTEXT);
  if (!watch) return async () => undefined;
  let signature = "";
  const update = async (live: Readonly<LiveState> | null) => {
   const next = JSON.stringify([live?.run?.first ?? live?.run?.taskId, live?.run?.inputs, !!live?.run?.afterRun, live?.runFailure]);
   if (next === signature) return;
   signature = next;
   const latest = await this.#options.harness.snapshot(LiveDoc, conversationId as ConversationId, BACKGROUND_CONTEXT);
   await this.#updateTaskFocus(conversationId, threadId, latest);
   if (latest?.runFailure) await this.endClarifications(threadId, new Map(), `clarification-failed:${conversationId}:${JSON.stringify(latest.runFailure)}`, true);
  };
  await update(watch.value);
  watch.start(async call => { if (call.kind === "failed") throw call.error; await update(call.value); });
  return async () => { await watch.stop(); };
 }

 /** Bootstrap legacy durable worker records without using legacy Now as a phase. */
 async #reconcileWorkerRecords(conversationId: number, threadId: string): Promise<void> {
  const { WorkersDoc } = await import("./workers.ts");
  const doc = await this.#options.harness.snapshot(WorkersDoc, conversationId as ConversationId, BACKGROUND_CONTEXT);
  if (!doc) return;
  const sources: { taskId: string; source: import("./task-activity.ts").TaskActivitySource }[] = [];
  for (const record of Object.values(doc.workers)) {
   if (!record.taskId) continue;
   const runId = record.activityRunId ?? record.spawnedByCallId ?? record.createdAt;
   const id = `${threadId}:${record.conversationId}:${runId}`;
   let status: "running" | "failed" | "ended" | "unknown" = record.status === "failed" ? "failed" : "ended";
   if (record.status === "running") {
    const live = await this.#options.harness.snapshot(LiveDoc, record.conversationId as ConversationId, BACKGROUND_CONTEXT).catch(() => undefined);
    status = live === undefined ? "unknown" : live.run && !live.run.afterRun ? "running" : "ended";
   }
   sources.push({ taskId: record.taskId, source: { actor: { id, kind: "worker", name: record.id, threadId, conversationId: record.conversationId, runId }, state: status, since: record.updatedAt, title: record.title, ...(status === "failed" ? { failure: record.failure ?? "no reason given" } : {}) } });
  }
  if (!sources.length) return;
  await this.#options.harness.commit(async tx => {
   const state = await openBoard(tx, this.#mainId);
   if (!state.taskActivityEnabled) return;
   for (const { taskId, source } of sources) {
    if (!state.tasks.some(task => task.id === taskId)) continue;
    const tracking = activityTracking(state, taskId);
    tracking.sources[source.actor.id] ??= source;
    if (source.state === "ended" || source.state === "failed") if (!tracking.lastEndedAt || tracking.lastEndedAt < source.since) tracking.lastEndedAt = source.since;
   }
  }, BACKGROUND_CONTEXT);
 }

 /** Reconcile persisted running sources against durable transcript run control, not token ages. */
 async reconcileActivity(): Promise<void> {
  const state = await this.state();
  const ended: { taskId: string; id: string; unknown: boolean }[] = [];
  for (const task of state.tasks) for (const source of Object.values(state.taskActivity?.[task.id]?.sources ?? {})) {
   if (source.state !== "running") continue;
   const live = await this.#options.harness.snapshot(LiveDoc, source.actor.conversationId as ConversationId, BACKGROUND_CONTEXT).catch(() => undefined);
   if (!live?.run || live.run.afterRun) ended.push({ taskId: task.id, id: source.actor.id, unknown: live === undefined });
  }
  if (!ended.length) return;
  await this.#commit(HARNESS_WRITER, state => {
   for (const item of ended) {
    const tracking = activityTracking(state, item.taskId);
    if (item.unknown && tracking.sources[item.id]) { tracking.sources[item.id]!.state = "unknown"; delete tracking.sources[item.id]!.phase; }
    else endActivitySource(tracking, item.id, this.#iso());
   }
  });
 }

	/** Push the board without archived tasks whenever the document changes. Resolves to a stop function. */
	async watch(onChange: (board: Board, openQuestions: number) => void): Promise<() => Promise<void>> {
		const watch = await this.#options.harness.watchDoc(BoardDoc, this.coordinator.id, BACKGROUND_CONTEXT);
		if (watch === undefined) return async () => undefined;
		const stops: (() => Promise<void>)[] = [];
  const attach = async (conversationId: number, threadId: string): Promise<void> => {
   await this.#reconcileWorkerRecords(conversationId, threadId);
   const stop = await this.#watchTaskFocus(conversationId, threadId);
   stops.push(stop);
  };
  for (const place of this.#options.coordinators?.places() ?? [{ conversationId: this.coordinator.id, threadId: "main" }]) await attach(place.conversationId, place.threadId);
  const unlisten = this.#options.coordinators?.onAdded(place => { void attach(place.conversationId, place.threadId).catch(error => this.#options.log(`board activity: ${errorMessage(error)}`)); });
  let current = "";
  let expiry: ReturnType<typeof setTimeout> | undefined;
  let watcherStatus = "";
		let boardState = watch.value;
  const publish = (value: BoardState | Readonly<BoardState> | null, liveOnly = false): void => {
			const state = (value ?? emptyBoardState()) as BoardState;
			const board = boardView(state, this.#options.now(), false);
   if (state.taskLiveEnabled && this.#liveWatch) {
    if (!liveOnly) this.#liveWatch.sync(state);
    this.#liveWatch.project(board, state);
   }
			const encoded = JSON.stringify(board);
			if (encoded !== current) {
    current = encoded;
    onChange(board, openQuestionCount(state));
   }
   if (liveOnly) return;
   if (this.#watcher && state.taskWatcherStatus) {
    const status = JSON.stringify(state.taskWatcherStatus);
    if (watcherStatus !== status) {
     watcherStatus = status;
     this.#persistWatcherStatus = this.#persistWatcherStatus.then(() => this.#options.watcherStatusChanged?.(JSON.parse(status))).catch(error => this.#options.log(`task watcher status: ${errorMessage(error)}`));
    }
   }
   if (Object.keys(state.taskWatcherJobs ?? {}).length) this.#watcher?.wake();
   if (expiry) clearTimeout(expiry);
   const due = [
    ...(state.pausedNotices?.length ? [this.#options.now() + 1000] : []),
    ...board.tasks.filter(task => task.activity?.kind === "delivery").map(task => Date.parse(task.activity!.since) + DELIVERY_ACTIVITY_MS),
    ...board.tasks.filter(task => task.status === "in_progress" && task.state?.kind === "working" && !task.state.refs.length && !Object.values(state.taskActivity?.[task.id]?.sources ?? {}).some(s => s.state === "running") && state.taskActivity?.[task.id]?.deploy?.state !== "active").map(task => Date.parse(taskQuietSince(task, state.taskActivity?.[task.id])) + TASK_PAUSED_MS),
   ].filter(at => at > this.#options.now());
   if (board.tasks.some(task => task.state?.kind === "paused") || state.pausedNotices?.length) void this.checkPaused().catch(error => this.#options.log(`board paused: ${errorMessage(error)}`));
   if (due.length) { expiry = setTimeout(() => publish(boardState), Math.min(...due) - this.#options.now()); expiry.unref?.(); }
			this.#armWaiting(state);
			this.#armReports(state);
		};
  const liveWatch = this.#options.taskLive === false ? undefined : new TaskLiveWatch(this.#options.harness,
   () => publish(boardState, true), error => this.#options.log(`task live: ${errorMessage(error)}`), this.#options.taskArtifactSaves?.read, this.#watcher ? async (conversationId, runId, run) => {
    const at = this.#options.now();
    const candidates = (boardState?.tasks ?? []).filter(task => task.status === "in_progress" && watcherCanPublish(boardState!, task.id, at)).flatMap(task =>
     runningLiveSources(boardState!.taskActivity?.[task.id]).filter(source => source.actor.kind === "worker" && source.actor.conversationId === conversationId && source.actor.runId === runId && run.due(source.watcherCursor, at, false))
      .map(source => ({ taskId: task.id, sourceId: source.actor.id })));
    if (!candidates.length) return;
    await this.#options.harness.commit(async tx => {
     const state = await openBoard(tx, this.#mainId);
     for (const { taskId, sourceId } of candidates) {
      const tracking = state.taskActivity?.[taskId];
      const source = tracking?.sources[sourceId];
      if (tracking && source?.state === "running" && state.tasks.some(task => task.id === taskId && task.status === "in_progress")) evaluateWatcherRun(state, taskId, tracking, source, run, at);
     }
    }, BACKGROUND_CONTEXT);
   } : undefined);
  this.#liveWatch = liveWatch;
  const unwatchSaves = liveWatch && this.#options.taskArtifactSaves?.watch(() => liveWatch.savesChanged());
		publish(boardState);
		watch.start(async (call) => {
			if (call.kind === "failed") throw call.error;
			boardState = call.value;
			publish(boardState);
		});
		return async () => {
			unlisten?.();
   unwatchSaves?.();
   this.#liveWatch = undefined;
   await liveWatch?.stop();
   if (expiry) clearTimeout(expiry);
   await Promise.all(stops.map(stop => stop()));
   await watch.stop().catch(() => undefined);
		};
	}

	// --- the user's edits, as one input ---------------------------------------------------------------------------

	#recordEdit(before: BoardTask | null, after: BoardTask, note?: string): void {
		const existing = this.#pending.get(after.id);
		const said = note?.trim() ?? "";
		const notes = [...(existing?.notes ?? []), ...(said.length === 0 ? [] : [said])];
		this.#pending.set(after.id, { before: existing === undefined ? before : existing.before, after, notes });
		this.#armEditTimer();
	}

	#armEditTimer(): void {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = setTimeout(() => {
			this.#timer = undefined;
			void this.flushEdits();
		}, this.#options.editDebounceMs ?? BOARD_EDIT_DEBOUNCE_MS);
		this.#timer.unref?.();
	}

	/** Send the user's edits so far to the coordinator as one `[board]` follow-up. */
	flushEdits(): Promise<void> {
		if (this.#timer !== undefined) clearTimeout(this.#timer);
		this.#timer = undefined;
		const edits = [...this.#pending.values()];
		const order = this.#pendingOrder;
		this.#pending = new Map();
		this.#pendingOrder = undefined;
		const lines = edits.map((edit) => describeEdit(edit)).filter((line) => line !== undefined);
		if (order !== undefined) lines.push(`order: ${order.ids.join(", ")} first`);
		if (lines.length === 0) return this.#flushing;
		const key = createHash("sha256")
			.update(edits.map((edit) => `${edit.after.id}@${edit.after.revision}`).join(",") + (order === undefined ? "" : `|${order.ids.join(",")}@${order.at}`))
			.digest("hex")
			.slice(0, 16);
		const content = `${BOARD_PREFIX} The user changed the board:\n${lines.map((line) => `- ${line}`).join("\n")}`;
		this.#flushing = this.#flushing.then(async () => {
			try {
				await this.coordinator.submit(
					{ type: "input", content, whenBusy: "followUp", requestId: `board-edit:${key}` },
					BACKGROUND_CONTEXT,
				);
			} catch (error) {
				this.#options.log(`board: could not deliver the user's edits: ${errorMessage(error)}`);
			}
		});
		return this.#flushing;
	}

	/** Rebuild the timer from durable task dates, also run when a project opens after a restart. */
	#armWaiting(state: Readonly<BoardState>): void {
		if (this.#waitingTimer !== undefined) clearTimeout(this.#waitingTimer);
		if (this.#stopped) return;
		const due = state.tasks.flatMap((task) => task.status === "waiting" && task.waiting?.until !== undefined ? [Date.parse(task.waiting.until)] : []);
		if (due.length === 0 && (state.waitingReturns?.length ?? 0) === 0) return;
		const delay = (state.waitingReturns?.length ?? 0) > 0 ? 1000 : Math.max(0, Math.min(60_000, Math.min(...due) - this.#options.now()));
		this.#waitingTimer = setTimeout(() => {
			this.#waitingTimer = undefined;
			void this.checkWaiting().catch((error) => this.#options.log(`board: waiting return failed: ${errorMessage(error)}`));
		}, delay);
		this.#waitingTimer.unref?.();
	}

	/** Exposed for an injected clock; delivery is replayable after a crash between commit and submit. */
	checkWaiting(): Promise<void> {
		if (this.#waitingRun !== undefined) return this.#waitingRun;
		this.#waitingRun = this.#returnWaiting().finally(async () => {
			this.#waitingRun = undefined;
			this.#armWaiting(await this.state());
		});
		return this.#waitingRun;
	}

 /** Exposed for fake clocks. Admission and delivery use a durable outbox and stable request IDs. */
 checkPaused(): Promise<void> {
  if (this.#stopped) return Promise.resolve();
  if (this.#pauseRun) return this.#pauseRun;
  this.#pauseRun = this.#nudgePaused().finally(() => { this.#pauseRun = undefined; });
  return this.#pauseRun;
 }

 async #nudgePaused(): Promise<void> {
  const state = await this.state();
  if (!state.taskStateEnabled) return;
  const paused = boardView(state, this.#options.now(), true).tasks.filter(t => t.state?.kind === "paused");
  if (paused.some(t => state.taskActivity?.[t.id]?.pauseNudgedEpisode !== pauseEpisode(t, state.taskActivity?.[t.id])) && !state.pausedNotices?.length) {
   await this.#commit(HARNESS_WRITER, doc => {
    for (const task of boardView(doc, this.#options.now(), true).tasks.filter(t => t.state?.kind === "paused")) {
     const tracking = activityTracking(doc, task.id);
     const episode = pauseEpisode(task, tracking);
     if (tracking.pauseNudgedEpisode === episode || doc.pausedNotices?.some(n => n.taskId === task.id && n.episode === episode)) continue;
     doc.pausedNotices ??= [];
     doc.pausedNotices.push({ taskId: task.id, episode, owner: task.ownerThreadId ?? "main" });
    }
   });
  }
  for (const notice of (await this.state()).pausedNotices ?? []) {
   const latest = await this.state();
   const task = latest.tasks.find(t => t.id === notice.taskId);
   const valid = task && pauseEpisode(task, latest.taskActivity?.[task.id]) === notice.episode && boardView(latest, this.#options.now(), true).tasks.find(t => t.id === task.id)?.state?.kind === "paused";
   if (valid) {
    const target = this.knowsThread(notice.owner) ? notice.owner : "main";
    const conversation = await this.#conversationOf(target);
    await conversation.submit({ type: "input", content: `${BOARD_PREFIX} ${notice.taskId} is in progress but nothing has run on it for 15 minutes. Move it to review if it is finished, back to To do if it is not being worked on, or ask the user.`, whenBusy: "followUp", requestId: `board-paused:${notice.taskId}:${createHash("sha256").update(notice.episode).digest("hex")}` }, BACKGROUND_CONTEXT);
    await this.#woke(target);
   }
   await this.#commit(HARNESS_WRITER, doc => {
    if (valid) activityTracking(doc, notice.taskId).pauseNudgedEpisode = notice.episode;
    doc.pausedNotices = (doc.pausedNotices ?? []).filter(n => n.taskId !== notice.taskId || n.episode !== notice.episode);
   });
  }
 }

	async #returnWaiting(): Promise<void> {
		const state = await this.state();
		const now = this.#options.now();
		if (state.tasks.some((task) => task.status === "waiting" && task.waiting?.until !== undefined && Date.parse(task.waiting.until) <= now)) {
			await this.#commit(HARNESS_WRITER, (doc) => {
				for (const task of doc.tasks) {
					if (task.status !== "waiting" || task.waiting?.until === undefined || Date.parse(task.waiting.until) > now) continue;
					const note = task.waiting.note;
					touchByHarness(doc, task, "review", new Date(now).toISOString());
					doc.waitingReturns ??= [];
					doc.waitingReturns.push({ task: plain(task), note });
				}
			});
		}
		for (const returned of (await this.state()).waitingReturns ?? []) {
			const { task, note } = returned;
			const project = this.#options.project();
			await this.#options.notifications?.deliver({
				...taskReviewNotification({ projectId: project.id, projectName: project.name, taskId: task.id, title: task.title, revision: task.revision, ...(task.ownerThreadId == null ? {} : { threadId: task.ownerThreadId }) }),
				body: `${task.id} is back for review: waiting for ${note}`,
			});
			const target = task.ownerThreadId ?? "main";
			const conversation = await this.#conversationOf(target);
			await conversation.submit({ type: "input", content: `${BOARD_PREFIX} ${task.id} is back for review: waiting for ${note}. Its check-again date has passed; check the external dependency with the user.`, whenBusy: "followUp", requestId: `board-waiting:${task.id}@${task.revision}` }, BACKGROUND_CONTEXT);
			await this.#woke(target);
			await this.#commit(HARNESS_WRITER, (doc) => {
				doc.waitingReturns = (doc.waitingReturns ?? []).filter((entry) => entry.task.id !== task.id || entry.task.revision !== task.revision);
			});
		}
	}


 /** Future commit/deploy adapters use this entry point only after attribution is verified. */
 async noteTaskFact(taskId: string, fact: TaskFact): Promise<void> {
  await this.requireTask(taskId);
  await this.#commit(HARNESS_WRITER, (state) => noteTaskFact(state, taskId, fact));
 }

 async markReportStale(taskId: string, sections?: readonly ReportSection[], reason?: string): Promise<BoardTask> {
  await this.requireTask(taskId);
  return this.#commit(USER_WRITER, (state) => {
   markReportStale(state, taskId, sections, reason, this.#iso(), "user");
   return plain(boardView(state, this.#options.now(), true).tasks.find(task => task.id === taskId)!);
  });
 }

 /** Preserve outgoing thread messages too, including tools called through code mode. Consume at the sender's turn end. */
 async recordReportChat(threadId: string, text: string, key: string): Promise<void> {
  if (this.#options.taskFreshness === false) return;
  await this.#commit(HARNESS_WRITER, (state) => {
   if (substantiveTaskMentions(text, new Set(state.tasks.map((task) => task.id))).length === 0) return;
   state.reportChatCandidates ??= {};
   const candidates = state.reportChatCandidates[threadId] ?? [];
   if (candidates.some((candidate) => candidate.key === key)) return;
   state.reportChatCandidates[threadId] = [...candidates, { text: text.slice(0, 4000), key }].slice(-20);
  });
 }

 /** Meter successful board writes in the write's own transaction, also for nested tool calls. */
 async recordChatDetailWrite(tx: Tx, conversationId: ConversationId, taskId: string, texts: readonly (string | null | undefined)[], ids?: { feedbackId?: string; questionId?: string }): Promise<void> {
  if (this.#options.taskFreshness === false) return;
  const chars = texts.reduce((sum, text) => sum + (text?.trim().replace(/\s+/g, " ").length ?? 0), 0);
  if (!chars && !ids?.feedbackId && !ids?.questionId) return;
  const first = (await tx.doc(LiveDoc, conversationId)).run?.first;
  if (first === undefined) return;
  const state = await openBoard(tx, this.#mainId);
  state.chatDetailWrites ??= {};
  const runs = state.chatDetailWrites;
  if (runs[conversationId]?.first !== first) runs[conversationId] = { first, tasks: {} };
  const writes = runs[conversationId]!.tasks;
  writes[taskId] ??= { chars: 0 };
  const write = writes[taskId]!;
  write.chars += chars;
  if (ids?.feedbackId && !write.feedbackIds?.includes(ids.feedbackId)) write.feedbackIds = [...(write.feedbackIds ?? []), ids.feedbackId];
  if (ids?.questionId && !write.questionIds?.includes(ids.questionId)) write.questionIds = [...(write.questionIds ?? []), ids.questionId];
 }

 async #checkChatDetail(tx: Tx, state: BoardState, run: ChatDetailRun, writes: Record<string, ChatDetailWrite>, key: string, threadId: string): Promise<boolean> {
  const candidate = detectMissingChatDetail(run.reply, []);
  let flagged = false;
  if (candidate) {
   const valid = new Set(state.tasks.map(task => task.id));
   const scoped = run.ownerInputs!.map(text => splitTaskReference(text.trimStart())).filter(scope => scope.taskId && valid.has(scope.taskId));
   const ids = new Set(scoped.length ? scoped.map(scope => scope.taskId!) :
    [...run.ownerInputs!, run.reply].flatMap(text => chatDetailTaskMentions(text, valid)));
   const ownTask = threadId === "main" ? undefined : state.taskFocus?.[threadId];
   if (!ids.size && ownTask && valid.has(ownTask)) ids.add(ownTask);
   const tasks = state.tasks.filter(task => ids.has(task.id));
   const fields: string[] = [];
   for (const task of tasks) {
    fields.push(task.description, task.goal ?? "", task.report.steps ?? "", task.report.summary ?? "", task.report.results, task.report.notDone ?? "", task.report.next);
    for (const decision of state.decisions) if (decision.taskId === task.id) fields.push(decision.text, decision.why ?? "");
    if (writes[task.id]?.feedbackIds?.length) {
     const history = await openTaskHistory(tx, this.#mainId, task.id);
     for (const feedback of history.feedback ?? []) if (feedback.note && writes[task.id]!.feedbackIds!.includes(feedback.id)) fields.push(feedback.note);
    }
   }
   const unscopedQuestions = writes.unscoped?.questionIds ?? [];
   for (const question of state.questions) if (question.status !== "withdrawn" && (question.taskId === null ? unscopedQuestions.includes(question.id) : ids.has(question.taskId))) {
    fields.push(question.text, ...question.options, ...(question.choices ?? []).map(choice => choice.effect ?? ""), question.answer ?? "", ...(question.exchanges ?? []).map(exchange => exchange.text));
   }
   const writtenChars = tasks.reduce((sum, task) => sum + (writes[task.id]?.chars ?? 0), writes.unscoped?.chars ?? 0);
   const missing = detectMissingChatDetail(run.reply, fields, writtenChars);
   flagged = missing !== undefined;
   if (missing && this.#options.project().chatDetailNudges !== false && !this.#options.project().archived) {
    const label = missingChatDetailLabel(missing);
    const active = tasks.filter(task => task.status !== "done" && task.status !== "dropped");
    for (const task of active) noteTaskFact(state, task.id, {
     actor: "harness", kind: "chat", nudge: false, reason: `only in chat: ${label}`,
     sections: missing.prose && !missing.steps && !missing.code && !missing.command ? ["results"] : ["next"], at: this.#iso(),
    });
    if (!tasks.length || active.length) {
     const subject = active.map(task => task.id).join(", ");
     const feedbackIds = scoped.filter(scope => active.some(task => task.id === scope.taskId)).map(scope => scope.feedbackId).filter(Boolean);
     const where = "Put manual steps and commands in Your steps; findings in Results; answers to task feedback in its feedback note";
     state.reportOutbox ??= [];
     state.reportOutbox.push({
      key: `reports:detail:${key}`, owner: threadId, admissions: [], chatDetail: true,
      content: `[reports] ${subject ? `${subject}${feedbackIds.length ? ` (${feedbackIds.join(", ")})` : ""}: only in chat: ${label}.` : `Only in chat: ${label}. File this on a task.`} ${where}. Use the detail from the reply ending at entry ${run.last}; do not just repeat it in chat.`,
     });
    }
   }
  }
  state.chatDetailCounts ??= {};
  countChatDetailTurn(state.chatDetailCounts, this.#options.now(), flagged);
  return candidate !== undefined;
 }

 /** Called once at run end; no chat text or report rewrite is added to the timeline. */
 async noteChat(content: string, written: ReadonlySet<string>, key: string, threadId = "main", userTasks: ReadonlyMap<string, number> = new Map(), run?: ChatDetailRun): Promise<void> {
  if (this.#options.taskFreshness === false) return;
  const counts = await this.#options.harness.commit(async tx => {
   const state = await openBoard(tx, this.#mainId);
   if (!claimHarnessKey(state, key)) return;
   const sources = [{ text: content, key }, ...(state.reportChatCandidates?.[threadId] ?? [])];
   if (state.reportChatCandidates !== undefined) delete state.reportChatCandidates[threadId];
   if (run) {
    const recorded = state.chatDetailWrites?.[run.conversationId];
    const writes = recorded?.first === run.first ? recorded.tasks : {};
    if (recorded && recorded.first <= run.first) delete state.chatDetailWrites![run.conversationId];
    if (run.ownerInputs === undefined) return;
    if (await this.#checkChatDetail(tx, state, run, writes, key, threadId)) return plain(state.chatDetailCounts);
   }
   const valid = new Set(state.tasks.map((task) => task.id));
   const mentioned = new Set<string>();
   for (const source of sources) for (const id of substantiveTaskMentions(source.text, valid)) {
    const userAt = userTasks.get(id);
    const task = state.tasks.find(task => task.id === id)!;
    if (userAt === undefined || written.has(id) || mentioned.has(id) || task.status === "done" || task.status === "dropped") continue;
    // A queued user message can have been answered by a report write in the preceding turn.
    const sections = REPORT_SECTIONS.filter(name => {
     const writtenAt = task.report.freshness?.[name].writtenAt;
     return writtenAt == null || Date.parse(writtenAt) <= userAt;
    });
    if (sections.length === 0) continue;
    mentioned.add(id);
    noteTaskFact(state, id, { actor: "harness", kind: "chat", reason: "discussed in chat", sections, at: this.#iso() });
    const tracking = state.reportTracking?.[id];
    if (tracking !== undefined) tracking.chatEvidence = [...(tracking.chatEvidence ?? []), { snippet: source.text.replace(/\s+/g, " ").slice(0, 240), source: source.key }].slice(-2);
   }
   return run?.ownerInputs && plain(state.chatDetailCounts);
  }, BACKGROUND_CONTEXT);
  if (counts) this.#options.log(`project ${this.#options.project().id}: chat detail counts (UTC): ${JSON.stringify(counts)}`);
 }

 #armReports(state: Readonly<BoardState>): void {
  if (this.#reportTimer !== undefined) clearTimeout(this.#reportTimer);
  if (this.#stopped || state.taskFreshnessEnabled === false) return;
  const timings = this.#options.reportTimings;
  const due = Object.entries(state.reportTracking ?? {}).flatMap(([id, tracking]) => {
   const task = state.tasks.find((candidate) => candidate.id === id);
   const owner = this.#reportOwners.get(id) ?? task?.ownerThreadId ?? "main";
   return tracking.pending === undefined || state.reportInFlight?.[owner] !== undefined ? [] : [reportDueAt(tracking.pending, timings?.trailingMs, timings?.maxBurstMs)];
  });
  due.push((state.lastReportSweep ?? this.#options.now()) + (timings?.sweepMs ?? REPORT_SWEEP_MS));
  const delay = state.reportOutbox?.some(batch => state.reportInFlight?.[batch.owner] === undefined) ? 10 : Math.max(10, Math.min(...due) - this.#options.now());
  this.#reportTimer = setTimeout(() => {
   this.#reportTimer = undefined;
   void this.checkReports().catch((error) => this.#options.log(`board: report nudge failed: ${errorMessage(error)}`));
  }, delay);
  this.#reportTimer.unref?.();
 }

 /** Injectable clock/timings; the outbox is frozen before submit, acknowledged afterwards. */
 checkReports(): Promise<void> {
  if (this.#reportRun !== undefined) return this.#reportRun;
  this.#reportRun = this.#deliverReports().finally(async () => {
   this.#reportRun = undefined;
   this.#armReports(await this.state());
  });
  return this.#reportRun;
 }

 async #deliverReports(): Promise<void> {
  if (this.#options.taskFreshness === false) return;
  const timings = this.#options.reportTimings;
  const state = await this.state();
  const live = new Set<string>(["main"]);
  for (const owner of new Set(state.tasks.map((task) => task.ownerThreadId ?? "main"))) {
   if (this.knowsThread(owner) && (this.#options.threadIsLive === undefined || await this.#options.threadIsLive(owner))) live.add(owner);
  }
  for (const task of state.tasks) this.#reportOwners.set(task.id, live.has(task.ownerThreadId ?? "main") ? task.ownerThreadId ?? "main" : "main");
  await this.#commit(HARNESS_WRITER, (state) => {
   if ((this.#options.project().chatDetailNudges === false || this.#options.project().archived) && state.reportOutbox) state.reportOutbox = state.reportOutbox.filter(batch => !batch.chatDetail);
   sweepReportAge(state, this.#options.now(), timings?.ageMs, timings?.sweepMs);
   prepareReportNudges(state, this.#options.now(), (task) => {
    const owner = task.ownerThreadId ?? "main";
    return live.has(owner) ? owner : "main";
   }, timings);
  });
  void this.audit?.check("hourly").catch(error => this.#options.log(`report audit failed: ${errorMessage(error)}`));
  const admitted = await this.state();
  const busyOwners = new Set(Object.keys(admitted.reportInFlight ?? {}));
  for (const batch of admitted.reportOutbox ?? []) {
   if (busyOwners.has(batch.owner)) continue;
   busyOwners.add(batch.owner);
   const conversation = await this.#conversationOf(batch.owner);
   const submission = await conversation.submit({ type: "input", content: batch.content, whenBusy: "followUp", requestId: batch.key }, BACKGROUND_CONTEXT);
   await this.#woke(batch.owner);
   await this.#commit(HARNESS_WRITER, (state) => acknowledgeReportNudge(state, batch.key, submission.id));
  }
  for (const [owner, id] of Object.entries((await this.state()).reportInFlight ?? {})) this.#waitForReport(owner, id);
 }

 #waitForReport(owner: string, id: number): void {
  if (this.#reportWaiters.has(id) || this.#stopped) return;
  this.#reportWaiters.add(id);
  void (async () => {
   const submission = await this.#options.harness.submission(id as Parameters<Harness["submission"]>[0], BACKGROUND_CONTEXT);
   await submission?.wait(BACKGROUND_CONTEXT);
   if (this.#stopped) return;
   await this.#commit(HARNESS_WRITER, (state) => {
    if (state.reportInFlight?.[owner] === id) delete state.reportInFlight[owner];
    for (const tracking of Object.values(state.reportTracking ?? {})) {
     if (tracking.inFlight?.owner === owner && tracking.inFlight.submissionId === id) delete tracking.inFlight;
    }
   });
   await this.#reportRun;
   if (!this.#stopped) await this.checkReports();
  })().catch((error) => { if (!this.#stopped) this.#options.log(`board: report receipt failed: ${errorMessage(error)}`); }).finally(() => this.#reportWaiters.delete(id));
 }

	/** Deliver edits still waiting, then stop the timer; called before the project closes. */
	async stop(): Promise<void> {
		this.#stopped = true;
		if (this.#waitingTimer !== undefined) clearTimeout(this.#waitingTimer);
		if (this.#reportTimer !== undefined) clearTimeout(this.#reportTimer);
		await this.audit?.stop();
  await this.#watcher?.stop();
  await this.#persistWatcherStatus;
		await this.#reportRun;
		await this.#waitingRun;
  await this.#pauseRun;
		await this.flushEdits();
	}
}

// --- the coordinator's tool --------------------------------------------------------------------------------------

function toolText(text: string, options: { isError?: boolean; details?: JsonObject } = {}): {
	output: { type: "text"; text: string }[];
	isError?: boolean;
	details?: JsonObject;
} {
	return {
		output: [{ type: "text", text }],
		...(options.isError === true ? { isError: true } : {}),
		...(options.details === undefined ? {} : { details: options.details }),
	};
}

const BoardToolParameters = Type.Object({
	action: Type.Union(
		[
			Type.Literal("list"),
			Type.Literal("add_task"),
			Type.Literal("update_task"),
			Type.Literal("drop_task"),
			Type.Literal("ask"),
			Type.Literal("resolve_question"),
   Type.Literal("reply_question"),
   Type.Literal("reopen_question"),
			Type.Literal("decide"),
			Type.Literal("write_report"),
			Type.Literal("show_task"),
			Type.Literal("claim"),
			Type.Literal("release"),
			Type.Literal("handoff"),
			Type.Literal("link"),
			Type.Literal("unlink"),
			Type.Literal("feedback"),
		],
		{
			description:
				"list: the board. add_task: needs title. update_task: needs id and expectedRevision, changes only the fields you pass. drop_task: refused; only the user drops a task. write_report: needs id and at least one of summary, results, notDone, next, steps or checks; Now is automatic; replaces the sections you pass and nothing else, never conflicts; milestone saves a snapshot. show_task: needs id; the task in full with its report, questions, warnings, decisions, workers and snapshots. ask: needs text; the user sees it as a waiting question, or as a warning with kind \"warning\". reply_question: needs id, expectedRevision and text; replies under an open clarification, optional revisedText/revisedOptions keep earlier wording. reopen_question: same fields; reopen an answered question once when its answer was really a question. Neither applies to MCP approvals. resolve_question: needs id; with answer it records the answer you got in the chat, without it withdraws the question. decide: needs text. claim: needs id and expectedRevision; makes the task yours, refused when another thread holds it. release: needs id and expectedRevision; gives up a task you hold. handoff: needs id, expectedRevision and toThread; passes a task you hold to another thread (\"main\" for main), which is told. link: needs id, link and to; adds one link from task id to task to (no revision needed). unlink: needs id, link, and to (optional for parent and foundWhile); removes it. feedback: needs id (the task), feedbackId and state; sets what became of a user's feedback entry (see state, note).",
		},
	),
	waitingFor: Type.Optional(Type.String({ maxLength: 2000, description: "Required when setting waiting: the external review, release or reply the user named." })),
	waitUntil: Type.Optional(Type.String({ description: "Optional ISO check-again date or timestamp; returns to review automatically." })),
	id: Type.Optional(Type.String({ minLength: 1, description: "A task ID (T3) for update_task, write_report and show_task, a question ID (Q2) for resolve_question." })),
	expectedRevision: Type.Optional(
		Type.Integer({ minimum: 1, description: "The row's revision from the last list (the rN). A stale one is refused: list again." }),
	),
	includeArchived: Type.Optional(Type.Boolean({ description: "list: also show done and dropped tasks archived after 7 days." })),
	title: Type.Optional(
		Type.String({
			minLength: 1,
			description: 'A short, plain outcome the user reads at a glance, e.g. "Complete the example change". Tickets and pull requests go in refs, not here.',
		}),
	),
	description: Type.Optional(Type.String({ description: "add_task, update_task: start with what will be different for the user. Write one whole sentence per fact, about 20 words per line, with no semicolons. Use names, not IDs or file paths." })),
	goal: BoardTaskGoalSchema,
	acceptance: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Done when…: one checkable outcome per line, in whole sentences, without repeating the description. Null clears it." })),
	refs: Type.Optional(
		Type.Array(Type.String(), {
			description:
				'add_task, update_task: what the task is about elsewhere, as full links, e.g. ["https://acme.atlassian.net/browse/EX-1234", "https://github.com/acme/app/pull/1234"]. When you only know a ticket key or PR number, look up its link (gh, acli) first. update_task replaces the whole list.',
		}),
	),
	status: Type.Optional(
		Type.Union(
			["todo", "in_progress", "blocked", "review", "waiting", "done", "dropped"].map((status) => Type.Literal(status)),
			{
				description:
					"Default todo. blocked: waiting or stopped (say why in blockedReason). review: ready for the user to check; put manual checks in steps. done and dropped are the user's alone: you cannot set them.",
			},
		),
	),
	blockedBy: Type.Optional(Type.Array(Type.String(), { description: "Task IDs this one waits for; they must exist and not form a cycle." })),
	blockedReason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	writeScopes: Type.Optional(Type.Array(Type.String(), { description: "Paths the task will change; advisory." })),
	revisedText: Type.Optional(Type.String({ minLength: 1, description: "reply_question/reopen_question: optional new question wording." })),
 revisedOptions: Type.Optional(Type.Array(Type.String(), { description: "reply_question/reopen_question: optional replacement options, including an empty list." })),
 text: Type.Optional(Type.String({ minLength: 1, description: "The reply (reply_question/reopen_question), question or warning (ask) or decision (decide). For a question, ask it in the first sentence so a choice can answer it. Then give at most three short lines needed to choose, including why you recommend a choice. Do not retell the task or list choices here." })),
	blocksWork: Type.Optional(Type.Boolean({ description: "ask: questions default blocking, warnings nonblocking." })),
 activitySourceId: Type.Optional(Type.String({ description: "ask warning: optional failed activity actor ID; acknowledging clears only that source." })),
 kind: Type.Optional(
		Type.Union([Type.Literal("question"), Type.Literal("warning")], {
			description: 'ask: "question" (default) waits for the user\'s answer. "warning" is something they must not miss; it stays open until they acknowledge it, and has no options.',
		}),
	),
	options: Type.Optional(Type.Array(Type.String(), { description: "ask: plain answer labels for compatibility; prefer choices." })),
	choices: Type.Optional(Type.Array(BoardQuestionChoiceSchema, { description: "ask: give each choice a short label and an effect. Mark at most one recommended and say why in the question context. Replaces options when supplied." })),
	coveredEventSeq: Type.Optional(Type.Integer({ minimum: 0, description: "write_report: optional eventSeq from when you read the task, so anything that happened since stays marked. If omitted, a changed section covers events up to this write." })),
	waitsOn: Type.Optional(Type.Array(Type.String(), { description: "write_report Next: explicit IDs of Q/task/change/deploy dependencies. Omitted means any task answer can invalidate Next." })),
	now: Type.Optional(Type.String({ description: "Compatibility only: optional short phase for this task-focused turn; Now is automatic. Prefer results and next." })),
	summary: Type.Optional(Type.String({ description: "write_report: start with what came out in one or two whole sentences. Shown above Results; empty clears it." })),
	results: Type.Optional(Type.String({ description: "write_report: what changed, rewritten whole. Use one plain, whole sentence per fact. Put check outcomes in checks, not prose. Link commits with a Kemiri-Task trailer and save files with taskId instead of repeating the record." })),
	notDone: Type.Optional(Type.String({ description: "write_report: Markdown, one item per line about what is missing or left out. Empty clears it." })),
	checks: Type.Optional(Type.Array(ReportCheckInputSchema, { description: "write_report: checks that ran, with name, result and count if known. Replaces the whole list; [] clears it." })),
	next: Type.Optional(Type.String({ description: "write_report: agents' next actions in one or two whole sentences. Use names, not IDs. Rewrite the whole section; keep manual actions in steps instead." })),
	steps: Type.Optional(Type.String({ description: "write_report Your steps: a full numbered Markdown list for actions the user must do by hand. Start each step with a verb. Give exact values and copyable commands. Rewrite the whole list; Next rewrites leave it alone. Clear with an empty string when done." })),
	milestone: Type.Optional(
		Type.String({ minLength: 1, description: 'write_report: a few words naming something meaningful that just happened, e.g. "First version merged". Saves a snapshot of the task.' }),
	),
	taskId: Type.Optional(Type.String({ minLength: 1, description: "ask, decide: the task it concerns." })),
	why: Type.Optional(Type.String({ description: "decide: the reason." })),
	answer: Type.Optional(Type.String({ minLength: 1, description: "resolve_question: the answer." })),
	toThread: Type.Optional(Type.String({ minLength: 1, description: 'handoff: the thread that takes the task over ("main" for main).' })),
	parent: Type.Optional(
		Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
			description:
				"add_task, update_task: the task this is a subtask of, for a planned piece of a bigger task. A required part: the parent goes to review/waiting only when its parts are done, in review or waiting. Follow-ups use foundWhile instead. At most one; no cycles. update_task: null removes it.",
		}),
	),
	foundWhile: Type.Optional(
		Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
			description:
				"add_task, update_task: the task whose work led you to find this one (a bug, more to build, an analysis). Always set it for a task found while working on another. At most one. update_task: null removes it.",
		}),
	),
	related: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description: "add_task, update_task: tasks to see also (symmetric: each shows the other). update_task replaces the whole list; use link and unlink to add or remove one.",
		}),
	),
	link: Type.Optional(
		Type.Union([Type.Literal("parent"), Type.Literal("foundWhile"), Type.Literal("related"), Type.Literal("blockedBy")], {
			description: "link, unlink: the kind. parent: id is a subtask of to. foundWhile: id was found while working on to. related: see also, both ways. blockedBy: id waits for to.",
		}),
	),
	to: Type.Optional(Type.String({ minLength: 1, description: "link, unlink: the other task." })),
	feedbackId: Type.Optional(Type.String({ minLength: 1, description: 'feedback: the entry, e.g. "F3" (the message said "[task T12, feedback F3]").' })),
	state: Type.Optional(
		Type.Union([Type.Literal("open"), Type.Literal("handling"), Type.Literal("addressed")], {
			description: "feedback: handling when you act on it; addressed when done, with a note that says what addressed it. open puts it back. Only the user dismisses an entry.",
		}),
	),
	note: Type.Optional(Type.String({ description: "feedback: what is being done, or for addressed the full answer or what changed. Write it here, not in chat. Use whole sentences, one fact per line; keep every step and answer complete and leave revision IDs to the record." })),
});

type BoardToolArguments = Static<typeof BoardToolParameters>;

const CHAT_POINTER_WARNING = "\nThis points at the chat. The user reads the task: write the answer or detail here.";

function onlyUserCloses(status: "done" | "dropped"): string {
	return `Only the user closes a task: you cannot set it ${status}. Move it to review (status review) instead, and write in its report's next what the user should check. The user marks it ${status} when they agree.`;
}

function createBoardExtension(service: BoardService): Extension {
	const boardTool = defineTool({
		name: "board",
		description:
			"Your working board for this project: tasks (with dependencies and the workers that ran them), questions waiting on the user, and decisions. " +
			"It is durable and always current; read it with action `list` instead of remembering it. Keep it in step with the work: add tasks as you plan, " +
			'each titled with a short, plain outcome the user reads at a glance ("Complete the example change"), with its tickets and pull requests in its refs as full links, not in the title; ' +
			"move a task to `review` when it is ready for the user (only the user sets `done` or `dropped`), keep Results and Next current with `write_report` (Now is automatic), " +
			"ask the user with `ask` when you need their call (they get a notification and answer in the app), warn them of what they must not miss with `ask` kind `warning`, and " +
			"record choices worth keeping with `decide`. The user edits it too; their edits arrive as `[board]` messages. " +
			"Every update names the row's revision from your last list, so you never overwrite a newer edit. The board is shared by every thread of the project: " +
			"claim a task before you work on it, so no other thread takes it too, and release or hand it over when you stop. " +
			"Tasks link to each other, each link shown from both sides: a required part (`parent`), the task a new one was found while working on (`foundWhile`), `related`, and `blockedBy`. " +
			"A planned piece of a bigger task gets parent only. foundWhile is for unplanned tasks discovered while working on another task, never a duplicate of parent. " +
			"Messages about a task are feedback entries on it (F3): mark each `handling` when you act on it and `addressed`, with a note of what addressed it, when done. " +
			"Write task text in whole sentences with their small words; short is good, shorthand is not. Limit each line, not the number of lines. Style warnings are advisory: the text is saved.",
		parameters: BoardToolParameters,
		replay: "unsafe",
		execute: async (args, api, context) => {
			if (!service.isCoordinator(api.conversationId)) {
				return toolText("board answers only the project's coordinator conversation, never a worker.", { isError: true });
			}
			const input = args as BoardToolArguments;
			const threadId = service.threadIdOf(api.conversationId);
			const writer = coordinatorWriter(threadId);
			// Names this call in snapshot keys; call IDs are only unique within a conversation.
			const callKey = `call:${api.conversationId}:${api.callId}`;
			// Meter the real commit, not the transcript result, so direct and nested tools use the same path.
			const countEntityWrite = <R,>(getTaskId: (result: R) => string | null, texts: readonly (string | null | undefined)[], getIds?: (result: R) => { feedbackId?: string; questionId?: string }) =>
				async (change: (tx: Tx) => Promise<R>): Promise<R> => api.commit(async tx => {
					const result = await change(tx);
					const taskId = getTaskId(result);
					const ids = getIds?.(result);
					if (taskId || ids?.questionId) await service.recordChatDetailWrite(tx, api.conversationId, taskId ?? "unscoped", texts, ids);
					return result;
				}, context);
			const countTaskWrite = (taskId: string, texts: readonly (string | null | undefined)[], ids?: { feedbackId: string }) =>
				<R,>(change: (tx: Tx) => Promise<R>) => countEntityWrite<R>(() => taskId, texts, () => ids ?? {})(change);
			try {
				switch (input.action) {
					case "list": {
						return toolText(describeBoard(await service.get(input.includeArchived === true)));
					}
					case "add_task": {
						if (input.status === "done" || input.status === "dropped") return toolText(onlyUserCloses(input.status), { isError: true });
						const change = await service.commitFor(
							countEntityWrite((result: TaskChange) => result.after.id, [input.description, input.goal]),
							(state, now) =>
								saveTask(state, {
									task: {
										title: need(input.title, input.action, "title"),
										description: input.description ?? "",
										...(input.goal === undefined ? {} : { goal: input.goal }),
										acceptance: input.acceptance ?? null,
										refs: input.refs ?? [],
										...(input.waitingFor === undefined ? {} : { waitingFor: input.waitingFor }),
										...(input.waitUntil === undefined ? {} : { waitUntil: input.waitUntil }),
										status: input.status ?? "todo",
										blockedBy: input.blockedBy ?? [],
										blockedReason: input.blockedReason ?? null,
										writeScopes: input.writeScopes ?? [],
										...(input.parent === undefined ? {} : { parent: input.parent }),
										...(input.foundWhile === undefined ? {} : { foundWhile: input.foundWhile }),
										...(input.related === undefined ? {} : { related: input.related }),
									},
									author: "coordinator",
									now,
								}),
							writer,
							callKey,
						);
						const task = change.after;
						service.noticeReview(change);
						const warnings = taskTextWarnings({ name: "Description", text: input.description }, { name: "Done when", text: input.acceptance });
						return toolText(`Added ${task.id} (r${task.revision}).${duplicateOriginNotice(change, input.foundWhile)}${warnings}`, { details: { taskId: task.id } });
					}
					case "update_task":
					case "drop_task": {
						if (input.action === "drop_task") return toolText(onlyUserCloses("dropped"), { isError: true });
						if (input.status === "done" || input.status === "dropped") return toolText(onlyUserCloses(input.status), { isError: true });
						if (input.status === "waiting" && !input.waitingFor?.trim()) return toolText("Waiting requires a waitingFor note: what external review, release or reply is this waiting for?", { isError: true });
						const id = need(input.id, input.action, "id");
						const expectedRevision = need(input.expectedRevision, input.action, "expectedRevision");
						const { change, unblocked } = await service.commitFor(
							countTaskWrite(id, [input.description, input.goal]),
							(state, now) => {
								const current = state.tasks.find((candidate) => candidate.id === id);
								if (current === undefined) throw unknownTask(id);
								const change = saveTask(state, {
									taskId: id,
									expectedRevision,
									task: {
										title: input.title ?? current.title,
										description: input.description ?? current.description,
										...(input.goal === undefined ? {} : { goal: input.goal }),
										acceptance: input.acceptance === undefined ? current.acceptance : input.acceptance,
										refs: input.refs ?? current.refs ?? [],
										...(input.waitingFor === undefined ? {} : { waitingFor: input.waitingFor }),
										...(input.waitUntil === undefined ? {} : { waitUntil: input.waitUntil }),
										status: input.status ?? current.status,
										blockedBy: input.blockedBy ?? current.blockedBy,
										blockedReason: input.blockedReason === undefined ? current.blockedReason : input.blockedReason,
										writeScopes: input.writeScopes ?? current.writeScopes,
										...(input.parent === undefined ? {} : { parent: input.parent }),
										...(input.foundWhile === undefined ? {} : { foundWhile: input.foundWhile }),
										...(input.related === undefined ? {} : { related: input.related }),
									},
									author: "coordinator",
									now,
								});
								return { change, unblocked: unblockedBy(state, change) };
							},
							writer,
							callKey,
       input.status === undefined ? undefined : id,
						);
						const task = change.after;
						service.noticeReview(change);
						await service.noticeUnblocked(task, unblocked);
						const warnings = taskTextWarnings({ name: "Description", text: input.description }, { name: "Done when", text: input.acceptance });
						return toolText(`Updated ${task.id} (now r${task.revision}, ${task.status}).${duplicateOriginNotice(change, input.foundWhile)}${warnings}`, { details: { taskId: task.id } });
					}
					case "ask": {
						const question = await service.commitFor(
							countEntityWrite((question: BoardQuestion) => question.taskId, [input.text, ...(input.choices?.flatMap(({ label, effect }) => [label, effect]) ?? input.options ?? [])], question => ({ questionId: question.id })),
							(state, now) =>
								askQuestion(state, {
									text: need(input.text, input.action, "text"),
									options: input.options ?? [],
									choices: input.choices,
									taskId: input.taskId ?? null,
									now,
									threadId,
									blocksWork: input.blocksWork,
         activitySourceId: input.activitySourceId,
         ...(input.kind === undefined ? {} : { kind: input.kind }),
								}),
							writer,
							callKey,
       input.taskId,
						);
						service.noticeQuestion(question);
						const warnings = taskTextWarnings(
							{ name: question.kind === "warning" ? "Warning" : "Question", text: question.text, question: question.kind !== "warning" },
							...question.options.map((text, index) => ({ name: `Option ${index + 1}`, text })),
							...(question.choices ?? []).map(({ effect }, index) => ({ name: `Choice ${index + 1} effect`, text: effect })),
						);
						if (question.kind === "warning") {
							return toolText(`Warned the user (${question.id}). It stays open until they acknowledge it; that arrives as a [board] message.${warnings}`, {
								details: { questionId: question.id },
							});
						}
						return toolText(`Asked ${question.id}. The user's answer arrives as a [board] message.${warnings}`, {
							details: { questionId: question.id },
						});
					}
                    case "reply_question":
                    case "reopen_question": {
                        const id = need(input.id, input.action, "id");
                        const question = await service.commitFor(countEntityWrite((question: BoardQuestion) => question.taskId, [input.text, input.revisedText, ...(input.revisedOptions ?? [])]), (state, now) => replyQuestion(state, {
                            questionId: id, expectedRevision: need(input.expectedRevision, input.action, "expectedRevision"),
                            text: need(input.text, input.action, "text"), revisedText: input.revisedText, revisedOptions: input.revisedOptions,
                            reopen: input.action === "reopen_question", by: writer, now,
                        }), writer, callKey);
                        service.noticeQuestion(question);
                        return toolText(`Replied on ${question.id} (r${question.revision}); waiting for the owner.`, { details: { questionId: question.id } });
                    }
					case "resolve_question": {
						const id = need(input.id, input.action, "id");
						const question = await service.commitFor(
							countEntityWrite((question: BoardQuestion) => question.taskId, [input.answer]),
							(state, now) =>
								settleQuestion(state, { questionId: id, expectedRevision: input.expectedRevision, answer: input.answer ?? null, now, actor: input.answer == null ? "coordinator" : "user" }),
							writer,
							callKey,
						);
						if (question.answer) await service.onMcpAnswer?.(question.id, question.answer);
						return toolText(`${question.id} is ${question.status}.`, { details: { questionId: question.id } });
					}
					case "decide": {
						const decision = await service.commitFor(
							countEntityWrite((decision: BoardDecision) => decision.taskId, [input.text, input.why]),
							(state, now) =>
								addDecision(state, {
									text: need(input.text, input.action, "text"),
									why: input.why ?? null,
									taskId: input.taskId ?? null,
									now,
									threadId,
								}),
							writer,
							callKey,
       input.taskId,
						);
						return toolText(`Recorded ${decision.id}.`, { details: { decisionId: decision.id } });
					}
					case "write_report": {
						const id = need(input.id, input.action, "id");
						const task = await service.writeReport(
							countTaskWrite(id, [input.summary, input.results, input.notDone, input.next, input.steps]),
							{
								taskId: id,
								sections: { now: input.now, results: input.results, next: input.next, steps: input.steps, summary: input.summary, notDone: input.notDone, checks: input.checks },
								by: writer,
								milestone: input.milestone,
							coveredEventSeq: input.coveredEventSeq,
							waitsOn: input.waitsOn,
							},
							callKey,
						);
						const milestone = input.milestone === undefined ? "" : `; milestone "${input.milestone.trim()}" saved`;
						const chatWarning = [input.summary, input.results, input.notDone, input.next, input.steps].some(pointsAtChat) ? CHAT_POINTER_WARNING : "";
						const styleWarnings = taskTextWarnings(
							{ name: "Summary", text: input.summary },
							{ name: "Results", text: input.results },
							{ name: "Not done", text: input.notDone },
							{ name: "Next", text: input.next },
							{ name: "Your steps", text: input.steps },
						);
						return toolText(`Rewrote the report of ${task.id} (report r${task.report.revision}${milestone}).${chatWarning}${styleWarnings}`, {
							details: { taskId: task.id },
						});
					}
					case "show_task": {
						const id = need(input.id, input.action, "id");
						const board = await service.get(true);
						const task = board.tasks.find((candidate) => candidate.id === id);
						if (task === undefined) throw unknownTask(id);
						const { entries, feedback } = await service.timeline(id);
						return toolText(describeTaskInFull(task, board, await service.history(id), { feedback, timeline: entries }), {
							details: { taskId: task.id },
						});
					}
					case "link":
					case "unlink": {
						const id = need(input.id, input.action, "id");
						const link = need(input.link, input.action, "link");
						const remove = input.action === "unlink";
						const change = await service.commitFor(
							(commit) => api.commit(commit, context),
							(state, now) => changeLink(state, { taskId: id, link, to: input.to, remove, now }),
							writer,
							callKey,
						);
						const words = LINK_WORDS[link].out;
						const target = input.to ?? (link === "parent" || link === "foundWhile" ? change.before?.[link] : undefined) ?? "";
						const ignored = !remove && link === "foundWhile" && target === change.after.parent;
						return toolText(ignored ? `${id}: ignored foundWhile ${target}; kept parent only for that task.` : `${remove ? "Unlinked" : "Linked"}: ${id}${remove ? " was" : ""} ${words} ${target}.${remove ? "" : duplicateOriginNotice(change)}`, {
							details: { taskId: change.after.id },
						});
					}
					case "feedback": {
						const id = need(input.id, input.action, "id");
						const feedbackId = need(input.feedbackId, input.action, "feedbackId");
						const feedbackState = need(input.state, input.action, "state");
						if (!COORDINATOR_FEEDBACK_STATES.includes(feedbackState)) {
							return toolText("Only the user dismisses feedback. Set it to handling, addressed or open.", { isError: true });
						}
						const entry = await service.setFeedbackFor(
							countTaskWrite(id, [input.note], input.note?.trim() ? { feedbackId } : undefined),
							{ taskId: id, feedbackId, state: feedbackState, note: input.note ?? null },
							writer,
						);
						const chatWarning = pointsAtChat(input.note) ? CHAT_POINTER_WARNING : "";
						const styleWarnings = taskTextWarnings({ name: "Feedback note", text: input.note });
						return toolText(`${entry.id} on ${id} is ${entry.state}.${chatWarning}${styleWarnings}`, { details: { taskId: id, feedbackId: entry.id } });
					}
					case "claim":
					case "release":
					case "handoff": {
						const id = need(input.id, input.action, "id");
						const expectedRevision = need(input.expectedRevision, input.action, "expectedRevision");
						let change: OwnershipChange;
						if (input.action === "handoff") {
							const to = need(input.toThread, input.action, "toThread");
							if (!service.knowsThread(to)) {
								return toolText(`No thread "${to}" in this project (unknown_thread). thread_list shows them.`, {
									isError: true,
									details: { code: "unknown_thread", threadId: to },
								});
							}
							change = { kind: "handoff", threadId, to };
						} else {
							change = { kind: input.action, threadId };
						}
						const task = await service.commitFor(
							(commit) => api.commit(commit, context),
							(state, now) => changeOwner(state, { taskId: id, expectedRevision, change, now }).after,
							writer,
							callKey,
						);
						if (input.action === "handoff") await service.noticeHandoff(task, threadId);
						const owner = task.ownerThreadId ?? null;
						return toolText(
							`${task.id} (now r${task.revision}) is ${owner === null ? "unclaimed" : owner === threadId ? "yours" : `thread "${owner}"'s`}.`,
							{ details: { taskId: task.id, ownerThreadId: owner } },
						);
					}
					default:
						return toolText("Unknown action.", { isError: true });
				}
			} catch (error) {
				return toolText(errorMessage(error), { isError: true });
			}
		},
	});

	return defineExtension({ name: "board-tools", tools: [boardTool] as ToolRegistration[], hooks: [hook(GenerationTask, {
  afterRun: async (run, api, context) => {
   if (!service.isCoordinator(api.conversationId)) return undefined;
   const written = new Set<string>();
   const userTasks = new Map<string, number>();
   const clarifications = new Map<string, number>();
   const validIds = new Set((await service.state()).tasks.map(task => task.id));
   let cursor;
   const texts: string[] = [];
   const replies: string[] = [];
   let ownerInputs: string[] | undefined;
   do {
    const page = await api.entries({ minEntryId: run.first, maxEntryId: run.last }, 200, cursor, context);
    for (const entry of page.items) for (const message of entry.model ?? []) {
     if ((entry.kind === "pi.user" || entry.kind === OWNER_CHAT_ENTRY) && message.role === "user") {
      const text = typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      if (entry.kind === OWNER_CHAT_ENTRY && !isReportHarnessInput(text.trimStart())) {
       if (entry.id === run.first) ownerInputs = [];
       ownerInputs?.push(text);
      }
      for (const match of text.matchAll(/\[board\] (?:The user asked back on|Clarification reminder for) (Q[1-9]\d*) \(r(\d+)\)/g)) clarifications.set(match[1]!, Number(match[2]));
      for (const id of reportChatUserTasks(text, validIds)) userTasks.set(id, Math.max(userTasks.get(id) ?? 0, message.timestamp));
     }
     if (message.role === "toolResult" && message.toolName === "board" && !message.isError) {
      for (const block of message.content) if (block.type === "text") {
       const id = /^(?:Rewrote the report of |F[1-9]\d* on )(T[1-9]\d*)\b/.exec(block.text)?.[1];
       if (id !== undefined) written.add(id);
      }
     }
     if (message.role !== "assistant") continue;
     for (const block of message.content) {
      if (block.type === "text") { texts.push(block.text); replies.push(block.text); }
      if (block.type === "toolCall" && block.name === "thread_send" && typeof block.arguments.message === "string") texts.push(block.arguments.message);
     }
    }
    cursor = page.next;
   } while (cursor !== undefined);
   await service.endTaskFocus(api.conversationId, String(run.first));
   await service.endClarifications(service.threadIdOf(api.conversationId), clarifications, `clarification-run:${api.conversationId}:${run.first}:${run.last}`);
   await service.noteChat(texts.join("\n"), written, `report-chat:${api.conversationId}:${run.first}:${run.last}`, service.threadIdOf(api.conversationId), userTasks, { conversationId: api.conversationId, first: run.first, last: run.last, ownerInputs, reply: replies.join("\n") });
   return undefined;
  },
 })] });
}
