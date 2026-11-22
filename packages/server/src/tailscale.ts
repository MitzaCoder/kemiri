import { execFile } from "node:child_process";
import { userInfo } from "node:os";
import type { TailscaleAppStatus } from "@kemiri/protocol";
import { childEnvironment } from "./child-environment.ts";

type CommandResult = { stdout: string; stderr: string; error?: string };
export type TailscaleCommand = (file: string, args: string[]) => Promise<CommandResult>;
const runCommand: TailscaleCommand = (file, args) => new Promise(resolve => {
	execFile(file, args, { env: childEnvironment(), timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) =>
		resolve({ stdout, stderr, ...(error ? { error: String(error.code ?? error.signal ?? "failed") } : {}) }));
});

export type ServeMapping = { hostname: string; httpsPort: number; target: string };
export type ServeStatus = { occupied: ReadonlySet<number>; matches(mapping: ServeMapping): boolean };
export function validServePort(port: number, backendPort?: number): boolean {
	return Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 8443 && port !== backendPort;
}

export const loopbackTarget = (port: number) => `http://127.0.0.1:${port}`;
export const validTailnetHostname = (hostname: unknown): hostname is string => typeof hostname === "string" &&
	hostname.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){2,}ts\.net$/i.test(hostname);

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function jsonObject(stdout: string): Record<string, unknown> {
	const parsed: unknown = JSON.parse(stdout);
	if (parsed === null) return {};
	const fields = object(parsed);
	if (!fields) throw new Error("Expected a Tailscale JSON object.");
	return fields;
}

/** A matching root proxy alone is insufficient: `off` clears the whole HTTPS port. */
export function parseServeStatus(stdout: string): ServeStatus {
	const config = stdout.trim() === "No serve config" ? {} : jsonObject(stdout);
	const occupied = new Set<number>();
	const conflicting = new Set<number>();
	const tcp = object(config.TCP) ?? {};
	const web = object(config.Web) ?? {};
	const authorityPort = (authority: string) => Number(authority.match(/:(\d+)$/)?.[1]);
	// Include foreground sessions and Funnel in collision checks, but never claim them.
	function collect(config: Record<string, unknown>, foreign: boolean) {
		for (const [key, fields] of Object.entries(config)) {
			if (fields === null) continue;
			const entries = object(fields);
			if (key === "Foreground" || key === "Services") {
				if (!entries) throw new Error("Unexpected Tailscale Serve status.");
				for (const session of Object.values(entries)) collect(object(session) ?? {}, true);
			} else if (key === "TCP" || key === "Web" || key === "AllowFunnel") {
				if (!entries) throw new Error("Unexpected Tailscale Serve status.");
				for (const name of Object.keys(entries)) {
					const port = key === "TCP" ? Number(name) : authorityPort(name);
					if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Unexpected port in Tailscale Serve status.");
					occupied.add(port);
					if (foreign || key === "AllowFunnel") conflicting.add(port);
				}
			}
		}
	}
	collect(config, false);
	return { occupied, matches({ hostname, httpsPort, target }) {
		const authority = `${hostname}:${httpsPort}`;
		const transport = object(tcp[String(httpsPort)]);
		const site = object(web[authority]);
		const handlers = object(site?.Handlers);
		const root = object(handlers?.["/"]);
		return !conflicting.has(httpsPort) && transport?.HTTPS === true && Object.keys(transport).length === 1 &&
			Object.keys(web).filter(name => authorityPort(name) === httpsPort).length === 1 &&
			!!site && Object.keys(site).length === 1 && !!handlers && Object.keys(handlers).length === 1 &&
			root?.Proxy === target && Object.keys(root).length === 1;
	} };
}

export class TailscaleServe {
	constructor(readonly run: TailscaleCommand = runCommand, readonly account = () => userInfo()) {}

	operatorFix(): string {
		const flag = `--operator=${this.account().username}`;
		return `Grant the backend account Serve permission: sudo tailscale set ${flag} (or add "${flag}" to services.tailscale.extraSetFlags on NixOS).`;
	}

