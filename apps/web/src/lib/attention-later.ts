import { markdownText, type Board, type BoardLater, type BoardLaterSetRequest, type BoardQuestion, type BoardTask } from '@kemiri/protocol';
import type { HarnessClient } from '@kemiri/client';
import { questionNeedsAnswer } from './question-clarify.js';
import { taskCoordinator } from './coordinators.js';

export type LaterDeadline = Pick<BoardLaterSetRequest, 'until' | 'whenLast'>;
export type LaterTarget = { target: BoardLaterSetRequest['target']; revision: number; label: string; urgent: boolean; later?: BoardLater };
export type LaterChoice = LaterDeadline & { label: string };
export const MAX_LATER_MS = 30 * 24 * 60 * 60_000;

function localTime(now: Date, days: number, time: string): Date {
 const [hour, minute] = time.split(':').map(Number);
 return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, minute);
}

export function laterChoices(now: Date, start: string, target: LaterTarget): LaterChoice[] {
 const evening = localTime(now, 0, '18:00');
 const morning = localTime(now, 1, start);
 const monday = localTime(now, (8 - now.getDay()) % 7 || 7, start);
 return [
  ...(evening > now ? [{ label: 'This evening', until: evening.toISOString() }] : []),
  { label: 'Tomorrow morning', until: morning.toISOString() },
  ...(!target.urgent ? [{ label: 'Next week', until: monday.toISOString() }] : []),
  ...(!target.urgent && 'taskId' in target.target ? [{ label: 'When it’s the last thing left', until: null, whenLast: true as const }] : []),
 ];
}

export function laterDateLimit(now: Date, start: string, urgent: boolean): Date {
 return urgent ? localTime(now, 1, start) : new Date(now.getTime() + MAX_LATER_MS);
}

export function laterDateInput(date: Date): string {
 const pad = (part: number) => String(part).padStart(2, '0');
 return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function laterDateLabel(until: string): string {
 return new Date(until).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function laterReturnLabel(later: BoardLater): string {
 return later.whenLast ? `Back when it’s the last thing left, by ${laterDateLabel(later.until)}` : `Back ${laterDateLabel(later.until)}`;
}

export function laterRequest(tasks: readonly BoardTask[], taskId: string): BoardTask | undefined {
 let task = tasks.find(row => row.id === taskId);
 const visited = new Set<string>();
 while (task?.parent != null) {
  if (visited.has(task.id)) return;
  visited.add(task.id);
  const parent = task.requestId ?? task.parent;
  task = tasks.find(row => row.id === parent);
 }
 return task;
}

const laterQuestionAllowed = (question: BoardQuestion) => !question.mcpApproval && !question.outsideModelApproval && !question.usageDrainIncident;

export function taskLaterTarget(board: Pick<Board, 'tasks' | 'questions'>, task: BoardTask, fromQuestion = false): LaterTarget | undefined {
 const request = laterRequest(board.tasks, task.id);
 if (!request || request.archived || request.status === 'done' || request.status === 'dropped') return;
 if (!fromQuestion && !request.later) {
  if (task.state?.group !== 'needs_you') return;
  if (task.state.kind === 'answer_needed' && !board.questions.some(question => questionNeedsAnswer(question) && laterQuestionAllowed(question)
   && question.taskId != null && laterRequest(board.tasks, question.taskId)?.id === request.id)) return;
 }
 const urgent = board.tasks.some(row => row.state?.kind === 'failed' && laterRequest(board.tasks, row.id)?.id === request.id) ||
  board.questions.some(row => row.kind === 'warning' && row.status === 'open' && row.waitingOn !== 'agent' && laterQuestionAllowed(row) && row.taskId != null && laterRequest(board.tasks, row.taskId)?.id === request.id);
 return { target: { taskId: request.id }, revision: request.revision, label: request.title, urgent, later: request.later };
}

export function questionLaterTarget(board: Pick<Board, 'tasks' | 'questions'>, question: BoardQuestion): LaterTarget | undefined {
 if (question.status !== 'open' || question.waitingOn === 'agent' || !laterQuestionAllowed(question)) return;
 if (question.taskId === null) return { target: { questionId: question.id }, revision: question.revision, label: markdownText(question.text), urgent: question.kind === 'warning', later: question.later };
 const task = board.tasks.find(row => row.id === question.taskId);
 const target = task && taskLaterTarget(board, task, true);
 // A new warning on a parked request is still live. Only the parked card gets Bring back.
 if (target?.later && !question.postponed) return;
 return target;
}

type LaterAttentionScope = { kind?: string; coordinatorId?: string; questionInScope?: (question: BoardQuestion) => boolean };

/** Summary rows may represent more than one request. Let the owner pick one, never postpone a whole summary. */
export function attentionLaterTargets(board: Board, scope: LaterAttentionScope = {}): LaterTarget[] {
 const targets = new Map<string, LaterTarget>();
 function add(target?: LaterTarget) {
  if (!target || target.later) return;
  targets.set('taskId' in target.target ? target.target.taskId : target.target.questionId, target);
 }
 if (!scope.kind || scope.kind === 'question' || scope.kind === 'warning') {
  for (const question of board.questions) {
   if (!questionNeedsAnswer(question) || (scope.kind && scope.kind !== (question.kind === 'warning' ? 'warning' : 'question')) || scope.questionInScope?.(question) === false) continue;
   add(questionLaterTarget(board, question));
  }
 }
 const need = scope.kind === 'worker' ? 'failed' : scope.kind === 'steps' ? 'steps_needed' : scope.kind;
 for (const task of board.tasks) {
  if (task.state?.group !== 'needs_you' || (need && task.state.kind !== need) || (scope.coordinatorId && taskCoordinator(task) !== scope.coordinatorId)) continue;
  if (task.state.kind !== 'answer_needed') add(taskLaterTarget(board, task));
 }
 return [...targets.values()];
}

export async function writeLater(client: HarnessClient, projectId: string, target: LaterTarget, deadline: LaterDeadline, start: string) {
 return client.setBoardLater(projectId, { target: target.target, expectedRevision: target.revision, ...deadline,
  workDay: { start, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } });
}
