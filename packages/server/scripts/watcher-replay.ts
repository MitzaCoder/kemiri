/** Offline only. Use an empty environment with a temporary HOME and explicit file paths.
 *  bun packages/server/scripts/watcher-replay.ts --session FILE --namespace NAME --list
 *  bun packages/server/scripts/watcher-replay.ts --session FILE --namespace NAME --credentials FILE --runs CID:ENTRY,...
 *      [--variant baseline|tuned|both|worker-words|constrained|grounded|candidates|most-steps] [--model PROVIDER/MODEL]
 *      [--compare PROVIDER/MODEL] [--verify] [--claim-rules] [--budget INPUT_TOKENS]
 * Results go in a fresh private /tmp directory. The JSONL has clipped private evidence; don't publish it.
 */
import { mkdtemp, open, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Model, type Models } from "@earendil-works/pi-ai";
import { type Cursor, type ConversationId, ROOT_CONVERSATION_ID, type Storage } from "@earendil-works/pi-durable";
import { DEFAULT_REPORT_AUDIT } from "@kemiri/protocol";
import { FileCredentialStore } from "../src/credentials.ts";
import { newModelSessionId } from "../src/model-session.ts";
import { createHarnessModels } from "../src/models.ts";
import { chooseAuditModel } from "../src/report-audit.ts";
import { openStorageReadOnly } from "../src/request-backfill.ts";
import { boundWatcherEvidence, checkWatcherAnswer, checkWatcherCandidate, pickWatcherCandidate, watcherCandidatePrompt, watcherCandidates, checkWatcherDraft, parseWatcherVerification, passesWatcherClaimRules, watcherDraftPrompt, watcherLineRateAllows, watcherPassReason, watcherPrompt, watcherToolCalls, watcherTranscriptStep, watcherVerificationPrompt,
	WATCHER_LINE_INTERVAL_MS, WATCHER_TRIGGER, WATCHER_TUNED_TRIGGER, type WatcherAnswer, type WatcherPageLine, type WatcherStep, type WatcherToolCall, type WatcherCandidate } from "../src/task-watcher.ts";

const INPUT_LIMIT = 3_000_000;
const MAX_IDLE_GAP_MS = 120_000;
const MIN_RUN_MS = 600_000;
const MAX_OUTPUT = 100;
// pi-ai tries to refresh OAuth credentials within five minutes of expiry.
const OAUTH_MIN_VALIDITY_MS = 5 * 60_000;
const ctx = BACKGROUND_CONTEXT;
const encoder = new TextEncoder();
class ReplayStop extends Error {}

function parseArgs(argv: string[]) {
	const options = new Map<string, string>();
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i]!;
		const val = ["--list", "--verify", "--claim-rules"].includes(flag) ? "yes" : argv[++i];
		if (!val || val.startsWith("--") || options.has(flag) || !["--session", "--list", "--runs", "--credentials", "--variant", "--compare", "--budget", "--namespace", "--model", "--verify", "--claim-rules"].includes(flag)) throw new ReplayStop("Invalid arguments; see the usage in watcher-replay.ts.");
		options.set(flag, val);
	}
	const session = options.get("--session");
	const credentials = options.get("--credentials");
	const list = options.has("--list");
	const runs = options.get("--runs")?.split(",") ?? [];
	const variant = options.get("--variant") ?? "both";
	const compare = options.get("--compare");
	const modelRef = options.get("--model");
	const verify = options.has("--verify");
	const claimRules = options.has("--claim-rules");
	const namespace = options.get("--namespace") ?? "aiki";
	const budget = Number(options.get("--budget") ?? INPUT_LIMIT);
	if (!/^[\w.-]+$/.test(namespace) || !session || !isAbsolute(session) || (!list && (!runs.length || (variant !== "most-steps" && (!credentials || !isAbsolute(credentials))))) ||
		runs.some(id => !/^\d+:\d+$/.test(id)) || new Set(runs).size !== runs.length ||
		!(variant === "both" || Object.hasOwn(VARIANTS, variant)) || [compare, modelRef].some(ref => ref && !/^[\w.-]+\/[\w.-]+$/.test(ref)) ||
		(variant === "most-steps" && (verify || compare || modelRef)) || !Number.isSafeInteger(budget) || budget <= 0 || budget > INPUT_LIMIT) throw new ReplayStop("Invalid paths, run IDs, variant, comparison or budget; see watcher-replay.ts.");
	return { session, credentials, list, runs, variant: variant as Variant | "both", modelRef, verify, claimRules, compare, budget, namespace };
}

