import type { WatcherCursor } from "./task-watcher-live.ts";
import type { BoardTask, BoardTaskActivity, BoardActivityActor, BoardQuestion, BoardTaskState, BoardLiveLine, BoardLivePlanStep } from "@kemiri/protocol";

/** Durable run identities, never worker names alone. Deployment facts have separate typed slots. */
export type TaskActivitySource = {
 actor: BoardActivityActor;
 state: "running" | "failed" | "ended" | "unknown";
 since: string;
 phase?: string;
 liveStartedAt?: string;
 liveFolded?: boolean;
 watcherCursor?: WatcherCursor;
 liveChecks?: number;
 livePlan?: BoardLivePlanStep[];
 liveCheckWrites?: string[];
 liveCommits?: string[];
 title: string;
 failure?: string;
};
export type TaskActivityTracking = {
 sources: Record<string, TaskActivitySource>;
 liveLines?: BoardLiveLine[];
 liveBurst?: { id: string; kind: string };
 pauseNudgedEpisode?: string;
 lastEndedAt?: string;
 status?: BoardTask["status"];
 statusSince?: string;
 statusChanges?: number;
 feedback?: { id: string; at: string }[];
 delivery?: { text: string; at: string; refs: string[]; count: number };
 deploy?: { state: "failed" | "active" | "unknown"; text: string; since: string; refs: string[] };
 deployUnknownSince?: string;
 deployFailure?: { text: string; since: string; refs: string[]; targets: string[]; total: number };
};
export const DELIVERY_ACTIVITY_MS = 24 * 60 * 60 * 1000;

/** First match wins. No ages, clock reads, mutations, model calls or transcript inference. */
export function taskActivity(task: BoardTask, questions: readonly BoardQuestion[], tasks: readonly BoardTask[], tracking: TaskActivityTracking | undefined, now: number): BoardTaskActivity {
 const sources = Object.values(tracking?.sources ?? {}).sort((a, b) => b.since.localeCompare(a.since) || a.actor.id.localeCompare(b.actor.id));
 const closed = task.status === "done" || task.status === "dropped";
 const workers = closed ? [] : sources.filter(s => s.state === "running" && s.actor.kind === "worker");
 const make = (kind: BoardTaskActivity["kind"], text: string, since: string, refs: string[] = [], actor?: BoardActivityActor, count?: number): BoardTaskActivity => ({ kind, text, since, refs, ...(actor ? { actor } : {}), ...(count === undefined ? {} : { count }) });
 const deploy = tracking?.deploy;
 if (tracking?.deployFailure) return make("failure", tracking.deployFailure.text, tracking.deployFailure.since, tracking.deployFailure.refs);
 if (deploy?.state === "failed") return make("failure", deploy.text, deploy.since, deploy.refs);
 const failure = sources.find(s => s.state === "failed");
 if (failure) return make("failure", `${failure.actor.name} failed${failure.failure ? `: ${failure.failure.replace(/\s+/g, " ").slice(0, 160)}` : ""}`, failure.since, [failure.actor.id], failure.actor);
 const blocking = blockingTaskQuestions(task, questions);
 if (blocking[0]) return make("question", `Waiting for your answer to ${blocking[0].id}${blocking.length > 1 ? ` and ${blocking.length - 1} more` : ""}${workers.length ? ` · ${workers.length} worker${workers.length === 1 ? "" : "s"} still running` : ""}`, blocking[0].askedAt, blocking.map(q => q.id), undefined, blocking.length);
 const clarifying = questions.filter(q => q.taskId === task.id && q.status === "open" && q.waitingOn === "agent");
 if (!closed && clarifying[0]) return make("working", `${clarifying[0].threadId && clarifying[0].threadId !== "main" ? clarifying[0].threadId : "Coordinator"} is clarifying ${clarifying[0].id}`, clarifying[0].exchanges?.at(-1)?.at ?? clarifying[0].askedAt, clarifying.map(q => q.id));
 if (deploy?.state === "active" && tracking?.deployUnknownSince) return make("unknown", "Status unknown", tracking.deployUnknownSince, deploy.refs);
 if (deploy?.state === "active") return make("deploy", deploy.text, deploy.since, deploy.refs);
 const live = closed ? undefined : sources.find(s => s.state === "running");
 if (live) return make("working", `${live.actor.name} is ${live.phase || `working on ${live.title}`}${workers.length > (live.actor.kind === "worker" ? 1 : 0) ? ` · +${workers.length - (live.actor.kind === "worker" ? 1 : 0)} worker${workers.length - (live.actor.kind === "worker" ? 1 : 0) === 1 ? "" : "s"}` : ""}`, live.since, [live.actor.id], live.actor, workers.length);
 const feedback = tracking?.feedback?.[0];
 if (feedback) return make("feedback", `Feedback ${feedback.id} is waiting for the coordinator`, feedback.at, tracking!.feedback!.map(f => f.id));
 const since = tracking?.statusSince ?? task.updatedAt;
 if (!closed) {
  const blocked = task.blockedBy.filter(id => !["done", "dropped"].includes(tasks.find(t => t.id === id)?.status ?? ""));
  if (blocked.length) return make("blocked", `Blocked by ${blocked.join(", ")}`, since, blocked);
  if (task.status === "blocked") return make("blocked", task.blockedReason ? `Blocked: ${task.blockedReason}` : "Blocked", since);
  if (task.status === "waiting") return make("waiting", `Waiting for ${task.waiting?.note ?? "external review"}`, task.waiting?.since ?? since);
  if (task.status === "review") return make("review", "Ready for your review", since);
 }
 if (tracking?.deployUnknownSince) return make("unknown", "Status unknown", tracking.deployUnknownSince, tracking.deploy?.refs ?? tracking.delivery?.refs ?? []);
 const delivery = tracking?.delivery;
 if (delivery && now - Date.parse(delivery.at) < DELIVERY_ACTIVITY_MS && !sources.some(s => s.since > delivery.at)) return make("delivery", delivery.text, delivery.at, delivery.refs, undefined, delivery.count);
 if (closed) return make(task.status === "done" ? "done" : "dropped", task.status === "done" ? "Done" : "Dropped", task.settledAt ?? since);
 if (deploy?.state === "unknown" || sources.some(s => s.state === "unknown")) return make("unknown", "Status unknown", sources.find(s => s.state === "unknown")?.since ?? deploy?.since ?? since);
 if (task.status === "todo") return make("not_started", "Not started", task.createdAt);
 return make("idle", "Idle", tracking?.lastEndedAt ?? task.createdAt);
}

