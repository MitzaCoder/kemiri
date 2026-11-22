import { join } from "node:path";
import { APP_PORT_SETUP_COMMAND } from "@kemiri/protocol";
import { readJsonFile } from "./fs-json.ts";
import { loopbackTarget, validServePort, validTailnetHostname, type ServeStatus } from "./tailscale.ts";

export const appPortReservationFile = (dataDir: string) => join(dataDir, "app-port-reservations.json");
export type AppPortRange = { startPort: number; endPort: number };
export type AppPortReservation = AppPortRange & { version: 1; hostname: string; phase: "enabling" | "active" | "disabling" };
export const appForwarderPort = (httpsPort: number) => httpsPort + 10_000;

export function validAppPortRange({ startPort, endPort }: AppPortRange, backendPort?: number): boolean {
	return validServePort(startPort) && validServePort(endPort) && endPort >= startPort && endPort - startPort < 100 &&
		appForwarderPort(endPort) <= 65535 && !(startPort <= 8443 && 8443 <= endPort) &&
		(backendPort === undefined || ![backendPort, backendPort - 10_000].some(port => startPort <= port && port <= endPort));
}

export function isReservedAppPort(reservation: AppPortRange | undefined, port: number): boolean {
	return !!reservation && [port, port - 10_000].some(candidate => reservation.startPort <= candidate && candidate <= reservation.endPort);
}

export function reservationMappings(reservation: AppPortReservation) {
	return Array.from({ length: reservation.endPort - reservation.startPort + 1 }, (_, offset) => {
		const httpsPort = reservation.startPort + offset;
		return { hostname: reservation.hostname, httpsPort, target: loopbackTarget(appForwarderPort(httpsPort)) };
	});
}

export async function readAppPortReservation(dataDir: string): Promise<AppPortReservation | undefined> {
	const saved = await readJsonFile(appPortReservationFile(dataDir)) as AppPortReservation | undefined;
	if (saved === undefined) return;
	if (!saved || saved.version !== 1 || !["enabling", "active", "disabling"].includes(saved.phase) ||
		!validTailnetHostname(saved.hostname) || !validAppPortRange(saved)) throw new Error("Could not read Kemiri’s app port reservation.");
	return saved;
}

export function appPortReservationStatus(reservation: AppPortReservation | undefined, serve: ServeStatus | undefined, hostname: string | null, backendPort: number) {
	const ok = reservation?.phase === "active" && reservation.hostname === hostname && validAppPortRange(reservation, backendPort) &&
		serve !== undefined && reservationMappings(reservation).every(mapping => serve.matches(mapping));
	return { ok, message: ok ? `Reserved HTTPS ports: ${reservation.startPort}–${reservation.endPort}. No runtime Tailscale changes.` :
		`HTTPS app ports are not reserved. Run ${APP_PORT_SETUP_COMMAND} once on the backend, or choose Address template for plain links.`,
		...(ok ? { range: { startPort: reservation.startPort, endPort: reservation.endPort } } : {}) };
}
