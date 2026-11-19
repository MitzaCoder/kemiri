import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { contentText, createAssistantMessageEventStream, getCurrentSystemPrompt, type AssistantMessage, type CredentialStore, type Models, type Provider, type StreamOptions, type TranscriptContext, type Model, type Usage } from "@earendil-works/pi-ai";
import type { ProviderInfo } from "@kemiri/protocol";
import { OfficialAgentAccounts, officialAgentAccounts, officialAgentEnvironment } from "./auth.ts";
import { readJsonFile, writeJsonFile } from "../fs-json.ts";
import { acpActivityUpdate, acpToolLabel, type AcpActivityUpdate } from "./acp-activity.ts";
import { AcpClient, AcpProcessError, AcpProtocolError, AcpRpcError, type AcpUpdate } from "./acp-client.ts";
import { OFFICIAL_AGENT_API, type OfficialAgentDefinition, type OfficialAgentLogin, type OfficialAgentModel } from "./definition.ts";
import type { OfficialAgentMcpBridge, OfficialAgentMcpGrant, OfficialAgentMcpScope } from "./mcp-bridge.ts";

export type OfficialAgentRequest = { projectId: string; conversationId: number; cwd: string; turnId: string; recordActivity?: (update: AcpActivityUpdate) => Promise<void>; mcpScope?: { taskId: string | null; create: () => Promise<OfficialAgentMcpScope> } };
type Turn = { state: "sent" } | { state: "done"; text: string; usage: Usage } | { state: "failed"; error: string };
type SessionJournal = { sessionId: string; cwd: string; modelId: string; loginMode: OfficialAgentLogin["mode"]; loginIdentity?: string; turns: Record<string, Turn> };
type AgentSession = {
	providerId: string;
	turnFinished?: Promise<void>;
	request: OfficialAgentRequest;
	stop: AbortController;
	busy: boolean;
	idle?: ReturnType<typeof setTimeout>;
	client?: AcpClient;
	mcp?: OfficialAgentMcpGrant;
	scratch?: string;
	journal?: SessionJournal;
	closing?: Promise<void>;
};

const IDLE_MS = 10 * 60_000;
const RESUME_NOTE = "[Kemiri was interrupted and resumed this turn.]\n\n";
const RESUME_PROMPT = "Kemiri restarted while you worked. Do not start the task over. Check what you already did in the workspace and in your session, finish the remaining work, then reply with your final report.";
const digest = (key: string) => createHash("sha256").update(key).digest("hex");
const zeroCost = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
const tokens = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
function acpUsage(usage: unknown, separateThoughtTokens = false): Usage {
	const reported = usage as Record<string, unknown> | undefined;
	const input = tokens(reported?.inputTokens);
	const thoughts = tokens(reported?.thoughtTokens);
	const output = tokens(reported?.outputTokens) + (separateThoughtTokens ? thoughts : 0);
	const cacheRead = tokens(reported?.cachedReadTokens ?? reported?.cacheReadTokens), cacheWrite = tokens(reported?.cachedWriteTokens ?? reported?.cacheWriteTokens);
	return { input, output, cacheRead, cacheWrite, ...(typeof reported?.thoughtTokens === "number" ? { reasoning: Math.min(thoughts, output) } : {}), totalTokens: tokens(reported?.totalTokens) || input + output + cacheRead + cacheWrite, cost: zeroCost() };
}

const providerMetadata = new WeakMap<Provider, () => Promise<NonNullable<ProviderInfo["officialAgent"]>>>();
export function describeOfficialAgent(provider: Provider) { return providerMetadata.get(provider)?.(); }
export function isWorkerOnlyModel(models: Models, ref: { provider: string; modelId: string }): boolean {
	const provider = models.getProvider(ref.provider);
	return (provider !== undefined && providerMetadata.has(provider)) || models.getModel(ref.provider, ref.modelId)?.api === OFFICIAL_AGENT_API;
}

