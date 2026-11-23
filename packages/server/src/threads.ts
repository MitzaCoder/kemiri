import { LANDING_TURN_GRANT_ENTRY, LANDING_TURN_NUDGE_KEY, LANDING_TURN_NUDGE_MS, LandingTurnDoc, type LandingTurnRequest } from "./landing-turn.ts";
import { THREAD_MESSAGE_ENTRY, THREAD_MESSAGE_LIMIT, ThreadMessagesDoc } from "./thread-messages.ts";
import { enqueueCoordinatorNotes, noteField, removeCoordinatorNote, type PendingCoordinatorNote } from "./coordinator-notes.ts";
import { isWorkerOnlyModel } from "./official-agents/provider.ts";
import { mcpRoleExtension } from "./mcp.ts";
import { timelineId, upsertTimelineFact } from "./task-timeline.ts";
import { boardAttention } from "./sidebar-attention.ts";
import { stateKind } from "./state-identity.ts";
/**
 * Background threads: full coordinators of a project, started by a coordinator (or a schedule) for big, long work. The contract
 * is `packages/protocol/src/threads.ts`; the design is DESIGN.md "Threads".
 *
 * A background thread is a child conversation of main's, built like a worker: a background anchor task owns it, so it
 * outlives main's turns and only `conversation.abort({ background: true })` on it (or `thread_stop`) reaches it, and a
 * kickoff task delivers the brief once, under a request ID derived from the call that started it. What differs from a
 * worker is what it may do: it keeps the coordinator's extensions (workers, board, memory, code mode, history,
 * compaction, the tool call cap) minus the tools that start threads and the schedule tools, so it runs its own workers
 * and one level is all there is. It works in its own workspace under the data directory (a jj workspace when the
 * project is jj, else a plain directory it can make git worktrees in), never in the project checkout.
 *
 * The list is a durable document on main's conversation (`aiki.threads`). Statuses `done` and `stopped` are written by
 * the tools; `running`, `idle` and `failed` follow a watch on each thread's transcript (a run in progress, its running
 * workers, a run that ended in an error), so a restart recomputes them instead of trusting a stale value.
 *
 * Everything a thread posts elsewhere is marked: its summary reaches main as `[thread <id> finished]`, a failure as
 * `[thread <id> failed: <reason>]`, both reviewed (an input) or recorded (a write that starts no turn) per `onFinish`;
 * `thread_send` delivers `[from <thread>] <message>`, and only requests and awaited replies wake an idle receiver. Every request ID derives
 * from the tool call or the failing entry, so a rerun after a crash posts nothing twice.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
	type Conversation,
	type ConversationId,
	type InputSubmissionDraft,
	type SubmissionDraft,
	type UserInput,
	InboxDoc,
	configure,
	defineDoc,
	defineExtension,
	defineTask,
	defineTool,
	type EntryRecord,
	type Extension,
	type Harness,
	type JsonObject,
	LiveDoc,
	type LiveState,
	section,
	type Task,
	type ToolRegistration,
	type Tx,
} from "@earendil-works/pi-durable";
import {
	MAIN_THREAD_ID,
 threadState,
	THINKING_LEVELS,
	type Board,
	type ModelRef,
	type ProjectActivity,
	type ThinkingLevel,
	type ThreadStartedBy,
	type ThreadKind,
	type ThreadMessage,
	type ThreadMessageKind,
	type ThreadsMessageEvent,
	type ThreadsMessagesRequest,
	type ThreadsCreateRequest,
	type ThreadsUpdateRequest,
	type ThreadStatus,
	type ThreadSummary,
	type LandingTurn,
	type WorkerModel,
	type WorkerSummary,
} from "@kemiri/protocol";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { DEFAULT_ACTIVITY, ProjectActivityService } from "./activity.ts";
import {
	type BoardService,
	HARNESS_WRITER,
	claimTaskForThread,
 moveTaskToCoordinator,
 queueUserMoveNotices,
 linksOfBoard,
 logLinkChanges,
 openTaskHistory,
	openBoard,
	snapshotStatusChanges,
	statusesOf,
	taskForSchedule,
	taskTime,
} from "./board.ts";
import type { CoordinatorPlace, Coordinators } from "./coordinators.ts";
import { ServerError, errorMessage } from "./errors.ts";
import { JjError, ensureJjWorkspace, jjRoot } from "./jj.ts";
import { type Notifier, replyNotification, threadFailedNotification, threadFinishedNotification } from "./notifications.ts";
import type { Project } from "./projects.ts";
import { formatRunStamp } from "./schedules.ts";
import {
	type WorkerService,
	WorkersDoc,
	entryLines,
	excerpt,
	formatDuration,
	lastActivityAt,
	liveLines,
} from "./workers.ts";

/** Threads a schedule started are archived this long after they finish. */
export const THREAD_ARCHIVE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** How much a `thread_peek` shows; a check-in shows less of each thread. */
export const THREAD_PEEK_ENTRIES = 8;
export const THREAD_PEEK_LINE_CHARS = 140;
export const THREAD_PEEK_MAX_CHARS = 2_400;
const THREAD_CHECK_IN_ENTRIES = 4;
const THREAD_CHECK_IN_LINE_CHARS = 110;

const GENERAL = { title: "General", area: "Everything without a home.", color: null };
type MainThreadRecord = { title: string; area: string; color: string | null; lifecycleOperations?: string[] };
type HeldInput = { entry?: InputSubmissionDraft["entry"]; content: import("@earendil-works/chord/json").JsonRepresentation<UserInput>; requestId: string };

export type ThreadRecord = {
	kind: ThreadKind;
	parentThreadId?: string;
	area?: string;
	paths?: string[];
	color?: string | null;
	order?: number;
	held?: boolean;
	heldAt?: string | null;
	heldInputs?: HeldInput[];
	heldInputReceipts?: string[];
	lifecycleOperations?: string[];
	archiveSchedules?: "move" | "disable";
	id: string;
	title: string;
	brief: string;
	conversationId: number;
	/** The background task that owns the thread's conversation. */
	anchorTaskId: number;
	startedBy: ThreadStartedBy;
	scheduleId: string | null;
	/** The board task it was started for and reports on; absent on threads started before tasks were required. */
	taskId?: string | null;
	/** The tool call (main's `thread_start`) or schedule slot that started it, so a rerun finds this thread. */
	startedByKey: string;
	model: ModelRef;
	thinkingLevel: ThinkingLevel | null;
	workerModel?: WorkerModel;
	onFinish: "review" | "record";
	status: ThreadStatus;
	summary: string | null;
	failure: string | null;
	createdAt: string;
	updatedAt: string;
	finishedAt: string | null;
	archived: boolean;
	/** Whether it archives itself 7 days after finishing: schedule-started ones until the user brings one back. */
	autoArchive: boolean;
	/** Its workspace: where its tools and its `shared` workers run. */
	checkout: string;
	checkoutKind: "jj" | "directory";
};

type StoredThreadRecord = Omit<ThreadRecord, "kind" | "parentThreadId"> & Partial<Pick<ThreadRecord, "kind" | "parentThreadId">>;

export type StoredThreadsState = {
	main?: MainThreadRecord;
	threads: Record<string, StoredThreadRecord>;
	/** When the list was created: main's `createdAt` in the protocol. */
	createdAt: string | null;
};

export type ThreadsState = StoredThreadsState & { main: MainThreadRecord; threads: Record<string, ThreadRecord> };

export const ThreadsDoc = defineDoc<StoredThreadsState>({
	kind: stateKind("threads"),
	// Keep the storage version readable by the previous release if deployment rolls back.
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	checkpointWhen: () => false,
	initial: () => ({ threads: {}, createdAt: null }),
});

function normalizeThreadRecord(record: Readonly<StoredThreadRecord>): ThreadRecord {
	return { ...record, kind: record.kind ?? "job", ...(record.kind === "coordinator" ? {} : { parentThreadId: record.parentThreadId ?? MAIN_THREAD_ID }) };
}

/** Default the service's read view only; drafts keep their persisted shape and unknown fields. */
function normalizeThreadsState(state: Readonly<StoredThreadsState> | undefined): ThreadsState {
	return {
		createdAt: state?.createdAt ?? null,
		main: state?.main ?? { ...GENERAL },
		threads: Object.fromEntries(Object.entries(state?.threads ?? {}).map(([id, record]) => [id, normalizeThreadRecord(record)])),
	};
}

/** Whether a thread counts as archived at `now`: by hand, or 7 days after a schedule-started one finished. */
export function isThreadArchived(record: StoredThreadRecord, now: number): boolean {
	if (record.archived) return true;
	if (!record.autoArchive || record.status !== "done" || record.finishedAt === null) return false;
	return Date.parse(record.finishedAt) + THREAD_ARCHIVE_AFTER_MS <= now;
}

/** Persist the archive flag of every thread whose 7 days passed. */
function sweepArchive(state: StoredThreadsState, now: number): void {
	for (const record of Object.values(state.threads)) {
		if (!record.archived && isThreadArchived(record, now)) record.archived = true;
	}
}

/** Whether a thread is still at work or waiting to be: not finished, stopped or failed. */
function isLive(status: ThreadStatus): boolean {
	return status === "running" || status === "idle";
}

// --- tasks -------------------------------------------------------------------------------------------------------