/** Refuse mutations before calling the callback. In particular, no OAuth refresh request can start. */
class ReplayCredentials extends FileCredentialStore {
	override async modify(): Promise<never> { throw new ReplayStop("Credential mutation is forbidden; stop rather than refresh."); }
	override async delete(): Promise<never> { throw new ReplayStop("Credential deletion is forbidden."); }
	override async setApiKey(): Promise<never> { throw new ReplayStop("Credential replacement is forbidden."); }
}
async function checkReplayCredential(credentials: ReplayCredentials, provider: string): Promise<void> {
	const credential = await credentials.read(provider);
	if (!credential || (credential.type === "api_key" && !credential.key)) throw new ReplayStop("Replay requires a stored credential; environment credentials are not accepted.");
	if (credential.type === "oauth" && !(credential.expires > Date.now() + OAUTH_MIN_VALIDITY_MS)) {
		throw new ReplayStop("Stored OAuth token expired or is too close to expiry; replay stopped without refreshing it.");
	}
}

async function document(storage: Storage, conversationId: ConversationId, kind: string) {
	const doc = await storage.findDocument({ kind, scope: { kind: "conversation", conversationId } }, "current", ctx);
	return doc ? (await storage.document(doc.id, "current", ctx))?.value : undefined;
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};

type ReplayStep = { at: number; entry: WatcherStep; pageLines?: WatcherPageLine[] };
type ReplayRun = { id: string; taskKey: string; steps: ReplayStep[]; start: number; end: number; activeMs: number; errors: number; failed: boolean; mix: Record<string, number> };

async function workerConversations(storage: Storage, selected: Set<number>, namespace: string) {
	const taskKeys = new Map<number, string>();
	const threads = record(record(await document(storage, ROOT_CONVERSATION_ID, `${namespace}.threads`)).threads);
	const coordinators = [Number(ROOT_CONVERSATION_ID), ...Object.values(threads).map(thread => record(thread).conversationId).filter((id): id is number => typeof id === "number")];
	for (const conversationId of coordinators) {
		const workers = record(record(await document(storage, conversationId as ConversationId, `${namespace}.workers`)).workers);
		for (const item of Object.values(workers)) {
			const { conversationId: id, taskId } = record(item);
			if (typeof id === "number" && typeof taskId === "string") taskKeys.set(id, taskId);
		}
	}
	const workers: { id: ConversationId; taskKey: string }[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanConversations({}, 100, cursor, ctx);
		for (const { id, owner } of page.items) {
			if (!owner || (selected.size && !selected.has(Number(id)))) continue;
			if ((await storage.task(owner.taskId, ctx))?.kind === `${namespace}.worker-anchor`) workers.push({ id, taskKey: taskKeys.get(Number(id)) ?? `worker:${id}` });
		}
		cursor = page.next;
	} while (cursor);
	return workers;
}

const phaseUpdates = (args: Record<string, unknown>): WatcherPageLine[] => [
	...(typeof args.now === "string" ? [{ kind: "phase" as const, text: args.now }] : []),
	...(typeof args.addResult === "string" && args.addResult.trim() ? [{ kind: "result" as const, text: args.addResult }] : []),
];
async function nestedPageUpdates(storage: Storage, conversationId: ConversationId) {
	const updates: { at: number; lines: WatcherPageLine[] }[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanTasks({ conversationId, kind: "pi.tool", status: "terminal" }, 100, cursor, ctx);
		for (const task of page.items) {
			const call = record(record(task.input).call);
			const outcome = record(record(task.state).outcome);
			if (call.name !== "task_progress" || outcome.status !== "completed" || task.endedAt === undefined || record(outcome.result).kind !== "nested") continue;
			const lines = phaseUpdates(record(call.arguments));
			if (lines.length) updates.push({ at: task.endedAt, lines });
		}
		cursor = page.next;
	} while (cursor);
	return updates.sort((a, b) => a.at - b.at);
}

