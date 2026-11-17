import { childEnvironment } from "./child-environment.ts";
import { serverSettings } from "./server-settings.ts";

/** Cache successes and misses for the process lifetime: prompt catalogues must not flap between turns. */
export function createAgentBrowserCommandLookup(lookup: () => string | null): () => string | null {
	let command: string | null | undefined;
	return () => {
		if (command === undefined) command = lookup();
		return command;
	};
}

/** One discovery point for both catalogues; a later managed install can extend this lookup. */
export const agentBrowserCommand = createAgentBrowserCommandLookup(() =>
	Bun.which(serverSettings.KEMIRI_AGENT_BROWSER_COMMAND?.trim() || "agent-browser", {
		PATH: childEnvironment().PATH ?? "",
	}),
);
