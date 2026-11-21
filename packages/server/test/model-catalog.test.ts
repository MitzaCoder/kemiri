import { describe, expect, it } from "bun:test";
import { calculateCost, createModels, InMemoryCredentialStore, type Api, type Model, type Usage } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { azureProvider } from "@earendil-works/pi-ai/providers/azure";
import { createHarnessModels, describeModels, findModel } from "../src/models.ts";
import { createSetup, TestClient } from "./support.ts";
import type { ThinkingLevel } from "@kemiri/protocol";

const ref = { provider: "anthropic", modelId: "claude-fable-5-2" };
const credentials = () => new InMemoryCredentialStore();
const fable = () => findModel(createHarnessModels({ credentials: credentials() }), ref)! as Model<"anthropic-messages">;

const usage = (hour = false): Usage => ({
	input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000,
	cacheWrite1h: hour ? 1_000_000 : 0, totalTokens: 4_000_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

describe("pi model catalog", () => {
	const gpt62Efforts: ThinkingLevel[] = ["low", "medium", "high", "xhigh", "max"];
	for (const [factory, contextWindows] of [
		[openaiProvider, [1_050_000, 1_050_000]],
		[openaiCodexProvider, [272_000, 500_000]],
		[azureProvider, [1_050_000, 1_050_000]],
	] as const) {
		const provider = factory();
		it(`uses native GPT-6.2 prices and capabilities for ${provider.id}`, async () => {
			const azureModels = createModels({ credentials: credentials() });
			if (provider.id === "azure") azureModels.setProvider(provider);
			const models = provider.id === "azure" ? azureModels : createHarnessModels({ credentials: credentials() });
			const catalog = await describeModels(models);
			for (const [suffix, contextWindow, cost] of [
				["astra", contextWindows[0], { input: 8, output: 40, cacheRead: 0.4, cacheWrite: 10 }],
				["sol", contextWindows[1], { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }],
			] as const) {
				const modelId = `gpt-6.2-${suffix}`;
				const native = provider.getModels().find(model => model.id === modelId)!;
				const model = findModel(models, { provider: provider.id, modelId })!;
				expect(model as Model<Api>).toEqual({ ...native, contextWindow, thinkingLevelMap: { ...native.thinkingLevelMap, minimal: null } });
				expect(model).toMatchObject({ reasoning: true, input: ["text", "image"], cost, maxTokens: 128_000 });
				expect(models.getAllModels(provider.id).filter(entry => entry.id === modelId)).toEqual([model]);
				expect(catalog.models.find(entry => entry.provider === provider.id && entry.modelId === modelId)).toMatchObject({ contextWindow, maxTokens: 128_000, thinkingLevels: gpt62Efforts });
				const atThreshold = { ...usage(), input: 272_000, cacheRead: 0, cacheWrite: 0, totalTokens: 1_272_000 };
				expect(calculateCost(model, atThreshold).output).toBe(cost.output);
				expect(calculateCost(model, { ...atThreshold, input: 272_001 }).output).toBe(cost.output * 1.5);
				expect(calculateCost(model, usage())).toMatchObject({
					input: cost.input * 2, output: cost.output * 1.5, cacheRead: cost.cacheRead * 2, cacheWrite: cost.cacheWrite * 2,
				});
			}
		});
	}

	it("does not expose Azure in the harness catalog", async () => {
		const catalog = await describeModels(createHarnessModels({ credentials: credentials() }));
		expect(catalog.providers.some(provider => provider.id === "azure")).toBe(false);
	});

	it("uses native Fable 5.2 for runtime lookup, availability and both client catalogs", async () => {
		const store = credentials();
		await store.modify("anthropic", async () => ({ type: "api_key", key: "not-a-real-key" }));
		const models = createHarnessModels({ credentials: store });
		const model = findModel(models, ref)!;
		expect(model).toMatchObject({ id: ref.modelId, name: "Claude Fable 5.2", api: "anthropic-messages", contextWindow: 1_000_000, maxTokens: 128_000, promptCache: { short: 300, long: 3600 } });
		expect(models.getAllModels("anthropic").filter((entry) => entry.id === ref.modelId)).toEqual([model]);
		expect((await models.getAvailable("anthropic")).filter((entry) => entry.id === ref.modelId)).toEqual([model]);
		const catalog = await describeModels(models);
		expect(catalog.models.find((entry) => entry.modelId === ref.modelId)).toMatchObject({ ...ref, name: "Claude Fable 5.2", configured: true, contextWindow: 1_000_000, maxTokens: 128_000, input: ["text", "image"], thinkingLevels: ["minimal", "low", "medium", "high", "xhigh", "max"] });
	});

	it("sets the current Claude Code user agent on every Anthropic chat model without enabling fallbacks", () => {
		const models = createHarnessModels({ credentials: credentials() });
		for (const catalog of [models.getModels("anthropic"), models.getAllModels("anthropic")]) {
			const chatModels = catalog.filter(model => model.type === undefined || model.type === "chat");
			expect(chatModels.length).toBeGreaterThan(0);
			for (const model of chatModels) {
				expect(model.headers?.["user-agent"]).toBe("claude-cli/2.1.322");
				expect((model as Model<"anthropic-messages">).compat?.allowedFallbackModels ?? []).toEqual([]);
			}
		}
		expect(fable().compat?.allowedFallbackModels).toEqual([]);
	});

	it("prices input/output and both cache TTLs through pi-ai's cost calculator", () => {
		expect(calculateCost(fable(), usage())).toEqual({ input: 8, output: 40, cacheRead: 0.2, cacheWrite: 10, total: 58.2, totalFromProvider: false });
		expect(calculateCost(fable(), usage(true)).cacheWrite).toBe(16);
	});

	it("keeps native thinking/system/tool/effort support and disables unsupported sampling", () => {
		expect(fable().compat).toMatchObject({ forceAdaptiveThinking: true, supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true, supportsMidConvoEffort: true });
		expect(fable().thinkingLevelMap).toMatchObject({ off: null, xhigh: "xhigh", max: "max" });
		expect(fable().compat?.allowedFallbackModels).toEqual([]);
		const native = anthropicProvider().getModels().find(model => model.id === ref.modelId)!;
		expect(native.compat?.allowedFallbackModels).toEqual([expect.objectContaining({ model: "claude-opus-5" })]);
	});

	it("returns the model through models.list on a throwaway WebSocket server", async () => {
		const setup = await createSetup({ configureModels: (models) => {
			for (const provider of createHarnessModels({ credentials: credentials() }).getProviders()) models.setProvider(provider);
		} });
		const client = await TestClient.open(setup.server);
		try {
			await client.hello();
			const catalog = await client.request({ type: "models.list" });
			if (catalog.type !== "models.list") throw new Error(`Unexpected ${catalog.type}`);
			expect(catalog.models.find((model) => model.modelId === ref.modelId)).toMatchObject({ ...ref, name: "Claude Fable 5.2", contextWindow: 1_000_000, maxTokens: 128_000 });
			for (const provider of ["openai", "openai-codex"]) {
				for (const modelId of ["gpt-6.2-astra", "gpt-6.2-sol"]) {
					expect(catalog.models.find(model => model.provider === provider && model.modelId === modelId)).toMatchObject({ thinkingLevels: gpt62Efforts, maxTokens: 128_000 });
				}
			}
		} finally {
			client.close();
			await setup.cleanup();
		}
	});

	it("builds adaptive, prefix-safe requests without sending any network request", async () => {
		const models = createModels();
		models.setProvider(anthropicProvider());
		let payload: Record<string, unknown> | undefined;
		let fetches = 0;
		await models.completeSimple(fable(), {
			messages: [
				{ role: "system", timestamp: 0, content: "Stable instructions", toolsAdded: [{ name: "read", description: "Read", parameters: { type: "object", properties: {} } }] },
				{ role: "user", content: "Hello", timestamp: 0 },
				{ role: "system", timestamp: 1, content: "New instructions", toolsAdded: [{ name: "write", description: "Write", parameters: { type: "object", properties: {} } }] },
			],
		}, {
			apiKey: "not-a-real-key", reasoning: "xhigh", temperature: 0.5, cacheRetention: "long",
			onPayload: (body) => { payload = body as Record<string, unknown>; throw new Error("Captured locally; never send"); },
			fetch: Object.assign(async () => { fetches++; throw new Error("Network forbidden"); }, { preconnect: () => undefined }),
		});
		expect(fetches).toBe(0);
		expect(payload).toMatchObject({ model: ref.modelId, max_tokens: 128_000, thinking: { type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } }, output_config: { effort: "low" } });
		expect(payload?.betas).toEqual(expect.arrayContaining(["thinking-binding-controls-2026-08-01", "inline-tools-2026-09-15", "mid-conversation-output-config-2026-07-01"]));
		expect(payload?.temperature).toBeUndefined();
		expect(payload?.fallbacks).toBeUndefined();
		expect(payload?.tool_choice).toBeUndefined();
		const wire = JSON.stringify(payload);
		expect(wire).toContain('"effort":"xhigh"');
		expect(wire).toContain('"tool_addition"');
		expect(wire).toContain("New instructions");
		expect(wire).toContain('"ttl":"1h"');
	});
});
