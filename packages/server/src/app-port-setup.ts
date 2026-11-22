import { open, rm } from "node:fs/promises";
import { APP_PORT_SETUP_COMMAND, DEFAULT_TAILSCALE_SERVE_RANGE } from "@kemiri/protocol";
import { listeningTcpPorts } from "./app-listeners.ts";
import { appForwarderPort, appPortReservationFile, readAppPortReservation, reservationMappings, validAppPortRange,
	type AppPortRange, type AppPortReservation } from "./app-port-reservations.ts";
import { appServeOwnershipFile, readAppServeOwnership } from "./app-serve-mappings.ts";
import { readBackendServeRecord } from "./backend-tailscale.ts";
import { writeJsonFile } from "./fs-json.ts";
import { serveUnavailable, type TailscaleServe } from "./tailscale.ts";

/** Only the interactive owner CLI writes this journal and the persistent Serve routes. */
export class AppPortSetup {
	constructor(readonly dataDir: string, readonly backendPort: number, readonly tailscale: TailscaleServe,
		readonly listeningPorts = listeningTcpPorts) {}

	async #exclusive<T>(work: () => Promise<T>): Promise<T> {
		const file = `${appPortReservationFile(this.dataDir)}.lock`;
		const lock = await open(file, "wx", 0o600).catch(error => {
			if (error.code === "ENOENT") throw new Error("Start Kemiri once as the backend account before reserving app ports.");
			if (error.code === "EEXIST") throw new Error("App port setup is locked. If no setup command is running, remove app-port-reservations.json.lock from the backend data directory and retry.");
			throw error;
		});
		try { return await work(); }
		finally { await lock.close(); await rm(file, { force: true }); }
	}

	enable(requestedRange?: AppPortRange) {
		return this.#exclusive(async () => {
			const record = await readAppPortReservation(this.dataDir);
			const range = requestedRange ?? record ?? DEFAULT_TAILSCALE_SERVE_RANGE;
			if (!validAppPortRange(range, this.backendPort)) throw new Error("Use 1–100 HTTPS ports from 1024 to 55535, excluding 8443 and Kemiri’s own port (including as a forwarder target).");
			const readiness = await this.tailscale.status();
			const unavailable = serveUnavailable(readiness, false);
			if (unavailable || !readiness.hostname) throw new Error(unavailable ?? readiness.magicDns.message);
			if (record && (record.phase === "disabling" || record.startPort !== range.startPort || record.endPort !== range.endPort || record.hostname !== readiness.hostname)) {
				throw new Error("Run kemiri tailscale disable --apps before changing the app reservation.");
			}
			const reservation: AppPortReservation = { version: 1, phase: "enabling", hostname: readiness.hostname, startPort: range.startPort, endPort: range.endPort };
			const mappings = reservationMappings(reservation);
			const serve = await this.tailscale.serveStatus();
			const legacy = await readAppServeOwnership(this.dataDir);
			const backend = await readBackendServeRecord(this.dataDir);
			const listeners = mappings.every(mapping => record && serve.matches(mapping)) ? new Set<number>() : await this.listeningPorts();
			if (!listeners) throw new Error("Could not check TCP listeners. On Linux, install iproute2 so Kemiri can use ss.");
			for (const mapping of mappings) {
				const port = mapping.httpsPort;
				const forwarder = appForwarderPort(port);
				if ([port, forwarder].includes(backend?.httpsPort ?? 0)) throw new Error(`Port ${backend?.httpsPort} belongs to the backend Serve setup.`);
				if (record && serve.matches(mapping)) continue;
				if (serve.occupied.has(port) && !legacy.some(owner => owner.httpsPort === port && serve.matches(owner))) {
					throw new Error(`Tailscale Serve already uses port ${port}. Choose another range with --ports START-END.`);
				}
				if (listeners.has(port) || listeners.has(forwarder)) throw new Error(`A local TCP listener already uses ${listeners.has(port) ? port : forwarder}. Choose another range with --ports START-END.`);
			}
			if (record?.phase === "active" && !legacy.length && mappings.every(serve.matches)) return record;
			// Remove the old direct routes only from the owner CLI, not from the reserved-mode backend.
			await writeJsonFile(appPortReservationFile(this.dataDir), reservation);
			await this.#removeLegacy(backend?.httpsPort);
			for (const mapping of mappings) {
				const latest = await this.tailscale.serveStatus();
				if (record && latest.matches(mapping)) continue;
				if (latest.occupied.has(mapping.httpsPort)) throw new Error(`Serve port ${mapping.httpsPort} became busy. Run ${APP_PORT_SETUP_COMMAND} again after resolving the conflict.`);
				await this.tailscale.add(mapping);
			}
			if (!mappings.every((await this.tailscale.serveStatus()).matches)) throw new Error(`Could not verify all app routes. Retry ${APP_PORT_SETUP_COMMAND}.`);
			reservation.phase = "active";
			await writeJsonFile(appPortReservationFile(this.dataDir), reservation);
			return reservation;
		});
	}

	async #removeLegacy(backendHttpsPort?: number): Promise<number> {
		let removed = 0;
		let remaining = await readAppServeOwnership(this.dataDir);
		for (const mapping of remaining) {
			if (mapping.httpsPort !== this.backendPort && mapping.httpsPort !== backendHttpsPort && (await this.tailscale.serveStatus()).matches(mapping)) {
				await this.tailscale.remove(mapping.httpsPort);
				removed++;
			}
			remaining = remaining.filter(owner => owner !== mapping);
			await writeJsonFile(appServeOwnershipFile(this.dataDir), remaining);
		}
		return removed;
	}

	disable() {
		return this.#exclusive(async () => {
			const reservation = await readAppPortReservation(this.dataDir);
			const backend = await readBackendServeRecord(this.dataDir);
			let removed = await this.#removeLegacy(backend?.httpsPort);
			if (reservation) {
				await writeJsonFile(appPortReservationFile(this.dataDir), { ...reservation, phase: "disabling" });
				for (const mapping of reservationMappings(reservation)) {
					if (mapping.httpsPort !== this.backendPort && mapping.httpsPort !== backend?.httpsPort && (await this.tailscale.serveStatus()).matches(mapping)) {
						await this.tailscale.remove(mapping.httpsPort);
						removed++;
					}
				}
				await rm(appPortReservationFile(this.dataDir));
			}
			return removed;
		});
	}
}
