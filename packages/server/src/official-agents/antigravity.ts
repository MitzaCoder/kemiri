import { join } from "node:path";
import { AntigravityInstaller } from "../antigravity-install.ts";
import { childEnvironment } from "../child-environment.ts";
import { writeJsonFile } from "../fs-json.ts";
import { serverSettings } from "../server-settings.ts";
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
		subscriptionWarning: "Google does not support agent-to-agent delegation on consumer subscriptions and may suspend Antigravity or Gemini CLI access. Use an approved Gemini API key instead.",
		models: [{ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }],
		separateThoughtTokens: true,
		apiKeyName: "Gemini API key",
		apiKeyMethod: "gemini-api-key",
		subscriptionMethod: "oauth-personal",
		signInRequired: "Sign Google's Antigravity agent in under Settings → Accounts and API keys, or set a Gemini API key there.",
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
