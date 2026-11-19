import type { Database } from "bun:sqlite";
import type { SubscriptionPrice } from "@kemiri/protocol";
import { DEFAULT_SUBSCRIPTION_PRICES } from "./default-subscription-prices.ts";
import type { LimitLedger } from "./limit-ledger.ts";
import type { RequestBilling } from "./request-log-store.ts";

export type PlanBilling = Exclude<RequestBilling, "api_key">;
export function subscriptionBilling(billing: RequestBilling | null): billing is PlanBilling {
	return billing !== null && billing !== "api_key";
}

type SubscriptionTerm = {
	since: number;
	plan: string | null;
	credential_type: PlanBilling | "api_key" | null;
	monthly_price: number | null;
	login_since: number | null;
};

export class SubscriptionTerms {
	constructor(private readonly db: Database, private readonly ledger: LimitLedger) {}

	at(providerId: string, at: number): SubscriptionTerm | null {
		return this.db.query<SubscriptionTerm, [string, number]>(`
			SELECT since, plan, credential_type, monthly_price, login_since FROM subscription_terms
			WHERE provider = ? AND since <= ? ORDER BY since DESC LIMIT 1
		`).get(providerId, at);
	}

	subscriptionsAt(at: number): { provider: string; credential_type: PlanBilling }[] {
		return this.db.query<{ provider: string; credential_type: PlanBilling }, [number]>(`
			SELECT provider, credential_type FROM subscription_terms AS term
			WHERE since = (SELECT max(since) FROM subscription_terms WHERE provider = term.provider AND since <= ?)
			AND credential_type IN ('subscription', 'plan_key', 'agent')
		`).all(at);
	}

	observe(providerId: string, plan: string | null, billing: SubscriptionTerm["credential_type"], at: number, loginChanged = false): void {
		this.db.transaction(() => {
			const last = this.at(providerId, at);
			if (!loginChanged && last?.plan === plan && last.credential_type === billing) return;
			if (loginChanged || last !== null || plan !== null) this.ledger.closeProvider(providerId, at);
			const loginSince = loginChanged || (last && last.credential_type !== billing) ? at : last?.login_since ?? null;
			this.#write(providerId, { since: at, plan, credential_type: billing, monthly_price: last?.monthly_price ?? null, login_since: loginSince });
		})();
	}

	setPrice(providerId: string, monthlyPrice: number | null, at: number): SubscriptionPrice {
		return this.db.transaction(() => {
			const last = this.at(providerId, at);
			const term = { since: at, plan: last?.plan ?? null, credential_type: last?.credential_type ?? null,
				login_since: last?.login_since ?? null, monthly_price: monthlyPrice };
			if ((last?.monthly_price ?? null) !== monthlyPrice) this.#write(providerId, term);
			return this.price(providerId, term);
		})();
	}

	#write(providerId: string, term: SubscriptionTerm): void {
		// If two changes have the same clock tick, the final state is the one effective at that instant.
		this.db.query("INSERT OR REPLACE INTO subscription_terms VALUES (?, ?, ?, ?, ?, ?)")
			.run(providerId, term.since, term.plan, term.credential_type, term.monthly_price, term.login_since);
	}

	price(providerId: string, term: SubscriptionTerm | null): SubscriptionPrice {
		if (term?.monthly_price != null) return { kind: "owner", monthlyPrice: term.monthly_price, checkedOn: null, source: null };
		const listPrice = term?.plan == null ? undefined : DEFAULT_SUBSCRIPTION_PRICES.get(`${providerId}/${term.plan.toLowerCase()}`);
		return listPrice ? { kind: "default", ...listPrice } : { kind: "none", monthlyPrice: null, checkedOn: null, source: null };
	}
}