function failure(definition: OfficialAgentDefinition, error: unknown): string {
	if (error instanceof AcpProcessError || error instanceof AcpProtocolError) return `${definition.name}: ${error.message}`;
	if (error instanceof AcpRpcError) {
		if (error.code === 429 || /quota|rate.limit|resource.exhausted|too many requests/i.test(error.message)) return `${definition.name}: quota exhausted or rate limited.`;
		if ((error.code === -32000 && error.method !== "session/prompt") || error.code === 401 || /not authenticated|auth.*required|unauthenticated|sign.in|log.in|api.key.*invalid|invalid.grant|(?:token|credential).*(?:expired|revoked)|(?:refresh|renew).*(?:failed|failure|token)|(?:failed|unable).*(?:refresh|renew)/i.test(error.message)) return definition.signInRequired;
		return `${definition.name}: ACP ${error.method} failed (code ${error.code}).`;
	}
	return `${definition.name}: could not prepare or save the agent session.`;
}

/** One per backend. Only generation hooks for authenticated worker conversations may tag requests. */
export class OfficialAgentSessions {
	readonly #requests = new WeakMap<object, OfficialAgentRequest>();
	readonly #sessions = new Map<string, AgentSession>();
	readonly #accounts = new Set<OfficialAgentAccounts>();
	#shuttingDown = false;

	constructor(readonly dataDir: string, readonly credentials: CredentialStore, readonly log: (message: string) => void = () => {}, readonly mcp?: OfficialAgentMcpBridge) {}

