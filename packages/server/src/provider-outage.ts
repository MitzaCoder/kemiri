import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type Models, type ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, GenerationTask, hook, modelRequestAdmission, type Harness, type ModelRequestAdmission, type SetTimer } from "@earendil-works/pi-durable";

const NETWORK_RETRY_LIMIT_MS = 3 * 60 * 60_000;
const NETWORK_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 30_000, 60_000, 120_000];
// Unlike the raw SDK error, this text won't spend pi's ordinary model retry budget after the outage has expired.
export const PROVIDER_UNREACHABLE = "Could not reach the model provider.";

export type ProviderOutage = {
	taskId: number; provider: string; label: string; startedAt: number; tries: number; error: string;
	/** Absent once we gave up. */
	retryAt?: number;
};

export const ProviderOutageDoc = defineDoc<{ outage?: ProviderOutage }>({
	kind: "kemiri.provider-outage", scope: "conversation", version: 1, history: "latest", fork: "initial", initial: () => ({}),
	checkpointWhen: doc => doc.outage === undefined,
});

/** Deliberately exclude provider-side HTTP errors and arbitrary JSON error bodies. */
export function isProviderNetworkError(error: string | undefined): boolean {
	const message = error?.trim();
	if (!message || /^(?:HTTP\s*)?[45]\d\d\b|^[{\[]|\bstatus(?: code)?[: ]+[45]\d\d\b/i.test(message)) return false;
	const cause = message.replace(/^(?:connection error[.:\s]+|typeerror:\s*)+/i, "");
	return /^(?:(?:getaddrinfo|connect|read|write|syscall)\s+)?(?:ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN|UND_ERR_CONNECT_TIMEOUT)\b/.test(cause) ||
		/^(?:fetch failed|failed to fetch|network(?: request)? failed|network error|(?:the )?network is offline|you are offline|offline|unable to connect|connection (?:refused|timed out|reset by peer))(?:$|[.:\s])/i.test(cause);
}

function hasOutput(message: AssistantMessage): boolean {
	return message.content.some(block => block.type === "text" ? block.text.length > 0
		: block.type === "thinking" ? block.thinking.length > 0 : true);
}

function waitForRetry(delay: number, signal: AbortSignal | undefined, setTimer: SetTimer): Promise<void> {
	return new Promise((resolve, reject) => {
		signal?.throwIfAborted();
		const abort = () => { cancel?.(); reject(signal?.reason); };
		const fire = () => { signal?.removeEventListener("abort", abort); resolve(); };
		const cancel = setTimer(fire, delay, { background: false }) ?? defaultTimer(fire, delay, { background: false });
		signal?.addEventListener("abort", abort, { once: true });
	});
}

const defaultTimer: SetTimer = (fire, delay) => {
	const timer = setTimeout(fire, delay);
	timer.unref?.();
	return () => clearTimeout(timer);
};

type GenerationRequest = {
	taskId: number;
	now(): number;
	previous?: ProviderOutage;
	save(outage: ProviderOutage | undefined): Promise<void>;
};

type AdmissionOptions = ModelsSimpleStreamOptions & { [modelRequestAdmission]?: ModelRequestAdmission };

/** Hold the same generation before pi sees a failed response. Tools and already-streamed answers are never replayed. */
export class ProviderOutageModels {
	readonly #generationRequests = new WeakMap<object, GenerationRequest>();
	// The normal maintenance path never scans the task graph. On reopen, only persisted waits enable the scan.
	readonly #projectsWithOutages = new WeakSet<Harness>();

	constructor(readonly setTimer: SetTimer = defaultTimer) {}

	async restore(harness: Harness): Promise<void> {
		if (await projectHasProviderOutage(harness)) this.#projectsWithOutages.add(harness);
	}

	checkProject(harness: Harness): Promise<boolean> | undefined {
		return this.#projectsWithOutages.has(harness) ? projectHasProviderOutage(harness) : undefined;
	}

	extension(harness: Harness) {
		return defineExtension({ name: "provider-outage", hooks: [hook(GenerationTask, {
			beforeRequest: async ({ messages }, api, context) => {
				const last = messages.at(-1);
				if (!last) return;
				const { conversationId, taskId } = api;
				const previous = (await api.snapshot(ProviderOutageDoc, conversationId, context))?.outage;
				this.#generationRequests.set(last, {
					taskId, now: () => api.now(), ...(previous?.taskId === taskId ? { previous } : {}),
					save: outage => {
						if (outage?.retryAt !== undefined) this.#projectsWithOutages.add(harness);
						return harness.commit(async tx => {
							// Ignore a late response when Stop or a replacement run has taken ownership.
							const task = await tx.task(taskId);
							if (!task || task.abortRequested || task.state.status !== "running") return;
							const doc = await tx.doc(ProviderOutageDoc, conversationId);
							if (outage) doc.outage = outage;
							else delete doc.outage;
						}, context);
					},
				});
			},
		})] });
	}

	wrap(models: Models): Models {
		const stream: typeof models.streamSimple = (model, context, options?: AdmissionOptions) => {
			const last = "messages" in context ? context.messages.at(-1) : undefined;
			const request = last && options?.[modelRequestAdmission] ? this.#generationRequests.get(last) : undefined;
			if (!request || !last) return models.streamSimple(model, context, options);
			this.#generationRequests.delete(last);
			const signal = options?.signal;
			const admission = options?.[modelRequestAdmission];
			const label = models.getProvider(model.provider)?.name || model.provider;
			const output = createAssistantMessageEventStream();
			const finish = (message: AssistantMessage) => {
				if (message.stopReason === "error" || message.stopReason === "aborted") output.push({ type: "error", reason: message.stopReason, error: message });
				else if (message.stopReason !== "pending") output.push({ type: "done", reason: message.stopReason, message });
				output.end(message);
			};
			const failed = (error: unknown): AssistantMessage => {
				const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
				return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, timestamp: request.now(),
					stopReason: signal?.aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : String(error),
					usage: { ...cost, totalTokens: 0, cost } };
			};
			const run = async () => {
				let outage = request.previous?.provider === model.provider ? request.previous : undefined;
				for (;;) {
					signal?.throwIfAborted();
					while (outage?.retryAt !== undefined && outage.retryAt > request.now())
						await waitForRetry(outage.retryAt - request.now(), signal, this.setTimer);
					// Before a real request, restore the engine's usual interrupted-attempt handling.
					if (admission?.waiting === "before-send" && outage) await admission.set(undefined);
					let start: AssistantMessageEvent | undefined;
					let streamed = false;
					let message: AssistantMessage;
					try {
						const response = models.streamSimple(model, context, options);
						for await (const event of response) {
							if (event.type === "error" || event.type === "done") continue;
							if (event.type === "start" && !hasOutput(event.partial)) { start = event; continue; }
							if (start) { output.push(start); start = undefined; }
							streamed ||= hasOutput(event.partial);
							output.push(event);
						}
						message = await response.result();
					} catch (error) { message = failed(error); }
					signal?.throwIfAborted();
					if (message.stopReason !== "error" || !isProviderNetworkError(message.errorMessage)) {
						if (request.previous || outage) await request.save(undefined);
						if (start) output.push(start);
						return finish(message);
					}
					const now = request.now();
					const startedAt = outage?.startedAt ?? now;
					const tries = (outage?.tries ?? 0) + 1;
					const deadline = startedAt + NETWORK_RETRY_LIMIT_MS;
					const retryAt = !streamed && !hasOutput(message) && now < deadline
						? Math.min(deadline, now + NETWORK_RETRY_DELAYS_MS[Math.min(tries - 1, NETWORK_RETRY_DELAYS_MS.length - 1)]!) : undefined;
					outage = { taskId: request.taskId, provider: model.provider, label, startedAt, tries, error: message.errorMessage!, ...(retryAt === undefined ? {} : { retryAt }) };
					if (retryAt !== undefined) await admission?.set("before-send");
					await request.save(outage);
					if (retryAt === undefined) return finish({ ...message, errorMessage: PROVIDER_UNREACHABLE });
				}
			};
			void run().catch(error => finish(failed(error)));
			return output;
		};
		return new Proxy(models, { get(target, key, receiver) {
			if (key === "streamSimple") return stream;
			const original: unknown = Reflect.get(target, key, receiver);
			return typeof original === "function" ? original.bind(target) : original;
		} });
	}
}

/** Only an unfinished, non-aborting generation can hold board maintenance. */
export async function projectHasProviderOutage(harness: Harness): Promise<boolean> {
	for (const { record: task } of (await harness.inspect(BACKGROUND_CONTEXT)).tasks) {
		if (task.kind !== "pi.generation" || task.abortRequested || task.conversationId === undefined) continue;
		const outage = (await harness.snapshot(ProviderOutageDoc, task.conversationId, BACKGROUND_CONTEXT))?.outage;
		if (outage?.taskId === task.id && outage.retryAt !== undefined) return true;
	}
	return false;
}
