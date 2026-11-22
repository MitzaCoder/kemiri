import { APP_PORT_SETUP_COMMAND, DEFAULT_APP_SETTINGS, type AppAddresses, type AppSettings } from "@kemiri/protocol";
import { ServerError } from "./errors.ts";
import { validServePort } from "./tailscale.ts";

function templateUrl(template: string, port: number, path: string): URL {
	const address = template.replaceAll("{port}", String(port));
	if (address.includes("{path}")) return new URL(address.replaceAll("{path}", () => path));
	const url = new URL(address);
	url.pathname = url.pathname.replace(/\/$/, "") + path;
	return url;
}

/** Address modes own URL resolution and bind instructions, not policy or registry state. */
const addressModes = {
	"tailscale-serve": {
		address: () => null, // The registry allocates the HTTPS port before resolving an address.
		instructions: (hostname: string) => `Serve on 127.0.0.1, and use app_start with the command and port. Devices reach it at https://${hostname}:PORT-ASSIGNED/; the app must accept the Host name ${hostname} (with the port) and is served over HTTPS.`,
	},
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
			return `Serve on 0.0.0.0, and use app_start with the command and port. Devices reach it at ${url}; the app must accept the Host name ${host}.`;
		},
	},
};

export function appAddress(addresses: AppAddresses, port: number, path: string): URL | null {
	switch (addresses.mode) {
		case "off": return addressModes.off.address();
		case "tailscale-reserved":
		case "tailscale-serve": return addressModes["tailscale-serve"].address();
		case "template": return addressModes.template.address(addresses.template, port, path);
	}
}

export function appInstructions(settings: AppSettings, hostname = "HOST", reserved = false): string {
	const { addresses } = settings;
	const localhost = "A localhost link only works on the server itself; never give one to the owner.";
	if (addresses.mode === "off") return `Apps: ${addressModes.off.instructions()} ${localhost}`;
	if (settings.policy === "off") return `Apps: agents may not publish apps on this backend. Attach screenshots or an HTML artifact instead. ${localhost}`;
	if (addresses.mode === "tailscale-reserved" && !reserved) return `Apps: reserved HTTPS ports are not ready. Ask the owner to run ${APP_PORT_SETUP_COMMAND} on the backend, or attach screenshots or an HTML artifact. ${localhost}`;
	return `Apps: this backend can publish an app you serve to the owner's devices. ${addresses.mode !== "template" ? addressModes["tailscale-serve"].instructions(hostname) : addressModes.template.instructions(addresses.template)}${addresses.mode === "tailscale-reserved" ? " Kemiri uses ports already reserved by the owner and does not change Tailscale." : ""} Managed apps survive backend service restarts when a user scope is available. ${localhost}`;
}

export function validateAppSettings(settings: AppSettings, backendPort?: number): AppSettings {
	if (settings.addresses.mode === "off" || settings.addresses.mode === "tailscale-reserved") return { addresses: { mode: settings.addresses.mode }, policy: settings.policy };
	if (settings.addresses.mode === "tailscale-serve") {
		const { startPort, endPort } = settings.addresses;
		if (!validServePort(startPort, backendPort) || !validServePort(endPort, backendPort) || endPort < startPort || endPort - startPort >= 100 ||
			(startPort <= 8443 && 8443 <= endPort) || (backendPort !== undefined && startPort <= backendPort && backendPort <= endPort)) {
			throw new ServerError("bad_request", "Use an HTTPS port range of 1–100 ports from 1024 to 65535, excluding 8443 and Kemiri’s own port.");
		}
		return { addresses: { mode: "tailscale-serve", startPort, endPort }, policy: settings.policy };
	}
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

export function readAppSettings(value: unknown, operatorOptIn = false): AppSettings {
	if (typeof value !== "object" || value === null) return DEFAULT_APP_SETTINGS;
	const settings = value as Partial<AppSettings>;
	const policy = settings.policy === "off" || settings.policy === "on" ? settings.policy : "ask";
	if (settings.addresses?.mode === "tailscale-serve" && !operatorOptIn) return { addresses: { mode: "tailscale-reserved" }, policy };
	if (settings.addresses?.mode === "tailscale-reserved" || settings.addresses?.mode === "tailscale-serve" || (settings.addresses?.mode === "template" && typeof settings.addresses.template === "string")) {
		try { return validateAppSettings({ addresses: settings.addresses, policy }); } catch { /* Invalid stored address is off. */ }
	}
	return { addresses: { mode: "off" }, policy };
}