/** Owns one thread's conversation and finishes at once, like a worker's anchor. */
const ThreadAnchor = defineTask<null, { phase: "done" }, null>({
	name: stateKind("thread-anchor"),
	version: 1,
	initial: () => ({ phase: "done" }),
	phases: {
		done: (_anchor, runtime, context) =>
			runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: null } }), context),
	},
	abort: (_anchor, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

type KickoffInput = { conversationId: number; content: string; requestId: string };

/** Delivers a thread's brief once, under a request ID derived from what started it; never waits for the answer. */
const ThreadKickoff = defineTask<KickoffInput, { phase: "deliver" }, null>({
	name: stateKind("thread-kickoff"),
	version: 1,
	initial: () => ({ phase: "deliver" }),
	phases: {
		deliver: async (task, runtime, context) => {
			const { conversationId, content, requestId } = task.input;
			const conversation = await runtime.conversation(conversationId as ConversationId, context);
			await runtime.commit(async tx => {
				const state = await tx.doc(ThreadsDoc, runtime.conversationId);
				const record = Object.values(state.threads).find(record => record.conversationId === conversationId);
				if (!record?.archived && !(record && queueHeldInput(record, content, requestId))) {
					await conversation?.submit(tx, { type: "input", content, whenBusy: "followUp", requestId });
				}
				return { status: "terminal", outcome: { status: "completed", result: null } };
			}, context);
		},
	},
	abort: (_task, runtime, context) =>
		runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

// --- prompts -----------------------------------------------------------------------------------------------------

/**
 * Main's paragraph on threads, in its system prompt. Static text, so the prompt stays byte-stable from turn to turn.
 */
export const PEER_THREADS_SECTION = `Work inside your area. Use thread_list to find the other coordinators and their areas; paths are hints, not locks. When the owner raises work that belongs to another area, add the task, hand it to that coordinator and say where it went. When ownership is unclear, keep it and ask. General takes work without a home.

Use the board to pass work (handoff), memory for facts that last, and a message only when another coordinator must do or answer something. Say what is needed and by when. Do not thank or acknowledge. In thread_send, use awaitReply when you end your turn waiting for an answer. Answer such a request with kind "reply" and copy its taskId if present. When the owner moves a task away, stop work on it, let running workers finish or stop them, and send the new coordinator what it needs to carry on. 

Before landing changes on the project's integration ref, or doing anything else the project's rules say needs the landing turn, take it with project_turn. If queued, end your turn and wait for the [turn] grant. Follow the project's own rules while holding it and release it right after. Never hold the landing turn while waiting for approval or anything else.`;

export const MAIN_THREADS_SECTION = `You are the default coordinator and keep the project checkout. Use coordinator_start when the owner asks for an enduring area of work. Other coordinators cannot call it.`;

export function mainThreadInstructions(project: Project, { title, area }: { title: string; area: string }): string {
	return `${MAIN_THREADS_SECTION}

You coordinate the project ${JSON.stringify(project.name)} at ${project.path}. Your name is ${JSON.stringify(title)} (thread main). Your area: ${JSON.stringify(area)}`;
}

/** What a background thread is told about itself; its brief arrives as its first message. */
export function threadInstructions(options: {
	id: string;
	title: string;
	project: Project;
	checkout: string;
	checkoutKind: "jj" | "directory";
	startedBy: ThreadStartedBy;
	area?: string;
	parentThreadId?: string;
	/** The board task it was started for. */
	taskId?: string | null;
}): string {
	const { id, title, project, checkout, checkoutKind, startedBy } = options;
	const task =
		options.taskId === undefined || options.taskId === null
			? ""
			: `\n\nYou were started for the board task ${options.taskId} and hold it. The user reads that task, not this conversation: keep Results and Next current with \`board.write_report\`, giving each result its own block. Now is automatic. Move the task to review when it is ready for the owner.`;
	const workspace =
		checkoutKind === "jj"
			? `Your workspace is ${checkout}, a jj workspace of the project's repository, started from main's working copy. Do your work and merge your workers' changes there, and commit it; name the change IDs in your summary. Add an \`Kemiri-Task: T…\` trailer to commit descriptions.`
			: `Your workspace is ${checkout}, a directory of your own. The project at ${project.path} is not a jj repository, so make your checkouts here: a git worktree (\`git -C ${project.path} worktree add ${checkout}/<name> -b <branch>\`) or a clone. Workers with isolation "workspace" need jj and are not available; spawn "shared" workers and name the worktree they work in.`;
	if (options.area !== undefined) return `You are the coordinator ${JSON.stringify(title)} (thread ${id}) of ${JSON.stringify(project.name)}. The owner talks to you directly.

Your area: ${JSON.stringify(options.area)}

${workspace} Never edit the project checkout at ${project.path}: it belongs to the default coordinator.`;
	const starter =
		startedBy === "schedule"
			? "A schedule started you with the user's prompt, your first message."
			: `Your parent coordinator (${options.parentThreadId ?? MAIN_THREAD_ID}) started you; your brief is your first message.`;
	return `You are the background thread "${id}" of the project "${project.name}", working on: ${title}

${workspace} Never edit the project checkout at ${project.path}: it is main's.

${starter} Only your summary (thread_finish) reaches your parent coordinator, so put everything they need in it.

A subtask is a required part of its parent; the parent goes to review/waiting only when its parts are done, in review or waiting. Follow-ups use foundWhile; wait for another task with status todo and blockedBy (freed when it closes), while blocked requires blockedReason for failure or being stuck.

Ending a turn does not end the thread. To wait for a worker's report, an answer to a board question or a message, end your turn: you resume when it arrives. Call thread_finish once, when the work is done or cannot go on.${task}`;
}

// --- what a thread is doing right now ----------------------------------------------------------------------------

function threadStatusLine(record: ThreadRecord): string {
	switch (record.status) {
		case "running":
			return "running";
		case "idle":
			return "idle, waiting for workers, a message or the user";
		case "failed":
			return `failed${record.failure === null ? "" : `: ${record.failure}`}`;
		case "stopped":
			return "stopped";
		case "done":
			return "done";
	}
}

/** One line on what a thread does now, as `ThreadSummary.current` carries it. */
export function currentLine(
	status: ThreadStatus,
	activity: ProjectActivity | undefined,
	runningWorkers: number,
	now: number,
): string | null {
	if (status === "done" || status === "stopped" || status === "failed") return null;
	if (activity?.coordinator === "working") {
		const tool = activity.runningTool ?? null;
		if (tool !== null) return `Running ${tool.name} · ${formatDuration(now - Date.parse(tool.startedAt))}`;
		return "Thinking";
	}
	if (runningWorkers > 0) return `Waiting for ${runningWorkers} worker${runningWorkers === 1 ? "" : "s"}`;
	return "Waiting for a message";
}

/** A bounded digest of one thread, shared by `thread_peek` and main's check-ins. */
export function describeThreadActivity(options: {
	record: ThreadRecord;
	entries: readonly EntryRecord[];
	live: LiveState | undefined;
	workers: readonly WorkerSummary[];
	ownedTasks: readonly string[];
	openQuestions: number;
	current: string | null;
	now: number;
	lines: number;
	lineChars: number;
	maxChars: number;
}): string {
	const { record, entries, live, workers, now, lineChars } = options;
	const activity = [...entries].reverse().flatMap((entry) => entryLines(entry, lineChars));
	const recent = [...activity, ...liveLines(live, lineChars)].slice(-options.lines);
	const last = lastActivityAt(entries, live);
	const running = workers.filter((worker) => worker.status === "running");
	const model = `${record.model.provider}/${record.model.modelId}${record.thinkingLevel === null ? "" : ` (thinking ${record.thinkingLevel})`}`;
	const body = [
		`${record.id} — ${record.title}`,
		`status: ${threadStatusLine(record)}${options.current === null ? "" : `; ${options.current}`}; last activity ${last === undefined ? "nothing yet" : `${formatDuration(now - last)} ago`}`,
		`model: ${model}; workspace: ${record.checkout}`,
		`workers: ${running.length === 0 ? "none running" : `${running.length} running (${running.map((worker) => worker.id).join(", ")})`}${workers.length > running.length ? `, ${workers.length - running.length} other` : ""}`,
		`tasks: ${options.ownedTasks.length === 0 ? "none claimed" : options.ownedTasks.join(", ")}; open questions: ${options.openQuestions}`,
	];
	if (recent.length > 0) {
		body.push("activity:");
		for (const line of recent) body.push(`  ${line}`);
	} else {
		body.push("activity: none yet");
	}
	if (record.summary !== null) body.push(`summary: ${excerpt(record.summary, Math.min(400, lineChars * 3))}`);
	const text = body.join("\n");
	return text.length <= options.maxChars ? text : `${text.slice(0, options.maxChars - 1)}…`;
}

// --- the service -------------------------------------------------------------------------------------------------

export type ThreadServiceOptions = {
	/** Read at each use, so a reconfigured project applies to the next thread. */
	project(): Project;
	harness: Harness;
	models: Models;
	/** Main and its background threads; this service registers each thread there. */
	coordinators: Coordinators;
	workers: WorkerService;
	board: BoardService;
	/** `<data>/projects/<id>/threads`: each thread's workspace and its workers' workspaces live below it. */
	threadsDir: string;
	/**
	 * Extensions a background thread removes besides the thread-start tools: the schedule tools, which stay main's. A
	 * function, since some are built after this service; read at each start.
	 */
	removedExtensions: (kind: ThreadKind) => readonly Extension[];
	archiveSchedules?: (threadId: string, action: "move" | "disable") => Promise<void>;
	/** Main's activity: its status in the list. */
	mainActivity: () => ProjectActivity;
	notifications?: Notifier;
	now(): number;
	/** Called whenever the list (without archived threads) may have changed; the caller compares and pushes. */
	onChange?: () => void;
	onMessage?: (event: ThreadsMessageEvent) => void;
	log(message: string): void;
};

/** What starts a thread: main's `thread_start`, or a schedule. */
type CoordinatorCreate = Pick<ThreadsCreateRequest, "title" | "area" | "paths" | "color" | "model" | "thinkingLevel" | "taskIds">;

export type ThreadStartInput = {
	coordinator?: CoordinatorCreate;
	parentThreadId?: string;
	title: string;
	brief: string;
	model: ModelRef | null;
	thinkingLevel: ThinkingLevel | null;
	onFinish: "review" | "record";
	startedBy: ThreadStartedBy;
	scheduleId: string | null;
	/**
	 * The board task the thread claims and reports on. Null only for a schedule's run, which takes its schedule's one task
	 * (made on the first run) and puts it back to in_progress.
	 */
	taskId: string | null;
	/** The tool call or schedule slot: the thread's request IDs derive from it, so a rerun starts nothing twice. */
	key: string;
	/** A fixed ID (a schedule's `<scheduleId>-<stamp>`); otherwise one is made from the title. */
	id?: string;
};

export type ThreadStartResult = { ok: true; record: ThreadRecord; existed: boolean; notices?: string[] } | { ok: false; message: string };

export type ScheduledThreadInput = {
	ownerThreadId?: string;
	scheduleId: string;
	title: string;
	brief: string;
	model: ModelRef | null;
	thinkingLevel: ThinkingLevel | null;
	onFinish: "review" | "record";
	at: number;
	timezone: string;
	/** An event run: its own thread ID and key (from the schedule, the event and its time) and the task it claims. */
	event?: { id: string; key: string; taskId: string };
};

const THREAD_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

function applyLifecycleOperation(record: { lifecycleOperations?: string[] }, action: string, operationId?: string): boolean {
	if (!operationId) return true;
	const key = `${action}:${operationId}`;
	if (record.lifecycleOperations?.includes(key)) return false;
	record.lifecycleOperations ??= [];
	record.lifecycleOperations.push(key);
	return true;
}

function requiredText(value: string, field: string): string {
	const text = value.trim();
	if (!text) throw new ServerError("bad_request", `${field} cannot be blank.`);
	return text;
}

function queueHeldInput(record: StoredThreadRecord, content: UserInput, requestId: string, entry?: InputSubmissionDraft["entry"]): boolean {
	if (record.heldInputReceipts?.includes(requestId)) return true;
	if (!record.held) return false;
	record.heldInputs ??= [];
	record.heldInputs.push({ content, requestId, ...(entry ? { entry } : {}) });
	record.heldInputReceipts ??= [];
	record.heldInputReceipts.push(requestId);
	return true;
}

function heldText(items: HeldInput[]): UserInput | undefined {
	if (items.length === 0) return undefined;
	if (items.every(item => typeof item.content === "string")) return items.map(item => item.content).join("\n\n");
	return items.flatMap(({ content }) => typeof content === "string" ? [{ type: "text" as const, text: content }] : content);
}

/** Keep the paused inbox in one model input, with optional per-message presentation anchors. */
function heldPeerData(items: HeldInput[], ownerContent?: UserInput) {
	const ids = items.flatMap(item => {
		const id = (item.entry?.data as { threadMessageId?: string } | undefined)?.threadMessageId;
		return id ? [id] : [];
	});
	if (!ids.length) return undefined;
	const ordinary = items.filter(item => item.entry?.kind !== THREAD_MESSAGE_ENTRY);
	const displayed = ownerContent === undefined ? heldText(ordinary) : heldText([{ content: ownerContent, requestId: "" }, ...ordinary]);
	return { threadMessageIds: ids, peerWake: ownerContent === undefined && ordinary.length === 0,
		peerDisplayContent: Array.isArray(displayed) ? displayed.map(part => ({ ...part })) : displayed ?? "" };
}

function slugify(title: string): string {
	const slug = title
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 32)
		.replace(/-+$/g, "");
	return slug.length === 0 || slug === MAIN_THREAD_ID ? "thread" : slug;
}

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

export class ThreadService {
	readonly #options: ThreadServiceOptions;
	#startExtension: Extension | undefined;
	#extension: Extension | undefined;
	#finishExtension: Extension | undefined;
	/** Each background thread's live activity, from a watch on its transcript. */
	readonly #watches = new Map<string, ProjectActivityService>();
	readonly #activities = new Map<string, ProjectActivity>();
	/** Every thread's workers, from the worker watch. */
	#workers: WorkerSummary[] = [];
	#board: Board | undefined;
	#storage: { removeThread(threadId: string): Promise<void> } | undefined;
	/** Status changes are serialized, so two watch callbacks never race on one thread. */
	#queue: Promise<void> = Promise.resolve();
	#stopped = false;
	readonly #landingTurnConversations = new Map<string, Conversation>();
	#landingTurnNudge: ReturnType<typeof setInterval> | undefined;

	constructor(options: ThreadServiceOptions) {
		this.#options = options;
		options.coordinators.queueWhileHeld = async (tx, conversationId, content, requestId) => {
			const place = options.coordinators.placeOf(conversationId);
			if (place?.kind !== "coordinator" || place.threadId === MAIN_THREAD_ID) return false;
			const record = (await tx.doc(ThreadsDoc, this.#mainId)).threads[place.threadId];
			return record ? queueHeldInput(record, content, requestId) : false;
		};
	}

	get project(): Project {
		return this.#options.project();
	}

	get coordinators(): Coordinators {
		return this.#options.coordinators;
	}

	get #mainId(): ConversationId {
		return this.#options.coordinators.mainId as ConversationId;
	}

	/** Coordinator job tools and their durable start tasks; jobs remove this extension. */
	get startExtension(): Extension {
		this.#startExtension ??= createThreadStartExtension(this);
		return this.#startExtension;
	}

	/** `thread_list`, `thread_peek` and `thread_send`, for every coordinator thread; workers remove it. */
	get extension(): Extension {
		this.#extension ??= createThreadExtension(this);
		return this.#extension;
	}

	/** `thread_finish`, for background threads only: main and workers remove it. */
	get finishExtension(): Extension {
		this.#finishExtension ??= createThreadFinishExtension(this);
		return this.#finishExtension;
	}

	async state(context: Context = BACKGROUND_CONTEXT): Promise<ThreadsState> {
		const state = await this.#options.harness.snapshot(ThreadsDoc, this.#mainId, context);
		return normalizeThreadsState(state);
	}

	async titleOf(threadId: string): Promise<string | undefined> {
		const state = await this.state();
		return threadId === MAIN_THREAD_ID ? state.main.title : state.threads[threadId]?.title;
	}

	async record(threadId: string, context: Context = BACKGROUND_CONTEXT): Promise<ThreadRecord | undefined> {
		return (await this.state(context)).threads[threadId];
	}

	/**
	 * Create the list if this project never had one, register every thread as a coordinator and persist archives that
	 * came due. Called on open, before anything resumes, so a resumed thread's tools know it.
	 */
	async open(): Promise<void> {
		const now = this.#options.now();
		await this.#options.harness.commit(async (tx) => {
			const doc = await tx.doc(ThreadsDoc, this.#mainId);
			doc.createdAt ??= new Date(now).toISOString();
			sweepArchive(doc, now);
   const board = await openBoard(tx, this.#mainId);
   for (const record of Object.values(doc.threads)) {
    if (!record.taskId || !board.tasks.some(task => task.id === record.taskId && task.ownerThreadId === record.id)) continue;
    board.taskFocus ??= {};
    board.taskFocus[record.id] ??= record.taskId;
   }
		}, BACKGROUND_CONTEXT);
		for (const record of Object.values((await this.state()).threads)) {
			this.#options.coordinators.add(this.placeFor(record));
			if (record.kind === "coordinator" && !record.archived) {
				const conversation = await this.#options.harness.conversation(record.conversationId as ConversationId, BACKGROUND_CONTEXT);
				if (conversation) this.#landingTurnConversations.set(record.id, conversation);
			}
		}
	}

	/** Watch every thread's transcript; called once the project's Harness is set up. */
	async startWatches(): Promise<void> {
		// Recover a queue even if an older release changed the roster while this document was ignored.
		const turn = await this.landingTurn();
		if (turn.holder || turn.queue.length) {
			await this.#options.harness.commit(async tx => {
				await this.#advanceLandingTurn(tx, await tx.doc(ThreadsDoc, this.#mainId));
			}, BACKGROUND_CONTEXT);
			this.#landingTurnChanged();
		}
		await this.nudgeLandingTurn();
		this.#landingTurnNudge = setInterval(() => {
			void this.#enqueue(() => this.nudgeLandingTurn());
		}, 60_000);
		this.#landingTurnNudge.unref();
		for (const record of Object.values((await this.state()).threads)) {
			if (record.archived) { await this.#settleArchivedSchedules(record); continue; }
			await this.#watch(record);
		}
	}

	async stop(): Promise<void> {
		this.#stopped = true;
		clearInterval(this.#landingTurnNudge);
		const watches = [...this.#watches.values()];
		this.#watches.clear();
		for (const watch of watches) await watch.stop().catch(() => undefined);
		await this.#queue.catch(() => undefined);
	}

	placeFor(record: Pick<ThreadRecord, "id" | "conversationId" | "checkout" | "kind" | "parentThreadId" | "model" | "workerModel">): CoordinatorPlace {
		return {
			threadId: record.id,
			kind: record.kind,
			model: record.model,
			...(record.workerModel === undefined ? {} : { workerModel: record.workerModel }),
			...(record.parentThreadId === undefined ? {} : { parentThreadId: record.parentThreadId }),
			conversationId: record.conversationId,
			checkout: record.checkout,
			workspacesDir: join(this.#options.threadsDir, record.id, "workers"),
			workspacePrefix: `harness-${record.id}-`,
		};
	}

	/** The thread a coordinator conversation is, or undefined for a worker. */
	threadIdOf(conversationId: number): string | undefined {
		return this.#options.coordinators.threadIdOf(conversationId);
	}

	/** A thread's conversation (main's for "main"), or `unknown_thread`. */
	async conversation(threadId: string): Promise<Conversation> {
		if (threadId === MAIN_THREAD_ID) return this.#options.coordinators.main;
		const record = await this.record(threadId);
		const conversation =
			record === undefined
				? undefined
				: await this.#options.harness.conversation(record.conversationId as ConversationId, BACKGROUND_CONTEXT);
		if (conversation === undefined) {
			throw new ServerError("unknown_thread", `No thread "${threadId}" in this project`, { threadId });
		}
		return conversation;
	}

	// --- the list as the protocol shows it ------------------------------------------------------------------------

	/** Every thread, main first, then by creation; archived ones only when asked for. */
	async list(includeArchived = false): Promise<ThreadSummary[]> {
		const state = await this.state();
		const now = this.#options.now();
		const records = Object.values(state.threads)
			.filter((record) => includeArchived || !isThreadArchived(record, now))
			.sort((left, right) => Number(right.kind === "coordinator") - Number(left.kind === "coordinator")
				|| (left.order ?? 0) - (right.order ?? 0) || left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
		return [this.#mainSummary(state, now), ...records.map((record) => this.summaryOf(record, now))];
	}

	/** Background threads still at work or waiting (not done, stopped, failed or archived). */
	async backgroundCount(): Promise<number> {
		const now = this.#options.now();
		return Object.values((await this.state()).threads).filter(
			(record) => isLive(record.status) && !isThreadArchived(record, now),
		).length;
	}

	summaryOf(record: ThreadRecord, now: number = this.#options.now()): ThreadSummary {
		const workers = this.#workersOf(record.id);
		const running = workers.filter((worker) => worker.status === "running").length;
		return {
			id: record.id,
			title: record.title,
			...this.#summaryFields(record.id, record.kind, this.#activities.get(record.id), record.status),
			...(record.parentThreadId === undefined ? {} : { parentThreadId: record.parentThreadId }),
			...(record.area === undefined ? {} : { area: record.area }),
			...(record.paths === undefined ? {} : { paths: record.paths }),
			...(record.color === undefined ? {} : { color: record.color }),
			...(record.order === undefined ? {} : { order: record.order }),
			held: record.held ?? false,
			status: record.kind === "coordinator" && record.status === "stopped" ? "idle" : record.status,
 state: threadState({ status: record.kind === "coordinator" && record.status === "stopped" ? "idle" : record.status, openQuestions: this.#openQuestions(record.id), runningWorkers: running }),
			main: false,
			startedBy: record.startedBy,
			scheduleId: record.scheduleId,
			taskId: record.taskId ?? null,
			conversationId: record.conversationId,
			model: record.model,
			...(record.workerModel === undefined ? {} : { workerModel: record.workerModel }),
			thinkingLevel: record.thinkingLevel,
			onFinish: record.onFinish,
			runningWorkers: running,
			ownedTasks: this.#ownedTasks(record.id),
			openQuestions: this.#openQuestions(record.id),
			current: currentLine(record.status, this.#activities.get(record.id), running, now),
			summary: record.summary,
			failure: record.failure,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			finishedAt: record.finishedAt,
			archived: isThreadArchived(record, now),
		};
	}

	#mainSummary(state: ThreadsState, now: number): ThreadSummary {
		const project = this.project;
		const activity = this.#options.mainActivity();
		const running = this.#workersOf(MAIN_THREAD_ID).filter((worker) => worker.status === "running").length;
		const status: ThreadStatus =
			activity.coordinator === "working" ? "running" : activity.coordinator === "failed" ? "failed" : running > 0 ? "running" : "idle";
		const createdAt = state.createdAt ?? new Date(0).toISOString();
		return {
			id: MAIN_THREAD_ID,
			title: state.main.title,
			...this.#summaryFields(MAIN_THREAD_ID, "coordinator", activity, status),
			area: state.main.area,
			color: state.main.color,
			status,
 state: threadState({ status, openQuestions: this.#openQuestions(MAIN_THREAD_ID), runningWorkers: running }),
			main: true,
			startedBy: null,
			scheduleId: null,
			conversationId: this.#mainId as number,
			model: project.coordinator.model,
			thinkingLevel: project.coordinator.thinkingLevel,
			onFinish: "review",
			runningWorkers: running,
			ownedTasks: this.#ownedTasks(MAIN_THREAD_ID),
			openQuestions: this.#openQuestions(MAIN_THREAD_ID),
			current: currentLine(status, activity, running, now),
			summary: null,
			failure: null,
			createdAt,
			updatedAt: activity.lastReplyAt ?? createdAt,
			finishedAt: null,
			archived: false,
		};
	}

	#summaryFields(id: string, kind: ThreadKind, activity: ProjectActivity | undefined, status: ThreadStatus) {
		const belongs = (threadId: string | null | undefined) => kind === "job"
			? threadId === id : this.coordinators.coordinatorId(threadId) === id;
		const tasks = (this.#board?.tasks ?? []).filter(task => belongs(task.ownerThreadId));
		const attention = boardAttention({ tasks, questions: (this.#board?.questions ?? []).filter(q => belongs(q.threadId)) });
		const failedJobs = kind === "coordinator" ? this.coordinators.places().filter(place =>
			place.kind === "job" && place.parentThreadId === id && this.#activities.get(place.threadId)?.coordinator === "failed").length : 0;
		return {
			kind,
			lastReplyAt: activity?.lastReplyAt ?? null,
			lastReplyEntryId: activity?.lastReplyEntryId ?? null,
			openTasks: tasks.filter(task => !task.archived && task.status !== "done" && task.status !== "dropped").length,
			attention: { questions: attention.questions, warnings: attention.warnings, steps: attention.stepsTasks ?? 0,
				review: attention.reviewTasks, failed: Number(status === "failed") + failedJobs + this.#workers.filter(w => belongs(w.threadId ?? MAIN_THREAD_ID) && w.status === "failed").length },
		};
	}

	#workersOf(threadId: string): WorkerSummary[] {
		return this.#workers.filter((worker) => (worker.threadId ?? MAIN_THREAD_ID) === threadId && worker.status !== "done");
	}

	#ownedTasks(threadId: string): string[] {
		return (this.#board?.tasks ?? [])
			.filter((task) => (task.ownerThreadId ?? null) === threadId && !task.archived)
			.map((task) => task.id);
	}

	/** The board questions a thread asked that are still open, read from the board itself. */
	async openQuestionIds(threadId: string): Promise<string[]> {
		return (await this.#options.board.state()).questions
			.filter((question) => question.status === "open" && (question.threadId ?? MAIN_THREAD_ID) === threadId)
			.map((question) => question.id);
	}

	#openQuestions(threadId: string): number {
		return (this.#board?.questions ?? []).filter(
			(question) => question.status === "open" && question.waitingOn !== "agent" && (question.threadId ?? MAIN_THREAD_ID) === threadId,
		).length;
	}

	/** The worker watch saw a change: running workers decide whether an idle thread is running. */
	workersChanged(workers: readonly WorkerSummary[]): void {
		this.#workers = [...workers];
		void this.#enqueue(async () => {
			for (const record of Object.values((await this.state()).threads)) {
				if (isLive(record.status)) await this.#settleStatus(record.id);
			}
		});
		this.#changed();
	}

	/** The board changed: owned tasks and open questions are part of every summary. */
	boardChanged(board: Board): void {
		this.#board = board;
		this.#changed();
	}

	/** Main's activity changed: it is main's status in the list. */
	mainChanged(): void {
		if (this.#options.mainActivity().coordinator === "failed") void this.#enqueue(async () => {
			if (this.#options.mainActivity().coordinator === "failed") await this.dropLandingTurn(MAIN_THREAD_ID);
		});
		this.#changed();
	}

	#changed(): void {
		if (this.#stopped) return;
		try {
			this.#options.onChange?.();
		} catch (error) {
			this.#options.log(`threads: change listener failed: ${errorMessage(error)}`);
		}
	}

	#enqueue(work: () => Promise<void>): Promise<void> {
		const next = this.#queue.then(work).catch((error: unknown) => {
			this.#options.log(`threads: ${errorMessage(error)}`);
		});
		this.#queue = next;
		return next;
	}

	async landingTurn(): Promise<LandingTurn> {
		const turn = await this.#options.harness.snapshot(LandingTurnDoc, this.#mainId, BACKGROUND_CONTEXT);
		return {
			...(turn?.holder ? { holder: { ...turn.holder } } : {}),
			queue: (turn?.queue ?? []).map(({ coordinatorId, taskId, askedAt }) => ({ coordinatorId, ...(taskId ? { taskId } : {}), askedAt })),
		};
	}

	#canHoldLandingTurn(roster: StoredThreadsState, threadId: string): boolean {
		if (threadId === MAIN_THREAD_ID) return this.#options.mainActivity().coordinator !== "failed";
		const record = roster.threads[threadId];
		return record?.kind === "coordinator" && !record.held && !record.archived && isLive(record.status);
	}

	/** The new holder and its waking submission commit together. A crash cannot strand a granted waiter. */
	async #advanceLandingTurn(tx: Tx, roster: StoredThreadsState, departing?: string): Promise<void> {
		const turn = await tx.doc(LandingTurnDoc, this.#mainId);
		const eligible = (id: string) => id !== departing && this.#canHoldLandingTurn(roster, id);
		turn.queue = turn.queue.filter(waiter => eligible(waiter.coordinatorId));
		let cancelGrant: (() => void) | undefined;
		if (turn.holder) {
			if (eligible(turn.holder.coordinatorId)) return;
			const id = turn.holder.coordinatorId;
			const conversationId = id === MAIN_THREAD_ID ? this.#mainId : roster.threads[id]?.conversationId as ConversationId | undefined;
			if (conversationId !== undefined) {
				if (turn.nudged) await removeCoordinatorNote(tx, conversationId, "turn", LANDING_TURN_NUDGE_KEY);
				const inbox = await tx.doc(InboxDoc, conversationId);
				const grants = inbox.items.filter(item => item.entry?.kind === LANDING_TURN_GRANT_ENTRY);
				inbox.items = inbox.items.filter(item => item.entry?.kind !== LANDING_TURN_GRANT_ENTRY);
				// Admission must precede the first submission-table write in this transaction.
				cancelGrant = () => {
					for (const grant of grants) tx.settleSubmission(grant.id, { status: "unanswered", reason: "landing-turn-released" });
				};
			}
			delete turn.holder;
			delete turn.nudged;
		}
		while (turn.queue.length) {
			const { coordinatorId, taskId, note, requestId } = turn.queue.shift()!;
			const conversation = coordinatorId === MAIN_THREAD_ID ? this.coordinators.main : this.#landingTurnConversations.get(coordinatorId);
			if (!conversation) continue;
			turn.holder = { coordinatorId, takenAt: new Date(this.now()).toISOString(), ...(taskId ? { taskId } : {}), ...(note ? { note } : {}) };
			await conversation.submit(tx, {
				type: "input", whenBusy: "steer", requestId: `landing-turn:${requestId}`,
				content: `[turn] The landing turn is yours${taskId ? ` (${taskId})` : ""}.`,
				entry: { kind: LANDING_TURN_GRANT_ENTRY },
			});
			break;
		}
		cancelGrant?.();
	}

	#landingTurnChanged(): void {
		this.#options.harness.resume();
		this.#changed();
	}

	async dropLandingTurn(threadId: string): Promise<void> {
		const turn = await this.landingTurn();
		if (turn.holder?.coordinatorId !== threadId && !turn.queue.some(waiter => waiter.coordinatorId === threadId)) return;
		await this.#options.harness.commit(async tx => {
			await this.#advanceLandingTurn(tx, await tx.doc(ThreadsDoc, this.#mainId), threadId);
		}, BACKGROUND_CONTEXT);
		this.#landingTurnChanged();
	}

	async nudgeLandingTurn(): Promise<void> {
		const { harness } = this.#options;
		const isDue = (turn: Readonly<{ holder?: LandingTurn["holder"]; nudged?: boolean }> | undefined) =>
			turn?.holder !== undefined && !turn.nudged && this.now() - Date.parse(turn.holder.takenAt) >= LANDING_TURN_NUDGE_MS;
		if (!isDue(await harness.snapshot(LandingTurnDoc, this.#mainId, BACKGROUND_CONTEXT))) return;
		await harness.commit(async tx => {
			const turn = await tx.doc(LandingTurnDoc, this.#mainId);
			if (!isDue(turn)) return;
			const { coordinatorId } = turn.holder!;
			const roster = await tx.doc(ThreadsDoc, this.#mainId);
			if (!this.#canHoldLandingTurn(roster, coordinatorId)) return;
			const id = coordinatorId === MAIN_THREAD_ID ? this.#mainId : roster.threads[coordinatorId]!.conversationId as ConversationId;
			await enqueueCoordinatorNotes(tx, id, [{ channel: "turn", key: LANDING_TURN_NUDGE_KEY,
				line: "You have held the landing turn for at least 30 minutes. Release it if you are no longer using it." }]);
			turn.nudged = true;
		}, BACKGROUND_CONTEXT);
	}

	async projectTurn(threadId: string, request: LandingTurnRequest, callId: string): Promise<string> {
		// Harness reads cannot run on the mutation line inside a commit. Cache the handle before a take can queue.
		if (request.action === "take" && threadId !== MAIN_THREAD_ID && !this.#landingTurnConversations.has(threadId)) {
			this.#landingTurnConversations.set(threadId, await this.conversation(threadId));
		}
		const result = await this.#options.harness.commit(async tx => {
			const roster = await tx.doc(ThreadsDoc, this.#mainId);
			if (threadId !== MAIN_THREAD_ID && roster.threads[threadId]?.kind !== "coordinator") {
				throw new ServerError("bad_request", "Only General and area coordinators can use the landing turn.");
			}
			const turn = await tx.doc(LandingTurnDoc, this.#mainId);
			const name = (id: string) => id === MAIN_THREAD_ID ? roster.main?.title ?? GENERAL.title : roster.threads[id]?.title ?? id;
			const label = ({ coordinatorId, taskId }: { coordinatorId: string; taskId?: string }) =>
				`${JSON.stringify(name(coordinatorId))} (${coordinatorId}${taskId ? `, ${taskId}` : ""})`;
			const heldBy = () => turn.holder ? `${label(turn.holder)} since ${turn.holder.takenAt}` : "free";
			if (request.action === "status") {
				return `Landing turn: ${heldBy()}.${turn.holder?.note ? ` Note: ${JSON.stringify(turn.holder.note)}.` : ""} Waiting: ${turn.queue.map(label).join(", ") || "nobody"}.`;
			}
			const receipt = `${threadId}:${callId}`;
			if (turn.receipts?.[receipt] !== undefined) return turn.receipts[receipt];
			let text: string;
			if (request.action === "release") {
				const held = turn.holder?.coordinatorId === threadId;
				const waited = turn.queue.some(waiter => waiter.coordinatorId === threadId);
				await this.#advanceLandingTurn(tx, roster, threadId);
				text = held ? `Released the landing turn. Now: ${heldBy()}.` : waited ? "Left the landing turn queue." : "You did not hold or wait for the landing turn.";
			} else {
				if (!this.#canHoldLandingTurn(roster, threadId)) throw new ServerError("bad_request", "A paused, stopped, failed or archived coordinator cannot take the landing turn.");
				await this.#advanceLandingTurn(tx, roster);
				const { taskId } = request;
				if (taskId !== undefined && !(await openBoard(tx, this.#mainId)).tasks.some(task => task.id === taskId)) {
					throw new ServerError("unknown_task", `No task ${JSON.stringify(taskId)} in this project.`);
				}
				const at = new Date(this.now()).toISOString();
				const note = request.note?.trim().slice(0, 240);
				const details = { coordinatorId: threadId, ...(taskId ? { taskId } : {}), ...(note ? { note } : {}) };
				if (!turn.holder || turn.holder.coordinatorId === threadId) {
					turn.holder ??= { ...details, takenAt: at };
					text = "The landing turn is yours. Release it as soon as you finish.";
				} else {
					let index = turn.queue.findIndex(waiter => waiter.coordinatorId === threadId);
					if (index < 0) {
						index = turn.queue.length;
						turn.queue.push({ ...details, askedAt: at, requestId: receipt });
					}
					text = `Queued at position ${index + 1}. Held by ${heldBy()}. End your turn and wait for the [turn] grant.`;
				}
			}
			(turn.receipts ??= {})[receipt] = text;
			return text;
		}, BACKGROUND_CONTEXT);
		if (request.action !== "status") this.#landingTurnChanged();
		return result;
	}

	// --- live status --------------------------------------------------------------------------------------------

	async #watch(record: ThreadRecord): Promise<void> {
		if (this.#stopped || this.#watches.has(record.id)) return;
		const conversation = await this.#options.harness.conversation(
			record.conversationId as ConversationId,
			BACKGROUND_CONTEXT,
		);
		if (conversation === undefined) return;
		const activity = new ProjectActivityService({
			conversation,
			initial: DEFAULT_ACTIVITY,
			now: this.#options.now,
			onChange: (value) => {
				this.#activities.set(record.id, value);
				void this.#enqueue(() => this.#settleStatus(record.id));
				this.#changed();
			},
			...(record.kind !== "coordinator" ? {} : { onReply: (reply: { entryId: number; at: string; text: string }) => {
				void this.titleOf(record.id).then(title => this.#options.notifications?.notify(replyNotification({
					projectId: this.project.id, projectName: this.project.name, coordinatorId: record.id,
					coordinatorTitle: title ?? record.title, entryId: reply.entryId, at: reply.at, text: reply.text,
				}))).catch(error => this.log(`coordinator reply notification: ${errorMessage(error)}`));
			} }),
			log: (message) => this.#options.log(`thread ${record.id}: ${message}`),
		});
		this.#watches.set(record.id, activity);
		await activity.start();
	}

	/**
	 * Bring a live thread's stored status in line with its transcript: a run in progress or running workers is
	 * `running`, a run that ended in an error is `failed` (posted to main once), anything else `idle`. A finished or
	 * stopped thread keeps its status: only a new message brings it back (`revive`).
	 */
	async #settleStatus(threadId: string): Promise<void> {
		const record = await this.record(threadId);
		const activity = this.#activities.get(threadId);
		if (record === undefined || activity === undefined) return;
		if (record.status === "done" || record.status === "stopped") return;
		const running = this.#workersOf(threadId).some((worker) => worker.status === "running");
		const next: ThreadStatus =
			activity.coordinator === "working" ? "running" : activity.coordinator === "failed" ? "failed" : running ? "running" : "idle";
		if (next === "failed") {
			await this.#reportFailure(record);
			return;
		}
		this.#options.notifications?.resolveAlerts(alert => alert.projectId === this.project.id && alert.threadId === threadId &&
			(alert.kind === "thread_failed" || alert.kind === "coordinator_failed"));
		if (next === record.status) return;
		await this.#update(threadId, (current) => {
			if (current.status === "done" || current.status === "stopped") return;
			current.status = next;
			current.failure = null;
		});
	}

	/** A turn of the thread ended in an error: record it and post `[thread <id> failed: …]` to main once. */
	async #reportFailure(record: ThreadRecord): Promise<void> {
		const conversation = await this.#options.harness.conversation(
			record.conversationId as ConversationId,
			BACKGROUND_CONTEXT,
		);
		const page = await conversation?.entries({ order: "descending" }, 10, undefined, BACKGROUND_CONTEXT);
		let reason = "its last turn failed";
		let entryId: number | undefined;
		for (const entry of page?.items ?? []) {
			const message = entry.model?.[0] as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
			if (message?.role !== "assistant") continue;
			if (message.stopReason === "error") {
				reason = excerpt(message.errorMessage ?? reason, 300);
				entryId = entry.id;
			}
			break;
		}
		const key = `${record.id}:${entryId ?? "unknown"}`;
		if (record.status === "failed" && record.failure === reason) return;
		await this.#update(record.id, (current) => {
			if (current.status === "done" || current.status === "stopped") return;
			current.status = "failed";
			current.failure = reason;
		}, true);
		if (record.kind === "job") await this.#options.board.noteThreadOutcome(record.id, `failed:${key}`, "thread failed", record.taskId);
		if (record.kind === "job") {
			await this.#post(record, `[thread ${record.id} failed: ${reason}]`, `thread-failed:${key}`);
			await this.#options.board.releaseThread(record.id, `failed:${key}`, record.taskId);
		}
		const project = this.project;
		this.#options.notifications?.notify(
			threadFailedNotification({
				projectId: project.id,
				projectName: project.name,
				threadId: record.id,
				coordinator: record.kind === "coordinator",
				taskId: record.taskId ?? null,
				title: record.title,
				failure: reason,
				key,
				scheduleId: record.scheduleId,
				coordinatorId: record.parentThreadId,
			}),
		);
	}

	/** Post a job’s finish or failure to its parent: an input it reviews, or a write it reads at its next turn. */
	async #post(record: ThreadRecord, content: string, requestId: string): Promise<void> {
		try {
			const parentRecord = record.parentThreadId && await this.record(record.parentThreadId);
			const parent = await this.conversation(parentRecord && !parentRecord.archived ? parentRecord.id : MAIN_THREAD_ID);
			if (record.onFinish === "record") {
				await parent.submit(
					{
						type: "write",
						entry: { kind: "pi.user", model: [{ role: "user", content, timestamp: this.#options.now() }] },
						requestId,
					},
					BACKGROUND_CONTEXT,
				);
			} else {
				await this.submitHarness(parent, { type: "input", content, whenBusy: "followUp", requestId }, content, requestId);
			}
		} catch (error) {
			this.#options.log(`thread ${record.id}: could not post to its parent: ${errorMessage(error)}`);
		}
	}

	async #update(threadId: string, change: (record: StoredThreadRecord) => void, dropLandingTurn = false): Promise<void> {
		const now = this.#options.now();
		await this.#options.harness.commit(async (tx) => {
			const doc = await tx.doc(ThreadsDoc, this.#mainId);
			const record = doc.threads[threadId];
			if (record === undefined) return;
			const before = JSON.stringify(record);
			change(record);
			if (JSON.stringify(record) !== before) record.updatedAt = new Date(now).toISOString();
			sweepArchive(doc, now);
			if (dropLandingTurn) await this.#advanceLandingTurn(tx, doc, threadId);
		}, BACKGROUND_CONTEXT);
		if (dropLandingTurn) this.#landingTurnChanged();
		else this.#changed();
	}

	// --- starting ------------------------------------------------------------------------------------------------

	/** A free ID made from the title: `jira-run`, then `jira-run-2`, … */
	#freeId(state: ThreadsState, title: string): string {
		const base = slugify(title);
		if (state.threads[base] === undefined) return base;
		for (let attempt = 2; ; attempt += 1) {
			const candidate = `${base.slice(0, 40)}-${attempt}`;
			if (state.threads[candidate] === undefined) return candidate;
		}
	}

	/** A thread whose checkout was cleaned up gets it back before it works again. */
	async #ensureCheckout(threadId: string): Promise<void> {
		const record = await this.record(threadId);
		if (record === undefined || record.checkout === this.project.path) return;
		const present = await stat(record.checkout).then((info) => info.isDirectory()).catch(() => false);
		if (!present) await this.#prepareCheckout(threadId);
	}

	/** The thread's own workspace: a jj workspace of the project's repository, or a plain directory. Idempotent. */
	async #prepareCheckout(threadId: string): Promise<{ checkout: string; kind: "jj" | "directory" }> {
		const base = join(this.#options.threadsDir, threadId);
		const checkout = join(base, "checkout");
		await mkdir(base, { recursive: true, mode: 0o700 });
		const repo = await jjRoot(this.project.path);
		if (repo === undefined) {
			await mkdir(checkout, { recursive: true, mode: 0o700 });
			return { checkout, kind: "directory" };
		}
		try {
			await ensureJjWorkspace({ repo, name: `harness-thread-${threadId}`, path: checkout });
		} catch (error) {
			if (error instanceof JjError) throw new ServerError("internal", `Could not create the thread's workspace: ${error.message}`);
			throw error;
		}
		return { checkout, kind: "jj" };
	}

	/**
	 * Start a background thread: its workspace, then in one commit its anchor, conversation, agent settings, list entry,
	 * the kickoff that delivers the brief, and main's check-in timer. `commit` is the tool call's own when main starts
	 * it, the Harness's for a schedule.
	 */
	async start(
		input: ThreadStartInput,
		commit: <T>(change: (tx: Tx) => Promise<T>) => Promise<T> = (change) =>
			this.#options.harness.commit(change, BACKGROUND_CONTEXT),
	): Promise<ThreadStartResult> {
		const project = this.project;
		const state = await this.state();
		const parentThreadId = input.parentThreadId ?? MAIN_THREAD_ID;
		const parent = state.threads[parentThreadId];
		const parentId = (parent?.conversationId ?? this.#mainId) as ConversationId;
		const existing = Object.values(state.threads).find((record) => record.startedByKey === input.key);
		if (existing !== undefined) return { ok: true, record: existing, existed: true };

		const model = input.model ?? project.coordinator.model;
		if (model === null) {
			return { ok: false, message: "No model for the thread: name one, or set the project's coordinator model." };
		}
		if (isWorkerOnlyModel(this.#options.models, model)) return { ok: false, message: "Official-agent models run only in worker conversations, not coordinator threads." };
		if (this.#options.models.getModel(model.provider, model.modelId) === undefined) {
			return { ok: false, message: `Unknown model ${model.provider}/${model.modelId}.` };
		}
		const thinkingLevel = input.thinkingLevel ?? (input.model === null ? project.coordinator.thinkingLevel : null);
		const id = input.id ?? this.#freeId(state, input.title);
		if (state.threads[id] !== undefined || id === MAIN_THREAD_ID || !THREAD_ID_PATTERN.test(id)) {
			return { ok: false, message: `The thread ID "${id}" is taken or not valid.` };
		}

		// The task is checked before the workspace is made; the commit claims it, and refuses a race the same way.
		if (input.taskId !== null) {
			const task = (await this.#options.board.state()).tasks.find((candidate) => candidate.id === input.taskId);
			if (task === undefined) return { ok: false, message: `No task "${input.taskId}" on the board (unknown_task). Add it with the board tool first.` };
			const owner = task.ownerThreadId ?? null;
			if ((owner ?? MAIN_THREAD_ID) !== parentThreadId) {
				return { ok: false, message: `Task ${task.id} is held by thread "${owner}". Start the thread on another task.` };
			}
			if (task.status === "done" || task.status === "dropped") {
				return { ok: false, message: `Task ${task.id} is ${task.status}: only the user reopens a closed task. Start the thread on another task.` };
			}
		} else if (input.scheduleId === null && input.coordinator === undefined) {
			return { ok: false, message: "A thread needs the board task it works on (taskId)." };
		}

		let place: { checkout: string; kind: "jj" | "directory" };
		try {
			place = await this.#prepareCheckout(id);
		} catch (error) {
			return { ok: false, message: errorMessage(error) };
		}
		const checkIn = input.coordinator === undefined && input.onFinish === "review" ? await this.#options.workers.checkInNeeded(BACKGROUND_CONTEXT, parentId) : false;
		const title = input.title.trim().slice(0, 120) || id;
		const { record, notices, existed } = await commit(async (tx) => {
			// Reads before the first write: a transaction may not read tables after it.
			const doc = await tx.doc(ThreadsDoc, this.#mainId);
			const existing = Object.values(doc.threads).find(record => record.startedByKey === input.key);
			if (existing) return { record: normalizeThreadRecord(JSON.parse(JSON.stringify(existing)) as StoredThreadRecord), notices: [], existed: true };
			if (doc.threads[id]) throw new ServerError("bad_request", `Thread ID ${id} is already in use. Try again.`);
			const currentParent = doc.threads[parentThreadId];
			if (parentThreadId !== MAIN_THREAD_ID && (currentParent?.kind !== "coordinator" || currentParent.archived || currentParent.held)) {
				throw new ServerError("bad_request", "The parent must be an unpaused, unarchived coordinator.");
			}
			const workers = await tx.doc(WorkersDoc, parentId);
			// The thread claims its task (a schedule's run its schedule's one task) and the status change is snapshotted,
			// all before the first table write.
			const now = new Date(this.#options.now()).toISOString();
			const board = await openBoard(tx, this.#mainId);
			const before = statusesOf(board);
   const linksBefore = linksOfBoard(board);
			const taskId = input.coordinator ? null :
				input.taskId ?? taskForSchedule(board, { scheduleId: input.scheduleId as string, title, now, ownerThreadId: parentThreadId }).after.id;
			const move = taskId === null ? undefined : claimTaskForThread(board, { key: `thread-start:${input.key}`, taskId, threadId: id, parentThreadId, now });
			const moved = [...new Set(input.coordinator?.taskIds ?? [])].map(taskId => moveTaskToCoordinator(board, taskId, id, now));
			for (const change of moved) queueUserMoveNotices(board, change, this.coordinators.coordinatorId(change.before?.ownerThreadId), id, title, false);
   await logLinkChanges(tx, this.#mainId, board, linksBefore, { by: HARNESS_WRITER, at: now });
			if (taskId !== null) {
				const task = board.tasks.find(task => task.id === taskId)!;
				const history = await openTaskHistory(tx, this.#mainId, taskId);
				upsertTimelineFact(history, task, { id: timelineId(taskId, `claim:${input.key}`), at: now, endAt: now, kind: "milestone", group: "work", source: "ownership", outcome: "claimed", label: `Claimed by ${id}`, by: HARNESS_WRITER });
			}

			await snapshotStatusChanges(tx, this.#mainId, board, before, { by: HARNESS_WRITER, at: now, key: `thread-start:${input.key}` });
			const background = { ownership: { kind: "conversation" as const }, conversationId: this.#mainId, background: true };
			const anchor = await tx.createTask(ThreadAnchor, null, background);
			const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
			await configure(tx, conversation.id, {
				model,
				thinkingLevel,
				cwd: place.checkout,
				extensions: this.extensionsFor(input.coordinator ? "coordinator" : "job"),
				instructions: threadInstructions({
					id,
					title,
					project,
					checkout: place.checkout,
					checkoutKind: place.kind,
					startedBy: input.startedBy,
					parentThreadId,
					taskId,
					...(input.coordinator ? { area: input.coordinator.area } : {}),
				}),
			});
			const created: ThreadRecord = {
				id,
				kind: input.coordinator ? "coordinator" : "job",
				parentThreadId,
				...(input.coordinator ? { area: input.coordinator.area, paths: input.coordinator.paths ?? [], color: input.coordinator.color ?? null,
					order: Math.max(0, ...Object.values(doc.threads).map(record => record.order ?? 0)) + 1, held: false, heldAt: null } : {}),
				title,
				brief: input.brief,
				conversationId: conversation.id,
				anchorTaskId: anchor,
				startedBy: input.startedBy,
				scheduleId: input.scheduleId,
				taskId,
				startedByKey: input.key,
				model: { provider: model.provider, modelId: model.modelId },
				thinkingLevel,
				onFinish: input.onFinish,
				status: input.coordinator && moved.length === 0 ? "idle" : "running",
				summary: null,
				failure: null,
				createdAt: now,
				updatedAt: now,
				finishedAt: null,
				archived: false,
				autoArchive: input.startedBy === "schedule",
				checkout: place.checkout,
				checkoutKind: place.kind,
			};
			doc.threads[id] = created;
			doc.createdAt ??= now;
			// Registered inside the commit: the thread's first turn cannot run before its tools know it.
			this.#options.coordinators.add(this.placeFor(created));
			if (input.coordinator) await this.#rosterNote(tx, id, conversation.id, title, "created", input.coordinator.area);
			if (!input.coordinator || moved.length > 0) await tx.createTask(
				ThreadKickoff,
				{ conversationId: conversation.id, content: input.coordinator ? moved.map(change => `[board] The user moved ${change.after.id} to you.`).join("\n") : input.brief, requestId: `thread-brief:${input.key}` },
				background,
			);
			await this.#options.workers.startCheckIn(tx, workers, parentId, checkIn);
			return { record: JSON.parse(JSON.stringify(created)) as ThreadRecord, notices: move?.notices ?? [], existed: false };
		});
		// The kickoff is a background task; outside a run nothing would pick it up without this.
		this.#options.harness.resume();
		await this.#watch(record);
		if (input.coordinator?.taskIds?.length) await this.#options.board.deliverUserMoveNotices();
		this.#changed();
		return { ok: true, record, existed, notices };
	}

	/**
	 * Start the thread of a scheduled run: ID `<scheduleId>-<yyyy-mm-dd-hhmm>` in the backend's timezone, so a retried
	 * slot finds the thread it already started.
	 */
	async create(input: CoordinatorCreate, key: string, commit?: <T>(change: (tx: Tx) => Promise<T>) => Promise<T>): Promise<ThreadSummary> {
		const title = requiredText(input.title, "Title");
		const area = requiredText(input.area, "Area");
		const started = await this.start({ title, brief: "", model: input.model ?? null,
			thinkingLevel: input.thinkingLevel ?? null, onFinish: "record", startedBy: "user", scheduleId: null,
			taskId: null, key: `coordinator:${key}`, coordinator: { ...input, title, area } }, commit);
		if (!started.ok) throw new ServerError("bad_request", started.message);
		return this.summaryOf(started.record);
	}

	/** Select from the durable roster in the same commit as each queue update. */
	async queueCoordinatorNotes(tx: Tx, notes: readonly PendingCoordinatorNote[], excludedConversation?: number, workspaceOnly = false) {
		const doc = await tx.doc(ThreadsDoc, this.#mainId);
		if (!workspaceOnly && this.#mainId !== excludedConversation) await enqueueCoordinatorNotes(tx, this.#mainId, notes);
		for (const record of Object.values(doc.threads)) {
			if (record.kind === "coordinator" && !record.archived && record.conversationId !== excludedConversation) {
				await enqueueCoordinatorNotes(tx, record.conversationId as ConversationId, notes);
			}
		}
	}

	async isHeld(tx: Tx, conversationId: ConversationId): Promise<boolean> {
		const threadId = this.coordinators.threadIdOf(conversationId);
		if (!threadId || threadId === MAIN_THREAD_ID) return false;
		return (await tx.doc(ThreadsDoc, this.#mainId)).threads[threadId]?.held === true;
	}

	async #rosterNote(tx: Tx, threadId: string, conversationId: number, title: string, action: string, area?: string) {
		await this.queueCoordinatorNotes(tx, [{ channel: "coordinators", key: `${threadId}:${action}`,
			line: `${noteField(title)} (${noteField(threadId)}) ${action}${area === undefined ? "" : ` — ${noteField(area, 240).replace(/[.!?]+$/, "")}`}.` }], conversationId);
	}

	async update(threadId: string, input: Omit<ThreadsUpdateRequest, "type" | "id" | "projectId" | "threadId">): Promise<ThreadSummary> {
		const title = input.title === undefined ? undefined : requiredText(input.title, "Title");
		const area = input.area === undefined ? undefined : requiredText(input.area, "Area");
		const { model, thinkingLevel, workerModel, color, paths, order } = input;
		const changesModelSettings = model !== undefined || thinkingLevel !== undefined || workerModel !== undefined;
		if (model && (isWorkerOnlyModel(this.#options.models, model) || !this.#options.models.getModel(model.provider, model.modelId))) {
			throw new ServerError("bad_request", "Choose a valid coordinator model.");
		}
		if (workerModel && !this.#options.models.getModel(workerModel.provider, workerModel.modelId)) {
			throw new ServerError("bad_request", "Choose a valid worker model.");
		}
		await this.#options.harness.commit(async tx => {
			const doc = await tx.doc(ThreadsDoc, this.#mainId);
			if (threadId === MAIN_THREAD_ID) {
				if (input.promote) throw new ServerError("bad_request", "General is already a coordinator.");
				if (changesModelSettings || paths !== undefined || order !== undefined) throw new ServerError("bad_request", "Only title, area and color can be edited for General here.");
				if (title === undefined && area === undefined && color === undefined) return;
				doc.main ??= { ...GENERAL };
				if (!applyLifecycleOperation(doc.main, "update", input.operationId)) return;
				if (title !== undefined && title !== doc.main.title) {
					doc.main.title = title;
					await this.#rosterNote(tx, threadId, this.#mainId, title, "renamed");
				}
				if (area !== undefined && area !== doc.main.area) {
					doc.main.area = area;
					await this.#rosterNote(tx, threadId, this.#mainId, doc.main.title, "re-scoped", area);
				}
				if (color !== undefined) doc.main.color = color;
				if (title !== undefined || area !== undefined) await configure(tx, this.#mainId, { instructions: mainThreadInstructions(this.project, doc.main) });
				return;
			}
			const record = doc.threads[threadId];
			if (!record) throw new ServerError("bad_request", "Choose a coordinator or job.");
			if (!applyLifecycleOperation(record, "update", input.operationId)) return;
			if (changesModelSettings && isThreadArchived(normalizeThreadRecord(record), this.now())) {
				throw new ServerError("bad_request", "Restore this thread before changing its model settings.");
			}
			const promoting = input.promote === true && record.kind !== "coordinator";
			if (promoting) {
				if (area === undefined || isThreadArchived(normalizeThreadRecord(record), this.now())) throw new ServerError("bad_request", "Choose an area and restore the job before keeping it as a coordinator.");
				record.kind = "coordinator";
				delete record.parentThreadId;
				record.autoArchive = false;
				record.order = Math.max(0, ...Object.values(doc.threads).map(thread => thread.order ?? 0)) + 1;
				if (record.status !== "running") record.status = "idle";
				record.finishedAt = null;
				record.failure = null;
			} else if (record.kind !== "coordinator" && (!changesModelSettings ||
				[title, area, color, paths, order].some(field => field !== undefined))) {
				throw new ServerError("bad_request", "Only model settings can be edited for a job.");
			}
			const before = JSON.stringify(record);
			const renamed = title !== undefined && title !== record.title;
			const rescoped = (area !== undefined && area !== record.area) || (paths !== undefined && JSON.stringify(paths) !== JSON.stringify(record.paths));
			if (title !== undefined) record.title = title;
			if (area !== undefined) record.area = area;
			if (color !== undefined) record.color = color;
			if (paths !== undefined) record.paths = paths;
			if (order !== undefined) record.order = order;
			if (model !== undefined) record.model = model;
			if (thinkingLevel !== undefined) record.thinkingLevel = thinkingLevel;
			if (workerModel === null) delete record.workerModel;
			else if (workerModel !== undefined) record.workerModel = workerModel;
			if (before !== JSON.stringify(record)) record.updatedAt = new Date(this.now()).toISOString();
			if (promoting) await this.#rosterNote(tx, threadId, record.conversationId, record.title, "kept as a coordinator", area);
			else if (renamed) await this.#rosterNote(tx, threadId, record.conversationId, record.title, "renamed");
			if (rescoped && !promoting) await this.#rosterNote(tx, threadId, record.conversationId, record.title, "re-scoped", record.area);
			if (promoting || title !== undefined || area !== undefined || model !== undefined || thinkingLevel !== undefined) {
				await configure(tx, record.conversationId as ConversationId, {
					model: record.model, thinkingLevel: record.thinkingLevel,
					...(promoting ? { extensions: this.extensionsFor("coordinator") } : {}),
					instructions: threadInstructions({ ...record, project: this.project }),
				});
			}
		}, BACKGROUND_CONTEXT);
		const state = await this.state();
		const updated = state.threads[threadId];
		if (updated && (input.promote || model !== undefined || workerModel !== undefined)) this.coordinators.add(this.placeFor(updated));
		this.#changed();
		return threadId === MAIN_THREAD_ID ? this.#mainSummary(state, this.now()) : this.summaryOf(updated!);
	}

	async submitHarness(conversation: Conversation, draft: SubmissionDraft, content: UserInput, requestId: string, context = BACKGROUND_CONTEXT) {
		if (this.coordinators.placeOf(conversation.id)?.kind !== "coordinator" || this.coordinators.isMain(conversation.id)) {
			return conversation.submit(draft, context);
		}
		const id = await this.#options.harness.commit(async tx =>
			await this.coordinators.queueWhileHeld?.(tx, conversation.id, content, requestId) ? undefined : conversation.submit(tx, draft), context);
		if (id === undefined) return undefined;
		this.#options.harness.resume();
		return this.#options.harness.submission(id, context);
	}

	async submitOwner(conversation: Conversation, draft: InputSubmissionDraft) {
		const place = this.coordinators.placeOf(conversation.id);
		if (!place || place.kind !== "coordinator" || place.threadId === MAIN_THREAD_ID) return conversation.submit(draft, BACKGROUND_CONTEXT);
		await this.revive(place.threadId);
		const id = await this.#options.harness.commit(async tx => {
			const record = (await tx.doc(ThreadsDoc, this.#mainId)).threads[place.threadId]!;
			const requestId = draft.requestId;
			const existing = requestId ? await tx.submissionByRequest(conversation.id, requestId) : undefined;
			if (existing) return existing.id;
			if (record.held) {
				const items = record.heldInputs ?? [];
				const queued = heldText(items);
				const peerData = heldPeerData(items, draft.content);
				this.#clearHold(record);
				await this.#rosterNote(tx, place.threadId, conversation.id, record.title, "resumed");
				if (queued) return conversation.submit(tx, { ...draft, ...(peerData && draft.entry ? { entry: { ...draft.entry, data: peerData } } : {}), whenBusy: "followUp", content: typeof draft.content === "string"
					? typeof queued === "string" ? `${draft.content}\n\n${queued}` : [{ type: "text", text: draft.content }, ...queued]
					: [...draft.content, ...(typeof queued === "string" ? [{ type: "text" as const, text: queued }] : queued)] });
			}
			return conversation.submit(tx, draft);
		}, BACKGROUND_CONTEXT);
		this.#options.harness.resume();
		return (await this.#options.harness.submission(id, BACKGROUND_CONTEXT))!;
	}

	#clearHold(record: StoredThreadRecord): void {
		record.held = false;
		record.heldAt = null;
		record.heldInputs = [];
		record.updatedAt = new Date(this.now()).toISOString();
	}

	async hold(threadId: string, held: boolean, requestId: string): Promise<ThreadSummary> {
		const current = await this.#requireBackground(threadId);
		const conversation = await this.conversation(threadId);
		await this.#options.harness.commit(async tx => {
			const roster = await tx.doc(ThreadsDoc, this.#mainId);
			const record = roster.threads[threadId]!;
			if (record.kind !== "coordinator" || record.archived) throw new ServerError("bad_request", "Only an unarchived coordinator can be paused.");
			if (!applyLifecycleOperation(record, "hold", requestId) || (record.held ?? false) === held) return;
			await this.#rosterNote(tx, threadId, conversation.id, record.title, held ? "paused" : "resumed");
			if (held) {
				record.held = true;
				record.heldAt = record.updatedAt = new Date(this.now()).toISOString();
				await this.#advanceLandingTurn(tx, roster, threadId);
				// Take not-yet-placed inputs away from the turn boundary. Their content is admitted together on resume.
				const inbox = await tx.doc(InboxDoc, conversation.id);
				for (const item of inbox.items) {
					if (item.mode === "write") continue;
					record.heldInputs ??= [];
					record.heldInputs.push({ content: item.content, requestId: `submission:${item.id}`, ...(item.entry ? { entry: item.entry } : {}) });
					tx.settleSubmission(item.id, { status: "unanswered", reason: "held" });
				}
				inbox.items = inbox.items.filter(item => item.mode === "write");
			} else {
				const items = record.heldInputs ?? [];
				const content = heldText(items);
				const peerData = heldPeerData(items);
				this.#clearHold(record);
				if (content) await conversation.submit(tx, { type: "input", content, whenBusy: "followUp", requestId: `thread-resume:${requestId}`, ...(peerData ? { entry: { kind: THREAD_MESSAGE_ENTRY, data: peerData } } : {}) });
			}
		}, BACKGROUND_CONTEXT);
		this.#landingTurnChanged();
		return this.summaryOf((await this.record(threadId)) ?? current);
	}

	extensionsFor(kind: ThreadKind) {
		return {
			add: [mcpRoleExtension(kind === "coordinator" ? "coordinator" : "background")],
			remove: [mcpRoleExtension("workers"), ...this.#options.removedExtensions(kind),
				...(kind === "coordinator" ? [mcpRoleExtension("background"), this.finishExtension] : [mcpRoleExtension("coordinator"), this.startExtension])],
		};
	}

	async requireScheduleOwner(tx: Tx, threadId: string): Promise<void> {
		if (threadId === MAIN_THREAD_ID) return;
		const owner = (await tx.doc(ThreadsDoc, this.#mainId)).threads[threadId];
		if (owner?.kind !== "coordinator" || owner.archived || owner.held) throw new ServerError("bad_request", "The schedule owner is paused or unavailable.");
	}

	async startScheduled(run: ScheduledThreadInput): Promise<ThreadStartResult> {
		const safe = run.scheduleId.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 32);
		return this.start({
			title: run.title,
			brief: run.brief,
			model: run.model,
			thinkingLevel: run.thinkingLevel,
			onFinish: run.onFinish,
			startedBy: "schedule",
			...(run.ownerThreadId === undefined ? {} : { parentThreadId: run.ownerThreadId }),
			scheduleId: run.scheduleId,
			taskId: run.event?.taskId ?? null,
			key: `schedule:${run.scheduleId}:${run.event?.key ?? new Date(run.at).toISOString()}`,
			id: run.event?.id ?? `${safe}-${formatRunStamp(run.at, run.timezone)}`.slice(0, 48),
		});
	}

	// --- stopping, archiving, reviving ---------------------------------------------------------------------------

	/** Stop a background thread: its running workers and its turn are aborted, its open tasks released. */
	async stopThread(threadId: string): Promise<ThreadSummary> {
		const record = await this.#requireBackground(threadId);
		if (record.status !== "done" && record.status !== "stopped") {
			const workers = await this.#options.workers.runningWorkers(BACKGROUND_CONTEXT, record.conversationId);
			for (const worker of workers) {
				const conversation = await this.#options.harness.conversation(
					worker.conversationId as ConversationId,
					BACKGROUND_CONTEXT,
				);
				await conversation?.abort(BACKGROUND_CONTEXT).catch(() => undefined);
			}
			if (workers.length > 0) {
				await this.#options.harness.commit(async (tx) => {
					const doc = await tx.doc(WorkersDoc, record.conversationId as ConversationId);
					for (const worker of workers) {
						const current = doc.workers[worker.id];
						if (current === undefined || current.status !== "running") continue;
						current.status = "stopped";
						current.updatedAt = new Date(this.#options.now()).toISOString();
					}
				}, BACKGROUND_CONTEXT);
			}
			const conversation = await this.conversation(threadId);
			await conversation.abort(BACKGROUND_CONTEXT, { background: true }).catch((error: unknown) => {
				this.#options.log(`thread ${threadId}: abort failed: ${errorMessage(error)}`);
			});
			await this.#update(threadId, (current) => {
				current.status = "stopped";
			}, true);
			if (record.kind === "job") await this.#options.board.releaseThread(threadId, `stopped:${threadId}:${record.updatedAt}`, record.taskId);
		}
		return this.summaryOf((await this.record(threadId)) as ThreadRecord);
	}

	/** Removes an archived thread's checkout and its workers' workspaces; attached by the runtime. */
	attachStorage(storage: { removeThread(threadId: string): Promise<void> }): void {
		this.#storage = storage;
	}

	/**
	 * Archive a thread that no longer works, or bring one back (which also stops it archiving itself). Archiving removes
	 * its checkout and its idle workers' workspaces in the background; its commits stay in the repository.
	 */
	async archive(threadId: string, archived: boolean, moveTasksTo?: string, operationId?: string, schedules: "move" | "disable" = "move"): Promise<ThreadSummary> {
		const record = await this.#requireBackground(threadId);
		if (moveTasksTo !== undefined && record.kind !== "coordinator") throw new ServerError("bad_request", "Only coordinators can move tasks on archive.");
		if (record.kind === "job" && archived && isLive(record.status)) {
			throw new ServerError("bad_request", `Thread "${threadId}" is still ${record.status}; stop it before archiving it.`, { threadId });
		}
		if (!archived) {
			await this.#settleArchivedSchedules(record);
			await this.#ensureCheckout(threadId);
		}
		if (record.kind === "coordinator") {
			const to = moveTasksTo ?? MAIN_THREAD_ID;
			await this.#options.harness.commit(async tx => {
				const doc = await tx.doc(ThreadsDoc, this.#mainId);
				const current = doc.threads[threadId]!;
				if (!applyLifecycleOperation(current, "archive", operationId) || current.archived === archived) return;
				if (archived) {
					const live = await tx.doc(LiveDoc, current.conversationId as ConversationId);
					const workers = await tx.doc(WorkersDoc, current.conversationId as ConversationId);
					if (live.run || Object.values(workers.workers).some(worker => worker.status === "running")) throw new ServerError("bad_request", "Wait for this coordinator and its workers to finish before archiving.");
					if (to === threadId || (to !== MAIN_THREAD_ID && (doc.threads[to]?.kind !== "coordinator" || doc.threads[to]?.archived))) throw new ServerError("bad_request", "Choose another unarchived coordinator.");
					for (const job of Object.values(doc.threads)) {
						if (job.kind === "coordinator" || job.parentThreadId !== threadId || job.archived) continue;
						const child = await tx.doc(LiveDoc, job.conversationId as ConversationId);
						const childWorkers = await tx.doc(WorkersDoc, job.conversationId as ConversationId);
						if (job.status === "running" || child.run || Object.values(childWorkers.workers).some(worker => worker.status === "running")) throw new ServerError("bad_request", "Wait for this coordinator’s background jobs to finish before archiving.");
					}
					current.archiveSchedules = schedules;
					const board = await openBoard(tx, this.#mainId);
					const now = new Date(this.now()).toISOString();
					for (const task of board.tasks) {
						if (task.status === "done" || task.status === "dropped" || this.coordinators.coordinatorId(task.ownerThreadId) !== threadId) continue;
						const change = moveTaskToCoordinator(board, task.id, to, now);
						queueUserMoveNotices(board, change, undefined, to, to === MAIN_THREAD_ID ? doc.main?.title ?? GENERAL.title : doc.threads[to]!.title);
					}
				}
				current.archived = archived;
				if (archived) await this.#advanceLandingTurn(tx, doc, threadId);
				await this.#rosterNote(tx, threadId, current.conversationId, current.title, archived ? "archived" : "restored");
				current.updatedAt = new Date(this.now()).toISOString();
			}, BACKGROUND_CONTEXT);
			this.#landingTurnChanged();
			await this.#options.board.deliverUserMoveNotices();
		} else {
			await this.#update(threadId, current => { current.archived = archived; if (!archived) current.autoArchive = false; });
		}
		const saved = (await this.record(threadId))!;
		if (saved.archived !== archived) return this.summaryOf(saved);
		if (archived) await this.#settleArchivedSchedules(saved);
		const watch = this.#watches.get(threadId);
		if (archived && watch !== undefined) {
			this.#watches.delete(threadId);
			await watch.stop().catch(() => undefined);
		} else if (!archived) {
			await this.#ensureCheckout(threadId);
			await this.#watch((await this.record(threadId)) as ThreadRecord);
		}
		if (archived) {
			await this.#storage?.removeThread(threadId).catch((error: unknown) => {
				this.#options.log(`thread ${threadId}: could not remove its workspaces: ${errorMessage(error)}`);
			});
		}
		return this.summaryOf((await this.record(threadId)) as ThreadRecord);
	}

	async #settleArchivedSchedules(record: ThreadRecord): Promise<void> {
		if (!record.archived || record.archiveSchedules === undefined) return;
		await this.#options.archiveSchedules?.(record.id, record.archiveSchedules);
		await this.#update(record.id, current => { if (current.archived) delete current.archiveSchedules; });
	}

	/**
	 * Someone wrote to a finished or stopped thread (the user from the app, or a thread's message): it works again, so
	 * its status follows its transcript from now on. An archived thread comes back to the list.
	 */
	async revive(threadId: string): Promise<void> {
		if (threadId === MAIN_THREAD_ID) return;
		const record = await this.record(threadId);
		if (record === undefined || (isLive(record.status) && !record.archived)) return;
		await this.#ensureCheckout(threadId);
		await this.#update(threadId, (current) => {
			if (current.status === "done" || current.status === "stopped" || current.status === "failed") current.status = "running";
			current.archived = false;
			current.failure = null;
		});
		await this.#watch((await this.record(threadId)) as ThreadRecord);
	}

	async #requireBackground(threadId: string): Promise<ThreadRecord> {
		if (threadId === MAIN_THREAD_ID) {
			throw new ServerError("bad_request", "Main is the thread the user talks to; it cannot be stopped or archived.", {
				threadId,
			});
		}
		const record = await this.record(threadId);
		if (record === undefined) {
			throw new ServerError("unknown_thread", `No thread "${threadId}" in this project`, { threadId });
		}
		return record;
	}

	// --- finishing and messages ----------------------------------------------------------------------------------

	/** `thread_finish`: record the summary and post it to main, once per call. */
	async finish(record: ThreadRecord, summary: string, callId: string): Promise<void> {
		const now = new Date(this.#options.now()).toISOString();
		await this.#update(record.id, (current) => {
			if (current.kind === "coordinator") throw new ServerError("bad_request", "Only background jobs can finish.");
			current.status = "done";
			current.summary = summary;
			current.failure = null;
			current.finishedAt = now;
		});
		await this.#post(record, `[thread ${record.id} finished]\n${summary}`, `thread-finished:${record.id}:${callId}`);
		await this.#options.board.releaseThread(record.id, `finished:${record.id}:${callId}`, record.taskId);
		const project = this.project;
		this.#options.notifications?.notify(
			threadFinishedNotification({
				projectId: project.id,
				projectName: project.name,
				threadId: record.id,
				title: record.title,
				summary,
				callId,
				scheduleId: record.scheduleId,
				coordinatorId: record.parentThreadId,
			}),
		);
	}

	async messages({ before, limit = 50, taskId }: Pick<ThreadsMessagesRequest, "before" | "limit" | "taskId">) {
		const doc = await this.#options.harness.snapshot(ThreadMessagesDoc, this.#mainId, BACKGROUND_CONTEXT);
		const messages = doc?.messages ?? [];
		const end = before === undefined ? messages.length : messages.findIndex(message => message.id === before);
		const matching = messages.slice(0, Math.max(end, 0)).reverse().filter(message => taskId === undefined || message.taskId === taskId);
		const page = matching.slice(0, limit);
		return { messages: page, ...(matching.length > page.length ? { nextBefore: page.at(-1)!.id } : {}) };
	}

	/** Commit delivery admission, reply matching and task history together. The submission also deduplicates pruned rows. */
	async deliver(input: { sender: string; receiver: string; message: string; kind?: ThreadMessageKind; awaitReply?: boolean; taskId?: string; reply?: boolean; callId: string }): Promise<"steered" | "written"> {
		const { harness } = this.#options;
		const conversation = await this.conversation(input.receiver);
		const id = `thread-message:${input.callId}`;
		const kind = input.kind ?? (input.reply ? "reply" : "request");
		const awaitReply = kind === "request" && input.awaitReply === true;
		const result = await harness.commit(async tx => {
			const doc = await tx.doc(ThreadMessagesDoc, this.#mainId);
			const roster = await tx.doc(ThreadsDoc, this.#mainId);
			const receiver = roster.threads[input.receiver];
			if (doc.messages.some(message => message.id === id) || await tx.submissionByRequest(conversation.id, id)
				|| receiver?.heldInputReceipts?.includes(id)) return undefined;
			if (receiver?.archived) throw new ServerError("bad_request", "The receiving thread is archived.");
			const answeredRequest = kind === "reply" ? doc.messages.findLast(message => message.kind === "request"
				&& message.awaitReply && !message.replied && message.from === input.receiver && message.to === input.sender
				&& (input.taskId === undefined || message.taskId === input.taskId)) : undefined;
			const taskId = input.taskId ?? answeredRequest?.taskId;
			const board = taskId === undefined ? undefined : await openBoard(tx, this.#mainId);
			const task = board?.tasks.find(task => task.id === taskId);
			if (taskId !== undefined && task === undefined) throw new ServerError("unknown_task", `No task "${taskId}" in this project.`);
			const now = this.now();
			const message: ThreadMessage = { id, from: input.sender, to: input.receiver, kind,
				...(awaitReply ? { awaitReply, replied: false } : {}), ...(taskId === undefined ? {} : { taskId }),
				firstLine: input.message.trim().split(/\r?\n/, 1)[0]!.slice(0, 240), text: input.message, at: new Date(now).toISOString() };
			const metadata = [awaitReply ? "request awaits reply" : kind === "note" ? "note" : "", taskId ? `task ${taskId}` : ""].filter(Boolean);
			const content = `[from ${input.sender}] ${metadata.length ? `[${metadata.join("; ")}]\n` : ""}${input.message}`;
			const wakes = kind === "request" || answeredRequest !== undefined;
			const live = await tx.doc(LiveDoc, conversation.id);
			const peerWake = wakes && live.run === undefined && (input.sender === MAIN_THREAD_ID || roster.threads[input.sender]?.kind === "coordinator")
				&& (input.receiver === MAIN_THREAD_ID || receiver?.kind === "coordinator");
			const entry = { kind: THREAD_MESSAGE_ENTRY, data: { threadMessageId: id, peerWake } };
			const written = kind === "note" || (!wakes && live.run === undefined);
			const held = receiver?.held === true && !written;
			if (held) queueHeldInput(receiver, content, id, entry);
			else await conversation.submit(tx, written ? {
				type: "write", entry: { ...entry, model: [{ role: "user", content, timestamp: now }] }, requestId: id,
			} : { type: "input", content, whenBusy: "steer", entry, requestId: id });
			if (answeredRequest) Object.assign(answeredRequest, { replied: true, replyId: id });
			doc.messages.push(message);
			if (doc.messages.length > THREAD_MESSAGE_LIMIT) doc.messages.splice(0, doc.messages.length - THREAD_MESSAGE_LIMIT);
			if (task) {
				const history = await openTaskHistory(tx, this.#mainId, task.id);
				const title = (threadId: string) => threadId === MAIN_THREAD_ID ? roster.main?.title ?? GENERAL.title : roster.threads[threadId]?.title ?? threadId;
				upsertTimelineFact(history, task, { id: timelineId(task.id, id), at: message.at, endAt: message.at,
					kind: "milestone", group: "work", source: "thread-message", outcome: kind,
					label: `${title(input.sender)} → ${title(input.receiver)}`, detail: message.firstLine, ref: id, by: HARNESS_WRITER });
			}
			return { message: { ...message }, answeredRequest: answeredRequest && { ...answeredRequest }, wakes: wakes && !held, written: written || held };
		}, BACKGROUND_CONTEXT);
		if (!result) return "written";
		try {
			if (result.wakes) await this.revive(input.receiver);
		} finally {
			harness.resume();
			this.#options.onMessage?.({ type: "threads.message", projectId: this.project.id, message: result.message,
				...(result.answeredRequest ? { answeredRequest: result.answeredRequest } : {}) });
		}
		await this.#options.board.recordReportChat(input.sender, input.message, id);
		return result.written ? "written" : "steered";
	}

	/** A bounded digest of one thread (or main), for `thread_peek`. */
	async peek(threadId: string, entries: number, now: number, maxChars: number = THREAD_PEEK_MAX_CHARS): Promise<string> {
		const record = threadId === MAIN_THREAD_ID ? this.#mainRecord(await this.state()) : await this.record(threadId);
		if (record === undefined) throw new ServerError("unknown_thread", `No thread "${threadId}" in this project`, { threadId });
		return this.#describe(record, { entries, lines: Math.max(entries, 4), lineChars: THREAD_PEEK_LINE_CHARS, maxChars }, now);
	}

	/** Main as a record, so `thread_peek main` reads like any other thread. */
	#mainRecord(state: ThreadsState): ThreadRecord {
		const project = this.project;
		const summary = this.#mainSummary(state, this.#options.now());
		return {
			id: MAIN_THREAD_ID,
			kind: "coordinator",
			parentThreadId: MAIN_THREAD_ID,
			title: state.main.title,
			brief: "",
			conversationId: this.#mainId as number,
			anchorTaskId: 0,
			startedBy: "user",
			scheduleId: null,
			startedByKey: "",
			model: project.coordinator.model ?? { provider: "none", modelId: "none" },
			thinkingLevel: project.coordinator.thinkingLevel,
			onFinish: "review",
			status: summary.status,
			summary: null,
			failure: null,
			createdAt: summary.createdAt,
			updatedAt: summary.updatedAt,
			finishedAt: null,
			archived: false,
			autoArchive: false,
			checkout: project.path,
			checkoutKind: "directory",
		};
	}

	async #describe(
		record: ThreadRecord,
		budget: { entries: number; lines: number; lineChars: number; maxChars: number },
		now: number,
	): Promise<string> {
		const conversationId = record.conversationId as ConversationId;
		const live = await this.#options.harness.snapshot(LiveDoc, conversationId, BACKGROUND_CONTEXT);
		const conversation = await this.#options.harness.conversation(conversationId, BACKGROUND_CONTEXT);
		const page = await conversation?.entries(
			{ order: "descending" },
			Math.max(budget.entries * 3, 12),
			undefined,
			BACKGROUND_CONTEXT,
		);
		const workers = this.#workersOf(record.id);
		const activity = record.id === MAIN_THREAD_ID ? this.#options.mainActivity() : this.#activities.get(record.id);
		const running = workers.filter((worker) => worker.status === "running").length;
		// Read fresh rather than from the last pushed board: the time in progress grows between board changes.
		const board = await this.#options.board.get();
		return describeThreadActivity({
			record,
			entries: page?.items ?? [],
			live,
			workers,
			ownedTasks: board.tasks
				.filter((task) => (task.ownerThreadId ?? null) === record.id && !task.archived)
				.map((task) => {
					const time = task.status === "in_progress" ? taskTime(task) : undefined;
					return time === undefined ? task.id : `${task.id} (${time})`;
				}),
			openQuestions: this.#openQuestions(record.id),
			current: currentLine(record.status, activity, running, now),
			now,
			lines: budget.lines,
			lineChars: budget.lineChars,
			maxChars: budget.maxChars,
		});
	}

	/** What a coordinator’s check-ins cover: its running jobs whose summary it reviews (a `record` one must not wake it). */
	async #checkInThreads(parentThreadId: string): Promise<ThreadRecord[]> {
		const now = this.#options.now();
		return Object.values((await this.state()).threads).filter(
			(record) => record.kind === "job" && record.parentThreadId === parentThreadId && record.status === "running" && record.onFinish === "review" && !isThreadArchived(record, now),
		);
	}

	/** Each coordinator’s check-ins: its running jobs, and a short digest of each. Attached to the worker service. */
	get checkIns(): { running(parentThreadId: string, context: Context): Promise<number>; digests(parentThreadId: string, now: number, maxChars: number, context: Context): Promise<string[]> } {
		return {
			running: async parentThreadId => (await this.#checkInThreads(parentThreadId)).length,
			digests: async (parentThreadId, now, maxChars) => {
				const digests: string[] = [];
				for (const record of await this.#checkInThreads(parentThreadId)) {
					digests.push(
						await this.#describe(
							record,
							{
								entries: THREAD_CHECK_IN_ENTRIES,
								lines: THREAD_CHECK_IN_ENTRIES,
								lineChars: THREAD_CHECK_IN_LINE_CHARS,
								maxChars,
							},
							now,
						),
					);
				}
				return digests;
			},
		};
	}

	/** Running workers of one thread, from the worker watch. */
	runningWorkersOf(threadId: string): WorkerSummary[] {
		return this.#workersOf(threadId).filter((worker) => worker.status === "running");
	}

	log(message: string): void {
		this.#options.log(message);
	}

	now(): number {
		return this.#options.now();
	}
}

// --- the tools ---------------------------------------------------------------------------------------------------

const modelRefSchema = Type.Object({
	provider: Type.String({ minLength: 1, description: 'For example "anthropic".' }),
	modelId: Type.String({ minLength: 1 }),
});

const thinkingLevelSchema = Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)));

