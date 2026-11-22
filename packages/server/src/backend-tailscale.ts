import { isReservedAppPort, readAppPortReservation } from "./app-port-reservations.ts";
import { DEFAULT_TAILSCALE_SERVE_RANGE, type AppAddresses } from "@kemiri/protocol";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { readAppServeOwnership } from "./app-serve-mappings.ts";
import type { DeviceAuth } from "./device-auth.ts";
import { readJsonFile, writeJsonFile } from "./fs-json.ts";
import { loopbackTarget, serveUnavailable, tailnetOrigin, validBackendServePort, validTailnetHostname, type ServeMapping, type TailscaleServe } from "./tailscale.ts";

export const CERTIFICATE_TRANSPARENCY_NOTE = "Machine names appear in public certificate transparency logs once HTTPS certificates are issued.";

export type BackendServeRecord = ServeMapping & {
	version: 1;
	phase: "enabling" | "active" | "disabling";
	publicOrigin: string;
	addedHost: boolean;
	addedProxy: boolean;
};
const recordFile = (dataDir: string) => join(dataDir, "backend-serve.json");

export async function readBackendServeRecord(dataDir: string): Promise<BackendServeRecord | undefined> {
	const saved = await readJsonFile(recordFile(dataDir)) as Partial<BackendServeRecord> | null | undefined;
	if (saved === undefined) return undefined;
	const targetPort = typeof saved?.target === "string" ? Number(saved.target.match(/^http:\/\/127\.0\.0\.1:(\d+)$/)?.[1]) : NaN;
	if (saved?.version !== 1 || !validTailnetHostname(saved.hostname) || typeof saved.httpsPort !== "number" ||
		!validBackendServePort(saved.httpsPort) || !validBackendServePort(targetPort) || saved.httpsPort === targetPort || saved.target !== loopbackTarget(targetPort) ||
		saved.publicOrigin !== tailnetOrigin(saved.hostname, saved.httpsPort) || typeof saved.addedHost !== "boolean" ||
		typeof saved.addedProxy !== "boolean" || !["enabling", "active", "disabling"].includes(saved.phase ?? "")) {
		throw new Error("Invalid backend Serve ownership record");
	}
	return saved as BackendServeRecord;
}

export class TailscaleSetupError extends Error {}
const RECORD_FIX = "Could not read backend Serve ownership. Restore the backend’s backend-serve.json from a valid backup before changing Serve.";
const RETRY_FIX = "Run kemiri tailscale disable to clean up, then run kemiri tailscale enable again.";
const REQUIRED_FIX = "Serve needs required device sign-in. Run kemiri auth mode required after all devices are ready, then retry.";

type BackendTailscaleOptions = {
	auth: Pick<DeviceAuth, "dir" | "mode" | "hosts" | "hostChange">;
	tailscale: TailscaleServe;
	backendPort: () => number;
	appAddresses: () => AppAddresses;
	trustedProxies: readonly string[];
	listeningPorts: () => Promise<ReadonlySet<number> | null>;
	loopbackReady: () => Promise<boolean>;
};

export class BackendTailscale {
	#record: BackendServeRecord | undefined;
	#pending: Promise<unknown> = Promise.resolve();
	constructor(readonly options: BackendTailscaleOptions) {}

