/** Owner-only local control; the service never logs command payloads or bootstrap output. */
import { serverSettings } from "./server-settings.ts";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DeviceAuth, DeviceAuthError, validateBackendOrigin } from "./device-auth.ts";
import { authFailure, authJson, readAuthBody } from "./device-auth-http.ts";
import { resolveDataDir } from "./data-dir.ts";
import { assertDataDirNotOwned } from "./data-dir-owner.ts";
import { TailscaleSetupError, type BackendTailscale } from "./backend-tailscale.ts";

type ControlOptions = {
	loopbackOrigin: string;
	allowedOrigins: readonly string[];
	tailscale?: BackendTailscale;
	tailnetWebShell?: boolean;
	serializeTailscale?: <T>(work: () => Promise<T>) => Promise<T>;
	/** Only installed on the owner socket, never the public HTTP router. */
	healthCheck?: (request: string) => Promise<unknown>;
};

export async function startAuthControl(
	auth: DeviceAuth,
	options: ControlOptions,
) {
	const socket = join(auth.dir, "auth.sock");
	await assertDataDirNotOwned(auth.dir);
	if (existsSync(socket)) unlinkSync(socket);
	let pendingOwnerSettings: Promise<unknown> = Promise.resolve();
	let draining = false;
	const server = Bun.serve({
		unix: socket,
		async fetch(request) {
			try {
				if (request.method !== "POST") return authJson({}, 405);
				const body = await readAuthBody(request);
				if (!Array.isArray(body.args) || !body.args.every((x) => typeof x === "string"))
					throw new DeviceAuthError("bad_request", 400);
				const args = body.args as string[];
				const run = () => ownerCommand(auth, args, options);
				if (["hosts", "mode", "pair", "tailscale"].includes(args[0] ?? "")) {
					if (draining) return authJson({ error: { code: "backend_stopping" } }, 503);
					const next = pendingOwnerSettings.then(run);
					pendingOwnerSettings = next.catch(() => undefined);
					return authJson(await next);
				}
				return authJson(await run());
			} catch (error) {
				// Setup fixes are local-only; the public auth router still sends codes only.
				if (error instanceof TailscaleSetupError) return authJson({ error: { code: "tailscale_setup", message: error.message } }, 400);
				return authFailure(error);
			}
		},
	});
	chmodSync(socket, 0o600);
	return {
		async drainSettings() {
			draining = true;
			await pendingOwnerSettings;
		},
		stop() {
			server.stop(true);
			if (existsSync(socket)) unlinkSync(socket);
		},
	};
}
export async function ownerCommand(
	auth: DeviceAuth,
	args: string[],
	options: ControlOptions,
): Promise<unknown> {
	const [command, action, value, ...rest] = args;
	const flag = (name: string) => {
		const i = args.indexOf(name);
		return i < 0 ? undefined : args[i + 1];
	};
	switch (command) {
		case "health-check":
			if (action && options.healthCheck) return {
				backendId: auth.backendId, loopbackOrigin: options.loopbackOrigin, answer: await options.healthCheck(action),
			};
			break;
		case "status":
			return auth.status();
		case "mode":
			return auth.setMode(action);
		case "devices":
			if (action === "list") return { devices: auth.devices() };
			if (action === "revoke" && value) {
				await auth.revoke(value);
				return { ok: true };
			}
			break;
		case "revoke-all":
			for (const device of auth.devices()) await auth.revoke(device.id);
			return { ok: true };
		case "hosts":
			if (action === "list") return auth.hostsList();
			if (value && (action === "allow" || action === "remove")) return auth.hostChange(value, action === "allow");
			break;
		case "migration":
			if (action === "list") return { claims: auth.inventory().filter(c => !args.includes("--pending") || c.state === "pending") };
			if (action === "approve" && value === "--batch" && rest[0] && rest.length > 1)
				return auth.approveMigration(rest[0], rest.slice(1));
			break;
		case "tailscale": {
			const setup = options.tailscale;
			if (!setup) break;
			const run = <T>(work: () => Promise<T>) => options.serializeTailscale ? options.serializeTailscale(work) : work();
			if (action === "disable" && args.length === 2) return run(() => setup.disable());
			if (action === "enable" && (args.length === 2 || (args.length === 4 && value === "--port" && /^\d+$/.test(rest[0]!)))) {
				return run(() => setup.enable(args.length === 4 ? Number(rest[0]) : undefined));
			}
			break;
		}
		case "pair": {
			const tailnet = args.includes("--tailscale");
			if (tailnet && (args.length !== 2 || !options.tailscale)) break;
			const local = args.includes("--local");
			const backend = tailnet ? await options.tailscale!.pairingOrigin() : local ? options.loopbackOrigin : flag("--backend");
			if (!backend || (!local && !auth.hosts.includes(validateBackendOrigin(backend))))
				throw new DeviceAuthError("backend_origin_required", 400);
			const webApp = tailnet && options.tailnetWebShell ? backend : flag("--web-app") ?? serverSettings.KEMIRI_WEB_APP ?? options.allowedOrigins[0];
			if (tailnet && !options.tailnetWebShell && (!webApp || !options.allowedOrigins.includes(webApp))) {
				throw new TailscaleSetupError("For an API-only backend, set KEMIRI_WEB_APP to the HTTPS web app origin, add it to KEMIRI_ALLOWED_ORIGINS, and restart Kemiri.");
			}
			if (!local && !webApp) throw new DeviceAuthError("web_app_required", 400);
			if (webApp) validateBackendOrigin(webApp);
			const grant = auth.bootstrap(local);
			if (local) return { url: `${options.loopbackOrigin}/pair#bootstrap=${grant.secret}`, expiresAt: grant.expiresAt };
			const fragment = Buffer.from(JSON.stringify([auth.backendId, backend, grant.requestId])).toString("base64url");
			return { url: `${webApp}/pair#bootstrap=v1.${fragment}`, code: grant.secret, expiresAt: grant.expiresAt };
		}
	}
	throw new DeviceAuthError("invalid_command", 400);
}
export async function runAuthCli(args: string[]): Promise<void> {
	// Even default same-user data paths may be the live installation: agent commands require deliberate targeting.
	if (serverSettings.KEMIRI_CHILD_PROCESS === "1" && !serverSettings.KEMIRI_ENV_FILE?.trim() && !serverSettings.KEMIRI_DATA_DIR?.trim()) {
		console.error("Owner CLI from an agent requires explicit KEMIRI_ENV_FILE or KEMIRI_DATA_DIR");
		process.exitCode = 1;
		return;
	}
	try {
		const response = await fetch("http://localhost/", {
			unix: join(resolveDataDir(), "auth.sock"),
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ args }),
			signal: AbortSignal.timeout(10000),
		});
		const result = await response.json();
		if (!response.ok) {
			console.error("Auth command failed", (result as { error: { code: string } }).error.code);
			process.exitCode = 1;
			return;
		}
		console.log(JSON.stringify(result, null, 2));
	} catch {
		console.error("Cannot reach running backend owner socket");
		process.exitCode = 1;
	}
}
