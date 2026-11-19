/** US monthly list prices, not introductory rates, taxes, or regional prices. Keys are provider/plan IDs. */
export const DEFAULT_SUBSCRIPTION_PRICES: ReadonlyMap<string, { monthlyPrice: number; checkedOn: string; source: string }> = new Map([
	["anthropic/pro", { monthlyPrice: 20, checkedOn: "2026-11-19", source: "https://claude.com/pricing" }],
	["anthropic/max 5x", { monthlyPrice: 100, checkedOn: "2026-11-19", source: "https://claude.com/pricing" }],
	["anthropic/max 20x", { monthlyPrice: 200, checkedOn: "2026-11-19", source: "https://support.claude.com/en/articles/17728952-what-is-the-ultra-plan" }],
	["anthropic/ultra", { monthlyPrice: 200, checkedOn: "2026-11-19", source: "https://claude.com/pricing" }],
	["openai-codex/plus", { monthlyPrice: 20, checkedOn: "2026-11-19", source: "https://help.openai.com/en/articles/6950777" }],
	["openai-codex/pro", { monthlyPrice: 200, checkedOn: "2026-11-19", source: "https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers" }],
	["openai-codex/pro lite", { monthlyPrice: 100, checkedOn: "2026-11-19", source: "https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers" }],
	["openai-codex/pro max", { monthlyPrice: 500, checkedOn: "2026-11-19", source: "https://help.openai.com/en/articles/9793128-about-chatgpt-pro-tiers" }],
	["opencode-go/go", { monthlyPrice: 10, checkedOn: "2026-11-19", source: "https://opencode.ai/go" }],
]);
