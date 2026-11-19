import type { BoardActivityActor, BoardLiveLine, BoardReportCheck, BoardTaskLive, BoardTimelineEntry, BoardTimelineFact, BoardWriter } from "@kemiri/protocol";
import type { TaskArtifactSave } from "./artifacts.ts";
import type { TaskLiveRun } from "./task-live-run.ts";
import type { BoardState } from "./board.ts";
import { setActivityPhase, type TaskActivitySource, type TaskActivityTracking } from "./task-activity.ts";
import { ServerError } from "./errors.ts";
import { updateLivePlan, type LivePlanUpdate } from "./task-live-plan.ts";
import { timelineId } from "./task-timeline.ts";

export const TASK_LIVE_LIMIT = 30;

/** Called inside the existing report write. Only the writer's running source on this task can add lines. */
export function recordLiveReport(state: BoardState, taskId: string, by: BoardWriter, at: string, phase: string | undefined, result: string | undefined, key: string | undefined, checks: readonly BoardReportCheck[] = [], planUpdate?: LivePlanUpdate): void {
 const tracking = state.taskActivity?.[taskId];
 const source = Object.values(tracking?.sources ?? {}).find(({ state, actor }) => state === "running" && actor.threadId === by.threadId &&
  (by.author === "worker" ? actor.kind === "worker" && actor.name === by.workerId : by.author === "coordinator" && actor.kind !== "worker"));
 if (planUpdate) {
  if (!state.taskLiveEnabled || key === undefined || by.author !== "worker" || !source) {
   throw new ServerError("bad_request", "Only a worker on a running task with Live enabled can update its run plan.");
  }
  const plan = updateLivePlan(source.livePlan, planUpdate);
  if (JSON.stringify(plan) !== JSON.stringify(source.livePlan)) source.livePlan = plan;
 }
 if (!tracking || !source) return;
 const startedAt = source.since;
 const changedPhase = phase === undefined ? undefined : setActivityPhase(tracking, source.actor.id, phase, at);
 if (!state.taskLiveEnabled || key === undefined) return;
 source.liveStartedAt ??= startedAt;
 appendLiveLine(tracking, taskId, source, at, `${key}:phase`, "phase", changedPhase);
 if (by.author === "worker") appendLiveLine(tracking, taskId, source, at, `${key}:result`, "result", result);
 if (checks.length && !source.liveCheckWrites?.includes(key)) {
  source.liveCheckWrites ??= [];
  source.liveCheckWrites.push(key);
  source.liveChecks = (source.liveChecks ?? 0) + checks.length;
  appendLiveFact(state, taskId, source, at, `checks:${key}`, `Check${checks.length === 1 ? "" : "s"} recorded: ${checks.map(check => `${check.name} ${check.result}`).join("; ")}`, "checks");
 }
}

const BURST_MS = 15_000;
function appendLiveLine(tracking: TaskActivityTracking, taskId: string, source: TaskActivitySource, at: string, key: string, kind: string, text: string | undefined, burst?: string): void {
 const clean = text?.replace(/\s+/g, " ").trim();
 if (!clean) return;
 const id = timelineId(taskId, `live:${source.actor.id}:${key}`);
 tracking.liveLines ??= [];
 const lines = tracking.liveLines;
 if (lines.some(line => line.id === id)) return;
 const previous = lines.at(-1);
 const elapsed = previous ? Date.parse(at) - Date.parse(previous.at) : Infinity;
 if (burst && previous?.actor.id === source.actor.id && tracking.liveBurst?.id === previous.id && tracking.liveBurst.kind === burst && elapsed >= 0 && elapsed <= BURST_MS) {
  previous.text = clipLine(burst === "send" ? clean : `${previous.text}; ${clean}`);
  previous.at = at;
  return;
 }
 lines.push({ id, at, kind, text: clipLine(clean), actor: { ...source.actor } });
 if (burst) tracking.liveBurst = { id, kind: burst };
 if (lines.length > TASK_LIVE_LIMIT) lines.splice(0, lines.length - TASK_LIVE_LIMIT);
}
const clipLine = (text: string) => text.length > 800 ? `${text.slice(0, 799)}…` : text;

export function appendLiveFact(state: BoardState, taskId: string, source: TaskActivitySource, at: string, key: string, text: string, burst?: string): void {
 if (!state.taskLiveEnabled || source.state !== "running") return;
 source.liveStartedAt ??= source.since;
 appendLiveLine(state.taskActivity![taskId]!, taskId, source, at, key, "fact", text, burst);
}

