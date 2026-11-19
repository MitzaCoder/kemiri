import { join } from "node:path";
import { AntigravityInstaller } from "../antigravity-install.ts";
import { childEnvironment } from "../child-environment.ts";
import { writeJsonFile } from "../fs-json.ts";
import { serverSettings } from "../server-settings.ts";
import { loginAntigravity } from "./antigravity-login.ts";
import { officialAgentEnvironment } from "./auth.ts";
import type { OfficialAgentDefinition } from "./definition.ts";

export const ANTIGRAVITY_PROVIDER = "antigravity";

export function antigravityDefinition(dataDir: string, command = serverSettings.KEMIRI_ANTIGRAVITY_COMMAND?.trim()): OfficialAgentDefinition {
	const installer = new AntigravityInstaller({ dataDir });
	const executable = () => command ? Bun.which(command, { PATH: childEnvironment().PATH ?? "" }) : null;
	return {
		id: ANTIGRAVITY_PROVIDER,
		name: "Google Antigravity (official agent)",
		vendor: "Google",
		transport: "acp",
		pinnedVersion: installer.pin.version,
		subscriptionWarning: "Google does not support delegated work on consumer subscriptions and may suspend Antigravity or Gemini CLI access. A Gemini API key avoids that risk.",
		models: [
			{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
			{ id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
			{ id: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
			{ id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
			{ id: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
			{ id: "gemini-4-carbon-high", name: "Gemini 4 Carbon (High)" },
			{ id: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
			{ id: "gemini-pro-orchestrator-argon", name: "Orchestrator (Argon)" },
			{ id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (Thinking)" },
			{ id: "claude-opus-5-5-high", name: "Claude Opus 5.5 (Thinking)" },
			{ id: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
			{ id: "gemini-3.6-flash-high", name: "Gemini 3.6 Flash (High)" },
			{ id: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
		],
		separateThoughtTokens: true,
		apiKeyName: "Gemini API key",
		apiKeyMethod: "gemini-api-key",
		subscriptionMethod: "oauth-personal",
		subscriptionName: "Google AI subscription",
		signInRequired: "Antigravity needs a login. Sign in again under Settings → Accounts and API keys, or set a Gemini API key.",
		loginSubscription(binary, profile, scratch, interaction) {
			return loginAntigravity(binary, [...this.launchArgs(profile), "--login"], scratch,
				{ ...officialAgentEnvironment(profile, scratch), ...this.environment(profile, { mode: "subscription" }) }, interaction);
		},
		async install() {
			if (!command) return installer.ensure();
			const binary = executable();
			if (!binary) throw new Error("KEMIRI_ANTIGRAVITY_COMMAND is not executable");
			return binary;
		},
		installedVersion() {
			if (!command) return installer.installedVersion();
			// Catalog reads must not launch an override (which may be an arbitrary admin-supplied program).
			return Promise.resolve(null);
		},
		launchArgs: profile => ["acp", "--gemini-dir", profile, "--app-data-dir", "antigravity-acp", "--sandbox"],
		async prepareProfile(profile, login) {
			await writeJsonFile(join(profile, "antigravity-acp", "settings.json"), {
				auth: { type: login.mode === "api-key" ? "gemini-api-key" : "oauth-personal" },
			});
		},
		environment(profile, login) {
			return {
				GEMINI_HOME: profile,
				AGY_ACP_FORCE_FILE_STORAGE: "1",
				AGY_CLI_DISABLE_AUTO_UPDATE: "1",
				...(login.mode === "api-key" ? { GEMINI_API_KEY: login.key } : {}),
			};
		},
	};
}
