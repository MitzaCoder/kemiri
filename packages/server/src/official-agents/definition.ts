import type { ProviderAuthInteraction } from "@earendil-works/pi-ai";
import type { TokenRates } from "../request-pricing.ts";

export const OFFICIAL_AGENT_API = "official-agent";

export type OfficialAgentModel = { id: string; name: string };
export type OfficialAgentLogin = { mode: "api-key"; key: string } | { mode: "subscription" };

export interface OfficialAgentDefinition {
	id: string;
	name: string;
	vendor: string;
	transport: "acp";
	pinnedVersion: string;
	subscriptionWarning: string;
	models: readonly OfficialAgentModel[];
	/** API-equivalent rates for confirmed single-model choices, independent of ACP display names. */
	modelRates?(modelId: string, at: number): TokenRates | undefined;
	/** Whether ACP outputTokens excludes separately reported thoughtTokens. */
	separateThoughtTokens?: boolean;
	apiKeyName: string;
	apiKeyMethod: string;
	subscriptionMethod: string;
	subscriptionName: string;
	loginSubscription(command: string, profile: string, scratch: string, interaction: ProviderAuthInteraction): Promise<void>;
	signInRequired: string;
	install(): Promise<string>;
	installedVersion(): Promise<string | null>;
	launchArgs(profile: string): readonly string[];
	prepareProfile(profile: string, login: OfficialAgentLogin): Promise<void>;
	environment(profile: string, login: OfficialAgentLogin): Record<string, string>;
}