async function readWorkerRuns(storage: Storage, conversationId: ConversationId, taskKey: string, withPageLines: boolean): Promise<ReplayRun[]> {
	const runs: ReplayRun[] = [];
	const calls = new Map<string, WatcherToolCall>();
	const progressCalls = new Map<string, WatcherPageLine[]>();
	const nested = withPageLines ? await nestedPageUpdates(storage, conversationId) : [];
	let nestedIndex = 0;
	let steps: ReplayStep[] = [];
	let start: number | undefined;
	let firstEntry: string | undefined;
	let lastAt = 0;
	let activeMs = 0;
	let cursor: Cursor | undefined;
	do {
		const page = await storage.scanEntries({ conversationId, order: "ascending" }, 100, cursor, ctx);
		for (const entry of page.items) {
			if (entry.conversationId !== conversationId) continue;
			const message = entry.model?.[0];
			if (!message || !("timestamp" in message) || !Number.isFinite(message.timestamp)) continue;
			const at = Math.max(lastAt, message.timestamp);
			if (message.role === "user") {
				if (start === undefined) { start = at; firstEntry = String(entry.id); lastAt = at; }
				continue; // A user message within a run can be a steer, not a new run.
			}
			if (start === undefined || (message.role !== "assistant" && message.role !== "toolResult")) continue;
			const finished = message.role === "assistant" && ["stop", "length", "error", "aborted"].includes(message.stopReason);
			const generation = finished && entry.byTaskId ? await storage.task(entry.byTaskId, ctx) : undefined;
			const completedAt = Math.max(at, generation?.endedAt ?? at);
			const step = watcherTranscriptStep(entry, calls);
			activeMs += Math.min(MAX_IDLE_GAP_MS, completedAt - lastAt);
			lastAt = completedAt;
			for (const [id, call] of watcherToolCalls(entry)) calls.set(id, call);
			if (withPageLines && message.role === "assistant") {
				for (const part of message.content) if (part.type === "toolCall" && part.name === "task_progress") progressCalls.set(part.id, phaseUpdates(record(part.arguments)));
			}
			const pageLines = message.role === "toolResult" && !message.isError ? [...(progressCalls.get(message.toolCallId) ?? [])] : [];
			if (message.role === "toolResult") { calls.delete(message.toolCallId); progressCalls.delete(message.toolCallId); }
			while (nested[nestedIndex] && nested[nestedIndex]!.at <= completedAt) {
				const update = nested[nestedIndex++]!;
				if (update.at >= start) pageLines.push(...update.lines);
			}
			if (step) steps.push({ at: completedAt, entry: step, pageLines });
			if (!finished) continue;
			if (activeMs >= MIN_RUN_MS && steps.length) {
				const mix: Record<string, number> = {};
				for (const { entry } of steps) if (entry.tool) mix[entry.tool] = (mix[entry.tool] ?? 0) + 1;
				runs.push({ id: `${conversationId}:${firstEntry}`, taskKey, steps, start, end: completedAt, activeMs,
					errors: steps.filter(step => step.entry.error).length, failed: message.stopReason !== "stop", mix });
			}
			start = undefined; lastAt = 0; activeMs = 0; steps = []; calls.clear(); progressCalls.clear();
		}
		cursor = page.next;
	} while (cursor);
	return runs;
}

const VARIANTS = {
	baseline: { trigger: WATCHER_TRIGGER, lineInterval: 0, guidance: "" },
	tuned: { trigger: WATCHER_TUNED_TRIGGER, lineInterval: WATCHER_LINE_INTERVAL_MS,
		guidance: "Prefer a specific change in approach, obstacle being investigated, or distinct piece of work. Cite a tool call or result that directly shows it, not just the worker's thinking. An attempt is not a result. Routine reading, testing, and final summaries are not news on their own." },
	"worker-words": { trigger: WATCHER_TUNED_TRIGGER, lineInterval: WATCHER_LINE_INTERVAL_MS },
	constrained: { trigger: WATCHER_TUNED_TRIGGER, lineInterval: WATCHER_LINE_INTERVAL_MS },
	grounded: { trigger: WATCHER_TUNED_TRIGGER, lineInterval: WATCHER_LINE_INTERVAL_MS },
	candidates: { trigger: WATCHER_TUNED_TRIGGER, lineInterval: WATCHER_LINE_INTERVAL_MS },
	"most-steps": { trigger: WATCHER_TUNED_TRIGGER, lineInterval: WATCHER_LINE_INTERVAL_MS },
} as const;
type Variant = keyof typeof VARIANTS;
type Pass = { run: ReplayRun; at: number; activeMs: number; reason: string; steps: WatcherStep[]; pageLines: WatcherPageLine[] };