	tag(message: object, request: OfficialAgentRequest): void { this.#requests.set(message, request); }

	async stopWorker(projectId: string, conversationId: number): Promise<void> {
		await Promise.all([...this.#sessions].filter(([, session]) => session.request.projectId === projectId && session.request.conversationId === conversationId)
			.map(([key, session]) => this.#close(key, session)));
	}

	beginShutdown(): void { this.#shuttingDown = true; this.mcp?.close(); }
	async close(): Promise<void> {
		this.beginShutdown();
		await Promise.all([...this.#sessions].map(([key, session]) => this.#close(key, session)));
		await Promise.all([...this.#accounts].map(accounts => accounts.drain()));
	}

	#close(key: string, session: AgentSession): Promise<void> {
		session.mcp?.revoke();
		return session.closing ??= Promise.resolve().then(async () => {
			clearTimeout(session.idle);
			session.stop.abort();
			await session.client?.close();
			if (session.scratch) await rm(session.scratch, { recursive: true, force: true }).catch(() => this.log("Could not remove an official agent's temporary files."));
			// A stopped in-flight turn still owns the journal until it has finished classifying its outcome.
			if (!session.busy && this.#sessions.get(key) === session) this.#sessions.delete(key);
		});
	}

	provider(definition: OfficialAgentDefinition): Provider {
		const directory = join(this.dataDir, "official-agents", definition.id);
		const accounts = new OfficialAgentAccounts({
			directory, definition, credentials: this.credentials, log: this.log,
			stopWorkers: async () => {
				await Promise.all([...this.#sessions].filter(([, session]) => session.providerId === definition.id).map(async ([key, session]) => {
					await this.#close(key, session);
					await session.turnFinished;
				}));
			},
		});
		this.#accounts.add(accounts);
		const signInChanging = () => new AcpProtocolError("Antigravity sign-in is changing. Try the next turn after it finishes.");
		const catalogPath = join(directory, "models.json");
		const models = new Map(definition.models.map(model => [model.id, model]));
		const updateCatalog = (reported: unknown): boolean => {
			let changed = false;
			if (!Array.isArray(reported)) return false;
			for (const model of reported.slice(0, 256) as Partial<OfficialAgentModel>[]) {
				if (typeof model?.id !== "string" || !/^[\w./:-]{1,160}$/.test(model.id) || typeof model.name !== "string" || !model.name || model.name.length > 160) continue;
				if ((models.size >= 256 && !models.has(model.id)) || models.get(model.id)?.name === model.name) continue;
				models.set(model.id, { id: model.id, name: model.name });
				changed = true;
			}
			return changed;
		};
		try { updateCatalog(JSON.parse(readFileSync(catalogPath, "utf8"))); } catch { /* Retain the bootstrap catalog. */ }
		let catalogWrite = Promise.resolve();
		const publish = (reported: OfficialAgentModel[]) => {
			if (updateCatalog(reported)) catalogWrite = catalogWrite
				.then(() => writeJsonFile(catalogPath, [...models.values()]))
				.catch(() => this.log("Could not save the official-agent model catalog."));
		};
		let advertisedVersion: string | undefined;
		const stream = (model: Model<string>, context: TranscriptContext, options?: StreamOptions) => {
			const events = createAssistantMessageEventStream();
			const answer: AssistantMessage = {
				role: "assistant", api: model.api, provider: model.provider, model: model.id,
				content: [], stopReason: "stop", usage: acpUsage(undefined), timestamp: Date.now(),
			};
			let text = "";
			let block: { type: "text" | "thinking"; index: number } | undefined;
			const endBlock = () => {
				if (!block) return;
				const content = answer.content[block.index];
				if (content?.type === "text") events.push({ type: "text_end", contentIndex: block.index, content: content.text, partial: answer });
				if (content?.type === "thinking") events.push({ type: "thinking_end", contentIndex: block.index, content: content.thinking, partial: answer });
				block = undefined;
			};
			const delta = (type: "text" | "thinking", fragment: string) => {
				if (!fragment) return;
				if (type !== block?.type) {
					endBlock();
					block = { type, index: answer.content.length };
					answer.content.push(type === "text" ? { type, text: "" } : { type, thinking: "" });
					events.push({ type: type === "text" ? "text_start" : "thinking_start", contentIndex: block.index, partial: answer });
				}
				const content = answer.content[block.index]!;
				if (content.type === "text") { content.text += fragment; text += fragment; }
				if (content.type === "thinking") content.thinking += fragment;
				events.push({ type: type === "text" ? "text_delta" : "thinking_delta", contentIndex: block.index, delta: fragment, partial: answer });
			};
			const last = context.messages.at(-1);
			const request = last && this.#requests.get(last);
			const sessionId = options?.sessionId;
			const signal = options?.signal;
			void (async () => {
				if (!request || !sessionId) throw new AcpProtocolError("Official-agent models run only in worker conversations.");
				const key = digest(`${definition.id}:${sessionId}`);
				const journalPath = join(this.dataDir, "official-agents", definition.id, `${key}.json`);
				if (signal?.aborted || this.#shuttingDown) throw new AcpProcessError("The agent turn was cancelled.");
				if (accounts.changing) throw signInChanging();
				let session = this.#sessions.get(key);
				if (session?.busy) throw new AcpProtocolError("The worker already has an agent turn in progress.");
				if (session && (request.cwd !== session.request.cwd || request.projectId !== session.request.projectId || request.conversationId !== session.request.conversationId)) throw new AcpProtocolError("The agent workspace changed.");
				// A reassigned worker keeps its native history, but the old process holds a task-bound grant.
				if (!session || session.closing || (session.client && !session.client.alive) || session.request.mcpScope?.taskId !== request.mcpScope?.taskId) {
					if (session) await this.#close(key, session);
					if (accounts.changing) throw signInChanging();
					session = { providerId: definition.id, request, stop: new AbortController(), busy: false };
					this.#sessions.set(key, session);
				}
				const running = session;
				running.busy = true;
				const finished = Promise.withResolvers<void>();
				running.turnFinished = finished.promise;
				clearTimeout(running.idle);
				const stop = () => { void this.#close(key, running); };
				signal?.addEventListener("abort", stop, { once: true });
				const cancelled = () => signal?.aborted || running.stop.signal.aborted;
				const checkCancelled = () => { if (cancelled()) throw new AcpProcessError("The agent turn was cancelled."); };
				const turnId = digest(request.turnId);
				let sent = false;
				let previous: Turn | undefined;
				try {
					checkCancelled();
					const journal = running.journal ?? await readJsonFile(journalPath) as SessionJournal | undefined;
					if (journal && (journal.cwd !== request.cwd || journal.modelId !== model.id || !journal.sessionId || !journal.turns)) throw new AcpProtocolError("The saved agent session does not match this workspace or model.");
					previous = journal?.turns[turnId];
					if (previous?.state === "failed") throw new AcpProcessError(previous.error);
					if (previous?.state === "done") {
						answer.usage = previous.usage;
						events.push({ type: "start", partial: answer });
						delta("text", previous.text);
						return;
					}
					const account = await accounts.workerLogin(running.stop.signal);
					checkCancelled();
					if (!account) throw new AcpProcessError(definition.signInRequired);
					const { login, profile, identity } = account;
					const sameLogin = journal && (journal.loginIdentity ?? journal.loginMode) === identity;
					if (!sameLogin && previous?.state === "sent") throw new AcpProtocolError("Sign-in changed while a turn was interrupted. Inspect its workspace before sending a follow-up.");
					if (!running.client) {
						const binary = await definition.install().catch(error => {
							// Installer errors are generated by Kemiri, but arbitrary OS/network diagnostics stay private.
							const detail = error instanceof Error && /not executable|Unsupported Antigravity platform|SHA-512 mismatch|HTTP \d+/.test(error.message) ? ` ${error.message}.` : "";
							throw new AcpProcessError(`${definition.name} is not installed.${detail}`);
						});
						checkCancelled();
						await mkdir(profile, { recursive: true, mode: 0o700 });
						await chmod(profile, 0o700);
						await definition.prepareProfile(profile, login);
						const scratch = await mkdtemp(join(profile, "tmp-"));
						if (cancelled()) { await rm(scratch, { recursive: true, force: true }); checkCancelled(); }
						running.scratch = scratch;
						const env = { ...officialAgentEnvironment(profile, scratch), ...definition.environment(profile, login) };
						if (this.mcp && request.mcpScope) {
							const scope = await request.mcpScope.create();
							checkCancelled();
							running.mcp = this.mcp.grant(scope);
						}
						const client = running.client = new AcpClient(binary, definition.launchArgs(profile), request.cwd, env, this.log, () => running.mcp?.revoke());
						// A worker must never start an interactive OAuth flow on expiry.
						const opened = await client.open(request.cwd, sameLogin ? journal.sessionId : undefined, login.mode === "api-key" ? definition.apiKeyMethod : undefined, running.mcp ? [running.mcp.server] : []);
						if (typeof opened.version === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(opened.version)) advertisedVersion = opened.version;
						await client.selectModel(opened.session, model.id, publish);
						running.journal = sameLogin ? journal : { sessionId: opened.sessionId, cwd: request.cwd, modelId: model.id, loginMode: login.mode, loginIdentity: identity, turns: journal?.turns ?? {} };
					}
					const sessionJournal = running.journal!;
					const resumed = previous?.state === "sent";
					// The retry sees the same generation task ID, even if pi-durable kept an aborted assistant partial.
					const boundary = context.messages.findLastIndex(message => message.role === "assistant" && message.stopReason !== "aborted");
					// A new account never receives the previous account's unanswered inputs.
					const userMessages = (journal && !sameLogin ? context.messages.slice(-1) : context.messages.slice(boundary + 1)).filter(message => message.role === "user");
					if (!resumed && (!userMessages.length || userMessages.some(message => typeof message.content !== "string" && message.content.some(block => block.type !== "text")))) {
						throw new AcpProtocolError("Official-agent workers need a text user input for this turn.");
					}
					const input = userMessages.map(message => contentText(message.content)).join("\n\n");
					const instructions = getCurrentSystemPrompt(context.messages);
					const prompt = resumed ? RESUME_PROMPT : !sameLogin || Object.keys(sessionJournal.turns).length === 0
						? `--- Worker instructions ---\n${instructions}\n--- End worker instructions ---\n\n--- User input ---\n${input}\n--- End user input ---` : input;
					checkCancelled();
					sessionJournal.turns[turnId] = { state: "sent" };
					await writeJsonFile(journalPath, sessionJournal);
					sent = true;
					checkCancelled();
					events.push({ type: "start", partial: answer });
					if (resumed) delta("text", RESUME_NOTE);
					let usage: unknown;
					let recorded = Promise.resolve();
					const result = await running.client.prompt(prompt, update => {
						const activity = acpActivityUpdate(update, request.cwd);
						const record = request.recordActivity;
						if (record && activity) recorded = recorded.then(() => record(activity)).catch(() => {
							this.log("Could not record official-agent activity.");
						});
						else if (activity && "callId" in activity && activity.status) delta("thinking", `${acpToolLabel(activity.kind ?? "other")} (${activity.status})\n`);
						else streamUpdate(update, delta);
						if (update.sessionUpdate === "usage_update" && ("usage" in update || "inputTokens" in update)) usage = update.usage ?? update;
					}, kind => delta("thinking", `Permission: ${kind === "cancelled" ? "cancelled" : `approved (${kind})`}\n`)).finally(async () => { await recorded; });
					checkCancelled();
					if (result?.stopReason !== "end_turn") {
						const reason = result?.stopReason;
						throw new AcpProtocolError(reason === "max_tokens" || reason === "max_turn_requests" ? "The agent reached its turn limit." : reason === "refusal" ? "The agent refused the turn." : "The agent did not finish the ACP turn.");
					}
					if (!text.slice(resumed ? RESUME_NOTE.length : 0).trim()) throw new AcpProtocolError("The agent finished without writing a report.");
					answer.usage = acpUsage(result.usage ?? usage, definition.separateThoughtTokens);
					sessionJournal.turns[turnId] = { state: "done", text, usage: answer.usage };
					await writeJsonFile(journalPath, sessionJournal);
				} catch (error) {
					let message = previous?.state === "failed" && !sent ? previous.error
						: error instanceof AcpProcessError && error.message === definition.signInRequired ? error.message : failure(definition, error);
					if (sent && !(this.#shuttingDown && cancelled()) && running.journal) {
						running.journal.turns[turnId] = { state: "failed", error: message };
						try { await writeJsonFile(journalPath, running.journal); }
						catch { message = `${message} Kemiri could not record this failure; inspect the workspace before retrying.`; }
					}
					await this.#close(key, running);
					throw new AcpProcessError(message);
				} finally {
					signal?.removeEventListener("abort", stop);
					running.busy = false;
					finished.resolve();
					if (running.closing) this.#sessions.delete(key);
					else running.idle = setTimeout(() => { void this.#close(key, running); }, IDLE_MS).unref();
				}
			})().then(() => {
				endBlock();
				events.push({ type: "done", reason: "stop", message: answer });
			}, error => {
				endBlock();
				answer.stopReason = signal?.aborted ? "aborted" : "error";
				answer.errorMessage = error instanceof AcpProcessError || error instanceof AcpProtocolError ? error.message : failure(definition, error);
				events.push({ type: "error", reason: answer.stopReason, error: answer });
			}).finally(() => events.end(answer));
			return events;
		};

		const provider: Provider = {
			id: definition.id, name: definition.name,
			auth: { apiKey: {
				name: definition.apiKeyName,
				check: async ({ credential }) => credential?.key ? { type: "api_key" } : undefined,
				// Resolve the selected account inside the worker, after registering it for teardown.
				resolve: async () => ({ auth: {} }),
			}, oauth: {
				name: definition.subscriptionName,
				loginLabel: "Sign in with Google",
				isSubscription: true,
				login: interaction => accounts.login(interaction),
				refresh: async marker => marker,
				toAuth: async () => ({}),
			} },
			getModels: () => [...models.values()].map(({ id, name }) => ({
				id, name, api: OFFICIAL_AGENT_API, provider: definition.id, baseUrl: "", input: ["text"], reasoning: false,
				cost: zeroCost(), contextWindow: 0, maxTokens: 0,
			})),
			streamSimple: stream,
			stream: stream,
		};
		officialAgentAccounts.set(provider, accounts);
		providerMetadata.set(provider, async () => ({
			transport: definition.transport, pinnedVersion: definition.pinnedVersion,
			installedVersion: advertisedVersion ?? await definition.installedVersion(), subscriptionWarning: definition.subscriptionWarning,
		}));
		return provider;
	}
}

function streamUpdate(update: AcpUpdate, delta: (type: "text" | "thinking", fragment: string) => void): void {
	const linePart = (value: unknown, fallback: string) => typeof value === "string" ? value.replace(/\s+/g, " ").slice(0, 160) : fallback;
	switch (update.sessionUpdate) {
		case "agent_message_chunk":
		case "agent_thought_chunk": {
			const content = update.content as { type?: string; text?: string } | undefined;
			if (content?.type === "text" && typeof content.text === "string") delta(update.sessionUpdate === "agent_message_chunk" ? "text" : "thinking", content.text);
			break;
		}
		case "plan": {
			if (!Array.isArray(update.entries)) break;
			const summary = update.entries.slice(0, 6).map(entry => `${linePart(entry?.content, "step")} (${linePart(entry?.status, "pending")})`).join("; ");
			if (summary) delta("thinking", `Plan: ${summary}\n`);
			break;
		}
	}
}
