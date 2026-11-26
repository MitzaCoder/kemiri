/** Compact summaries from the watches the runtime already owns, not a board watch per client/project. */
import { ProjectAttentionSchema, type ProjectAttention, type Board, type WorkerSummary, type ThreadSummary, type AttentionFailure, MAIN_THREAD_ID } from "@kemiri/protocol";
import { Value } from "typebox/value";
import { join } from "node:path";
import { readJsonFile, writeJsonFile } from "./fs-json.ts";
import { taskLater } from "./attention-later.ts";
import { requestAttention } from "./request-attention.ts";

export const EMPTY_ATTENTION: ProjectAttention = {
	questions: 0, warnings: 0, reviewTasks: 0, waitingTasks: 0, nextReturnAt: null,
	failedWorkers: 0, failedThreads: 0, runningWorkers: 0, failedCoordinators: 0, failedCoordinatorId: null, failedTaskIds: [],
	questionTaskId: null, warningTaskId: null, reviewTaskId: null, failedWorkerTaskId: null, failedThreadId: null,
	stepsTasks: 0, stepsTaskId: null,
};

export function boardAttention(board: Pick<Board, "questions" | "tasks">, withLater = [...board.tasks, ...board.questions].some(row => row.later !== undefined)): Pick<ProjectAttention, "questions" | "warnings" | "reviewTasks" | "waitingTasks" | "nextReturnAt" | "questionTaskId" | "warningTaskId" | "reviewTaskId" | "stepsTasks" | "stepsTaskId" | "laterItems" | "nextLaterAt"> {
	const questions = board.questions.filter((question) => !question.postponed && question.status === "open" && question.waitingOn !== "agent" && question.kind !== "warning");
	const warnings = board.questions.filter((question) => !question.postponed && question.status === "open" && question.waitingOn !== "agent" && question.kind === "warning");
	// Count each request once, but link to the part with the steps. Use the same priority even
	// when the optional request state is not on the board view.
	const { needsByRequest } = requestAttention(board.tasks, board.questions.filter(question => !question.postponed));
	const steps: string[] = [];
	const reviews: string[] = [];
	for (const task of board.tasks) {
		if (task.archived || task.parent != null || task.state?.group === "later") continue;
		const need = needsByRequest.get(task.id);
		const state = task.state?.fromPartId ? task.state : need?.state;
		if (state?.kind === "steps_needed") steps.push(state.fromPartId ?? need?.task.id ?? task.id);
		if (state?.kind === "review") reviews.push(task.id);
	}
	const waiting = board.tasks.filter((task) => task.status === "waiting" && !task.state?.liveWorkSince);
	const dates = waiting.flatMap((task) => task.waiting?.until && Number.isFinite(Date.parse(task.waiting.until)) ? [task.waiting.until] : []);
	dates.sort((left, right) => Date.parse(left) - Date.parse(right));
 const laterDates = [...board.tasks, ...board.questions].flatMap(row => row.later ? [row.later.until] : []).sort();
	return {
  ...(withLater ? { laterItems: laterDates.length, nextLaterAt: laterDates[0] ?? null } : {}),
		questions: questions.length, warnings: warnings.length, reviewTasks: reviews.length, waitingTasks: waiting.length,
		nextReturnAt: dates[0] ?? null, questionTaskId: questions[0]?.taskId ?? null,
		warningTaskId: warnings[0]?.taskId ?? null, reviewTaskId: reviews[0] ?? null,
		stepsTasks: steps.length, stepsTaskId: steps[0] ?? null,
	};
}

type FailureThread = { occurredAt?: string } & Pick<ThreadSummary, "id" | "title" | "conversationId" | "status" | "updatedAt" | "archived" | "kind" | "taskId" | "parentThreadId">;
export type FailureAttention = { failure: AttentionFailure; sourceKey: string; coordinatorId: string; failedTaskRow: boolean };

/** The same incident records feed the coordinator list, sidebar and Tasks panel. */
export function actionableFailures(
	tasks: readonly Board["tasks"][number][], workers: readonly WorkerSummary[], threads: readonly FailureThread[],
	acknowledged: Readonly<Record<string, string>> = {},
 withLater = false,
): FailureAttention[] {
	const taskById = new Map(tasks.map(task => [task.id, task]));
	const threadById = new Map(threads.map(thread => [thread.id, thread]));
	const failures: FailureAttention[] = [];
	const coordinatorOf = (threadId: string): string => {
		const thread = threadById.get(threadId);
		const coordinator = thread?.kind === "coordinator" ? thread.id : thread?.parentThreadId ?? MAIN_THREAD_ID;
		return threadById.get(coordinator)?.archived ? MAIN_THREAD_ID : coordinator;
	};
	function add(kind: AttentionFailure["kind"], source: Pick<WorkerSummary, "id" | "title" | "taskId" | "updatedAt" | "conversationId">, threadId: string, occurredAt = source.updatedAt) {
		const task = source.taskId == null ? undefined : taskById.get(source.taskId);
		if (source.taskId != null && (!task || task.archived || task.status === "done" || task.status === "dropped")) return;
		const sourceKey = JSON.stringify([kind, threadId, source.id]);
		const id = JSON.stringify([sourceKey, source.conversationId, source.updatedAt]);
		if (acknowledged[sourceKey] === id) return;
  const later = withLater && task && taskLater({ tasks: [...tasks] }, task);
  if (later && Date.parse(occurredAt) <= Date.parse(later.since) && task.state?.group === "later") return;
		const failedTaskRow = task?.state?.kind === "failed";
		failures.push({ sourceKey, failedTaskRow,
			coordinatorId: failedTaskRow ? coordinatorOf(task.ownerThreadId ?? MAIN_THREAD_ID) : coordinatorOf(threadId),
			failure: { id, kind, title: source.title || source.id, threadId,
				...(kind === "worker" ? { workerId: source.id } : {}), ...(task ? { taskId: task.id } : {}) },
		});
	}
	for (const worker of workers) {
		if (worker.status === "failed") add("worker", worker, worker.threadId ?? MAIN_THREAD_ID);
	}
	for (const thread of threads) {
		if (!thread.archived && thread.status === "failed") add(thread.kind === "coordinator" ? "coordinator" : "job", thread, thread.id, thread.occurredAt);
	}
	return failures;
}

