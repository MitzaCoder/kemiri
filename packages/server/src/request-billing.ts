import type { CredentialStore, Models } from "@earendil-works/pi-ai";
import type { RequestBilling } from "./request-log-store.ts";
import { API_KEY_PLAN_PROVIDERS } from "./subscription-usage.ts";

/** Read metadata only. An ambient key can be in use without a stored credential. */
export async function requestBilling(credentials: CredentialStore, models: Models, provider: string): Promise<RequestBilling | null> {
	const stored = (await credentials.list()).find((credential) => credential.providerId === provider);
	const type = stored?.type ?? (await models.checkAuth(provider))?.type;
	if (type === "oauth") return "subscription";
	if (type === "api_key") return API_KEY_PLAN_PROVIDERS.has(provider) ? "plan_key" : "api_key";
	return null;
}

/** The catalog represents undetermined prices with all zero rates. An empty response can still be priced. */
export function hasCatalogPrice(model: ReturnType<Models["getModel"]>): boolean {
	const cost = model?.cost;
	return cost !== undefined && [cost, ...(cost.tiers ?? [])].some(
		({ input, output, cacheRead, cacheWrite }) => input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0,
	);
}
