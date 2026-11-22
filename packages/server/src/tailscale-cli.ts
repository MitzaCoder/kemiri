import { AppPortSetup } from "./app-port-setup.ts";
import { appSetupTailscale } from "./tailscale.ts";
import { resolvedServerConfig } from "./server-env.ts";
import { join } from "node:path";
import { CERTIFICATE_TRANSPARENCY_NOTE } from "./backend-tailscale.ts";
import { resolveDataDir, type Environment } from "./data-dir.ts";
import { runTailscaleStatusCli } from "./tailscale-status-cli.ts";
import { encode } from "uqr";

function requireExplicitTargetInAgent(env: Environment): void {
	if (env.KEMIRI_CHILD_PROCESS === "1" && !env.KEMIRI_ENV_FILE?.trim() && !env.KEMIRI_DATA_DIR?.trim()) {
		throw new Error("Owner CLI from an agent requires explicit KEMIRI_ENV_FILE or KEMIRI_DATA_DIR");
	}
}

async function requestOwnerCommand<Result>(env: Environment, args: readonly string[]): Promise<Result> {
	let response: Response;
	try {
		response = await fetch("http://localhost/", {
			unix: join(resolveDataDir(env), "auth.sock"), method: "POST",
			headers: { "content-type": "application/json" }, body: JSON.stringify({ args }), signal: AbortSignal.timeout(45_000),
		});
	} catch { throw new Error("Cannot reach the running backend owner socket. Run kemiri start for this installation and retry."); }
	const result = await response.json() as Result & { error?: { code: string; message?: string } };
	if (!response.ok) throw new Error(result.error?.message ?? `Owner command failed: ${result.error?.code ?? response.status}`);
	return result;
}

export async function runTailscaleCli(args: readonly string[], env: Environment): Promise<void> {
	requireExplicitTargetInAgent(env);
	if (args[0] === "status") return runTailscaleStatusCli(args.slice(1), env);
	if (args[1] === "--apps" && (args[0] === "enable" || args[0] === "disable")) {
		if (env.KEMIRI_CHILD_PROCESS === "1") throw new Error("Run app port setup in a terminal as the backend account, not from an agent.");
		const { dataDir, port } = resolvedServerConfig(env);
		const setup = new AppPortSetup(dataDir, port, appSetupTailscale());
		if (args[0] === "disable" && args.length === 2) {
			const removed = await setup.disable();
			console.log(`App port reservation cleared. Removed ${removed} Kemiri app Serve mappings. Other mappings were left untouched.`);
			return;
		}
		const range = args.length === 4 && args[2] === "--ports" ? args[3]?.match(/^(\d+)-(\d+)$/) : null;
		if (args[0] === "enable" && (args.length === 2 || range)) {
			const { startPort, endPort } = await setup.enable(range ? { startPort: Number(range[1]), endPort: Number(range[2]) } : undefined);
			console.log(`App HTTPS ports ${startPort}–${endPort} reserved. This setup does not grant Kemiri Tailscale operator rights.\n${CERTIFICATE_TRANSPARENCY_NOTE}`);
			return;
		}
	}
	if (args[0] === "enable" && (args.length === 1 || (args.length === 3 && args[1] === "--port" && /^\d+$/.test(args[2]!)))) {
		const setup = await requestOwnerCommand<{ publicOrigin: string; alreadyEnabled: boolean }>(env, ["tailscale", ...args]);
		console.log(`${setup.alreadyEnabled ? "Already enabled" : "Enabled"}: ${setup.publicOrigin}\n${CERTIFICATE_TRANSPARENCY_NOTE}\nRun kemiri pair --tailscale to pair a device.`);
		return;
	}
	if (args[0] === "disable" && args.length === 1) {
		const setup = await requestOwnerCommand<{ mapping: "removed" | "unchanged" | "absent" }>(env, ["tailscale", "disable"]);
		console.log(setup.mapping === "removed" ? "Tailnet access disabled. Removed Kemiri’s Serve mapping." : setup.mapping === "unchanged" ?
			"Kemiri’s tailnet setup was cleared. The changed Serve mapping was left untouched." : "No Kemiri Serve mapping to remove. Tailnet setup is disabled.");
		return;
	}
	throw new Error("Usage: kemiri tailscale status [--json] | enable [--port <P> | --apps [--ports START-END]] | disable [--apps]");
}

/** Draw two QR modules per terminal row, with an explicit light quiet zone. */
export function terminalPairingQr(url: string): string {
	const { data } = encode(url, { ecc: "M", border: 4 });
	const lines: string[] = [];
	for (let y = 0; y < data.length; y += 2) {
		let line = "", color = "";
		for (let x = 0; x < data[y]!.length; x++) {
			const colors = `\x1b[${data[y]![x] ? 30 : 97};${data[y + 1]?.[x] ? 40 : 107}m`;
			if (colors !== color) { line += colors; color = colors; }
			line += "▀";
		}
		lines.push(line + "\x1b[0m");
	}
	return lines.join("\n");
}

export async function runTailnetPairCli(args: readonly string[], env: Environment): Promise<void> {
	if (args.length !== 1 || args[0] !== "--tailscale") throw new Error("Usage: kemiri pair --tailscale");
	requireExplicitTargetInAgent(env);
	const grant = await requestOwnerCommand<{ url: string; code: string; expiresAt: string }>(env, ["pair", "--tailscale"]);
	console.log(`Pairing link: ${grant.url}\nCode: ${grant.code}\nExpires: ${grant.expiresAt}\n${terminalPairingQr(grant.url)}`);
}
