import { TailscaleServe, type TailscaleCommand } from "../src/tailscale.ts";

export function fakeTailscale(hostname = "oven.example-tailnet.ts.net") {
	const commands: string[][] = [];
	const config = { TCP: {} as Record<string, unknown>, Web: {} as Record<string, { Handlers: Record<string, unknown> }> };
	const installed = { value: true };
	const running = { value: true };
	const https = { value: true };
	const operator = { value: true };
	const writeDenied = { value: false };
	const mapping = (port: number, target: string) => {
		config.TCP[port] = { HTTPS: true };
		config.Web[`${hostname}:${port}`] = { Handlers: { "/": { Proxy: target } } };
	};
	const drop = (port: number) => { delete config.TCP[port]; delete config.Web[`${hostname}:${port}`]; };
	const run: TailscaleCommand = async (file, args) => {
		commands.push([file, ...args]);
		const json = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: "" });
		if (!installed.value) return { stdout: "", stderr: "", error: "ENOENT" };
		if (args[0] === "status") return json({ BackendState: running.value ? "Running" : "Stopped", Self: { DNSName: `${hostname}.` },
			CurrentTailnet: { MagicDNSEnabled: true }, CertDomains: https.value ? [hostname] : [] });
		if (args[0] === "debug") return json({ OperatorUser: operator.value ? "example-service" : "" });
		if (args[1] === "status") return json(config);
		if (writeDenied.value) return { stdout: "", stderr: "Access denied", error: "1" };
		const port = Number(args.find(arg => arg.startsWith("--https="))?.slice(8));
		if (!port) throw new Error("Unexpected Tailscale command.");
		if (args.at(-1) === "off") drop(port);
		else mapping(port, args.at(-1)!);
		return { stdout: "", stderr: "" };
	};
	return { tailscale: new TailscaleServe(run, () => ({ uid: 1000, gid: 1000, username: "example-service", homedir: "/", shell: null })),
		commands, config, installed, running, https, operator, writeDenied, mapping, drop, hostname };
}