function schedulePasses(runs: ReplayRun[], variant: Variant): Pass[] {
	const chronology = runs.flatMap(run => [...run.steps.map(step => ({ at: step.at, run, step })), { at: run.end, run, step: undefined }]);
	chronology.sort((a, b) => a.at - b.at);
	const states = new Map<ReplayRun, { lastAt: number; activeMs: number; lastPassActiveMs: number; steps: WatcherStep[]; pageLines: WatcherPageLine[] }>();
	const lastPassByTask = new Map<string, number>();
	const pagesByTask = new Map<string, WatcherPageLine[]>();
	const passes: Pass[] = [];
	for (const { at, run, step } of chronology) {
		let state = states.get(run);
		const pageLines = pagesByTask.get(run.taskKey) ?? [];
		if (!state) states.set(run, state = { lastAt: run.start, activeMs: 0, lastPassActiveMs: 0, steps: [], pageLines });
		if (step) {
			state.steps.push(step.entry);
			state.pageLines.push(...(step.pageLines ?? []));
			if (state.pageLines.length > 32) state.pageLines.splice(0, state.pageLines.length - 32);
			pagesByTask.set(run.taskKey, state.pageLines);
		}
		state.activeMs += Math.min(MAX_IDLE_GAP_MS, at - state.lastAt);
		state.lastAt = at;
		const lastPassAt = lastPassByTask.get(run.taskKey);
		const reason = watcherPassReason({ kind: step ? "step" : "end", at, pendingSteps: state.steps.length, activityMs: state.activeMs - state.lastPassActiveMs,
			...(lastPassAt !== undefined ? { lastPassAt } : {}) }, VARIANTS[variant].trigger);
		if (reason) {
			passes.push({ run, at, activeMs: state.activeMs, reason, steps: state.steps, pageLines: [...state.pageLines] });
			lastPassByTask.set(run.taskKey, at);
			state.lastPassActiveMs = state.activeMs;
			state.steps = [];
		}
		if (!step) states.delete(run);
	}
	return passes;
}

type Budget = { limit: number; input: number };
type PassRow = {
	run: string; at: number; activeMs: number; reason: string; evidence: ReturnType<typeof boundWatcherEvidence>;
	answer: WatcherAnswer | { kind: "rate-limited"; candidate: string; evidence: string[] } | { kind: "call-failed" | "verification-no" | "verification-malformed" | "claim-rules" | "no-candidates" | "floor" };
	input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; latencyMs: number;
	candidates?: WatcherCandidate[];
	called?: boolean;
	verification?: Pick<PassRow, "input" | "output" | "latencyMs" | "cost">;
};