export function activityTracking(state: { taskActivity?: Record<string, TaskActivityTracking> }, taskId: string): TaskActivityTracking {
 state.taskActivity ??= {};
 state.taskActivity[taskId] ??= { sources: {} };
 return state.taskActivity[taskId]!;
}

/** Clear just this run. Failure persists until its source retries or is acknowledged. */
export function endActivitySource(tracking: TaskActivityTracking, id: string, at: string): void {
 const source = tracking.sources[id];
 if (!source || source.state === "ended" || source.state === "failed") return;
 source.state = "ended";
 delete source.phase;
 source.since = at;
 tracking.lastEndedAt = at;
}

export function setActivityPhase(tracking: TaskActivityTracking, id: string, phase: string, at: string): string | undefined {
 const source = tracking.sources[id];
 const short = phase.replace(/\s+/g, " ").trim().slice(0, 160);
 if (!source || source.state !== "running" || (source.phase ?? "") === short) return;
 if (short) source.phase = short;
 else delete source.phase;
 source.since = at;
 return short || undefined;
}

export const TASK_PAUSED_MS = 15 * 60 * 1000;

export function blockingTaskQuestions(task: BoardTask, questions: readonly BoardQuestion[]): BoardQuestion[] {
 return questions.filter(q => q.taskId === task.id && q.status === "open" && q.waitingOn !== "agent" && (q.blocksWork ?? q.kind !== "warning")).sort((a, b) => a.askedAt.localeCompare(b.askedAt) || a.id.localeCompare(b.id));
}

export function openTaskBlockers(task: Pick<BoardTask, "blockedBy">, tasks: readonly BoardTask[]): BoardTask[] {
 return task.blockedBy.flatMap(id => { const blocker = tasks.find(t => t.id === id); return blocker && !["done", "dropped"].includes(blocker.status) ? [blocker] : []; });
}

export function taskQuietSince(task: BoardTask, tracking: TaskActivityTracking | undefined): string {
 return [tracking?.lastEndedAt, tracking?.statusSince ?? task.updatedAt].filter((at): at is string => !!at).sort().at(-1)!;
}

