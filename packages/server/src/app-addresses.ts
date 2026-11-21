import { DEFAULT_APP_SETTINGS, type AppAddresses, type AppSettings } from "@kemiri/protocol";
import { ServerError } from "./errors.ts";

function templateUrl(template: string, port: number, path: string): URL {
	const address = template.replaceAll("{port}", String(port));
	if (address.includes("{path}")) return new URL(address.replaceAll("{path}", () => path));
	const url = new URL(address);
	url.pathname = url.pathname.replace(/\/$/, "") + path;
	return url;
}

/** Address modes own URL resolution and bind instructions, not policy or registry state. */
const addressModes = {
	off: {
		address: () => null,
		instructions: () => "No app address is configured on this backend. Attach screenshots or an HTML artifact instead.",
	},
	template: {
		address: templateUrl,
		instructions(template: string) {
			const samplePort = 54321;
			const example = templateUrl(template, samplePort, "/");
			const host = example.hostname.replaceAll(String(samplePort), "PORT");
			const url = example.href.replaceAll(String(samplePort), "PORT");
			return `Serve on 0.0.0.0, then call app_publish with the port. Devices reach it at ${url}; the app must accept the Host name ${host}.`;
		},
	},
};

export function appAddress(addresses: AppAddresses, port: number, path: string): URL | null {
	switch (addresses.mode) {
		case "off": return addressModes.off.address();
		case "template": return addressModes.template.address(addresses.template, port, path);
	}
}

export function appInstructions(settings: AppSettings): string {
	const { addresses } = settings;
	const localhost = "A localhost link only works on the server itself; never give one to the owner.";
	if (addresses.mode === "off") return `Apps: ${addressModes.off.instructions()} ${localhost}`;
	if (settings.policy === "off") return `Apps: agents may not publish apps on this backend. Attach screenshots or an HTML artifact instead. ${localhost}`;
	return `Apps: this backend can publish an app you serve to the owner's devices. ${addressModes.template.instructions(addresses.template)} ${localhost}`;
}

export function validateAppSettings(settings: AppSettings): AppSettings {
	if (settings.addresses.mode === "off") return { addresses: { mode: "off" }, policy: settings.policy };
	const template = settings.addresses.template.trim();
	const invalid = () => new ServerError("bad_request", "Use an HTTP or HTTPS address with {port} in its host or port, optional {path} in the URL path, and no credentials, query or fragment.");
	const [authority] = template.replace(/^https?:\/\//i, "").replaceAll("{path}", "/").split("/");
	if (!/^https?:\/\//i.test(template) || !authority?.includes("{port}") ||
		/[\s\\?#]/u.test(template) || /[{}]/.test(template.replaceAll("{port}", "").replaceAll("{path}", ""))) throw invalid();
	let example: URL;
	try { example = templateUrl(template, 54321, "/test"); } catch { throw invalid(); }
	if (example.username || example.password || authority?.includes("@") || !example.hostname) throw invalid();
	return { addresses: { mode: "template", template }, policy: settings.policy };
}

export function readAppSettings(value: unknown): AppSettings {
	if (typeof value !== "object" || value === null) return DEFAULT_APP_SETTINGS;
	const settings = value as Partial<AppSettings>;
	const policy = settings.policy === "off" || settings.policy === "on" ? settings.policy : "ask";
	if (settings.addresses?.mode === "template" && typeof settings.addresses.template === "string") {
		try { return validateAppSettings({ addresses: settings.addresses, policy }); } catch { /* Invalid stored address is off. */ }
	}
	return { addresses: { mode: "off" }, policy };
}
