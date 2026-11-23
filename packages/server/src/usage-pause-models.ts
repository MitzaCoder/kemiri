import {
	createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream,
	type Context, type Model, type Models, type ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { defineExtension, GenerationTask, hook } from "@earendil-works/pi-durable";
import type { UsagePauseGate } from "./usage-pause.ts";

export function usagePauseConversation(projectId: string, conversationId: number): string {
	return JSON.stringify([projectId, conversationId]);
}

type UsagePauseModelsOptions = {
	gate: UsagePauseGate;
	isSubscriptionLogin: (login: string) => Promise<boolean>;
	label: (login: string) => string;
	now?: () => number;
};
type StreamRequest = (model: Model<string>, context: Context, options?: ModelsSimpleStreamOptions) => AssistantMessageEventStream;

/** Admission is outside the provider and request log: long waits are not network time or paid attempts. */
export class UsagePauseModels {
	readonly #options: UsagePauseModelsOptions;
	readonly #conversations = new WeakMap<object, string>();

	constructor(options: UsagePauseModelsOptions) { this.#options = options; }

	extension(projectId: string) {
		return defineExtension({ name: "usage-pause-conversation", hooks: [hook(GenerationTask, {
			beforeRequest: (request, api) => {
				const last = request.messages.at(-1);
				if (last) this.#conversations.set(last, usagePauseConversation(projectId, Number(api.conversationId)));
			},
		})] });
	}

	wrap(models: Models): Models {
		const handlers = new Map<string, unknown>();
		for (const method of ["stream", "streamSimple", "complete", "completeSimple"] as const) {
			const stream = (method === "stream" || method === "complete" ? models.stream : models.streamSimple).bind(models) as StreamRequest;
			handlers.set(method, (model: Model<string>, context: Context, options?: ModelsSimpleStreamOptions) => {
				const response = this.#request(stream, model, context, options);
				return method === "complete" || method === "completeSimple" ? response.result() : response;
			});
		}
		return new Proxy(models, { get(target, property, receiver) {
			if (typeof property === "string" && handlers.has(property)) return handlers.get(property);
			const value: unknown = Reflect.get(target, property, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		} });
	}

	#request(stream: StreamRequest, model: Model<string>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream {
		const { gate, isSubscriptionLogin, label } = this.#options;
		const now = this.#options.now ?? Date.now;
		const login = model.provider;
		const last = "messages" in context ? context.messages.at(-1) : undefined;
		const conversation = last ? this.#conversations.get(last) : undefined;
		const signal = options?.signal;
		const output = createAssistantMessageEventStream();
		const run = async () => {
			for (let attempt = 0; attempt <= 1; attempt++) {
				while (gate.isPaused(login) && !gate.canSend(login, conversation)) await gate.wait(login, signal, conversation);
				signal?.throwIfAborted();
				const denial: { confirmed?: { reset?: number }; httpThrottle?: boolean } = {};
				const requestOptions = this.#inspectLimitDenials(model, options, denial);
				const response = stream(model, context, requestOptions);
				let start: AssistantMessageEvent | undefined;
				let emittedContent = false;
				for await (const event of response) {
					if (event.type === "error" || event.type === "done") continue;
					if (event.type === "start" && event.partial.content.length === 0) { start = event; continue; }
					if (start) { output.push(start); start = undefined; }
					emittedContent = true;
					output.push(event);
				}
				const message = await response.result();
				signal?.throwIfAborted();
				const limit = message.stopReason === "error" ? denial.confirmed ??
					(denial.httpThrottle ? undefined : subscriptionLimitError(login, message.errorMessage, now())) : undefined;
				if (limit !== undefined && await isSubscriptionLogin(login)) {
					signal?.throwIfAborted();
					gate.limitReached(login, `${label(login)} usage limit`, limit.reset);
					if (attempt === 0 && !emittedContent) continue;
					// Do not let the runtime's generic 429 classifier retry the second denial or a partial response.
					end({ ...message, errorMessage: `${label(login)} subscription allowance exhausted.` });
					return;
				}
				if (start) output.push(start);
				end(message);
				return;
			}
		};
		const end = (message: AssistantMessage) => {
			if (message.stopReason === "error" || message.stopReason === "aborted") output.push({ type: "error", reason: message.stopReason, error: message });
			else if (message.stopReason !== "pending") output.push({ type: "done", reason: message.stopReason, message });
			output.end(message);
		};
		void run().catch(error => {
			const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
			end({ role: "assistant", content: [], api: model.api, provider: login, model: model.id, timestamp: now(),
				stopReason: signal?.aborted ? "aborted" : "error", errorMessage: error instanceof Error ? error.message : String(error),
				usage: { ...cost, totalTokens: 0, cost } });
		});
		return output;
	}

	#inspectLimitDenials(model: Model<string>, options: ModelsSimpleStreamOptions | undefined,
		denial: { confirmed?: { reset?: number }; httpThrottle?: boolean }): ModelsSimpleStreamOptions | undefined {
		const claude = model.provider === "anthropic" && model.api === "anthropic-messages";
		const codex = model.provider === "openai-codex" && model.api === "openai-codex-responses";
		if (!claude && !codex) return options;
		const now = this.#options.now ?? Date.now;
		const fetchRequest = options?.fetch ?? fetch;
		return { ...options,
			fetch: Object.assign(async (...args: Parameters<typeof fetch>) => {
				const response = await fetchRequest(...args);
				if (response.ok) return response;
				if (response.status < 400 || response.status >= 500) return response;
				denial.httpThrottle = response.status === 429;
				const text = await response.clone().text().catch(() => "");
				const reported = subscriptionLimitError(model.provider, text, now());
				const unifiedRejected = claude && response.headers.get("anthropic-ratelimit-unified-status") === "rejected";
				if ((!reported && !unifiedRejected) || !await this.#options.isSubscriptionLogin(model.provider)) return response;
				const unifiedReset = Number(response.headers.get("anthropic-ratelimit-unified-reset")) * 1_000;
				denial.confirmed = reported?.reset !== undefined ? reported : unifiedReset > now() ? { reset: unifiedReset } : {};
				if (!claude) return response;
				// The Anthropic SDK normally retries 429s before reporting them. This is not a transient throttle.
				const headers = new Headers(response.headers);
				headers.set("anthropic-should-retry", "false");
				return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
			}, { preconnect: fetchRequest.preconnect }),
			onResponse: async (response, requestedModel) => {
				await options?.onResponse?.(response, requestedModel);
				// The Codex HTTP adapter retries generic 429s, but not errors that explicitly name the usage limit.
				if (codex && denial.confirmed && response.status >= 400) throw new Error("ChatGPT subscription usage limit reached");
			},
		};
	}
}

/** Do not turn a transient request/token throttle, overloaded server or API-key billing error into a pause. */
export function subscriptionLimitError(login: string, error: string | undefined, now: number): { reset?: number } | undefined {
	if (!error) return;
	const matched = login === "openai-codex"
		? /usage_limit_reached|subscription_sharing_usage_limit_exceeded|hit your ChatGPT usage limit/i.test(error)
		: login === "anthropic"
			? /(?:hit|reached|exceeded) (?:your |the )?(?:(?:Claude|subscription|5-hour|weekly) )?usage limit|usage limit (?:has been )?(?:reached|exceeded)/i.test(error)
			: login === "opencode-go" && /GoUsageLimitError|monthly usage limit reached/i.test(error);
	if (!matched) return;
	const unix = /"resets_at"\s*:\s*(\d{10,13})/.exec(error)?.[1];
	const relative = /"resets_in_seconds"\s*:\s*(\d+)/.exec(error)?.[1];
	const roughMinutes = /try again in ~(\d+) min/i.exec(error)?.[1];
	const reset = unix ? Number(unix) * (unix.length === 10 ? 1_000 : 1)
		: relative ? now + Number(relative) * 1_000
			: roughMinutes ? now + Number(roughMinutes) * 60_000 + 30_000 : undefined;
	return reset !== undefined && reset >= now ? { reset } : {};
}
