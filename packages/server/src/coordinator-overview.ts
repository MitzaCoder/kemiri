import type { Board, BoardQuestion, BoardTask, Overview, OverviewTimeLeft, Schedule, ThreadSummary } from "@kemiri/protocol";
import type { BoardState } from "./board.ts";
import type { OverviewRecords, OverviewRun } from "./overview-records.ts";
import { agentTime, duration, firstWorkAt, requestWorkClock, statusSpans, time, timeSplit, union } from "./overview-clock.ts";
import { collectOverviewCalibration, overviewReplayRequest, summarizeOverviewReplay, type OverviewReplayRequest } from "./overview-estimate-replay.ts";
import { overviewCalibrationMiss, OverviewEstimator, overviewQuantile as quantile, summarizeOverviewEstimates, type SavedOverviewEstimate, type ScoredOverviewEstimate } from "./overview-estimates.ts";
import { topRequest } from "./request-attention.ts";
import { questionLater, taskLater } from "./attention-later.ts";

export const OVERVIEW_DAY_MS = 86_400_000;
export function overviewWeekStart(now: number): number { return Math.floor(now / OVERVIEW_DAY_MS) * OVERVIEW_DAY_MS - 6 * OVERVIEW_DAY_MS; }
const iso = (ms: number) => new Date(ms).toISOString();
const settled = (task: BoardTask) => task.status === "done" || task.status === "dropped";
const blocking = (question: BoardQuestion) => question.blocksWork ?? question.kind !== "warning";
const awaitingOwner = (question: BoardQuestion) => question.status === "open" && question.waitingOn !== "agent";

function durationSample(values: number[]) {
 return values.length ? { count: values.length, medianMs: quantile(values, .5), p75Ms: quantile(values, .75) } : undefined;
}

export type OverviewUsage = {
 weekByTask: ReadonlyMap<string, NonNullable<Overview["week"]["taskUsage"]>>;
 lifetimeByTask: ReadonlyMap<string, NonNullable<Overview["week"]["taskUsage"]>>;
 weekByCoordinator: ReadonlyMap<string, NonNullable<Overview["week"]["coordinatorUsage"]>>;
 modelRequestsByCoordinator: ReadonlyMap<string, NonNullable<Overview["more"]["modelRequests"]>>;
};

type OverviewSource = {
 firstEstimates?: Map<string, SavedOverviewEstimate>;
 board: Board; state: Readonly<BoardState>; withLater?: boolean; records?: Readonly<OverviewRecords>;
 scope: Overview["scope"]; now: number; coordinatorOf(owner?: string | null): string;
 threads?: readonly ThreadSummary[]; schedules?: readonly Schedule[]; usage?: OverviewUsage;
};

