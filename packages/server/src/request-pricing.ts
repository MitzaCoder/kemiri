import type { Usage } from "@earendil-works/pi-ai";

type BillableTokens = Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite">;
/** Standard API rates, in USD per million tokens. */
export type TokenRates = BillableTokens;

export function tokenCatalogCost(rates: TokenRates, tokens: BillableTokens): Usage["cost"] {
	const input = tokens.input * rates.input / 1_000_000;
	const output = tokens.output * rates.output / 1_000_000;
	const cacheRead = tokens.cacheRead * rates.cacheRead / 1_000_000;
	const cacheWrite = tokens.cacheWrite * rates.cacheWrite / 1_000_000;
	return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite };
}
