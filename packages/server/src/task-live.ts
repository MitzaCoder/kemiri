import type { BoardTaskLive, BoardTimelineEntry, BoardTimelineFact, BoardWriter } from "@kemiri/protocol";
import type { BoardState } from "./board.ts";
import { setActivityPhase, type TaskActivitySource, type TaskActivityTracking } from "./task-activity.ts";
import { timelineId } from "./task-timeline.ts";

export const TASK_LIVE_LIMIT = 30;

/** Called inside the existing report write. Only the writer's running source on this task can add lines. */
export function recordLiveReport(state: BoardState, taskId: string, by: BoardWriter, at: string, phase: string | undefined, result: string | undefined, key: string | undefined): void {
 const tracking = state.taskActivity?.[taskId];
 if (!tracking) return;
 const source = Object.values(tracking.sources).find(({ state, actor }) => state === "running" && actor.threadId === by.threadId &&
  (by.author === "worker" ? actor.kind === "worker" && actor.name === by.workerId : by.author === "coordinator" && actor.kind !== "worker"));
 if (!source) return;
 const startedAt = source.since;
 const changedPhase = phase === undefined ? undefined : setActivityPhase(tracking, source.actor.id, phase, at);
 if (!state.taskLiveEnabled || key === undefined) return;
 const append = (kind: "phase" | "result", text: string | undefined) => {
  const clean = text?.replace(/\s+/g, " ").trim();
  if (!clean) return;
  const id = timelineId(taskId, `live:${source.actor.id}:${key}:${kind}`);
  tracking.liveLines ??= [];
  const lines = tracking.liveLines;
  if (lines.some(line => line.id === id)) return;
  source.liveStartedAt ??= startedAt;
  lines.push({ id, at, kind, text: clean.length > 800 ? `${clean.slice(0, 799)}…` : clean, actor: { ...source.actor } });
  if (lines.length > TASK_LIVE_LIMIT) lines.splice(0, lines.length - TASK_LIVE_LIMIT);
 };
 append("phase", changedPhase);
 if (by.author === "worker") append("result", result);
}

export function taskLive(tracking: TaskActivityTracking | undefined): BoardTaskLive | undefined {
 const lines = tracking?.liveLines?.filter(line => tracking.sources[line.actor.id]?.state === "running");
 return tracking && Object.values(tracking.sources).some(source => source.state === "running") ? { lines: lines ?? [] } : undefined;
}

/** Take just the ending source's lines; other sources on the task keep working. */
export function takeLiveTrail(tracking: TaskActivityTracking, source: TaskActivitySource): BoardTaskLive | undefined {
 const lines = tracking.liveLines?.filter(line => line.actor.id === source.actor.id);
 if (!lines?.length) return undefined;
 const remaining = tracking.liveLines!.filter(line => line.actor.id !== source.actor.id);
 if (remaining.length) tracking.liveLines = remaining;
 else delete tracking.liveLines;
 return { lines };
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