export function buildCoordinatorOverview({ board, state, withLater = false, records, scope, now, coordinatorOf, threads = [], schedules = [], usage, firstEstimates }: OverviewSource): Omit<Overview, "id"> {
 const { coordinatorId } = scope;
 const selected = (id: string) => coordinatorId === null || coordinatorId === id;
 const byId = new Map(board.tasks.map(task => [task.id, task]));
 const coordinatorByTask = new Map(board.tasks.map(task => [task.id, task.coordinatorId ?? coordinatorOf(task.ownerThreadId)]));
 const owner = (task: BoardTask) => coordinatorByTask.get(task.id)!;
 const requests = board.tasks.filter(task => task.parent == null);
 const families = new Map<string, BoardTask[]>();
 for (const task of board.tasks) {
  const root = topRequest(task, byId);
  if (!root || root === task) continue;
  const parts = families.get(root.id) ?? [];
  if (!families.has(root.id)) families.set(root.id, parts);
  parts.push(task);
 }
 const directParts = (task: BoardTask) => (families.get(task.id) ?? []).filter(part => part.parent === task.id && part.status !== "dropped");
 const belongsTo = (task: BoardTask) => owner(topRequest(task, byId) ?? task);
 const questionRequest = (question: BoardQuestion) => {
  const task = question.taskId ? byId.get(question.taskId) : undefined;
  return task ? topRequest(task, byId) : undefined;
 };
 const questionOwner = (question: BoardQuestion) => {
  const root = questionRequest(question);
  return root && !settled(root) ? owner(root) : coordinatorOf(question.threadId);
 };
 const questionsByRequest = new Map<string, BoardQuestion[]>();
 for (const question of state.questions) {
  const root = questionRequest(question);
  if (!root) continue;
  const questions = questionsByRequest.get(root.id) ?? [];
  if (!questionsByRequest.has(root.id)) questionsByRequest.set(root.id, questions);
  questions.push(question);
 }
 const open = requests.filter(task => !settled(task));
 const rows = records?.tasks ?? {};
 const statuses = (task: BoardTask) => rows[task.id]?.statuses ?? [];
 const since = (task: BoardTask, status: BoardTask["status"]) => statuses(task).findLast(move => move.status === status)?.at ?? task.state?.since ?? task.updatedAt;
 const runningSince = (task: BoardTask) => [task, ...(families.get(task.id) ?? [])].map(part => part.state?.liveWorkSince ?? part.state?.runningWork?.since)
  .filter((at): at is string => at !== undefined).sort()[0];
 const runningByRequest = new Map(open.map(task => [task.id, runningSince(task)]));
 const waiting: Overview["waiting"] = [];
 const holdsParts = (task: BoardTask, root: BoardTask) => directParts(root).filter(part => !settled(part) && (
  task === root || task.id === part.id || isWithin(task, part.id, byId)
  || part.blockedBy.includes(task.id)
 )).length;
 for (const question of state.questions.filter(question => awaitingOwner(question) && (!withLater || !questionLater(state, question)))) {
  const task = question.taskId ? byId.get(question.taskId) : undefined;
  const root = questionRequest(question);
  const exchange = question.exchanges?.at(-1);
  const returnedAt = state.questionWaitReturns?.[question.id]?.at(-1);
  waiting.push({ kind: question.kind ?? "question", taskId: question.taskId, requestId: root?.id ?? null, questionId: question.id,
   since: [exchange?.author.author === "coordinator" ? exchange.at : question.askedAt, returnedAt ?? ""].sort().at(-1)!,
   holdsParts: root && task && blocking(question) && !settled(root) ? holdsParts(task, root) : 0 });
 }
 for (const root of open) {
  if (withLater && taskLater(state, root)) continue;
  if (root.status === "review") waiting.push({ kind: "review", taskId: root.id, requestId: root.id, since: since(root, "review"), holdsParts: directParts(root).filter(part => !settled(part)).length });
  if (runningByRequest.get(root.id)) continue;
  for (const task of [root, ...(families.get(root.id) ?? [])]) {
   if (!settled(task) && task.report.steps?.trim()) waiting.push({ kind: "steps", taskId: task.id, requestId: root.id, since: task.report.stepsWrittenAt ?? task.state?.since ?? task.updatedAt, holdsParts: holdsParts(task, root) });
  }
 }
 waiting.sort((a, b) => a.since.localeCompare(b.since) || (a.questionId ?? a.taskId ?? "").localeCompare(b.questionId ?? b.taskId ?? ""));
 const questionById = new Map(state.questions.map(question => [question.id, question]));
 const waitingOwner = (item: Overview["waiting"][number]) => item.questionId ? questionOwner(questionById.get(item.questionId)!) : coordinatorByTask.get(item.requestId!)!;
 const waitsForScope = waiting.filter(item => selected(waitingOwner(item)));
 const openForScope = open.filter(task => selected(owner(task)));
 const counts = (opened: readonly BoardTask[], waits: Overview["waiting"]): Overview["counts"] => ({
  open: opened.length, running: opened.filter(task => runningByRequest.get(task.id)).length,
  waitingOnOwner: waits.length, ...(waits[0] ? { oldestWaitSince: waits[0].since } : {}),
 });
 const heldRequests = new Set(waitsForScope.filter(item => item.requestId && (!item.questionId || blocking(questionById.get(item.questionId)!))).map(item => item.requestId));
 const inFlight: Overview["inFlight"] = openForScope.map(task => {
  const parts = task.partsDigest;
  const runSince = runningByRequest.get(task.id);
  const activePlan = runSince ? [task, ...(families.get(task.id) ?? [])].find(part => part.state?.liveWorkSince && part.live?.plan?.some(step => step.status === "doing")) : undefined;
  const plan = activePlan?.live?.plan;
  const step = plan?.findIndex(step => step.status === "doing") ?? -1;
  const firstWork = statuses(task).find(move => move.status === "in_progress")?.at;
  return { requestId: task.id, ...(parts ? { parts: { done: parts.done, total: parts.total, working: parts.working, needsOwner: parts.needsOwner } } : {}),
   ...(activePlan && plan && step >= 0 ? { planStep: { taskId: activePlan.id, number: step + 1, total: plan.length, text: plan[step]!.text } } : {}),
   ...(runSince ? { runningSince: runSince } : {}), ...(firstWork ? { firstWorkAt: firstWork } : {}), heldUp: !runSince && heldRequests.has(task.id),
  };
 });
 const startOfWeek = overviewWeekStart(now);
 const startOfToday = startOfWeek + 6 * OVERVIEW_DAY_MS;
 const startOfMonth = now - 30 * OVERVIEW_DAY_MS;
 const perDay = Array.from({ length: 7 }, (_, day) => ({ day: iso(startOfWeek + day * OVERVIEW_DAY_MS).slice(0, 10), requests: 0, parts: 0 }));
 const closed = board.tasks.flatMap(task => {
  if (task.status !== "done" || !task.settledAt || time(task.settledAt) > now) return [];
  const recorded = state.taskClosures?.[task.id];
  const closer = recorded?.at === task.settledAt ? recorded.by : statuses(task).findLast(move => move.status === "done" && move.at === task.settledAt)?.by ??
   (task.updatedAt === task.settledAt ? task.updatedBy : undefined);
  return [{ task, at: time(task.settledAt), owner: belongsTo(task), counted: task.parent == null ? closer === "user" : closer === "coordinator" }];
 });
 const recentClosed = closed.filter(close => close.counted && selected(close.owner) && close.at >= startOfWeek);
 for (const close of recentClosed) perDay[Math.floor((close.at - startOfWeek) / OVERVIEW_DAY_MS)]![close.task.parent == null ? "requests" : "parts"]++;
 const recentRequests = recentClosed.filter(close => close.task.parent == null);
 const recentRequestIds = new Set(recentRequests.map(close => close.task.id));
 const ownerClosedRequests = new Set(closed.filter(close => close.counted && close.task.parent == null).map(close => close.task.id));
 const weeks: number[] = [];
 const earliest = Math.min(Infinity, ...board.tasks.filter(task => selected(belongsTo(task))).map(task => time(task.createdAt)).filter(Number.isFinite));
 for (let week = 1; week <= 4; week++) {
  const from = startOfWeek - week * 7 * OVERVIEW_DAY_MS;
  if (earliest > from) break;
  weeks.push(closed.filter(close => close.counted && selected(close.owner) && close.task.parent == null && close.at >= from && close.at < from + 7 * OVERVIEW_DAY_MS).length);
 }
 const workAndWait = (task: BoardTask) => requestWorkClock(state, rows, task, families.get(task.id) ?? [], questionsByRequest.get(task.id) ?? [], now);
 const weekSplits: { total: number; split: Overview["week"]["split"] }[] = [];
 const completed: Overview["estimateInputs"]["completed"] = [];
 const scoredEstimates: ScoredOverviewEstimate[] = [];
 const replayRequests: OverviewReplayRequest[] = [];
 let heldUpTodayMs = 0;
 for (const task of requests) {
  const done = task.status === "done" ? time(task.settledAt) : NaN;
  const clock = workAndWait(task);
  const { work, waits } = clock;
  if (selected(owner(task))) heldUpTodayMs += timeSplit(work, waits, startOfToday, settled(task) ? Math.min(now, time(task.settledAt)) : now).waitingMs;
  if (!Number.isFinite(done) || done > now) continue;
  const moves = statuses(task);
  const firstWork = firstWorkAt(moves, clock);
  if (!Number.isFinite(firstWork) || firstWork >= done) continue;
  const ready = moves.find(move => move.status === "review" && time(move.at) >= firstWork && time(move.at) <= done);
  if (ready && ownerClosedRequests.has(task.id)) {
   const readyAt = time(ready.at);
   const agentMs = agentTime(clock, firstWork, readyAt);
   const sample = { requestId: task.id, coordinatorId: owner(task), firstWorkAt: iso(firstWork), readyAt: ready.at, doneAt: iso(done),
    parts: ready.parts ?? directParts(task).filter(part => time(part.createdAt) <= readyAt).length, agentMs };
   completed.push(sample);
   replayRequests.push(overviewReplayRequest(sample, task, families.get(task.id) ?? [], rows, clock));
   const estimate = rows[task.id]?.firstEstimate;
   if (estimate && time(estimate.at) >= firstWork && time(estimate.at) < readyAt) {
    scoredEstimates.push({ requestId: task.id, coordinatorId: owner(task), doneAt: iso(done), actualMs: agentTime(clock, time(estimate.at), readyAt), estimate });
   }
  }
  if (recentRequestIds.has(task.id)) weekSplits.push({ total: done - firstWork, split: timeSplit(work, waits, firstWork, done) });
 }
 const replay = collectOverviewCalibration(replayRequests);
 const recordedRequestIds = new Set(scoredEstimates.map(score => score.requestId));
 const misses = [...replay.misses.filter(miss => !recordedRequestIds.has(miss.requestId)), ...scoredEstimates.map(overviewCalibrationMiss)];
 const estimator = new OverviewEstimator(completed, misses, now);
 const replayScore = summarizeOverviewReplay(replay.first.filter(point => selected(point.coordinatorId)));
 const estimates = summarizeOverviewEstimates(scoredEstimates.filter(score => selected(score.coordinatorId)));
 function timeLeft(task: BoardTask, flight: Overview["inFlight"][number]): OverviewTimeLeft {
  if (task.status === "review") return { kind: "stopped", reason: "review" };
  const parts = directParts(task);
  const partsLeft = parts.filter(part => part.status !== "done").length;
  const moves = statuses(task);
  const reviewed = moves.some(move => move.status === "review" || move.status === "done");
  const clock = workAndWait(task);
  const startedAt = firstWorkAt(moves, clock);
  const startsOnBoard = task.status !== "todo" && Number.isFinite(startedAt) && startedAt <= now;
  if (flight.heldUp) {
   const stopped = { kind: "stopped", reason: "owner_wait" } as const;
   if (!startsOnBoard || !partsLeft || reviewed) return stopped;
   const estimate = estimator.partsLeft(owner(task), partsLeft);
   if ("reason" in estimate) return stopped;
   const { kind: _kind, ...range } = estimate.range;
   return { ...stopped, then: range };
  }
  if (reviewed) return { kind: "none", reason: "already_reviewed" };
  if (task.status === "waiting" || task.state?.kind === "blocked_by_task") return { kind: "none", reason: "outside_wait" };
  if (!startsOnBoard) return { kind: "none", reason: "not_started" };
  if (!parts.length) {
   if (!flight.runningSince) return { kind: "none", reason: "no_parts" };
   return estimator.usualDuration(owner(task), flight.runningSince, agentTime(clock, startedAt, now)) ?? { kind: "none", reason: "not_enough_history" };
  }
  if (!partsLeft) return { kind: "none", reason: "all_parts_done" };
  const first = rows[task.id]?.firstEstimate;
  const estimate = estimator.partsLeft(owner(task), partsLeft);
  if ("reason" in estimate) return { kind: "none", reason: estimate.reason };
  const range = estimate.range;
  if (!first) firstEstimates?.set(task.id, { at: iso(now), baselineMs: estimate.baselineMs, minutes: range.minutes, low: range.low, high: range.high });
  const overrunInMs = first ? Math.max(0, first.high * 60_000 - agentTime(clock, time(first.at), now)) : range.high * 60_000;
  return { ...range, overrunInMs, overrun: overrunInMs === 0 };
 }
 for (const flight of inFlight) flight.left = timeLeft(byId.get(flight.requestId)!, flight);
 // Use the observed request nearest the middle, not three unrelated medians that can't add up.
 weekSplits.sort((a,b) => a.total - b.total);
 const typicalRequest = weekSplits[Math.floor((weekSplits.length - 1) / 2)];
 const reviewTimes = requests.filter(task => selected(owner(task))).flatMap(task => statuses(task).flatMap((move, index, moves) => {
  const exit = moves[index + 1];
  return move.status === "review" && exit?.by === "user" && time(exit.at) >= startOfMonth && time(exit.at) <= now && time(exit.at) >= time(move.at) ? [time(exit.at) - time(move.at)] : [];
 }));
 const scopedQuestions = state.questions.filter(question => selected(questionOwner(question)));
 const answers = scopedQuestions.filter(question => question.kind !== "warning" && question.status === "answered" && time(question.answeredAt) >= startOfMonth && time(question.answeredAt) <= now);
 const answerTime = durationSample(answers.map(question => time(question.answeredAt) - time(question.askedAt)).filter(ms => ms >= 0));
 const reviews = durationSample(reviewTimes);
 const statusTimes: Overview["more"]["statusTimes"] = [];
 for (const status of ["todo", "in_progress", "review", "waiting", "blocked"] as const) {
  const samples = recentRequests.filter(({ task }) => statuses(task).some(move => move.status === "in_progress" || move.status === "review")).map(({ task, at }) =>
   duration(union(statusSpans(statuses(task), status, at), time(task.createdAt), at)));
  if (samples.length) statusTimes.push({ status, medianMs: quantile(samples, .5) });
 }
 const scopedTasks = board.tasks.filter(task => selected(belongsTo(task)));
 const runsByTask = scopedTasks.map(task => Object.values(rows[task.id]?.runs ?? {}).filter(run => run.source === "worker" && time(run.at) >= startOfWeek && time(run.at) <= now));
 const runs = runsByTask.flat();
 const lengths = runs.filter(run => run.outcome !== "running" && time(run.endAt) <= now).map(run => time(run.endAt) - time(run.at)).filter(ms => ms >= 0);
 const workerMs = runs.reduce((sum, run: OverviewRun) => sum + Math.max(0, Math.min(now, run.outcome === "running" ? now : time(run.endAt)) - time(run.at)), 0);
 const checks = openForScope.flatMap(task => [task, ...(families.get(task.id) ?? []).filter(part => !settled(part))].flatMap(member => member.report.checks ?? []));
 const deploys = new Map<string, string>();
 for (const task of scopedTasks) for (const [id, deploy] of Object.entries(rows[task.id]?.deploys ?? {})) {
  if (time(deploy.at) >= startOfWeek && time(deploy.at) <= now) deploys.set(id, deploy.outcome);
 }
 const nextSchedule = schedules.filter(schedule => selected(coordinatorOf(schedule.ownerThreadId)) && time(schedule.nextRunAt) >= now)
  .sort((a,b) => a.nextRunAt!.localeCompare(b.nextRunAt!))[0];
 const sumUsage = (map: OverviewUsage["weekByTask"], keys: Iterable<string>) => {
  const amounts = [...keys].flatMap(key => map.get(key) ?? []);
  return amounts.length ? { apiValue: amounts.reduce((total, row) => total + row.apiValue, 0), unpricedRequests: amounts.reduce((total, row) => total + row.unpricedRequests, 0) } : undefined;
 };
 const taskUsage = usage && sumUsage(usage.weekByTask, scopedTasks.map(task => task.id));
 const coordinatorUsage = usage && sumUsage(usage.weekByCoordinator, [...usage.weekByCoordinator.keys()].filter(selected));
 const requestValues = recentRequests.flatMap(({ task }) => {
  const value = usage && sumUsage(usage.lifetimeByTask, [task, ...(families.get(task.id) ?? [])].map(member => member.id));
  return value ? [value.apiValue] : [];
 });
 const modelRequests = usage && [...usage.modelRequestsByCoordinator].filter(([id]) => selected(id)).reduce((sum, [, row]) =>
  ({ errors: sum.errors + row.errors, aborted: sum.aborted + row.aborted }), { errors: 0, aborted: 0 });
 const allCoordinatorIds = [...new Set(["main", ...threads.filter(thread => thread.kind === "coordinator" && !thread.archived).map(thread => thread.id)])];
 return {
  type: "overview", asOf: iso(now), scope, counts: counts(openForScope, waitsForScope), waiting: waitsForScope, inFlight,
  week: { requests: recentRequests.length, parts: recentClosed.length - recentRequests.length, perDay,
   ...(weeks.length >= 3 ? { usualWeek: { low: quantile(weeks, .25), high: quantile(weeks, .75) } } : {}),
   ...(typicalRequest?.split ? { startToDoneMs: typicalRequest.total, split: typicalRequest.split } : {}),
   sentBack: recentRequests.filter(({ task }) => statuses(task).some((move, i, moves) => move.status === "in_progress" && moves[i - 1]?.status === "review")).length,
   reopened: recentRequests.filter(({ task }) => statuses(task).some((move, i, moves) => move.status !== "done" && moves[i - 1]?.status === "done")).length,
   ...(taskUsage ? { taskUsage } : {}), ...(coordinatorUsage ? { coordinatorUsage } : {}),
   ...(requestValues.length ? { usualRequestValue: quantile(requestValues, .5) } : {}),
  },
  more: { heldUpTodayMs, statusTimes, ...(estimates ? { estimates } : {}), ...(replayScore.scored ? { estimateReplay: { held: replayScore.held, scored: replayScore.scored } } : {}),
   runs: { started: runs.length, failed: runs.filter(run => run.outcome === "failed").length, stopped: runs.filter(run => run.outcome === "stopped").length,
    tasksWithMultipleRuns: runsByTask.filter(taskRuns => taskRuns.length > 1).length, workerMs, ...(lengths.length ? { medianMs: quantile(lengths, .5) } : {}) },
   questions: { asked: scopedQuestions.filter(question => time(question.askedAt) >= startOfMonth && time(question.askedAt) <= now).length, answered: answers.length, ...(answerTime ? { answerTime } : {}) },
   ...(reviews ? { reviews } : {}), checks: { passed: checks.filter(check => check.result === "passed").length, failed: checks.filter(check => check.result === "failed").length },
   ...(modelRequests ? { modelRequests } : {}),
   runningJobs: threads.filter(thread => !thread.archived && !thread.main && thread.kind !== "coordinator" && (thread.status === "running" || thread.runningWorkers > 0) && selected(coordinatorOf(thread.parentThreadId))).map(thread => thread.id),
   ...(nextSchedule ? { nextSchedule: { scheduleId: nextSchedule.id, at: nextSchedule.nextRunAt! } } : {}),
   ...(state.deployFeedConfigured || deploys.size ? { deploys: { landed: [...deploys.values()].filter(outcome => outcome === "live" || outcome === "landed" || outcome === "ok").length,
    failed: [...deploys.values()].filter(outcome => outcome === "failed").length, rolledBack: [...deploys.values()].filter(outcome => outcome === "rolled_back").length } } : {}),
  },
  estimateInputs: { completed },
  ...(coordinatorId === null ? { coordinators: allCoordinatorIds.map(id => {
   const finished = closed.filter(close => close.counted && close.owner === id && close.at >= startOfWeek);
   const requests = finished.filter(close => close.task.parent == null).length;
   const taskUsage = usage && sumUsage(usage.weekByTask, scopedTasks.filter(task => belongsTo(task) === id).map(task => task.id));
   return { coordinatorId: id, counts: counts(open.filter(task => owner(task) === id), waiting.filter(item => waitingOwner(item) === id)),
    week: { requests, parts: finished.length - requests, ...(taskUsage ? { taskUsage } : {}) } };
  }) } : {}),
 };
}

function isWithin(task: BoardTask, ancestorId: string, byId: ReadonlyMap<string, BoardTask>): boolean {
 const seen = new Set<string>();
 let current: BoardTask | undefined = task;
 while (current?.parent && !seen.has(current.id)) {
  seen.add(current.id);
  if (current.parent === ancestorId) return true;
  current = byId.get(current.parent);
 }
 return false;
}
