import { childEnvironment } from "./child-environment.ts";
import { serverSettings } from "./server-settings.ts";

export function findBrowserExecutable(setting = serverSettings.KEMIRI_BROWSER_EXECUTABLE, path = childEnvironment().PATH ?? ""): string | null {
	if (setting?.trim()) return Bun.which(setting.trim(), { PATH: path });
	for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome",
		...(process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"] : [])]) {
		const found = Bun.which(name, { PATH: path });
		if (found) return found;
	}
	return null;
}

