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
	/** Whether ACP outputTokens excludes separately reported thoughtTokens. */
	separateThoughtTokens?: boolean;
	apiKeyName: string;
	apiKeyMethod: string;
	subscriptionMethod: string;
	signInRequired: string;
	install(): Promise<string>;
	installedVersion(): Promise<string | null>;
	launchArgs(profile: string): readonly string[];
	prepareProfile(profile: string, login: OfficialAgentLogin): Promise<void>;
	environment(profile: string, login: OfficialAgentLogin): Record<string, string>;
}
