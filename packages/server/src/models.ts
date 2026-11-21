/**
 * pi-ai model access for the harness: the providers from the design, credential-backed, plus a catalog for the
 * client. No model defaults live here or anywhere else: the client picks every conversation model. The bounded report audit is the sole
 * server-chosen default; it chooses a credentialed small model, never a coordinator or worker.
 */
import {
	type Api,
	type AuthCheck,
	type CredentialStore,
	createModels,
	type Models,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { describeOfficialAgent, isWorkerOnlyModel } from "./official-agents/provider.ts";
import {
	THINKING_LEVELS,
	type ModelInfo,
	type ModelRef,
	type ProviderInfo,
	type ThinkingLevel,
} from "@kemiri/protocol";

/** The providers the harness exposes to clients. */
/**
 * `openai-codex` is the Codex CLI's ChatGPT login, which pi-ai calls legacy. It stays because a ChatGPT workspace
 * account gets "Your organization hasn't enabled access for this app" from Sign in with ChatGPT (`openai`).
 */
export const HARNESS_PROVIDERS = ["opencode-go", "anthropic", "openai", "openai-codex"] as const;

/** Claude Code version sent with Anthropic requests; kept aligned with pi-ai's OAuth identity (1.6.0: 2.1.322). */
export const CLAUDE_CODE_VERSION = "2.1.322";

export function createHarnessModels(options: { credentials: CredentialStore; officialAgent?: Provider }): Models {
	const models = createModels({ credentials: options.credentials });
	// Side-effect free factories: their API SDKs load lazily on the first request.
	models.setProvider(opencodeGoProvider());
	const anthropic = anthropicProvider();
	// Provider-side model switches require an explicit product choice, not a catalog upgrade.
	const withoutFallbacks = <T extends Model<Api>>(model: T): T => model.compat && "allowedFallbackModels" in model.compat && model.compat.allowedFallbackModels?.length
		? { ...model, compat: { ...model.compat, allowedFallbackModels: [] } } : model;
	// Newer models reject subscription requests from older Claude Code versions; model headers override pi-ai's own.
	const withClaudeCodeVersion = <T extends Model<Api>>(model: T): T =>
		({ ...model, headers: { ...model.headers, "user-agent": `claude-cli/${CLAUDE_CODE_VERSION}` } });
	const anthropicChatModel = <T extends Model<Api>>(model: T): T => withClaudeCodeVersion(withoutFallbacks(model));
	models.setProvider({
		...anthropic,
		getModels: () => anthropic.getModels().map(anthropicChatModel),
		getAllModels: () => (anthropic.getAllModels?.() ?? anthropic.getModels()).map(model =>
			model.type === undefined || model.type === "chat" ? anthropicChatModel(model) : model),
	});
	models.setProvider(withGpt62CatalogPolicy(openaiProvider()));
	models.setProvider(withGpt62CatalogPolicy(openaiCodexProvider()));
	if (options.officialAgent) models.setProvider(options.officialAgent);
	return models;
}

/** Keep the existing Kemiri limits and choices while using the native prices and request capabilities. */
function withGpt62CatalogPolicy(provider: Provider): Provider {
	const applyPolicy = (model: Model<Api>): Model<Api> => {
		if (model.id !== "gpt-6.2-astra" && model.id !== "gpt-6.2-sol") return model;
		// pi caps the direct API at the short pricing tier; Kemiri deliberately offers the full API context.
		if (provider.id === "openai") return { ...model, contextWindow: 1_050_000 };
		// Codex aliases minimal to low; do not offer a duplicate effort in the picker.
		return { ...model, thinkingLevelMap: { ...model.thinkingLevelMap, minimal: null } };
	};
	return {
		...provider,
		getModels: () => provider.getModels().map(applyPolicy),
		getAllModels: () => (provider.getAllModels?.() ?? provider.getModels()).map(model =>
			model.type === undefined || model.type === "chat" ? applyPolicy(model) : model),
	};
}

export type ModelCatalog = {
	providers: ProviderInfo[];
	models: ModelInfo[];
};

function thinkingLevelsOf(model: Model<string>): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return THINKING_LEVELS.filter((level) => model.thinkingLevelMap?.[level] !== null);
}

/** Every chat model of the registered providers, with whether its provider has a credential. */
export async function describeModels(models: Models): Promise<ModelCatalog> {
	const providers = models.getProviders();
	const auth = new Map<string, AuthCheck | undefined>();
	await Promise.all(
		providers.map(async (provider) => {
			try {
				auth.set(provider.id, await models.checkAuth(provider.id));
			} catch {
				// A credential store failure means "not configured" for listing; request paths report it in detail.
				auth.set(provider.id, undefined);
			}
		}),
	);

	const providerInfos: ProviderInfo[] = await Promise.all(providers.map(async (provider) => {
		const check = auth.get(provider.id);
		const oauth = provider.auth.oauth;
		const officialAgent = await describeOfficialAgent(provider);
		return {
			id: provider.id,
			name: provider.name,
			configured: check !== undefined,
			...(officialAgent === undefined ? {} : { officialAgent }),
			...(check === undefined ? {} : { authType: check.type }),
			...(oauth === undefined
				? {}
				: {
						oauth: {
							name: oauth.name,
							loginLabel: oauth.loginLabel ?? oauth.name,
							isSubscription: oauth.isSubscription === true,
						},
					}),
		};
	}));

	const modelInfos: ModelInfo[] = [];
	for (const provider of providers) {
		const configured = auth.get(provider.id) !== undefined;
		for (const model of provider.getModels()) {
			modelInfos.push({
				provider: provider.id,
				modelId: model.id,
				api: model.api,
				name: model.name,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				input: [...model.input],
				reasoning: model.reasoning,
				thinkingLevels: thinkingLevelsOf(model),
				configured,
				...(isWorkerOnlyModel(models, { provider: provider.id, modelId: model.id }) ? { workerOnly: true } : {}),
			});
		}
	}

	return { providers: providerInfos, models: modelInfos };
}

/** A model is usable only when a provider lists it; the protocol rejects unknown refs at configure time. */
export function findModel(models: Models, ref: ModelRef): Model<string> | undefined {
	return models.getModel(ref.provider, ref.modelId);
}