/** One failed task row stands for its failed runs; other failures each need a row of their own. */
export function failureAttentionRows(failures: readonly FailureAttention[]): FailureAttention[] {
	const failedTasks = new Set<string>();
	return failures.filter(({ failedTaskRow, failure }) => {
		if (!failedTaskRow || failure.taskId === undefined) return true;
		if (failedTasks.has(failure.taskId)) return false;
		failedTasks.add(failure.taskId);
		return true;
	});
}

export function projectFailureAttention(workers: readonly Pick<WorkerSummary, "status">[], failures: readonly FailureAttention[]) {
	const rows = failureAttentionRows(failures);
	const failedWorkers = rows.filter(row => row.failure.kind === "worker");
	const failedJobs = rows.filter(row => row.failure.kind === "job");
	const failedCoordinators = rows.filter(row => row.failure.kind === "coordinator");
	return {
		runningWorkers: workers.filter(worker => worker.status === "running").length,
		failedWorkers: failedWorkers.length, failedWorkerTaskId: failedWorkers[0]?.failure.taskId ?? null,
		failedThreads: failedJobs.length, failedThreadId: failedJobs[0]?.failure.threadId ?? null,
		failedCoordinators: failedCoordinators.length, failedCoordinatorId: failedCoordinators[0]?.failure.threadId ?? null,
		failedTaskIds: rows.flatMap(row => row.failedTaskRow && row.failure.taskId ? [row.failure.taskId] : []),
	};
}

/** Small independent file: lists can read it without starting a Harness; writes serialize per project. */
export class ProjectAttentionStore {
	readonly #pendingLater = new Map<string, string>();
 readonly #legacy = new Map<string, ProjectAttention>();
 readonly #cache = new Map<string, ProjectAttention | undefined>();
	readonly #writes = new Map<string, Promise<void>>();
	constructor(readonly projectDir: (id: string) => string, readonly onError: (error: unknown) => void = () => undefined) {}
	async read(id: string): Promise<ProjectAttention | undefined> {
		if (this.#cache.has(id)) return this.#cache.get(id);
		let attention: ProjectAttention | undefined;
		try {
			const stored = await readJsonFile(join(this.projectDir(id), "attention.json"));
			if (Value.Check(ProjectAttentionSchema, stored) && "requestAttentionCounts" in stored && stored.requestAttentionCounts === true) {
				const { requestAttentionCounts: _, legacyLaterAttention, pendingLaterAt, ...summary } = stored as ProjectAttention & { requestAttentionCounts: true; legacyLaterAttention?: unknown; pendingLaterAt?: unknown };
    if (typeof pendingLaterAt === "string" && Number.isFinite(Date.parse(pendingLaterAt))) this.#pendingLater.set(id, pendingLaterAt);
    if (Value.Check(ProjectAttentionSchema, legacyLaterAttention)) this.#legacy.set(id, { ...legacyLaterAttention, runningWorkers: 0 });
				attention = { ...summary, runningWorkers: 0 };
			}
		} catch { /* Missing/corrupt summaries fall back to activity, not a broken project list. */ }
		// A watch may have published while the file was being read.
		if (!this.#cache.has(id)) this.#cache.set(id, attention);
		return this.#cache.get(id);
	}
	legacy(id: string): ProjectAttention | undefined { return this.#legacy.get(id); }
 pendingLaterAt(id: string): string | undefined { return this.#pendingLater.get(id); }
 update(id: string, patch: Partial<ProjectAttention>, legacyPatch?: Partial<ProjectAttention>, pendingLaterAt?: string | null): boolean {
		const previous = this.#cache.get(id);
		const next = { ...(previous ?? EMPTY_ATTENTION), ...patch };
		const previousLegacy = this.#legacy.get(id);
  const previousPending = this.#pendingLater.get(id);
  const pending = pendingLaterAt === undefined ? previousPending : pendingLaterAt;
  if (pending) this.#pendingLater.set(id, pending); else this.#pendingLater.delete(id);
  const legacyLaterAttention = next.laterItems || next.nextLaterAt ? { ...(previousLegacy ?? previous ?? EMPTY_ATTENTION), ...legacyPatch } : undefined;
  if (legacyLaterAttention) this.#legacy.set(id, legacyLaterAttention);
  else this.#legacy.delete(id);
  if (JSON.stringify(previous) === JSON.stringify(next) && JSON.stringify(previousLegacy) === JSON.stringify(legacyLaterAttention) && previousPending === (pending ?? undefined)) return false;
		this.#cache.set(id, next);
		const write = (this.#writes.get(id) ?? Promise.resolve()).catch(() => undefined)
			.then(() => writeJsonFile(join(this.projectDir(id), "attention.json"), { ...next, requestAttentionCounts: true, ...(legacyLaterAttention ? { legacyLaterAttention } : {}), ...(pending ? { pendingLaterAt: pending } : {}) }, 0o600))
			.catch(this.onError);
		this.#writes.set(id, write);
		return true;
	}
	async flush(): Promise<void> { await Promise.all(this.#writes.values()); }
}