	async status(): Promise<TailscaleAppStatus> {
		const result = await this.run("tailscale", ["status", "--json"]);
		const installed = result.error !== "ENOENT";
		let status: Record<string, unknown> = {};
		if (installed) {
			try { status = jsonObject(result.stdout); } catch { /* Not connected to a running daemon. */ }
		}
		const running = !result.error && status.BackendState === "Running";
		const dnsName = object(status.Self)?.DNSName;
		const hostname = typeof dnsName === "string" ? dnsName.replace(/\.$/, "").toLowerCase() : null;
		const magicDns = validTailnetHostname(hostname) && object(status.CurrentTailnet)?.MagicDNSEnabled !== false;
		const https = magicDns && Array.isArray(status.CertDomains) && status.CertDomains.some(domain =>
			typeof domain === "string" && domain.replace(/\.$/, "").toLowerCase() === hostname);
		const account = this.account();
		let operator = running && account.uid === 0;
		if (running && !operator) {
			const prefs = await this.run("tailscale", ["debug", "prefs"]);
			try { operator = !prefs.error && jsonObject(prefs.stdout).OperatorUser === account.username; } catch { /* Cannot confirm permission. */ }
		}
		const statusLine = (ok: boolean, message: string) => ({ ok, message });
		return { hostname: magicDns ? hostname : null,
			installed: statusLine(installed, installed ? "Tailscale is installed." : "Install Tailscale: https://tailscale.com/download."),
			running: statusLine(running, running ? "Tailscale is running." : "Start tailscaled, then run tailscale up and sign in to the tailnet."),
			magicDns: statusLine(magicDns, magicDns ? `MagicDNS: ${hostname}` : "Enable MagicDNS in the Tailscale admin console under DNS."),
			https: statusLine(https, https ? "HTTPS certificates are enabled." : "Enable HTTPS Certificates in the Tailscale admin console under DNS."),
			operator: statusLine(operator, operator ? "The backend account has Serve permission." : this.operatorFix()),
		};
	}

	async serveStatus(): Promise<ServeStatus> {
		const stdout = await this.#command(["serve", "status", "--json"]);
		try { return parseServeStatus(stdout); }
		catch { throw new Error("Could not read Tailscale Serve configuration. Check `tailscale serve status --json` on the backend."); }
	}

	async add({ httpsPort, target }: ServeMapping): Promise<void> {
		const targetPort = Number(target.match(/^http:\/\/127\.0\.0\.1:(\d+)$/)?.[1]);
		if (!validServePort(httpsPort) || !Number.isInteger(targetPort) || targetPort < 1024 || targetPort > 65535 || target !== loopbackTarget(targetPort)) {
			throw new Error("Tailscale Serve needs an allowed HTTPS port and an IPv4 loopback HTTP target.");
		}
		await this.#command(["serve", "--bg", "--yes", `--https=${httpsPort}`, target]);
	}

	async remove(httpsPort: number): Promise<void> {
		if (!validServePort(httpsPort)) throw new Error("Cannot remove a reserved Tailscale Serve port.");
		await this.#command(["serve", `--https=${httpsPort}`, "off"]);
	}

	async #command(args: string[]): Promise<string> {
		const { stdout, stderr, error } = await this.run("tailscale", args);
		if (!error) return stdout;
		const output = `${stdout}\n${stderr}`;
		if (/access denied|permission denied|operator|not authorized/i.test(output)) throw new Error(this.operatorFix());
		if (/https.+(?:not enabled|disabled)|certificates.+(?:not enabled|disabled)/i.test(output)) {
			throw new Error("Enable HTTPS Certificates in the Tailscale admin console under DNS.");
		}
		throw new Error("Make sure tailscaled is running and connected, then check `tailscale serve status` on the backend.");
	}
}

export function serveUnavailable(status: TailscaleAppStatus): string | undefined {
	return [status.installed, status.running, status.magicDns, status.https, status.operator].find(line => !line.ok)?.message;
}