export function runningLiveSources(tracking: TaskActivityTracking | undefined): TaskActivitySource[] {
 return Object.values(tracking?.sources ?? {}).filter(source => source.state === "running").sort((a, b) => b.since.localeCompare(a.since) || a.actor.id.localeCompare(b.actor.id));
}

export function liveRunFacts(taskId: string, source: TaskActivitySource, run: TaskLiveRun | undefined, saves: readonly TaskArtifactSave[]): BoardTaskLive {
 const lines: BoardLiveLine[] = (run?.acpFileFacts ?? []).map(({ entryId, at, files }) => ({
  id: timelineId(taskId, `live:${source.actor.id}:acp-files:${entryId}`), at, kind: "fact", actor: source.actor,
  text: `Changed ${files} file${files === 1 ? "" : "s"}`,
 }));
 let burstEnd = -Infinity;
 let burstSize = 0;
 for (const save of saves) {
  const at = Date.parse(save.at);
  if (at - burstEnd > BURST_MS) {
   burstSize = 0;
   lines.push({ id: timelineId(taskId, `live:${source.actor.id}:save:${save.id}`), at: save.at, kind: "fact", text: "", actor: source.actor });
  }
  burstEnd = at;
  burstSize += 1;
  lines.at(-1)!.text = `Saved ${burstSize} file${burstSize === 1 ? "" : "s"}`;
 }
 const ledgerCommits = source.liveCommits ?? [];
 const toolCommits = [...run?.commitIds ?? []].filter(id => !ledgerCommits.some(hash => hash.startsWith(id) || id.startsWith(hash))).length;
 const counters = { steps: run?.steps ?? 0, filesChanged: run?.changedPaths.size ?? 0, filesSaved: saves.length,
  commits: toolCommits + Math.max(ledgerCommits.length, run?.commitsWithoutId ?? 0), checks: source.liveChecks ?? 0 };
 return { lines, ...(Object.values(counters).some(Boolean) ? { counters } : {}), ...(run?.pulse ? { pulse: run.pulse } : {}) };
}

export function mergeLiveLines(...parts: readonly BoardLiveLine[][]): BoardLiveLine[] {
 return parts.flat().sort((a, b) => a.at.localeCompare(b.at)).slice(-TASK_LIVE_LIMIT);
}

export function taskLive(tracking: TaskActivityTracking | undefined, actor?: BoardActivityActor): BoardTaskLive | undefined {
 const sources = runningLiveSources(tracking);
 const primary = sources.find(source => source.actor.id === actor?.id) ?? sources[0];
 if (!primary) return undefined;
 const lines = tracking?.liveLines?.filter(line => tracking.sources[line.actor.id]?.state === "running");
 return { lines: lines ?? [], ...(primary.livePlan ? { plan: primary.livePlan } : {}) };
}

/** Take just the ending source's lines and plan; other sources on the task keep working. */
export function takeLiveTrail(tracking: TaskActivityTracking, source: TaskActivitySource): BoardTaskLive | undefined {
 const lines = tracking.liveLines?.filter(line => line.actor.id === source.actor.id);
 const plan = source.livePlan?.map(step => ({ ...step }));
 delete source.livePlan;
 if (!lines?.length && !plan) return undefined;
 if (lines?.length) {
  const remaining = tracking.liveLines!.filter(line => line.actor.id !== source.actor.id);
  if (remaining.length) tracking.liveLines = remaining;
  else delete tracking.liveLines;
 }
 return { lines: lines ?? [], ...(plan ? { plan } : {}) };
}

/** The flat endpoint projects the same single run row, replacing its old start/report events. */
export function foldedLiveEntries(history: { events?: readonly BoardTimelineEntry[]; timelineEntries?: readonly BoardTimelineFact[] } | undefined): BoardTimelineEntry[] {
 const runs = history?.timelineEntries?.filter(entry => entry.live) ?? [];
 return [
  ...(history?.events ?? []).filter(event => !runs.some(run => run.source === "worker" && event.kind === "worker" && event.ref === run.ref &&
   (!event.by?.threadId || event.by.threadId === run.actor?.threadId) && event.at >= run.at && event.at <= run.endAt)),
  ...runs.map(({ endAt, kind, label, detail, ref, by, live }) => ({ at: endAt, kind, label, detail, ref, by, live })),
 ];
}
