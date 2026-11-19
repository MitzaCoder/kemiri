/**
 * Official agents: providers whose own program does the work (Antigravity today), so they run as workers and never as
 * Kemiri's coordinator. Pure helpers for what the catalog says about them: which models a coordinator picker may
 * offer, which login is in use, and the version and warning lines Accounts shows. Testable without a component.
 */
import type { ModelInfo, ProviderInfo } from '@kemiri/protocol';

/** The short hint beside an official agent's name or model. */
export const OFFICIAL_AGENT_LABEL = 'Official agent';

/**
 * A provider's name without the "(official agent)" the backend appends to an official agent's name: the app shows that
 * as its own "Official agent" label, so the name would say it twice.
 */
export function providerDisplayName(name: string): string {
	return name.replace(/\s*\(official agent\)\s*$/i, '').trim() || name;
}

export type OfficialAgentInfo = NonNullable<ProviderInfo['officialAgent']>;

/** A model only a worker may run: Kemiri's own loop (coordinator, background job, audit, memory) refuses it. */
export function isWorkerOnly(model: Pick<ModelInfo, 'workerOnly'>): boolean {
	return model.workerOnly === true;
}

/** The models a non-worker picker may offer: everything except worker-only models. */
export function withoutWorkerOnly<Model extends Pick<ModelInfo, 'workerOnly'>>(models: readonly Model[]): Model[] {
	return models.filter((model) => !isWorkerOnly(model));
}

/** Whether a model's provider is an official agent, by what the backend lists for it. */
export function isOfficialAgentModel(model: ModelInfo, providers: readonly ProviderInfo[]): boolean {
	return isWorkerOnly(model) || providers.some((provider) => provider.id === model.provider && provider.officialAgent !== undefined);
}

/** The program and login names a user knows an official agent by; a provider not listed here falls back to its ID. */
const AGENT_NAMES: Readonly<Record<string, { program: string; subscription: string; apiKey: string }>> = {
	antigravity: { program: 'agy', subscription: 'Google subscription', apiKey: 'Gemini API key' }
};

export type OfficialAgentLogin = 'subscription' | 'api_key' | 'environment' | 'none';

/** Which login the agent runs on now. The backend reports `authType` only when a credential resolves. */
export function officialAgentLogin(provider: Pick<ProviderInfo, 'configured' | 'authType'>): OfficialAgentLogin {
	if (!provider.configured) return 'none';
	if (provider.authType === 'oauth') return 'subscription';
	if (provider.authType === 'api_key') return 'api_key';
	return 'environment';
}

export function officialAgentLoginLabel(providerId: string, login: OfficialAgentLogin): string {
	const names = AGENT_NAMES[providerId];
	switch (login) {
		case 'subscription':
			return names?.subscription ?? 'Subscription';
		case 'api_key':
			return names?.apiKey ?? 'API key';
		case 'environment':
			return 'From the backend environment';
		case 'none':
			return 'Not signed in';
	}
}

/** "agy 1.5.12" once installed, otherwise what the first run installs. */
export function officialAgentVersionLine(providerId: string, agent: OfficialAgentInfo): string {
	const program = AGENT_NAMES[providerId]?.program ?? providerId;
	return agent.installedVersion === null
		? `Installs ${program} ${agent.pinnedVersion} on first use`
		: `${program} ${agent.installedVersion}`;
}

/**
 * The ban-risk warning, or undefined when it does not apply. It shows while the subscription is in use, and whenever
 * the subscription sign-in is on offer without a subscription login: next to the choice, before signing in.
 */
export function officialAgentWarning(
	provider: Pick<ProviderInfo, 'configured' | 'authType' | 'officialAgent' | 'oauth'>,
	signInOffered: boolean
): string | undefined {
	const agent = provider.officialAgent;
	if (agent === undefined || agent.subscriptionWarning.length === 0) return undefined;
	if (officialAgentLogin(provider) === 'subscription') return agent.subscriptionWarning;
	return signInOffered && provider.oauth?.isSubscription === true ? agent.subscriptionWarning : undefined;
}
