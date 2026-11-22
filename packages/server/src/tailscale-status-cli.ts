import { join } from "node:path";
import { readAppSettings } from "./app-addresses.ts";
import { appPortReservationStatus, readAppPortReservation, reservationMappings } from "./app-port-reservations.ts";
import { readAppServeOwnership } from "./app-serve-mappings.ts";
import { CERTIFICATE_TRANSPARENCY_NOTE, readBackendServeRecord, type BackendServeRecord } from "./backend-tailscale.ts";
import { readAllowedBackendOrigins } from "./device-auth.ts";
import { readJsonFile } from "./fs-json.ts";
import { resolvedServerConfig } from "./server-env.ts";
import { loopbackTarget, TailscaleServe, type ServeHttpsRoute, type ServeStatus } from "./tailscale.ts";
import type { Environment } from "./data-dir.ts";
import type { AppAddresses } from "@kemiri/protocol";

type CheckStatus = "ok" | "missing" | "warning";
const check = (status: CheckStatus, message: string) => ({ status, message });
const readinessCheck = (line: { ok: boolean; message: string }) => check(line.ok ? "ok" : "missing", line.message);
const appAddressesFix = "Choose a free app port range.";
const dnsFix = "Enable MagicDNS in the Tailscale admin console under DNS.";

export async function inspectTailscaleStatus(env: Environment, tailscale = new TailscaleServe()) {
	const { dataDir, port: backendPort } = resolvedServerConfig(env);
	const { status, backendUser, operatorKnown } = await tailscale.inspectReadiness();
	const hostname = status.running.ok ? status.hostname : null;
	const notRunningFix = status.installed.ok ? status.running.message : `${status.installed.message} Then run tailscale up.`;
	const operator = status.running.ok
		? operatorKnown ? readinessCheck(status.operator) : check("warning", `Could not read the operator preference. Run tailscale debug prefs as the backend account. ${status.operator.message}`)
		: check("warning", notRunningFix);

	let addresses: AppAddresses | null = null;
	try {
		const saved = await readJsonFile(join(dataDir, "user-settings.json")) as { apps?: unknown; appAddressesVersion?: number } | undefined;
		addresses = readAppSettings(saved?.apps, saved?.appAddressesVersion === 2).addresses;
	} catch { /* Don't mistake unreadable settings for the defaults. */ }

	let reservation: Awaited<ReturnType<typeof readAppPortReservation>>;
	let reservationUnreadable = false;
	try { reservation = await readAppPortReservation(dataDir); } catch { reservationUnreadable = true; }
	const portRange = addresses?.mode === "tailscale-serve" ? { startPort: addresses.startPort, endPort: addresses.endPort } :
		reservation ? { startPort: reservation.startPort, endPort: reservation.endPort } : null;

	let backendServe: BackendServeRecord | undefined;
	let ownershipReadable = true;
	try { backendServe = await readBackendServeRecord(dataDir); } catch { ownershipReadable = false; }
	let serveStatus: ServeStatus | undefined;
	let serveCheck = check("warning", notRunningFix);
	let ownedPorts: Set<number> | undefined;
	if (status.running.ok) {
		try {
			serveStatus = await tailscale.serveStatus();
			serveCheck = check("ok", serveStatus.httpsRoutes.length ? "Current HTTPS mappings:" : "No HTTPS mappings.");
		} catch (error) { serveCheck = check("warning", (error as Error).message); }
		if (serveStatus) {
			try {
				if (!ownershipReadable || reservationUnreadable) throw new Error("Invalid backend Serve ownership");
				ownedPorts = new Set((await readAppServeOwnership(dataDir)).filter(serveStatus.matches).map(mapping => mapping.httpsPort));
				if (backendServe && serveStatus.matches(backendServe)) ownedPorts.add(backendServe.httpsPort);
				if (reservation) for (const mapping of reservationMappings(reservation)) if (serveStatus.matches(mapping)) ownedPorts.add(mapping.httpsPort);
			} catch {
				serveCheck = check("warning", "Could not verify mapping ownership. Restore the backend’s app-serve-ownership.json, app-port-reservations.json or backend-serve.json from a valid backup.");
			}
		}
	}
	const reserved = appPortReservationStatus(reservation, status.https.ok ? serveStatus : undefined, hostname, backendPort);
	const appAddresses = {
		mode: addresses?.mode ?? null,
		portRange,
		check: !addresses ? check("warning", "Could not read App addresses. Restore the backend’s user-settings.json from a valid backup.") :
			addresses.mode === "tailscale-serve" && portRange ? check("ok", `Advanced operator mode; HTTPS ports ${portRange.startPort}–${portRange.endPort}.`) :
				check("ok", `Address mode: ${addresses.mode}.`),
		reservedPorts: check(reserved.ok ? "ok" : "missing", reserved.message),
	};
	const httpsMappings = (serveStatus?.httpsRoutes ?? []).map(route => ({ ...route,
		ownership: !ownedPorts ? "unknown" as const : ownedPorts.has(route.httpsPort) ? "kemiri" as const : "foreign" as const,
	}));
	const conflictPorts = serveStatus && ownedPorts && portRange ? [...serveStatus.occupied].filter(port =>
		port >= portRange.startPort && port <= portRange.endPort && !ownedPorts.has(port)).sort((a, b) => a - b) : null;
	const rangeConflicts = {
		ports: conflictPorts,
		check: conflictPorts === null ? null : conflictPorts.length
			? check("warning", `Foreign Serve configuration occupies app-range ports ${conflictPorts.join(", ")}. ${appAddressesFix}`)
			: check("ok", "No foreign Serve ports overlap the app range."),
	};

	let allowedOrigins: string[] | undefined;
	try { allowedOrigins = readAllowedBackendOrigins(dataDir, env); } catch { /* Report unknown instead of disallowed. */ }
	const origins = hostname ? candidateOrigins(hostname, backendPort, httpsMappings).map(origin => ({
		origin,
		check: !allowedOrigins ? check("warning", "Could not read the backend allowlist. Run kemiri auth hosts list against the running backend.") :
			allowedOrigins.includes(origin) ? check("ok", "Allowed.") :
				check("missing", `If this is the backend address, run kemiri auth hosts allow ${origin}`),
	})) : [];
	const backendOrigins = { candidates: origins, check: origins.length ? null : check("warning", status.running.ok ? dnsFix : notRunningFix) };
	const proxies = env.KEMIRI_TRUSTED_PROXIES?.split(",") ?? [];
	const ipv4 = proxies.includes("127.0.0.1"), ipv6 = proxies.includes("::1");
	const managedOrigin = backendServe?.phase === "active" && backendServe.addedProxy &&
		(backendPort === 0 || backendServe.target === loopbackTarget(backendPort)) ? backendServe.publicOrigin : null;
	const trustedLoopback = { ipv4, ipv6, managedOrigin, check: ipv4 ? check("ok", "IPv4 loopback is trusted for Serve.") :
		managedOrigin ? check("ok", `IPv4 loopback is trusted only for ${managedOrigin}.`) :
			check("missing", "Run kemiri tailscale enable to trust IPv4 loopback only for the backend’s tailnet address.") };

	return {
		version: 1,
		installed: readinessCheck(status.installed),
		running: status.installed.ok ? readinessCheck(status.running) : check("warning", notRunningFix),
		magicDns: { hostname, check: status.running.ok ? readinessCheck(status.magicDns) : check("warning", notRunningFix) },
		https: status.running.ok ? readinessCheck(status.https) : check("warning", notRunningFix),
		operator: { backendUser, check: operator },
		serve: { check: serveCheck, httpsMappings, rangeConflicts,
			backend: backendServe ? { publicOrigin: backendServe.publicOrigin, phase: backendServe.phase } : null },
		backendPort,
		backendOrigins,
		trustedLoopback,
		appAddresses,
		certificateTransparency: CERTIFICATE_TRANSPARENCY_NOTE,
	};
}