	async #readRecord(): Promise<BackendServeRecord | undefined> {
		try { return await readBackendServeRecord(this.options.auth.dir); }
		catch { throw new TailscaleSetupError(RECORD_FIX); }
	}

	async load(): Promise<void> {
		this.#record = await this.#readRecord();
		const origin = this.activeOrigin;
		// An explicit host allowlist in server.env is reapplied on startup. Keep our own additional entry.
		if (origin && this.#record?.addedHost && !this.options.auth.hosts.includes(origin)) this.options.auth.hostChange(origin, true);
	}

	#matchesPort(): boolean { return this.#record?.target === loopbackTarget(this.options.backendPort()); }
	get activeOrigin(): string | undefined {
		return this.#record?.phase === "active" && this.#matchesPort() ? this.#record.publicOrigin : undefined;
	}

	get addsLoopbackTrust(): boolean { return this.activeOrigin !== undefined && this.#record?.addedProxy === true; }

	/** Scoped proxy trust: never accept forwarded headers from the network or for another origin. */
	forwardedOrigin(peer: string, headers: Headers): string | undefined {
		if (peer !== "127.0.0.1" && peer !== "::ffff:127.0.0.1") return undefined;
		const record = this.#record;
		if (!record || headers.get("x-forwarded-proto") !== "https") return undefined;
		const host = new URL(record.publicOrigin).host;
		const forwardedHost = headers.get("x-forwarded-host");
		return forwardedHost === host || (record.httpsPort === 443 && forwardedHost === `${host}:443`) ? record.publicOrigin : undefined;
	}

	#serialize<T>(work: () => Promise<T>): Promise<T> {
		const operation = this.#pending.then(work);
		this.#pending = operation.catch(() => undefined);
		return operation;
	}

	async #write(record: BackendServeRecord): Promise<void> {
		await writeJsonFile(recordFile(this.options.auth.dir), record);
		this.#record = record;
	}

	async #clearRecord(): Promise<void> {
		await rm(recordFile(this.options.auth.dir), { force: true });
		this.#record = undefined;
	}

	async #readServe() {
		try { return await this.options.tailscale.serveStatus(); }
		catch (error) { throw new TailscaleSetupError((error as Error).message); }
	}

	enable(requestedPort?: number) {
		return this.#serialize(async () => {
			const { auth, tailscale } = this.options;
			const readiness = await tailscale.status();
			const unavailable = serveUnavailable(readiness);
			if (unavailable || !readiness.hostname) throw new TailscaleSetupError(unavailable ?? readiness.magicDns.message);
			if (auth.mode !== "required") throw new TailscaleSetupError(REQUIRED_FIX);
			const existing = this.#record = await this.#readRecord();
			const httpsPort = requestedPort ?? existing?.httpsPort ?? 443;
			if (!validBackendServePort(httpsPort)) throw new TailscaleSetupError("Choose an HTTPS port from 1 to 65535 with --port.");
			const target = loopbackTarget(this.options.backendPort());
			const publicOrigin = tailnetOrigin(readiness.hostname, httpsPort);
			if (existing) {
				if (existing.phase === "active" && existing.publicOrigin === publicOrigin && existing.target === target &&
					auth.hosts.includes(publicOrigin) && (await this.#readServe()).matches(existing)) return { publicOrigin, alreadyEnabled: true };
				throw new TailscaleSetupError(`The recorded backend Serve setup differs from the current request or mapping. ${RETRY_FIX}`);
			}
			if (httpsPort === this.options.backendPort()) throw new TailscaleSetupError("The HTTPS port cannot be Kemiri’s own local port. Choose another --port.");
			const addresses = this.options.appAddresses();
			const range = addresses.mode === "tailscale-serve" ? addresses : DEFAULT_TAILSCALE_SERVE_RANGE;
			if (httpsPort >= range.startPort && httpsPort <= range.endPort) {
				throw new TailscaleSetupError(`The HTTPS port is in the agent-app range ${range.startPort}–${range.endPort}. Choose another --port.`);
			}
			if (isReservedAppPort(await readAppPortReservation(auth.dir), httpsPort)) throw new TailscaleSetupError(`App Serve reserves port ${httpsPort}. Choose another --port.`);
			let appOwnership;
			try { appOwnership = await readAppServeOwnership(auth.dir); }
			catch { throw new TailscaleSetupError("Could not read app Serve ownership. Restore the backend’s app-serve-ownership.json from a valid backup."); }
			if (appOwnership.some(mapping => mapping.httpsPort === httpsPort)) throw new TailscaleSetupError(`App Serve already owns port ${httpsPort}. Choose another --port.`);
			const listeners = await this.options.listeningPorts();
			if (!listeners) throw new TailscaleSetupError("Could not check local TCP listeners. On Linux, install iproute2 and make ss available to the backend; on macOS, check /usr/sbin/netstat.");
			if (listeners.has(httpsPort)) throw new TailscaleSetupError(`A local TCP listener already uses port ${httpsPort}. Choose another --port.`);
			if (!await this.options.loopbackReady()) throw new TailscaleSetupError(`Kemiri does not answer on ${target}. Bind the backend to 127.0.0.1 and restart it before enabling Serve.`);
			if ((await this.#readServe()).occupied.has(httpsPort)) throw new TailscaleSetupError(`Tailscale Serve already uses port ${httpsPort}. Choose another --port.`);
			const record: BackendServeRecord = { version: 1, phase: "enabling", hostname: readiness.hostname, httpsPort, target, publicOrigin,
				addedHost: !auth.hosts.includes(publicOrigin), addedProxy: !this.options.trustedProxies.includes("127.0.0.1") };
			// Persist intent before the external write. An interrupted command remains individually removable.
			await this.#write(record);
			try {
				if ((await this.#readServe()).occupied.has(httpsPort)) throw new TailscaleSetupError(`Tailscale Serve now uses port ${httpsPort}. Choose another --port.`);
			} catch (error) {
				// No external write was attempted. Drop our intent, leaving the occupied port untouched.
				await this.#clearRecord();
				throw error;
			}
			try {
				await tailscale.addBackend(record);
				if (!(await this.#readServe()).matches(record)) throw new TailscaleSetupError("Could not verify the new Serve mapping.");
			} catch (error) { throw new TailscaleSetupError(`${(error as Error).message} ${RETRY_FIX}`); }
			if (record.addedHost) auth.hostChange(publicOrigin, true);
			await this.#write({ ...record, phase: "active" });
			return { publicOrigin, alreadyEnabled: false };
		});
	}

	disable() {
		return this.#serialize(async () => {
			const { auth, tailscale } = this.options;
			// Do not restore active settings just to remove them.
			const record = this.#record = await this.#readRecord();
			if (!record) return { mapping: "absent" as const };
			await this.#write({ ...record, phase: "disabling" });
			if (record.addedHost && auth.hosts.includes(record.publicOrigin)) auth.hostChange(record.publicOrigin, false);
			const serve = await this.#readServe();
			let mapping: "removed" | "unchanged" | "absent" = "absent";
			if (serve.matches(record)) {
				try { await tailscale.removeBackend(record.httpsPort); }
				catch (error) { throw new TailscaleSetupError(`${(error as Error).message} Run kemiri tailscale disable again to finish cleanup.`); }
				mapping = "removed";
			} else if (serve.occupied.has(record.httpsPort)) mapping = "unchanged";
			await this.#clearRecord();
			return { mapping };
		});
	}

	async pairingOrigin(): Promise<string> {
		const origin = this.activeOrigin;
		if (!origin) {
			const readiness = await this.options.tailscale.status();
			const fix = serveUnavailable(readiness);
			throw new TailscaleSetupError(`Tailnet pairing is not enabled.${readiness.hostname ? ` MagicDNS: ${readiness.hostname}.` : ""} ${fix ? `${fix} ` : ""}Run kemiri tailscale enable first.`);
		}
		if (this.options.auth.mode !== "required") throw new TailscaleSetupError(REQUIRED_FIX);
		if (!this.addsLoopbackTrust && !this.options.trustedProxies.includes("127.0.0.1")) {
			throw new TailscaleSetupError(`IPv4 loopback is no longer a trusted proxy. ${RETRY_FIX}`);
		}
		if (!this.options.auth.hosts.includes(origin)) throw new TailscaleSetupError(`The backend no longer allows ${origin}. Run kemiri auth hosts allow ${origin} first.`);
		if (!(await this.#readServe()).matches(this.#record!)) throw new TailscaleSetupError(`The backend Serve mapping is missing or changed. ${RETRY_FIX}`);
		return origin;
	}
}