/** One shared state, first match wins. Facts are the same ones used by activity. */
export function taskState(task: BoardTask, questions: readonly BoardQuestion[], tasks: readonly BoardTask[], tracking: TaskActivityTracking | undefined, now: number, parts: readonly { id: string; state: BoardTaskState }[] = []): BoardTaskState {
 const since = tracking?.statusSince ?? task.updatedAt;
 const make = (group: BoardTaskState["group"], kind: BoardTaskState["kind"], at = since, refs: string[] = []): BoardTaskState => ({ group, kind, since: at, refs, sentence: taskStateSentence(kind, task, questions, tasks, tracking, now, at, refs) });
 if (task.status === "done" || task.status === "dropped") return make("closed", task.status, task.settledAt ?? since);
 const activity = taskActivity(task, questions, tasks, tracking, now);
 const blockers = openTaskBlockers(task, tasks);
 if (activity.kind === "failure") return make("needs_you", "failed", activity.since, activity.refs);
 if (task.status === "blocked" && (task.blockedReason?.trim() || !blockers.length)) return make("needs_you", "failed");
 const blocking = blockingTaskQuestions(task, questions);
 if (blocking[0]) return make("needs_you", "answer_needed", blocking[0].askedAt, blocking.map(q => q.id));
 if (task.report?.steps?.trim()) return make("needs_you", "steps_needed", task.report.stepsWrittenAt ?? since);
 const clarifying = questions.filter(q => q.taskId === task.id && q.status === "open" && q.waitingOn === "agent");
 if (clarifying[0]) return make("in_progress", "clarifying", clarifying[0].exchanges?.at(-1)?.at ?? clarifying[0].askedAt, clarifying.map(q => q.id));
 const live = Object.values(tracking?.sources ?? {}).filter(s => s.state === "running").sort((a, b) => a.since.localeCompare(b.since) || a.actor.id.localeCompare(b.actor.id));
 if (live[0] || tracking?.deploy?.state === "active") return make("in_progress", "working", [live[0]?.since, tracking?.deploy?.state === "active" ? tracking.deploy.since : undefined].filter((at): at is string => !!at).sort()[0]!, [...live.map(s => s.actor.id), ...(tracking?.deploy?.state === "active" ? tracking.deploy.refs : [])]);
 if (blockers.length) return make("waiting", "blocked_by_task", since, blockers.map(t => t.id));
 if (task.status === "review") return make("needs_you", "review");
 if (task.status === "waiting") return make("waiting", "waiting_outside", task.waiting?.since ?? since);
 // A direct part counts only with live work (refs), never the short idle grace period.
 // Part states are derived bottom-up, so live descendant work follows the same rule at every level.
 const workingParts = parts.filter(part => part.state.kind === "working" && part.state.refs.length > 0);
 if (workingParts.length) return make("in_progress", "working", workingParts.map(part => part.state.since).sort()[0]!, workingParts.map(part => part.id));
 if (task.status === "in_progress") {
  const quiet = taskQuietSince(task, tracking);
  const paused = now - Date.parse(quiet) >= TASK_PAUSED_MS;
  return make("in_progress", paused ? "paused" : "working", paused ? new Date(Date.parse(quiet) + TASK_PAUSED_MS).toISOString() : quiet);
 }
 return make("todo", "todo");
}

/** Compact state wording is shared by both clients. Durations still tick locally. */
function taskStateSentence(kind: BoardTaskState["kind"], task: BoardTask, questions: readonly BoardQuestion[], tasks: readonly BoardTask[], tracking: TaskActivityTracking | undefined, now: number, since: string, refs: string[]): BoardTaskActivity {
 const activity = taskActivity(task, questions, tasks, tracking, now);
 const make = (activityKind: BoardTaskActivity["kind"], text: string, ageFormat: BoardTaskActivity["ageFormat"] = "duration", at = since, agePrefix?: string): BoardTaskActivity => ({ kind: activityKind, text, since: at, refs, ageFormat, ...(agePrefix ? { agePrefix } : {}) });
 const short = (text: string, limit = 160) => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean;
 };
 switch (kind) {
  case "failed": return make("failure", activity.kind === "failure" ? `Failed: ${short(activity.text.replace(/^failed:\s*/i, ""))}` : task.blockedReason ? `Failed: ${short(task.blockedReason)}` : "Failed");
  case "answer_needed": {
   const blocking = blockingTaskQuestions(task, questions);
   return make("question", `Answer needed: ${short(blocking[0]?.text ?? "Answer the question")}${blocking.length > 1 ? ` and ${blocking.length - 1} more` : ""}`, "none");
  }
  case "steps_needed": return make("review", "Your steps", "none");
  case "clarifying": return { ...activity, ageFormat: "duration" };
  case "review": return make("review", "Ready for review");
  case "working": {
   if (activity.kind === "deploy") return { ...activity, ageFormat: "duration" };
   if (activity.kind === "working" && activity.actor) {
    const source = Object.values(tracking?.sources ?? {}).find(source => source.actor.id === activity.actor?.id);
    return { ...activity, text: `${activity.actor.name} is ${source?.phase || "working"}`, ageFormat: "duration" };
   }
   return activity.kind === "working" ? { ...activity, ageFormat: "duration" } : make("working", "Working");
  }
  case "paused": return make("idle", "Paused", "duration", taskQuietSince(task, tracking), " · nothing has run on it for ");
  case "blocked_by_task": {
   const blockers = openTaskBlockers(task, tasks);
   const first = blockers[0];
   return make("blocked", `Blocked by ${first ? `${first.id} ${short(first.title, 80)}` : refs[0]}${blockers.length > 1 ? ` and ${blockers.length - 1} more` : ""}`, "none");
  }
  case "waiting_outside": {
   const note = task.waiting?.note?.trim();
   return make("waiting", note ? /^waiting for\b/i.test(note) ? note : `Waiting for ${note}` : "Waiting for external review");
  }
  case "todo": {
   const origin = tasks.find(other => other.id === task.foundWhile);
   return make("not_started", `Not started${task.foundWhile ? ` · follow-up of ${task.foundWhile}${origin ? ` (${origin.status === "in_progress" ? "in progress" : origin.status})` : ""}` : ""}`, "none");
  }
  case "done": return make("done", "Done");
  case "dropped": return make("dropped", "Dropped");
 }
}

export function pauseEpisode(task: BoardTask, tracking: TaskActivityTracking | undefined): string {
 return [String(tracking?.statusChanges ?? 0), tracking?.statusSince ?? task.updatedAt, taskQuietSince(task, tracking), ...Object.values(tracking?.sources ?? {}).map(s => s.actor.id).sort()].join("|");
}