async function callWatcher(models: Models, model: Model<string>, credentials: ReplayCredentials, prompt: ReturnType<typeof watcherPrompt>, at: number) {
	await checkReplayCredential(credentials, model.provider);
	const start = performance.now();
	const signal = AbortSignal.timeout(25_000);
	const message = await new Promise<Awaited<ReturnType<Models["completeSimple"]>>>((resolve, reject) => {
		const abort = () => reject(new ReplayStop("Provider call timed out; replay stopped."));
		signal.addEventListener("abort", abort, { once: true });
		void models.completeSimple(model, { systemPrompt: prompt.system, messages: [{ role: "user", content: prompt.user, timestamp: at }] }, {
			sessionId: newModelSessionId(), cacheRetention: "none", maxTokens: MAX_OUTPUT, signal, maxRetries: 0,
		}).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
	return { message, latencyMs: Math.round(performance.now() - start) };
}
function answerText(message: Awaited<ReturnType<Models["completeSimple"]>>): string | undefined {
	return message.stopReason === "stop" && message.content.every(block => block.type === "text" || block.type === "thinking")
		? message.content.filter(block => block.type === "text").map(block => block.text).join("") : undefined;
}

async function paidCall(models: Models, model: Model<string>, credentials: ReplayCredentials, prompt: ReturnType<typeof watcherPrompt>, at: number, budget: Budget) {
	// Admit pessimistically, then charge the actual bill. Stop on an unknown bill or an overrun.
	const reserved = encoder.encode(`${prompt.system}${prompt.user}`).length + 512;
	if (budget.input + reserved > budget.limit) throw new ReplayStop("Input token budget reached.");
	budget.input += reserved;
	const { message, latencyMs } = await callWatcher(models, model, credentials, prompt, at);
	const usage = message.usage;
	const input = usage.input + usage.cacheRead + usage.cacheWrite;
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		if (input > reserved) budget.input += input - reserved;
		const error = message.errorMessage ?? "";
		throw new ReplayStop(/\b(?:401|unauthorized|authentication|expired token|token expired|credential)\b/i.test(error)
			? "Provider rejected authentication (possibly expired); replay stopped without refreshing."
			: /\b429\b/.test(error) ? "Provider rate limit reached." : "Provider call failed or timed out; replay stopped. No provider error text was logged.");
	}
	budget.input += input - reserved;
	if (input > reserved) throw new ReplayStop("Provider input exceeded the conservative reservation; replay stopped.");
	const cost = (usage.input * model.cost.input + usage.output * model.cost.output + usage.cacheRead * model.cost.cacheRead + usage.cacheWrite * model.cost.cacheWrite) / 1e6;
	return { message, input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, cost, latencyMs };
}
function percentile(values: number[], quantile: number): number | null {
	return values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(quantile * values.length) - 1)]! : null;
}
function distribution(values: number[]) {
	return { min: percentile(values, 0), median: percentile(values, 0.5), p90: percentile(values, 0.9), max: percentile(values, 1) };
}
function summary(rows: PassRow[], hours: number) {
	const counts: Record<string, number> = {};
	let input = 0, output = 0, cost = 0, lines = 0;
	const lastLines = new Map<string, { at: number; activeMs: number }>();
	const gaps: number[] = [], wallGaps: number[] = [];
	for (const row of rows) {
		const answer = row.answer.kind === "dropped" ? row.answer.reason : row.answer.kind;
		counts[answer] = (counts[answer] ?? 0) + 1;
		input += row.input; output += row.output; cost += row.cost;
		if (answer !== "line") continue;
		lines++;
		const prior = lastLines.get(row.run);
		if (prior) { gaps.push(row.activeMs - prior.activeMs); wallGaps.push(row.at - prior.at); }
		lastLines.set(row.run, row);
	}
	const per = (divisor: number) => divisor > 0 ? { input: input / divisor, output: output / divisor, cost: cost / divisor } : null;
	return { hours, passes: rows.length, lines, counts, shareNothing: rows.length ? (counts.nothing ?? 0) / rows.length : null,
		passesPerHour: hours ? rows.length / hours : null, linesPerHour: hours ? lines / hours : null, gapsMs: distribution(gaps), wallGapsMs: distribution(wallGaps),
		input, output, cost, perPass: per(rows.length), perHour: per(hours), perProjectDay: per(hours / (52 / 5.5)), latencyMs: distribution(rows.filter(row => row.called !== false).map(row => row.latencyMs)), calls: rows.filter(row => row.called !== false).length };
}

