import { join } from "node:path";
import type { AppAddresses } from "@kemiri/protocol";
import { validateAppSettings } from "./app-addresses.ts";
import type { AppRecord } from "./app-registry-document.ts";
import { errorMessage } from "./errors.ts";
import { readJsonFile, writeJsonFile } from "./fs-json.ts";
import { loopbackTarget, serveUnavailable, validServePort, validTailnetHostname, type ServeMapping, type TailscaleServe } from "./tailscale.ts";

type ServeAddresses = Extract<AppAddresses, { mode: "tailscale-serve" }>;
type ServeOwnership = ServeMapping & { projectId: string; appId: string };

export function isAppServeMapping(mapping: unknown, appPort?: number): mapping is ServeMapping {
	if (!mapping || typeof mapping !== "object") return false;
	const { hostname, httpsPort, target } = mapping as ServeMapping;
	if (!validServePort(httpsPort) || !validTailnetHostname(hostname) || typeof target !== "string") return false;
	const targetPort = Number(target.match(/^http:\/\/127\.0\.0\.1:(\d+)$/)?.[1]);
	return Number.isInteger(targetPort) && targetPort >= 1024 && targetPort <= 65535 && target === loopbackTarget(targetPort) &&
		(appPort === undefined || targetPort === appPort);
}

const ownershipFile = (dataDir: string) => join(dataDir, "app-serve-ownership.json");

export async function readAppServeOwnership(dataDir: string): Promise<ServeOwnership[]> {
	const saved = await readJsonFile(ownershipFile(dataDir));
	if (saved === undefined) return [];
	if (!Array.isArray(saved) || !saved.every(owner => isAppServeMapping(owner) &&
		typeof (owner as ServeOwnership).projectId === "string" && typeof (owner as ServeOwnership).appId === "string") ||
		new Set(saved.map(owner => owner.httpsPort)).size !== saved.length) throw new Error("Cannot read Kemiri’s Serve ownership list.");
	return saved;
}

function owns(owner: ServeOwnership, app: AppRecord): boolean {
	return owner.projectId === app.projectId && owner.appId === app.appId && owner.target === loopbackTarget(app.port);
}

function keptBy(owner: ServeOwnership, app: AppRecord): boolean {
	return owns(owner, app) && app.state === "live" && app.mode === "tailscale-serve" &&
		app.serveMapping?.httpsPort === owner.httpsPort && app.serveMapping.hostname === owner.hostname;
}

/** The journal is written before Serve. A CLI success followed by a crash must not leave an untracked mapping. */
export class AppServeMappings {
	readonly file: string;
	constructor(readonly dataDir: string, readonly tailscale: TailscaleServe, readonly backendPort: () => number,
		readonly backendOrigins: () => readonly string[], readonly log: (message: string) => void) {
		this.file = ownershipFile(dataDir);
	}

	/** The caller serializes operations across projects from journal read through app record commit. */
	async resolve(app: AppRecord, addresses: ServeAddresses, listeningPorts: () => Promise<ReadonlySet<number> | undefined>): Promise<void> {
		app.mode = "tailscale-serve";
		app.url = null;
		try {
			const readiness = await this.tailscale.status();
			const unavailable = serveUnavailable(readiness);
			if (unavailable || !readiness.hostname) throw new Error(unavailable ?? "Enable MagicDNS in the Tailscale admin console under DNS.");
			const hostname = readiness.hostname;
			const ownership = await readAppServeOwnership(this.dataDir);
			const serveStatus = await this.tailscale.serveStatus();
			const recorded = app.serveMapping && ownership.find(owner => keptBy(owner, app));
			if (!recorded) delete app.serveMapping;
			if (app.port === this.backendPort()) throw new Error("Cannot serve Kemiri’s own port.");
			const address = (port: number) => {
				const url = new URL(`https://${hostname}:${port}/`);
				url.pathname = app.path;
				return url;
			};
			const usable = (port: number) => validServePort(port, this.backendPort()) && !this.backendOrigins().includes(address(port).origin);
			if (recorded && (recorded.hostname !== hostname || !usable(recorded.httpsPort))) {
				// Let the orphan pass clean up the previous hostname before allocating again.
				delete app.serveMapping;
				throw new Error("The previous HTTPS address changed. Refresh Running apps to assign a new address.");
			}
			if (recorded && serveStatus.matches(recorded)) {
				app.url = address(recorded.httpsPort).href;
				delete app.addressMessage;
				return;
			}
			if (recorded && serveStatus.occupied.has(recorded.httpsPort)) {
				throw new Error("The recorded HTTPS port is now used by another Tailscale mapping. Free that port or unpublish the app and publish it again.");
			}
			if (app.stoppedAt) return;
			const listening = await listeningPorts();
			if (!listening) throw new Error("Install iproute2 and make its ss command available to the backend to check for port conflicts.");
			if (!recorded) validateAppSettings({ addresses, policy: "on" }, this.backendPort());
			const httpsPort = recorded?.httpsPort ?? Array.from({ length: addresses.endPort - addresses.startPort + 1 }, (_, offset) => addresses.startPort + offset)
				.find(port => usable(port) && port !== app.port && !listening.has(port) && !serveStatus.occupied.has(port) && !ownership.some(owner => owner.httpsPort === port));
			if (httpsPort === undefined) throw new Error("No HTTPS port is free. Free a port or change the range in App addresses.");
			if (listening.has(httpsPort)) throw new Error("The recorded HTTPS port is now in use. Free that port or unpublish the app and publish it again.");
			const mapping = { hostname, httpsPort, target: loopbackTarget(app.port) };
			// Re-read immediately before the write; another tool may have changed Serve during the listener scan.
			if ((await this.tailscale.serveStatus()).occupied.has(httpsPort)) throw new Error("The HTTPS port became busy. Refresh Running apps to retry.");
			if (!recorded) await writeJsonFile(this.file, [...ownership, { ...mapping, projectId: app.projectId, appId: app.appId }]);
			await this.tailscale.add(mapping);
			app.serveMapping = mapping;
			app.url = address(httpsPort).href;
			delete app.addressMessage;
		} catch (error) {
			app.addressMessage = errorMessage(error);
		}
	}

	async removeOrphans(apps: readonly AppRecord[], enabled: boolean): Promise<void> {
		const ownership = await readAppServeOwnership(this.dataDir);
		let remaining = ownership;
		for (const owner of ownership) {
			if (enabled && apps.some(app => keptBy(owner, app))) continue;
			try {
				const status = await this.tailscale.serveStatus();
				if (status.occupied.has(owner.httpsPort)) {
					if (owner.httpsPort !== this.backendPort() && status.matches(owner)) await this.tailscale.remove(owner.httpsPort);
					else this.log(`Leaving changed or reserved Tailscale Serve mapping on port ${owner.httpsPort} untouched.`);
				}
				remaining = remaining.filter(entry => entry !== owner);
				await writeJsonFile(this.file, remaining);
			} catch (error) { this.log(`Could not release Tailscale Serve port ${owner.httpsPort}: ${errorMessage(error)}`); }
		}
	}
}