function describeRecordLine(summary: ThreadSummary): string {
	const parts = [`${summary.id} — ${summary.title} (${summary.kind ?? "job"})`, `  status: ${summary.status}${summary.current === null ? "" : `; ${summary.current}`}`];
	if (summary.kind === "coordinator") parts.push(`  area: ${summary.area ?? ""}; paths: ${summary.paths?.join(", ") || "none"}; held: ${summary.held ?? false}`);
	if (summary.kind === "job") {
		parts.push(
			`  started by ${summary.startedBy ?? "main"}${summary.scheduleId === null ? "" : ` (schedule ${summary.scheduleId})`}; summary is ${summary.onFinish === "review" ? "reviewed" : "recorded"}`,
		);
	}
	parts.push(
		`  workers running: ${summary.runningWorkers}; open tasks: ${summary.openTasks ?? 0}; tasks: ${summary.ownedTasks.length === 0 ? "none" : summary.ownedTasks.join(", ")}; open questions: ${summary.openQuestions}`,
	);
	if (summary.failure !== null) parts.push(`  failure: ${excerpt(summary.failure, 200)}`);
	if (summary.summary !== null) parts.push(`  summary: ${excerpt(summary.summary, 240)}`);
	if (summary.archived) parts.push("  archived");
	return parts.join("\n");
}