async function replay(folder: string, runs: ReplayRun[], modelAccess: { models: Models; model: Model<string>; credentials: ReplayCredentials } | undefined, variant: Variant, budget: Budget, verifier?: Model<string>, claimRules = false): Promise<void> {
	const model = modelAccess?.model;
	const file = join(folder, `${variant}-${model ? `${model.provider}-${model.id}` : "local"}`);
	const log = await open(`${file}.jsonl`, "wx", 0o600);
	const verifiedFile = verifier ? `${file}-verified` : undefined;
	const verifiedLog = verifiedFile ? await open(`${verifiedFile}.jsonl`, "wx", 0o600) : undefined;
	const rulesFile = claimRules ? `${file}-rules` : undefined;
	const rulesLog = rulesFile ? await open(`${rulesFile}.jsonl`, "wx", 0o600) : undefined;
	const passes = schedulePasses(runs, variant);
	const rows: PassRow[] = [];
	const verifiedRows: PassRow[] = [];
	const rulesRows: PassRow[] = [];
	const draftMode = variant === "worker-words" || variant === "constrained" || variant === "grounded" ? variant : undefined;
	const candidateMode = variant === "candidates" || variant === "most-steps";
	const autoLines = new Map<string, WatcherPageLine[]>();
	const lastLines = new Map<string, number>();
	let stopped: string | undefined;
	try {
		for (const pass of passes) {
			const earlier = autoLines.get(pass.run.taskKey) ?? [];
			// Keep both recent recorded page text and recent auto text in the bounded prompt.
			const pageLines = [...pass.pageLines.slice(-6), ...earlier.slice(-6)];
			const passSteps = candidateMode ? pass.steps : pass.steps.map(({ action: _action, actionKey: _key, ...step }) => step);
			const evidence = boundWatcherEvidence(passSteps, pageLines);
			const candidates = candidateMode ? watcherCandidates(evidence.steps) : undefined;
			const page = [...pass.pageLines, ...earlier];
			const canPublish = watcherLineRateAllows(pass.at, lastLines.get(pass.run.taskKey), VARIANTS[variant].lineInterval);
			let answer: PassRow["answer"];
			let generation = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, latencyMs: 0 };
			let called = false;
			if (candidates && !candidates.length) answer = { kind: "no-candidates" };
			else if (candidates && !canPublish) answer = { kind: "floor" };
			else if (candidates && variant === "most-steps") answer = pickWatcherCandidate(candidates, page);
			else {
				if (!modelAccess) throw new ReplayStop("A model is required for this replay.");
				const prompt = candidates ? watcherCandidatePrompt(candidates, evidence) : draftMode ? watcherDraftPrompt(draftMode, evidence) : watcherPrompt(evidence, variant === "tuned" ? VARIANTS.tuned.guidance : "");
				const { message, ...usage } = await paidCall(modelAccess.models, modelAccess.model, modelAccess.credentials, prompt, pass.at, budget);
				generation = usage;
				called = true;
				const response = answerText(message);
				answer = response === undefined ? { kind: "dropped", reason: "malformed" } : candidates ? checkWatcherCandidate(response, candidates, page)
					: draftMode ? checkWatcherDraft(draftMode, response, evidence, page) : checkWatcherAnswer(response, evidence, page);
			}
			if (answer.kind === "line") {
				if (!canPublish) {
					answer = { kind: "rate-limited", candidate: answer.line, evidence: answer.evidence };
				} else {
					lastLines.set(pass.run.taskKey, pass.at);
					earlier.push({ kind: "auto", text: answer.line });
					autoLines.set(pass.run.taskKey, earlier.slice(-32));
				}
			}
			const row: PassRow = { run: pass.run.id, at: pass.at, activeMs: pass.activeMs, reason: pass.reason, evidence, answer, called, ...(candidates ? { candidates } : {}), ...generation };
			await log.writeFile(`${JSON.stringify(row)}\n`);
			rows.push(row);
			if (rulesLog) {
				const rulesRow: PassRow = answer.kind !== "line" || passesWatcherClaimRules(answer, evidence) ? row : { ...row, answer: { kind: "claim-rules" } };
				await rulesLog.writeFile(`${JSON.stringify(rulesRow)}\n`);
				rulesRows.push(rulesRow);
			}
			// Paired postfilter: keep generator history fixed to isolate what the verifier removes.
			// Only otherwise publishable candidates need a second paid call.
			if (verifier && verifiedLog && modelAccess) {
				let verifiedRow = row;
				if (answer.kind === "line") {
					const { message: verdict, ...usage } = await paidCall(modelAccess.models, verifier, modelAccess.credentials, watcherVerificationPrompt(answer, evidence, variant === "grounded" ? "attempts" : "strict"), pass.at, budget);
					const judgment = parseWatcherVerification(answerText(verdict) ?? "");
					verifiedRow = { ...row, answer: judgment === true ? answer : { kind: judgment === false ? "verification-no" : "verification-malformed" },
						input: row.input + usage.input, output: row.output + usage.output, cacheRead: row.cacheRead + usage.cacheRead,
						cacheWrite: row.cacheWrite + usage.cacheWrite, cost: row.cost + usage.cost, latencyMs: row.latencyMs + usage.latencyMs, verification: usage };
				}
				await verifiedLog.writeFile(`${JSON.stringify(verifiedRow)}\n`);
				verifiedRows.push(verifiedRow);
			}
		}
	} catch (error) {
		stopped = error instanceof ReplayStop ? error.message : "Replay failed or timed out; error details withheld.";
	} finally {
		await log.close();
		await verifiedLog?.close();
		await rulesLog?.close();
		const saveSummary = async (path: string, passRows: PassRow[], verifierModel?: Model<string>) => {
			const finalAt = stopped ? passRows.at(-1)?.at ?? 0 : Infinity;
			const activeMs = runs.reduce((sum, run) => sum + (run.end <= finalAt ? run.activeMs : passRows.findLast(row => row.run === run.id)?.activeMs ?? 0), 0);
			const verification = passRows.flatMap(row => row.verification ? [row.verification] : []);
			const modelRef = (m: Model<string>) => `${m.provider}/${m.id}`;
			await writeFile(`${path}-summary.json`, JSON.stringify({ variant, model: model ? modelRef(model) : null, pricesPerMillion: model?.cost ?? null,
				...(verifierModel ? { verifier: modelRef(verifierModel), verifierCalls: verification.length, verifierCost: verification.reduce((sum, row) => sum + row.cost, 0),
					verifierInput: verification.reduce((sum, row) => sum + row.input, 0), verifierOutput: verification.reduce((sum, row) => sum + row.output, 0),
					verifierLatencyMs: distribution(verification.map(row => row.latencyMs)) } : {}),
				plannedPasses: passes.length, stopped: stopped ?? null, inputAcrossReplays: budget.input, ...summary(passRows, activeMs / 3_600_000) }, null, 2), { mode: 0o600 });
		};
		await saveSummary(file, rows);
		if (verifiedFile) await saveSummary(verifiedFile, verifiedRows, verifier);
		if (rulesFile) await saveSummary(rulesFile, rulesRows);
	}
	if (stopped) throw new ReplayStop(stopped);
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const selected = new Set(args.runs.map(id => Number(id.split(":")[0])));
	const storage = await openStorageReadOnly(args.session);
	const runs: ReplayRun[] = [];
	try {
		for (const worker of await workerConversations(storage, selected, args.namespace)) runs.push(...await readWorkerRuns(storage, worker.id, worker.taskKey, !args.list));
	} finally { await storage.close(ctx); }
	runs.sort((a, b) => a.start - b.start);
	if (args.list) {
		for (const { steps, ...run } of runs) console.log(JSON.stringify({ ...run, steps: steps.length }));
		return;
	}
	const sample = runs.filter(run => args.runs.includes(run.id));
	if (sample.length !== args.runs.length) throw new ReplayStop("Sample includes unknown, incomplete, or under-ten-minute runs; use --list.");
	const budget = { limit: args.budget, input: 0 };
	const folder = await mkdtemp("/tmp/watcher-replay-");
	console.log(`Private replay results: ${folder}`);
	await writeFile(join(folder, "sample.json"), JSON.stringify(sample.map(({ steps, ...run }) => ({ ...run, steps: steps.length })), null, 2), { mode: 0o600 });
	if (args.variant === "most-steps") {
		await replay(folder, sample, undefined, args.variant, budget);
		return;
	}
	const credentials = new ReplayCredentials(args.credentials!);
	const models = createHarnessModels({ credentials });
	const auditModel = await chooseAuditModel(models, DEFAULT_REPORT_AUDIT);
	const storedModel = async (ref: string) => {
		const [provider, id] = ref.split("/") as [string, string];
		const chosen = models.getModel(provider, id);
		await checkReplayCredential(credentials, provider);
		if (!chosen || !await models.checkAuth(provider, { signal: AbortSignal.timeout(10_000) })) throw new ReplayStop("Requested model unavailable.");
		return chosen;
	};
	const model = args.modelRef ? await storedModel(args.modelRef) : auditModel;
	if (!model || (args.verify && !auditModel)) throw new ReplayStop("No credentialed automatic audit model.");
	await checkReplayCredential(credentials, model.provider);
	const comparison = args.compare ? await storedModel(args.compare) : undefined;
	const verifier = args.verify ? auditModel : undefined;
	const variants = args.variant === "both" ? ["baseline", "tuned"] as const : [args.variant];
	for (const variant of variants) await replay(folder, sample, { models, model, credentials }, variant, budget, verifier, args.claimRules);
	if (comparison) await replay(folder, sample, { models, model: comparison, credentials }, variants.at(-1)!, budget, verifier, args.claimRules);
}

if (import.meta.main) await main().catch((error: unknown) => {
	// Never print provider errors, filesystem error payloads, or raw credentials.
	console.error(error instanceof ReplayStop ? error.message : "Watcher replay failed; details withheld.");
	process.exitCode = 1;
});
