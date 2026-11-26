import type { Board, BoardLater, BoardLaterSetRequest, BoardQuestion, BoardTask } from "@kemiri/protocol";
import type { BoardState } from "./board.ts";
import { ServerError } from "./errors.ts";
import { topRequest } from "./request-attention.ts";

export const MAX_LATER_MS = 30 * 24 * 60 * 60_000;
export const LATER_INSTRUCTION = "The owner can put a board ask aside for Later: until it returns, do not re-ask, remind the owner or move the postponed task; keep doing work that does not need the ask.";

export function laterUntilText(later: BoardLater): string {
 return later.whenLast ? `later until this is the last thing left (at most ${later.until})` : `later until ${later.until}`;
}

export const attentionTaskOpen = (task: BoardTask): boolean => !task.archived && task.status !== "done" && task.status !== "dropped";
export const ownerQuestionOpen = (question: BoardQuestion): boolean => question.status === "open" && question.waitingOn !== "agent";
export const laterQuestionAllowed = (question: BoardQuestion): boolean => !question.mcpApproval && !question.outsideModelApproval && !question.usageDrainIncident;

export function laterTaskRequest(board: Pick<Board, "tasks">, task: BoardTask): BoardTask | undefined {
 const current = board.tasks.find(row => row.id === task.id);
 if (!current) return;
 return current.parent == null ? current : topRequest(current, new Map(board.tasks.map(row => [row.id, row])));
}

export function taskLater(board: Pick<Board, "tasks">, task: BoardTask): BoardLater | undefined {
 const request = laterTaskRequest(board, task);
 return request && attentionTaskOpen(request) ? request.later : undefined;
}

export function questionLater(board: Pick<BoardState, "tasks" | "laterUrgent">, question: BoardQuestion): BoardLater | undefined {
 if (!ownerQuestionOpen(question) || !laterQuestionAllowed(question)) return;
 if (question.taskId == null) return question.later;
 const task = board.tasks.find(row => row.id === question.taskId);
 const request = task && laterTaskRequest(board, task);
 if (!request?.later || !attentionTaskOpen(request)) return;
 if (question.kind === "warning" && !board.laterUrgent?.[request.id]?.includes(`${question.id}@${question.revision}`)) return;
 return request.later;
}

export function laterFailureKey(task: BoardTask): string {
 const state = task.state;
 return JSON.stringify([task.id, state?.since, state?.refs, state?.sentence?.text]);
}

export function coversLaterFailure(board: Pick<BoardState, "tasks" | "laterUrgent">, task: BoardTask): boolean {
 const request = laterTaskRequest(board, task);
 return !!request?.later && attentionTaskOpen(request) && !!board.laterUrgent?.[request.id]?.includes(laterFailureKey(task));
}

const validInstant = (at: unknown): at is string => typeof at === "string" && Number.isFinite(Date.parse(at));

/** Read old boards unchanged, and do not allow malformed or orphaned records to hide attention. */
export function normalizeLater(state: BoardState): void {
 const valid = (later: BoardLater) => later != null && later.by === "user" && (later.whenLast === undefined || later.whenLast === true) && Number.isSafeInteger(later.times) && later.times > 0 &&
  validInstant(later.since) && validInstant(later.until) && Date.parse(later.until) > Date.parse(later.since) &&
  Date.parse(later.until) - Date.parse(later.since) <= MAX_LATER_MS;
 for (const task of state.tasks) if (task.later !== undefined && (task.parent != null || !attentionTaskOpen(task) || !valid(task.later))) {
  delete task.later;
  if (state.laterUrgent) delete state.laterUrgent[task.id];
 }
 // Clarification leaves the question temporarily waiting on an agent, not settled.
 for (const question of state.questions) if (question.later !== undefined &&
  (question.taskId != null || question.status !== "open" || !laterQuestionAllowed(question) || !valid(question.later) || question.later.whenLast === true)) delete question.later;
}

/** Same calendar rule as dated Waiting: the owner’s device supplies its wall time and zone. */
export function nextLaterMorning(now: number, workDay: BoardLaterSetRequest["workDay"]): number {
 const { start, timeZone } = workDay ?? { start: "08:00", timeZone: "UTC" };
 try {
  // Temporal's compatible disambiguation shifts gaps forward and chooses the earlier overlap.
  const date = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(timeZone).toPlainDate().add({ days: 1 });
  return date.toPlainDateTime(Temporal.PlainTime.from(start)).toZonedDateTime(timeZone).epochMilliseconds;
 } catch {
  throw new ServerError("bad_request", "Later needs a valid work-day start and time zone.");
 }
}

export function validateLaterDeadline(input: Pick<BoardLaterSetRequest, "until" | "whenLast" | "workDay">, now: number, urgent: boolean): string {
 let at = input.until == null && input.whenLast ? now + MAX_LATER_MS : NaN;
 if (input.until && /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(input.until)) {
  try { at = Temporal.Instant.from(input.until).epochMilliseconds; } catch { /* Invalid calendar instant. */ }
 }
 if (!Number.isFinite(at) || at <= now || at > now + MAX_LATER_MS) throw new ServerError("bad_request", "Later needs a future time no more than 30 days away.");
 if (urgent && (input.whenLast || at > nextLaterMorning(now, input.workDay))) throw new ServerError("bad_request", "Failures and warnings can only go to Later until the next work-day start.");
 return new Date(at).toISOString();
}

/** Don't leak projected records or flags on the legacy wire. */
export function withoutLaterBoard(board: Board): Board {
 return {
  ...board,
  tasks: board.tasks.map(task => { const { later: _, ...rest } = task; return rest; }),
  questions: board.questions.map(question => { const { later: _, postponed: _postponed, ...rest } = question; return rest; }),
 };
}