function candidateOrigins(hostname: string, backendPort: number, routes: readonly ServeHttpsRoute[]): string[] {
	const ports = new Set([443]);
	if (backendPort) {
		ports.add(backendPort);
		for (const route of routes) {
			if (route.hostname === hostname && route.path === "/" && route.target === loopbackTarget(backendPort)) ports.add(route.httpsPort);
		}
	}
	return [...ports].sort((a, b) => a - b).map(port => new URL(`https://${hostname}:${port}`).origin);
}

export function formatTailscaleStatus(report: Awaited<ReturnType<typeof inspectTailscaleStatus>>): string {
	const line = (label: string, result: ReturnType<typeof check>) => `${result.status}: ${label}: ${result.message}`;
	return [
		line("Tailscale installed", report.installed),
		line("Tailscale running and signed in", report.running),
		line("MagicDNS name", report.magicDns.check),
		line("Tailnet HTTPS certificates", report.https),
		line(`Serve operator, advanced mode only (${report.operator.backendUser})`, report.operator.check),
		line("Serve", report.serve.check),
		...(report.serve.backend ? [`  Backend Serve: ${report.serve.backend.publicOrigin} (${report.serve.backend.phase})`] : []),
		...report.serve.httpsMappings.map(mapping => {
			const source = mapping.hostname ? `${mapping.hostname}:${mapping.httpsPort}${mapping.path ?? ""}` : `HTTPS port ${mapping.httpsPort}`;
			return `  ${source} → ${mapping.target} (${mapping.ownership === "kemiri" ? "Kemiri" : mapping.ownership})`;
		}),
		...(report.serve.rangeConflicts.check ? [line("App port range", report.serve.rangeConflicts.check)] : []),
		...(report.backendOrigins.check ? [line("Backend tailnet origin", report.backendOrigins.check)] :
			report.backendOrigins.candidates.map(({ origin, check }) => line(`Backend origin ${origin}`, check))),
		line(`Trusted proxy (IPv4 loopback ${report.trustedLoopback.ipv4 ? "on" : "off"}, IPv6 loopback ${report.trustedLoopback.ipv6 ? "on" : "off"})`, report.trustedLoopback.check),
		line("App addresses", report.appAddresses.check),
		line("Reserved app HTTPS ports", report.appAddresses.reservedPorts),
		`info: ${report.certificateTransparency}`,
	].join("\n");
}

export async function runTailscaleStatusCli(args: readonly string[], env: Environment): Promise<void> {
	if (args.length > 1 || (args.length === 1 && args[0] !== "--json")) throw new Error("Usage: kemiri tailscale status [--json]");
	const report = await inspectTailscaleStatus(env);
	console.log(args.includes("--json") ? JSON.stringify(report, null, 2) : formatTailscaleStatus(report));
}
