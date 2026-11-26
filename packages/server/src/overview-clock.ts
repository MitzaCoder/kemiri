import type { BoardQuestion, BoardTask } from "@kemiri/protocol";
import type { BoardState } from "./board.ts";
import type { OverviewStatus, OverviewTaskRecord } from "./overview-records.ts";

export const time = (at?: string | null) => at == null ? NaN : Date.parse(at);
type Span = [number, number];
export function union(spans: Span[], from: number, to: number): Span[] {
 const clipped = spans.map(([a, b]): Span => [Math.max(a, from), Math.min(b, to)])
  .filter(([a, b]) => b > a).sort(([a], [b]) => a - b);
 const merged: Span[] = [];
 for (const [a, b] of clipped) {
  const last = merged.at(-1);
  if (last && last[1] >= a) last[1] = Math.max(last[1], b);
  else merged.push([a, b]);
 }
 return merged;
}
export const duration = (spans: Span[]) => spans.reduce((sum, [a, b]) => sum + b - a, 0);
export function timeSplit(work: Span[], waits: Span[], from: number, to: number) {
 const agentsMs = duration(union(work, from, to));
 const waitingMs = duration(union([...work, ...waits], from, to)) - agentsMs;
 return { agentsMs, waitingMs, otherMs: Math.max(0, to - from - agentsMs - waitingMs) };
}

function questionWaits(question: BoardQuestion, returnedAt: readonly string[], now: number): Span[] {
 let since = time(question.askedAt);
 const spans: Span[] = [];
 const transitions = [...(question.exchanges ?? []).map(exchange => ({ at: exchange.at, waitingOnOwner: exchange.author.author !== "user", previousAnswerAt: exchange.previousAnswer?.at })),
  ...returnedAt.map(at => ({ at, waitingOnOwner: true, previousAnswerAt: undefined }))].sort((a, b) => a.at.localeCompare(b.at));
 for (const transition of transitions) {
  if (transition.previousAnswerAt) spans.push([since, time(transition.previousAnswerAt)]);
  else if (!transition.waitingOnOwner) spans.push([since, time(transition.at)]);
  since = transition.waitingOnOwner ? time(transition.at) : NaN;
 }
 // An agent reply restarts the owner's clock; an open clarification is on the agent, not the owner.
 if (question.waitingOn !== "agent") spans.push([since, question.status === "open" ? now : time(question.answeredAt)]);
 return spans;
}

export function statusSpans(statuses: OverviewStatus[], status: BoardTask["status"], now: number): Span[] {
 return statuses.flatMap((entry, index) => entry.status === status ? [[time(entry.at), time(statuses[index + 1]?.at) || now] as Span] : []);
}

export type RequestWorkClock = { work: Span[]; waits: Span[] };

export function requestWorkClock(state: Readonly<BoardState>, rows: Readonly<Record<string, OverviewTaskRecord>>,
 request: BoardTask, members: readonly BoardTask[], questions: readonly BoardQuestion[], now: number): RequestWorkClock {
 const work: Span[] = [];
 const waits = [...statusSpans(rows[request.id]?.statuses ?? [], "review", now), ...questions
  .filter(question => question.blocksWork ?? question.kind !== "warning").flatMap(question => questionWaits(question, state.questionWaitReturns?.[question.id] ?? [], now))];
 for (const member of [request, ...members]) {
  const row = rows[member.id];
  const closed = member.status === "done" || member.status === "dropped";
  for (const run of Object.values(row?.runs ?? {})) work.push([time(run.at), time(run.endAt)]);
  for (const source of Object.values(state.taskActivity?.[member.id]?.sources ?? {})) {
   if (source.state === "running" && !closed) work.push([time(source.since), now]);
  }
  const steps = row?.stepsWaits ?? [];
  for (const step of steps) waits.push([time(step.at), time(step.endAt) || (closed ? time(member.settledAt) : now)]);
  if (!closed && member.report?.steps?.trim() && (!steps.length || steps.at(-1)?.endAt)) {
   const previousEnd = time(steps.at(-1)?.endAt);
   const start = time(member.report.stepsWrittenAt ?? member.updatedAt);
   if (!Number.isFinite(previousEnd) || previousEnd < start) waits.push([start, now]);
  }
 }
 return { work, waits };
}

export function firstWorkAt(statuses: OverviewStatus[], clock: RequestWorkClock): number {
 const inProgress = time(statuses.find(move => move.status === "in_progress")?.at);
 return Math.min(Number.isFinite(inProgress) ? inProgress : Infinity, ...clock.work.map(([start]) => start).filter(Number.isFinite));
}

/** Wall time on the agent clock, excluding the union of owner waits where no agent was working. */
export function agentTime({ work, waits }: RequestWorkClock, from: number, to: number): number {
 return Math.max(0, to - from - timeSplit(work, waits, from, to).waitingMs);
}
