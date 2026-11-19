/**
 * Official agents in the web app: which models a coordinator picker may offer, how a worker list marks them, and what
 * Accounts says about the login in use, the agent version and the subscription warning.
 */
import { describe, expect, test } from "bun:test";
import type { ModelInfo, ProviderInfo } from "@kemiri/protocol";
import { modelDescription, modelOptions, providerName } from "../src/lib/models.ts";
import {
	OFFICIAL_AGENT_LABEL,
	isOfficialAgentModel,
	isWorkerOnly,
	officialAgentLogin,
	officialAgentLoginLabel,
	officialAgentVersionLine,
	officialAgentWarning,
	providerDisplayName,
	withoutWorkerOnly,
} from "../src/lib/official-agents.ts";
import { projectWorkerModelRows } from "../src/lib/worker-model-hint.ts";

const WARNING = "Synthetic ban-risk warning. A Gemini API key avoids it.";

function agentProvider(overrides: Partial<ProviderInfo> = {}): ProviderInfo {
	return {
		id: "antigravity",
		name: "Antigravity",
		configured: false,
		oauth: { name: "Google AI subscription", loginLabel: "Sign in with Google", isSubscription: true },
		officialAgent: { transport: "acp", pinnedVersion: "1.5.12", installedVersion: null, subscriptionWarning: WARNING },
		...overrides,
	};
}

function model(provider: string, modelId: string, overrides: Partial<ModelInfo> = {}): ModelInfo {
	return {
		provider,
		modelId,
		name: modelId,
		contextWindow: 200_000,
		maxTokens: 8_192,
		input: ["text"],
		reasoning: false,
		thinkingLevels: ["off"],
		configured: true,
		...overrides,
	};
}

const NATIVE = model("anthropic", "claude-sonnet");
const AGENT = model("antigravity", "gemini-3.8-flash", { workerOnly: true, contextWindow: 0, maxTokens: 0 });
const PROVIDERS: ProviderInfo[] = [{ id: "anthropic", name: "Anthropic", configured: true }, agentProvider({ configured: true, authType: "oauth" })];

describe("worker-only models", () => {
	test("a coordinator picker drops them and keeps the order of the rest", () => {
		const other = model("openai", "gpt-5");
		expect(withoutWorkerOnly([NATIVE, AGENT, other])).toEqual([NATIVE, other]);
		expect(isWorkerOnly(AGENT)).toBe(true);
		expect(isWorkerOnly(NATIVE)).toBe(false);
		expect(isWorkerOnly({ workerOnly: false })).toBe(false);
	});

	test("a worker list keeps them and says what they are", () => {
		const options = modelOptions([NATIVE, AGENT], PROVIDERS);
		expect(options.map((option) => option.value)).toEqual(["anthropic/claude-sonnet", "antigravity/gemini-3.8-flash"]);
		expect(options[1]?.description).toBe(`gemini-3.8-flash · ${OFFICIAL_AGENT_LABEL}`);
		expect(options[0]?.description).toBe("claude-sonnet · 200k context");
	});

	test("a model of an official agent counts even when the backend did not tag the model", () => {
		const untagged = model("antigravity", "gemini-3.8-flash");
		expect(isOfficialAgentModel(untagged, PROVIDERS)).toBe(true);
		expect(isOfficialAgentModel(NATIVE, PROVIDERS)).toBe(false);
		expect(modelDescription(untagged, PROVIDERS)).toContain(OFFICIAL_AGENT_LABEL);
	});

	test("the project's worker rows mark an official agent and not an unavailable model", () => {
		const rows = projectWorkerModelRows(
			[
				{ provider: "antigravity", modelId: "gemini-3.8-flash" },
				{ provider: "anthropic", modelId: "claude-sonnet" },
				{ provider: "antigravity", modelId: "retired" },
			],
			[NATIVE, AGENT],
			null,
		);
		expect(rows.map((row) => row.officialAgent)).toEqual([true, false, false]);
		expect(rows.map((row) => row.role)).toEqual(["Default", "Fallback", "Unavailable"]);
	});
});

describe("the login in use", () => {
	test("follows the backend's auth type", () => {
		expect(officialAgentLogin(agentProvider())).toBe("none");
		expect(officialAgentLogin(agentProvider({ configured: true, authType: "oauth" }))).toBe("subscription");
		expect(officialAgentLogin(agentProvider({ configured: true, authType: "api_key" }))).toBe("api_key");
		expect(officialAgentLogin(agentProvider({ configured: true }))).toBe("environment");
		// A stale auth type without a credential is not a login.
		expect(officialAgentLogin(agentProvider({ configured: false, authType: "oauth" }))).toBe("none");
	});

	test("is named the way the user knows it", () => {
		expect(officialAgentLoginLabel("antigravity", "subscription")).toBe("Google subscription");
		expect(officialAgentLoginLabel("antigravity", "api_key")).toBe("Gemini API key");
		expect(officialAgentLoginLabel("antigravity", "none")).toBe("Not signed in");
		expect(officialAgentLoginLabel("future-agent", "subscription")).toBe("Subscription");
	});
});

describe("the agent version", () => {
	const agent = agentProvider().officialAgent!;

	test("names the installed version", () => {
		expect(officialAgentVersionLine("antigravity", { ...agent, installedVersion: "1.5.12" })).toBe("agy 1.5.12");
	});

	test("says what the first use installs", () => {
		expect(officialAgentVersionLine("antigravity", agent)).toBe("Installs agy 1.5.12 on first use");
	});
});

describe("the subscription warning", () => {
	test("shows while the subscription is in use, offered or not", () => {
		const provider = agentProvider({ configured: true, authType: "oauth" });
		expect(officialAgentWarning(provider, true)).toBe(WARNING);
		expect(officialAgentWarning(provider, false)).toBe(WARNING);
	});

	test("shows beside the subscription sign-in before anyone signs in", () => {
		expect(officialAgentWarning(agentProvider(), true)).toBe(WARNING);
		expect(officialAgentWarning(agentProvider(), false)).toBeUndefined();
	});

	test("keeps the risk next to the subscription sign-in while an API key is in use", () => {
		const keyed = agentProvider({ configured: true, authType: "api_key" });
		// The subscription sign-in is still a choice on the panel, so the risk stays next to it.
		expect(officialAgentWarning(keyed, true)).toBe(WARNING);
		expect(officialAgentWarning(keyed, false)).toBeUndefined();
	});

	test("never shows for a provider that is not an official agent", () => {
		const plain: ProviderInfo = { id: "anthropic", name: "Anthropic", configured: true, authType: "oauth", oauth: { name: "Claude", loginLabel: "Sign in", isSubscription: true } };
		expect(officialAgentWarning(plain, true)).toBeUndefined();
	});
});

describe("provider names", () => {
	test("an official agent's name does not say it twice next to the Official agent label", () => {
		expect(providerDisplayName("Google Antigravity (official agent)")).toBe("Google Antigravity");
		expect(providerDisplayName("Anthropic")).toBe("Anthropic");
		expect(providerDisplayName("(official agent)")).toBe("(official agent)");
		expect(providerName([agentProvider({ name: "Google Antigravity (official agent)" })], "antigravity")).toBe("Google Antigravity");
	});
});
