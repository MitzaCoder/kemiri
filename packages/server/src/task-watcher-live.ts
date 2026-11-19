import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai";
import { estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { DEFAULT_TASK_WATCHER, type BoardLiveLine, type TaskWatcherSettings, type TaskWatcherStatus } from "@kemiri/protocol";
import type { BoardState } from "./board.ts";
import type { TaskActivitySource, TaskActivityTracking } from "./task-activity.ts";
import { acpToolLabel, acpToolStep } from "./official-agents/acp-activity.ts";
import { liveToolLabel } from "./task-live-run.ts";
import { mergeLiveLines } from "./task-live.ts";
import { timelineId } from "./task-timeline.ts";
import { auditDay, chooseAuditModel } from "./report-audit.ts";
import { newModelSessionId } from "./model-session.ts";
import {
 boundWatcherEvidence, checkWatcherCandidate, pickWatcherCandidate, watcherCandidatePrompt, watcherCandidates,
 watcherLineRateAllows, watcherNearDuplicate, watcherPassReason, watcherToolAction, watcherToolCalls, WATCHER_MAX_STEPS, WATCHER_TUNED_TRIGGER,
 type WatcherAnswer, type WatcherCandidate, type WatcherPageLine, type WatcherStep, type WatcherToolCall,
} from "./task-watcher.ts";

const ACTIVE_GAP_MS = 120_000;
const MAX_ANSWER_TOKENS = 64;
const LOCAL_PICKER = "most_steps";

export type WatcherCursor = { entryId: number; at: number; activityMs: number };
type EvidenceStep = NonNullable<BoardLiveLine["evidence"]>["steps"][number];
type RecordedTool = { action?: NonNullable<WatcherToolCall["action"]>; description: string };
type WatcherPass = { cursor: WatcherCursor; candidates: (Omit<WatcherCandidate, "evidence"> & { evidence: string[] })[]; steps: EvidenceStep[]; pageLines: WatcherPageLine[] };
export type WatcherJob = { taskId: string; source: TaskActivitySource["actor"]; at: number; pass: WatcherPass; settings: TaskWatcherSettings; admitted?: boolean };
export type WatcherPublication = { at: number; recent: WatcherPageLine[] };

// Display only explicit short prose or allowlisted subjects. Never reuse the offline intent field:
// it deliberately accepts raw commands, paths, and arbitrary arguments for private replay.
const privateLabel = /(?:secret|credential|password|passwd|token|api[-_ ]?key|private[-_ ]?key|bearer|authorization|session[-_ ]?id)|[\da-f]{12,}|[a-z]{24,}/i;
function safeFilename(path: unknown): string | undefined {
 const filename = typeof path === "string" ? path.split(/[\\/]/).at(-1) : undefined;
 return filename && /^[a-z][a-z0-9_.-]{0,49}\.(?:[cm]?[jt]sx?|svelte|css|html?|md|json|py|kt|rs|go|java|rb|sql|xml)$/i.test(filename) && !privateLabel.test(filename) ? filename : undefined;
}

function toolDescription(name: string, args: Record<string, unknown> | undefined): string {
 const label = liveToolLabel(name, args);
 const intent = typeof args?.intent === "string" ? args.intent.replace(/\s+/g, " ").trim() : "";
 const command = typeof args?.command === "string" ? args.command.replace(/\s+/g, " ").trim() : "";
 const prose = intent.length <= 60 && /^[\p{L}]+(?:[ -][\p{L}]+)+$/u.test(intent) && !privateLabel.test(intent) &&
  !command.toLowerCase().includes(intent.toLowerCase()) ? intent : undefined;
 const file = ["read", "write", "edit"].includes(name) ? safeFilename(args?.path ?? args?.file) : undefined;
 // Only a simple, positional test-file target is eligible; never expose flags, shell text, or output.
 const testFile = label === "Running tests" ? /^(?:bun|npm|pnpm|yarn|cargo|go) (?:run )?test +([\w./-]+)(?: |$)|^pytest +([\w./-]+)(?: |$)/.exec(command) : null;
 const subject = prose ?? file ?? safeFilename(testFile?.[1] ?? testFile?.[2]);
 return subject ? `${label} · ${subject}` : label;
}

/** The same recorded tool entries as the Live counters; no output, command, or full path is retained. */
export class TaskWatcherRun {
 readonly #calls = new Map<string, RecordedTool>();
 readonly #steps: { step: WatcherStep; description: string; cursor: WatcherCursor }[] = [];
 #last: WatcherCursor | undefined;

 add(entry: EntryRecord): void {
  if (this.#last && entry.id <= this.#last.entryId) return;
  const acp = acpToolStep(entry);
  if (acp) {
   const path = acp.changedPaths[0] ?? acp.paths[0];
   const filename = safeFilename(path);
   const label = acpToolLabel(acp.kind);
   const action = acp.status === "failed" ? undefined : watcherToolAction(acp.changedPaths.length ? "edit" : acp.kind, { path });
   this.#addStep(entry.id, acp.at, acp.callId, filename ? `${label} · ${filename}` : label, action);
   return;
  }
  const messages = entry.model ?? [];
  const result = messages.find(message => message.role === "toolResult");
  const assistant = messages.find(message => message.role === "assistant" && message.content.some(part => part.type === "toolCall"));
  const tool = result ?? assistant;
  if (!tool) return;
  const actions = watcherToolCalls(entry);
  let firstCallId: string | undefined;
  for (const message of messages) if (message.role === "assistant") for (const call of message.content) {
   if (call.type !== "toolCall") continue;
   firstCallId ??= call.id;
   const action = actions.get(call.id)?.action;
   this.#calls.set(call.id, { ...(action ? { action } : {}), description: toolDescription(call.name, call.arguments) });
  }
  const actionKey = result?.toolCallId ?? firstCallId;
  if (!actionKey) return;
  const recorded = this.#calls.get(actionKey);
  const description = recorded?.description ?? liveToolLabel(result?.toolName ?? "", undefined);
  for (const message of messages) if (message.role === "toolResult") this.#calls.delete(message.toolCallId);
  while (this.#calls.size > 128) this.#calls.delete(this.#calls.keys().next().value!);
  this.#addStep(entry.id, tool.timestamp, actionKey, description, recorded?.action);
 }

 #addStep(entryId: number, timestamp: number, actionKey: string, description: string, action?: RecordedTool["action"]): void {
  const step = { id: String(entryId), actionKey, ...(action ? { action } : {}) };
  const at = Number.isFinite(timestamp) ? Math.max(this.#last?.at ?? 0, timestamp) : this.#last?.at ?? 0;
  const gap = this.#last ? at - this.#last.at : 0;
  const cursor = { entryId, at, activityMs: (this.#last?.activityMs ?? 0) + (gap <= ACTIVE_GAP_MS ? gap : 0) };
  this.#last = cursor;
  this.#steps.push({ cursor, step, description });
  if (this.#steps.length > WATCHER_MAX_STEPS) this.#steps.shift();
 }

 due(cursor: WatcherCursor | undefined, at: number, end: boolean): boolean {
  return this.#pending(cursor, at, end).length > 0;
 }

 #pending(cursor: WatcherCursor | undefined, at: number, end: boolean) {
  const pending = this.#steps.filter(row => row.cursor.entryId > (cursor?.entryId ?? 0));
  if (!this.#last || !watcherPassReason({ kind: end ? "end" : "step", at, pendingSteps: pending.length,
   activityMs: this.#last.activityMs - (cursor?.activityMs ?? 0), ...(cursor ? { lastPassAt: cursor.at } : {}) }, WATCHER_TUNED_TRIGGER)) return [];
  return pending;
 }

 pass(cursor: WatcherCursor | undefined, at: number, end: boolean, pageLines: WatcherPageLine[]): WatcherPass | undefined {
  const pending = this.#pending(cursor, at, end);
  if (!pending.length) return undefined;
  const evidence = boundWatcherEvidence(pending.map(row => row.step), pageLines);
  const ids = new Set(evidence.steps.map(step => step.id));
  // Use the result entry when present, so a recorded call and its result appear only once.
  const calls = new Map<string, EvidenceStep>();
  for (const { step, description } of pending) if (ids.has(step.id)) {
   calls.set(step.actionKey ?? step.id, { entryId: step.id, description });
  }
  const steps = [...calls.values()].sort((a, b) => Number(a.entryId) - Number(b.entryId));
  return { cursor: { ...pending.at(-1)!.cursor, at }, candidates: watcherCandidates(evidence.steps).map(candidate => ({ ...candidate, evidence: [...candidate.evidence] })), steps, pageLines: [...evidence.pageLines] };
 }
}

export function watcherStatus(settings: TaskWatcherSettings, now: number, stored?: TaskWatcherStatus): TaskWatcherStatus {
 const day = auditDay(now);
 const tokensUsed = stored?.day === day ? stored.tokensUsed : 0;
 const modelMatches = settings.mode === "model" && settings.model && stored?.effectiveModel?.provider === settings.model.provider && stored.effectiveModel.modelId === settings.model.modelId;
 const budget = settings.mode === "model" && tokensUsed >= settings.dailyTokens;
 const prior = settings.mode === "model" && modelMatches && stored.day === day;
 return { day, tokensUsed, lastRunAt: stored?.lastRunAt ?? null,
  totals: stored?.totals ?? { written: 0, wrong: 0 }, byPicker: stored?.byPicker ?? {},
  effectiveModel: settings.mode === "model" ? settings.model ?? null : null,
  state: settings.mode === "off" ? "off" : settings.mode === "auto" ? "automatic" : budget ? "budget" : prior ? stored.state : "idle",
  reason: settings.mode === "off" ? "Live news lines are disabled." : budget ? "Daily token budget spent. Using Automatic." : prior ? stored.reason : null };
}

function recordStatus(state: BoardState, now: number): TaskWatcherStatus {
 state.taskWatcherStatus = watcherStatus(state.taskWatcherSettings ?? DEFAULT_TASK_WATCHER, now, state.taskWatcherStatus);
 return state.taskWatcherStatus;
}

function count(state: BoardState, at: number, picker: string, field: "written" | "wrong"): void {
 const status = recordStatus(state, at);
 status.totals[field]++;
 status.byPicker[picker] ??= { written: 0, wrong: 0 };
 status.byPicker[picker]![field]++;
}

export function markWatcherLineWrong(state: BoardState, line: BoardLiveLine, by: string, at: number): void {
 if (line.wrong || line.kind !== "auto" || !line.picker) return;
 line.wrong = { by, at: new Date(at).toISOString() };
 count(state, at, line.picker, "wrong");
}

function pageLines(lines: readonly BoardLiveLine[]): WatcherPageLine[] {
 return lines.flatMap(({ kind, text }) => kind === "auto" || kind === "phase" || kind === "result" ? [{ kind, text }] : []);
}

export function watcherCanPublish(state: Readonly<BoardState>, taskId: string, at: number): boolean {
 return !!state.taskWatcherSettings && state.taskWatcherSettings.mode !== "off" && watcherLineRateAllows(at, state.taskWatcherPublications?.[taskId]?.at);
}

/** Called only inside the board transaction; the cursor, publication and counters move together. */
export function evaluateWatcherRun(state: BoardState, taskId: string, tracking: TaskActivityTracking, source: TaskActivitySource, run: TaskWatcherRun, at: number, end = false): boolean {
 if (!watcherCanPublish(state, taskId, at) || source.actor.kind !== "worker") return false;
 const settings = state.taskWatcherSettings!;
 const recent = [...state.taskWatcherPublications?.[taskId]?.recent ?? [], ...pageLines(tracking.liveLines ?? [])];
 const pass = run.pass(source.watcherCursor, at, end, recent);
 if (!pass) return false;
 source.watcherCursor = pass.cursor;
 if (!pass.candidates.length) return false;
 const job = { taskId, source: source.actor, at, pass, settings };
 const status = watcherStatus(settings, at, state.taskWatcherStatus);
 if (settings.mode === "model" && status.tokensUsed < settings.dailyTokens) {
  state.taskWatcherJobs ??= {};
  // A newer evaluation replaces queued evidence for this run. An admitted call is never replayed.
  state.taskWatcherJobs[watcherJobKey(job)] = job;
  return true;
 }
 if (settings.mode === "model") state.taskWatcherStatus = status;
 publishWatcherAnswer(state, job, pickWatcherCandidate(pass.candidates, recent), LOCAL_PICKER, at, tracking.liveLines ?? [], lines => { tracking.liveLines = lines; });
 return false;
}

export function publishWatcherAnswer(state: BoardState, job: WatcherJob, answer: WatcherAnswer, picker: string, now: number, lines: BoardLiveLine[], setLines: (lines: BoardLiveLine[]) => void): boolean {
 if (answer.kind !== "line" || !watcherCanPublish(state, job.taskId, now)) return false;
 const recent = [...state.taskWatcherPublications?.[job.taskId]?.recent ?? [], ...pageLines(lines)];
 // A worker report or another run can publish while a model is choosing.
 if (recent.some(line => watcherNearDuplicate(answer.line, line.text))) return false;
 const at = new Date(now).toISOString();
 const id = timelineId(job.taskId, `watcher:${job.source.id}:${job.pass.cursor.entryId}`);
 if (lines.some(line => line.id === id)) return false;
 const steps = job.pass.steps.filter(step => step.description);
 if (!steps.some(step => answer.evidence.includes(step.entryId))) return false;
 setLines(mergeLiveLines(lines, [{ id, at, kind: "auto", text: answer.line, actor: { ...job.source }, picker, evidence: { conversationId: job.source.conversationId, steps } }]));
 state.taskWatcherPublications ??= {};
 state.taskWatcherPublications[job.taskId] = { at: now, recent: [...state.taskWatcherPublications[job.taskId]?.recent ?? [], { kind: "auto" as const, text: answer.line }].slice(-12) };
 count(state, now, picker, "written");
 return true;
}

export const watcherJobKey = (job: WatcherJob) => timelineId(job.taskId, `watcher-job:${job.source.id}`);

export class TaskWatcherLiveService {
 #running: Promise<void> | undefined;
 #dirty = false;
 #stopped = false;
 #abort: AbortController | undefined;
 constructor(readonly models: Models, readonly now: () => number, readonly state: () => Promise<BoardState>,
  readonly update: (change: (state: BoardState, publish: (job: WatcherJob, answer: WatcherAnswer, picker: string) => Promise<void>) => Promise<void> | void) => Promise<void>,
  readonly log: () => void, readonly timeoutMs = 15_000) {}

 wake(): void {
  if (this.#stopped) return;
  this.#dirty = true;
  this.#running ??= this.#drain().catch(this.log).finally(() => { this.#running = undefined; if (this.#dirty) this.wake(); });
 }
 async stop(): Promise<void> { this.#stopped = true; this.#abort?.abort(); await this.#running; }

 async #drain(): Promise<void> {
  while (this.#dirty && !this.#stopped) {
   this.#dirty = false;
   for (const job of Object.values((await this.state()).taskWatcherJobs ?? {})) {
    if (this.#stopped) return;
    await this.#pick(job);
   }
  }
 }

 async #pick(job: WatcherJob): Promise<void> {
  const { pass } = job;
  const key = watcherJobKey(job);
  if (job.admitted) {
   // A restart can safely retire a reserved pass, but must never resend its request.
   await this.update(doc => {
    const pending = doc.taskWatcherJobs?.[key];
    if (pending?.admitted && pending.pass.cursor.entryId === pass.cursor.entryId) delete doc.taskWatcherJobs![key];
   });
   return;
  }
  const candidates = pass.candidates.map(({ shortSubject: _short, ...candidate }) => candidate);
  const prompt = watcherCandidatePrompt(candidates, { steps: [], pageLines: [], omittedSteps: 0 });
  const reservation = estimateTextTokens(prompt.system) + estimateTextTokens(prompt.user) + MAX_ANSWER_TOKENS;
  const sameSettings = (doc: BoardState) => JSON.stringify(doc.taskWatcherSettings) === JSON.stringify(job.settings);
  const fits = (status: TaskWatcherStatus) => status.tokensUsed + reservation <= job.settings.dailyTokens;
  const now = this.now();
  const board = await this.state();
  const model = sameSettings(board) && fits(watcherStatus(job.settings, now, board.taskWatcherStatus))
   ? await chooseAuditModel(this.models, job.settings) : undefined;
  if (this.#stopped) return;
  let admitted = false;
  await this.update(async (doc, publish) => {
   const pending = doc.taskWatcherJobs?.[key];
   if (!pending || pending.admitted || pending.pass.cursor.entryId !== pass.cursor.entryId) return;
   if (!sameSettings(doc) || !watcherCanPublish(doc, job.taskId, this.now())) { delete doc.taskWatcherJobs![key]; return; }
   const status = recordStatus(doc, this.now());
   const budget = !fits(status);
   if (budget || !model) {
    delete doc.taskWatcherJobs![key];
    status.state = budget ? "budget" : "unavailable";
    status.reason = budget ? "Remaining budget cannot fit this pass. Using Automatic." : "The chosen model is unavailable. Using Automatic.";
    await publish(job, pickWatcherCandidate(candidates, pass.pageLines), LOCAL_PICKER);
    return;
   }
   admitted = true;
   pending.admitted = true;
   status.tokensUsed += reservation;
   status.lastRunAt = new Date(this.now()).toISOString();
  });
  if (!model || !admitted || this.#stopped) return;
  const controller = new AbortController();
  this.#abort = controller;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let answer: WatcherAnswer = { kind: "dropped", reason: "malformed" };
  let tokens = reservation;
  try {
   const timeout = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error("watcher stopped or timed out")), { once: true });
    timer = setTimeout(() => controller.abort(), this.timeoutMs);
   });
   const result = await Promise.race([this.models.completeSimple(model, { systemPrompt: prompt.system, messages: [{ role: "user", content: prompt.user, timestamp: now }] }, {
    sessionId: newModelSessionId(), signal: controller.signal, cacheRetention: "none", maxTokens: MAX_ANSWER_TOKENS,
    ...(model.reasoning && !model.api.startsWith("anthropic") ? { reasoning: "minimal" as const } : {}),
   }), timeout]);
   const usage = result.usage;
   tokens = Math.max(0, usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
   if (result.stopReason === "stop" && result.content.every(block => block.type === "text" || block.type === "thinking")) {
    answer = checkWatcherCandidate(result.content.flatMap(block => block.type === "text" ? [block.text] : []).join(""), candidates, pass.pageLines);
   }
  } catch { /* An interrupted attempt keeps its reservation and consumes the cursor. */ }
  finally { if (timer) clearTimeout(timer); this.#abort = undefined; }
  if (this.#stopped) return;
  await this.update(async (doc, publish) => {
   if (doc.taskWatcherJobs?.[key]?.pass.cursor.entryId === pass.cursor.entryId) delete doc.taskWatcherJobs[key];
   const status = recordStatus(doc, this.now());
   if (status.day === auditDay(now)) status.tokensUsed = Math.max(0, status.tokensUsed - reservation + tokens);
   if (!sameSettings(doc)) return;
   const invalid = answer.kind === "dropped" && answer.reason !== "duplicate";
   status.state = invalid ? "error" : "checked";
   status.reason = invalid ? "No valid answer from the chosen model. The pass was discarded." : null;
   await publish(job, answer, `model:${model.provider}/${model.id}`);
  });
 }
}