function createThreadStartExtension(service: ThreadService): Extension {
	const onlyMain = (tool: string): string =>
		`${tool} is main's: only the thread the user talks to starts, stops and archives background threads. A background thread cannot start threads (one level only); use workers, or ask main with thread_send.`;

	const coordinatorStart = defineTool({
		name: "coordinator_start", callers: ["model"], replay: "safe",
		description: "Create an idle coordinator for a lasting area when the owner asks. Only General can do this.",
		parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 120 }), area: Type.String({ minLength: 1, maxLength: 2000 }),
			paths: Type.Optional(Type.Array(Type.String())), model: Type.Optional(modelRefSchema), thinkingLevel: Type.Optional(thinkingLevelSchema) }),
		execute: async (args, api, context) => {
			if (!service.coordinators.isMain(api.conversationId)) return toolText(onlyMain("coordinator_start"), { isError: true });
			try {
				const thread = await service.create(args, `tool:${api.callId}`, change => api.commit(change, context));
				return toolText(`Coordinator ${thread.title} (${thread.id}) is ready. It waits for a message or a task.`, { details: { threadId: thread.id, conversationId: thread.conversationId } });
			} catch (error) { return toolText(errorMessage(error), { isError: true }); }
		},
	});
	const startTool = defineTool({
		name: "thread_start",
		callers: ["model"],
		description:
			"Start a background thread: a full coordinator (its own workers, the shared board, memory) for big, long work, " +
			"working in its own workspace, never in your checkout. It gets the brief as its first message and works on its " +
			'own; its summary arrives as a message starting with "[thread <id> finished]". Use a worker for one self-contained task.',
		parameters: Type.Object({
			title: Type.String({ minLength: 1, maxLength: 120, description: "One line naming the work; the thread's ID is made from it." }),
			brief: Type.String({
				minLength: 1,
				description: "The complete brief: goal, scope, constraints, how to verify, what the summary must say. The thread never sees this conversation.",
			}),
			model: Type.Optional(modelRefSchema),
			thinkingLevel: Type.Optional(thinkingLevelSchema),
			onFinish: Type.Optional(
				Type.Union([Type.Literal("review"), Type.Literal("record")], {
					description: '"review" (default): its summary wakes you to review it. "record": the summary is kept for your next turn without waking you.',
				}),
			),
			taskId: Type.String({
				minLength: 1,
				description: "The board task (T3) the thread works on: it claims the task, moves it to in_progress and keeps its report. Add the task first.",
			}),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const parent = service.coordinators.placeOf(api.conversationId);
			if (parent?.kind !== "coordinator") return toolText("Only coordinators can start background jobs; jobs cannot start jobs.", { isError: true });
			const started = await service.start(
				{
					title: args.title,
					brief: args.brief,
					model: args.model ?? null,
					thinkingLevel: args.thinkingLevel ?? null,
					onFinish: args.onFinish ?? "review",
					startedBy: "main",
					parentThreadId: parent.threadId,
					scheduleId: null,
					taskId: args.taskId,
					key: api.callId,
				},
				(change) => api.commit(change, context),
			);
			if (!started.ok) return toolText(started.message, { isError: true });
			const { record } = started;
			const details = { threadId: record.id, conversationId: record.conversationId };
			await api.details(details, context);
			if (started.existed) return toolText(`Background thread "${record.id}" is already started (${record.status}).`, { details });
			return toolText(
				`Started background thread "${record.id}" on ${record.model.provider}/${record.model.modelId}, working in ${record.checkout}. ` +
					`It works on its own: its summary arrives as "[thread ${record.id} finished]" (or "[thread ${record.id} failed: ...]"). ` +
					`Look in with thread_peek, steer it with thread_send, stop it with thread_stop; keep going meanwhile.${started.notices?.length ? ` ${started.notices.join(" ")}` : ""}`,
				{ details },
			);
		},
	});

	const stopTool = defineTool({
		name: "thread_stop",
		callers: ["model"],
		description:
			"Stop a background thread: its running turn and workers are aborted and the board tasks it held are released, " +
			"so you can take the work over. A message with thread_send wakes it again.",
		parameters: Type.Object({ id: Type.String({ minLength: 1, description: "The thread's ID." }) }),
		replay: "unsafe",
		execute: async (args, api, context) => {
			const caller = service.coordinators.placeOf(api.conversationId);
			if (!service.coordinators.isMain(api.conversationId) && (caller?.kind !== "coordinator" || (await service.record(args.id))?.parentThreadId !== caller.threadId)) {
				return toolText("thread_stop is for General or the coordinator that owns the job.", { isError: true });
			}
			try {
				const summary = await service.stopThread(args.id);
				const details = { threadId: summary.id, conversationId: summary.conversationId };
				await api.details(details, context);
				return toolText(`Thread "${summary.id}" is ${summary.status}. Its open tasks are released; claim them to take them over.`, {
					details,
				});
			} catch (error) {
				return toolText(errorMessage(error), { isError: true });
			}
		},
	});

	const archiveTool = defineTool({
		name: "thread_archive",
		callers: ["model"],
		description:
			"Archive a background thread that is done, stopped or failed, so it leaves the list (its transcript stays). " +
			"`archived: false` brings one back.",
		parameters: Type.Object({
			id: Type.String({ minLength: 1, description: "The thread's ID." }),
			archived: Type.Optional(Type.Boolean({ description: "Default true." })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const caller = service.coordinators.placeOf(api.conversationId);
			if (!service.coordinators.isMain(api.conversationId) && (caller?.kind !== "coordinator" || (await service.record(args.id))?.parentThreadId !== caller.threadId)) {
				return toolText("thread_archive is for General or the coordinator that owns the job.", { isError: true });
			}
			try {
				const summary = await service.archive(args.id, args.archived !== false);
				const details = { threadId: summary.id, conversationId: summary.conversationId };
				await api.details(details, context);
				return toolText(`Thread "${summary.id}" is ${summary.archived ? "archived" : "back in the list"}.`, { details });
			} catch (error) {
				return toolText(errorMessage(error), { isError: true });
			}
		},
	});

	return defineExtension({
		name: "thread-start-tools",
		tasks: [ThreadAnchor, ThreadKickoff] as Task<unknown, { phase: string }, unknown, object>[],
		tools: [coordinatorStart, startTool, stopTool, archiveTool] as ToolRegistration[],
	});
}

function createThreadExtension(service: ThreadService): Extension {
	const notCoordinator = (tool: string): string =>
		`${tool} answers only the project's coordinator threads, never a worker. A worker reports to the coordinator that started it.`;

	const listTool = defineTool({
		name: "thread_list",
		description:
			"List the project's threads: main and the background threads, each with its status, what it does now, its " +
			"running workers, the board tasks it holds, its open questions and, once done, its summary.",
		parameters: Type.Object({
			includeArchived: Type.Optional(Type.Boolean({ description: "Also list archived threads." })),
		}),
		replay: "safe",
		execute: async (args, api) => {
			if (!service.coordinators.isCoordinator(api.conversationId)) {
				return toolText(notCoordinator("thread_list"), { isError: true });
			}
			const threads = await service.list(args.includeArchived === true);
			const self = service.threadIdOf(api.conversationId);
			const background = threads.length - 1;
			const header = `You are ${self === MAIN_THREAD_ID ? "main" : `the background thread "${self}"`}. ${
				background === 0 ? "No background threads." : `${background} background thread${background === 1 ? "" : "s"}.`
			}`;
			return toolText(`${header}\n\n${threads.map(describeRecordLine).join("\n\n")}`);
		},
	});

	const peekTool = defineTool({
		name: "thread_peek",
		description:
			"Look at what a thread is doing right now without waiting for its summary: status, what it runs, its workers, " +
			"the tasks it holds and the tail of its transcript, in a few hundred tokens. \"main\" peeks main.",
		parameters: Type.Object({
			id: Type.String({ minLength: 1, description: 'The thread\'s ID; "main" for main.' }),
			entries: Type.Optional(
				Type.Integer({ minimum: 1, maximum: 20, description: `How many recent entries to summarize. Default ${THREAD_PEEK_ENTRIES}.` }),
			),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			if (!service.coordinators.isCoordinator(api.conversationId)) {
				return toolText(notCoordinator("thread_peek"), { isError: true });
			}
			try {
				const text = await service.peek(args.id, args.entries ?? THREAD_PEEK_ENTRIES, api.now());
				const place = service.coordinators.placeOfThread(args.id);
				const details: JsonObject =
					place === undefined ? { threadId: args.id } : { threadId: args.id, conversationId: place.conversationId };
				await api.details(details, context);
				return toolText(text, { details });
			} catch (error) {
				return toolText(errorMessage(error), { isError: true });
			}
		},
	});

	const sendTool = defineTool({
		name: "thread_send",
		callers: ["model"],
		description:
			'Send a message to another coordinator or job ("main" for General). A request wakes it; use awaitReply if you end your turn waiting for the answer. ' +
			'Answer with kind "reply" and the same taskId if present: it wakes only an asker who was waiting. A note never wakes. ' +
			'Use the board to hand off work and memory for lasting facts.',
		parameters: Type.Object({
			id: Type.String({ minLength: 1, description: 'The receiving thread; "main" for General.' }),
			message: Type.String({ minLength: 1 }),
			kind: Type.Optional(Type.Union([Type.Literal("request"), Type.Literal("reply"), Type.Literal("note")], { description: 'Defaults to "request".' })),
			awaitReply: Type.Optional(Type.Boolean({ description: 'On a request, let its reply wake you.' })),
			taskId: Type.Optional(Type.String({ minLength: 1, description: 'The board task the message is about.' })),
			reply: Type.Optional(Type.Boolean({ description: 'Legacy alias for kind "reply" when kind is omitted.' })),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const sender = service.threadIdOf(api.conversationId);
			if (sender === undefined) return toolText(notCoordinator("thread_send"), { isError: true });
			if (args.id === sender) return toolText("That is you; send to another thread.", { isError: true });
			if (args.id !== MAIN_THREAD_ID) {
				const record = await service.record(args.id);
				if (record === undefined) {
					return toolText(`No thread "${args.id}" (unknown_thread). thread_list shows them.`, {
						isError: true,
						details: { code: "unknown_thread", threadId: args.id },
					});
				}
				if (record.archived) {
					return toolText(`Thread "${args.id}" is archived. Start a new one, or ask main to bring it back.`, { isError: true });
				}
			}
			try {
				const how = await service.deliver({
					sender,
					receiver: args.id,
					message: args.message,
					kind: args.kind,
					awaitReply: args.awaitReply,
					taskId: args.taskId,
					reply: args.reply === true,
					callId: api.callId,
				});
				const details = { threadId: args.id, threadMessageId: `thread-message:${api.callId}` };
				await api.details(details, context);
				return toolText(
					how === "written"
						? `Delivered to "${args.id}" without waking it; it reads it at its next turn.`
						: `Delivered to "${args.id}"; it reads it at its next step.`,
					{ details },
				);
			} catch (error) {
				return toolText(errorMessage(error), { isError: true });
			}
		},
	});

	const turnTool = defineTool({
		name: "project_turn",
		callers: ["model"],
		description: "Take, release, or inspect the project-wide landing turn. If it is busy, take queues you and a [turn] input wakes you when it is yours. Release hands it to the next coordinator or removes you from the queue. The project's own rules govern what needs the landing turn.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("take"), Type.Literal("release"), Type.Literal("status")]),
			taskId: Type.Optional(Type.String({ minLength: 1 })),
			note: Type.Optional(Type.String({ maxLength: 240 })),
		}),
		replay: "safe",
		execute: async (args, api) => {
			const threadId = service.threadIdOf(api.conversationId);
			if (threadId === undefined) return toolText(notCoordinator("project_turn"), { isError: true });
			try {
				return toolText(await service.projectTurn(threadId, args, api.callId));
			} catch (error) {
				return toolText(errorMessage(error), { isError: true });
			}
		},
	});

	return defineExtension({
		name: "thread-tools",
		tools: [listTool, peekTool, sendTool, turnTool] as ToolRegistration[],
		sections: [section("coordinator-peers", input => service.coordinators.isCoordinator(input.conversationId) ? PEER_THREADS_SECTION : undefined)],
	});
}

function createThreadFinishExtension(service: ThreadService): Extension {
	const finishTool = defineTool({
		name: "thread_finish",
		callers: ["model"],
		description:
			"End this background thread with a summary for your parent coordinator: outcome, where the work is (workspace, change IDs, branches, " +
			'pull requests), open issues and anything the user must decide. It reaches your parent as "[thread <id> finished]"; ' +
			"nothing you write afterwards does. Call it when the work is done, not to wait: to wait for a report, an answer or a " +
			"message, end your turn instead. Your running workers must have reported or been stopped first.",
		parameters: Type.Object({
			summary: Type.String({ minLength: 1, description: "Everything your parent needs: they see nothing else of your work." }),
		}),
		replay: "safe",
		execute: async (args, api, context) => {
			const threadId = service.threadIdOf(api.conversationId);
			if (threadId === undefined || threadId === MAIN_THREAD_ID) {
				return toolText(
					"thread_finish ends a background thread; main does not finish, and a worker ends with its report instead.",
					{ isError: true },
				);
			}
			const record = await service.record(threadId);
			if (record?.kind !== "job") return toolText("Only background jobs can finish.", { isError: true });
			const running = Object.values(
				((await api.snapshot(WorkersDoc, api.conversationId, context)) ?? { workers: {} }).workers,
			).filter((worker) => worker.status === "running");
			if (running.length > 0 && record.status !== "done") {
				return toolText(
					`${running.length} of your workers still run (${running.map((worker) => worker.id).join(", ")}). Wait for their reports, or stop them with worker_stop, then finish.`,
					{ isError: true },
				);
			}
			// A weaker model reads "wait for the answer" as "finish"; the answer would then wake a thread that said it was done.
			const asked = record.status === "done" ? [] : await service.openQuestionIds(threadId);
			if (asked.length > 0) {
				return toolText(
					`Your question ${asked.join(", ")} is still open. To wait for the answer, end your turn: it arrives as a message and you go on from there. If you no longer need it, withdraw it with the board tool (resolve_question without an answer), then finish.`,
					{ isError: true },
				);
			}
			await service.finish(record, args.summary.trim(), api.callId);
			const details = { threadId };
			await api.details(details, context);
			return toolText("Finished: main has your summary. End your turn now, without another message.", { details });
		},
	});

	return defineExtension({ name: "thread-finish-tools", tools: [finishTool] as ToolRegistration[] });
}
