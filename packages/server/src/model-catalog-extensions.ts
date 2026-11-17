/** Temporary catalog entries until pi-ai ships them. Native entries always win, including their compat flags. */
import type { Api, Model, Provider } from "@earendil-works/pi-ai";

export type ModelCatalogExtension = {
	provider: string;
	baseModelId: string;
	model: Pick<Model<Api>, "id" | "name" | "cost" | "contextWindow" | "maxTokens"> & Partial<Pick<Model<Api>, "thinkingLevelMap">>;
	compat?: Model<Api>["compat"];
};

// pi main e56d35ce + cead615b, with the full OpenAI API context from its model pages.
// Retain provider-specific Codex defaults and long-context pricing on every provider.
const astraCost: Model<Api>["cost"] = {
	input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10,
	tiers: [{ inputTokensAbove: 272_000, input: 16, output: 60, cacheRead: 0.8, cacheWrite: 20 }],
};
const solCost: Model<Api>["cost"] = {
	input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5,
	tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
};

export const MODEL_CATALOG_EXTENSIONS: readonly ModelCatalogExtension[] = [
	{
		provider: "openai", baseModelId: "gpt-6-astra",
		model: { id: "gpt-6.2-astra", name: "GPT-6.2 Astra", cost: astraCost, contextWindow: 1_050_000, maxTokens: 128_000 },
	},
	{
		provider: "openai", baseModelId: "gpt-6.1-sol",
		model: { id: "gpt-6.2-sol", name: "GPT-6.2 Sol", cost: solCost, contextWindow: 1_050_000, maxTokens: 128_000 },
	},
	{
		provider: "openai-codex", baseModelId: "gpt-6-astra",
		// Upstream aliases minimal to low on Codex; omit that misleading picker choice.
		model: { id: "gpt-6.2-astra", name: "GPT-6.2 Astra", cost: astraCost, contextWindow: 272_000, maxTokens: 128_000, thinkingLevelMap: { minimal: null } },
	},
	{
		provider: "openai-codex", baseModelId: "gpt-6.1-sol",
		model: { id: "gpt-6.2-sol", name: "GPT-6.2 Sol", cost: solCost, contextWindow: 500_000, maxTokens: 128_000, thinkingLevelMap: { minimal: null } },
	},
	{
		provider: "azure", baseModelId: "gpt-6-astra",
		model: { id: "gpt-6.2-astra", name: "GPT-6.2 Astra", cost: astraCost, contextWindow: 1_050_000, maxTokens: 128_000 },
	},
	{
		provider: "azure", baseModelId: "gpt-6.1-sol",
		model: { id: "gpt-6.2-sol", name: "GPT-6.2 Sol", cost: solCost, contextWindow: 1_050_000, maxTokens: 128_000 },
	},
];

/** Extend the provider, not just models.list: runtime lookup, costs, caches and both clients share this catalog. */
export function withModelCatalogExtensions(provider: Provider, catalog: readonly ModelCatalogExtension[] = MODEL_CATALOG_EXTENSIONS): Provider {
	const extensions = catalog.filter((extension) => extension.provider === provider.id);
	if (extensions.length === 0) return provider;

	const extraModels = (nativeModels: readonly Model<Api>[]): Model<Api>[] => {
		const extra: Model<Api>[] = [];
		for (const extension of extensions) {
			if (nativeModels.some((model) => model.id === extension.model.id)) continue;
			const base = nativeModels.find((model) => model.id === extension.baseModelId);
			if (base === undefined) continue; // A removed base must not break the provider's synchronous catalog.
			extra.push({
				...base, ...extension.model,
				...(extension.model.thinkingLevelMap === undefined ? {} : {
					thinkingLevelMap: { ...base.thinkingLevelMap, ...extension.model.thinkingLevelMap },
				}),
				compat: { ...base.compat, ...extension.compat },
			});
		}
		return extra;
	};

	return {
		...provider,
		getModels: () => {
			const nativeModels = provider.getModels();
			return [...nativeModels, ...extraModels(nativeModels)];
		},
		getAllModels: () => [...(provider.getAllModels?.() ?? provider.getModels()), ...extraModels(provider.getModels())],
	};
}
