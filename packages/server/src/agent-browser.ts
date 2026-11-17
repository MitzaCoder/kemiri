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

export function findBrowserExecutable(setting = serverSettings.KEMIRI_BROWSER_EXECUTABLE, path = childEnvironment().PATH ?? ""): string | null {
	if (setting?.trim()) return Bun.which(setting.trim(), { PATH: path });
	for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome",
		...(process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"] : [])]) {
		const found = Bun.which(name, { PATH: path });
		if (found) return found;
	}
	return null;
}

let managedCommand: string | null = null;
/** Availability has one off → on transition, never a per-turn install/probe. */
export function offerManagedAgentBrowser(command: string): void { managedCommand ??= command; }
const explicitCommand = createAgentBrowserCommandLookup(() => {
	const override = serverSettings.KEMIRI_AGENT_BROWSER_COMMAND?.trim();
	return override && findBrowserExecutable() ? Bun.which(override, { PATH: childEnvironment().PATH ?? "" }) : null;
});
export const agentBrowserCommand = (): string | null => managedCommand ?? explicitCommand();
