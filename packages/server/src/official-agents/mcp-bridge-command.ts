import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, type Tool } from "@earendil-works/pi-mcp";

export const OFFICIAL_AGENT_MCP_COMMAND = "official-agent-mcp";
export const OFFICIAL_AGENT_MCP_PATH = "/internal/official-agent-mcp";
export const BRIDGE_URL_ENV = "KEMIRI_OFFICIAL_AGENT_MCP_URL";
export const BRIDGE_TOKEN_ENV = "KEMIRI_OFFICIAL_AGENT_MCP_TOKEN";
export const BRIDGE_REQUEST_BYTES = 64 * 1024;

export type AcpStdioMcpServer = {
	name: string;
	command: string;
	args: string[];
	env: { name: string; value: string }[];
};

export type BridgeToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
export const bridgeToolError = (text: string): BridgeToolResult => ({ content: [{ type: "text", text }], isError: true });

export function bridgeCommand(execPath = process.execPath, main = Bun.main): Pick<AcpStdioMcpServer, "command" | "args"> {
	// A Bun compiled executable has a virtual main. The bridge must re-exec the binary, not that path.
	const compiled = main.startsWith("/$bunfs/") || main.startsWith("B:/~BUN/");
	if (compiled) return { command: execPath, args: [OFFICIAL_AGENT_MCP_COMMAND] };
	const entry = fileURLToPath(new URL("../main.ts", import.meta.url));
	return { command: execPath, args: ["--no-env-file", `--cwd=${dirname(entry)}`, entry, OFFICIAL_AGENT_MCP_COMMAND] };
}

/** Stdio MCP's tool-only subset. pi-mcp ships a client but no production server. */
export async function runOfficialAgentMcpCommand(bridgeEnvironment: Readonly<Record<string, string | undefined>>): Promise<void> {
	const url = URL.parse(bridgeEnvironment[BRIDGE_URL_ENV] ?? "");
	const token = bridgeEnvironment[BRIDGE_TOKEN_ENV];
	if (!url || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.pathname !== OFFICIAL_AGENT_MCP_PATH ||
		url.username || url.password || url.search || url.hash || !token || !/^[a-f0-9]{64}$/.test(token)) {
		process.stderr.write("The official-agent MCP bridge requires a local Kemiri capability.\n");
		process.exitCode = 1;
		return;
	}
	const shutdown = new AbortController();
	const forward = async <T>(request: object): Promise<T | undefined> => {
		try {
			const body = JSON.stringify(request);
			if (Buffer.byteLength(body) > BRIDGE_REQUEST_BYTES) return;
			const response = await fetch(url, {
				method: "POST", redirect: "error", proxy: "", body,
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				signal: AbortSignal.any([shutdown.signal, AbortSignal.timeout(120_000)]),
			});
			if (response.ok) return await response.json() as T;
			await response.body?.cancel();
		} catch { /* Never print request details or OS/network errors from the bridge. */ }
	};
	// One dispatch at a time per capability, even if the agent sends parallel MCP calls.
	let dispatches = Promise.resolve();
	const dispatch = <T>(request: object) => {
		const response = dispatches.then(() => forward<T>(request));
		dispatches = response.then(() => undefined);
		return response;
	};
	const send = (message: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
	let initialized = false;
	let ready = false;
	let pending = 0;
	const receive = async (line: Buffer) => {
		let frame: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
		try { frame = JSON.parse(line.toString("utf8")); }
		catch { send({ id: null, error: { code: -32700, message: "Invalid JSON" } }); return; }
		if (frame?.jsonrpc !== "2.0" || typeof frame.method !== "string") {
			send({ id: null, error: { code: -32600, message: "Invalid request" } });
			return;
		}
		const { id, method, params } = frame;
		if (id === undefined) {
			if (initialized && method === "notifications/initialized") ready = true;
			return;
		}
		if (typeof id !== "string" && typeof id !== "number") {
			send({ id: null, error: { code: -32600, message: "Invalid request ID" } });
			return;
		}
		const reply = (result: object) => send({ id, result });
		const error = (code: number, message: string) => send({ id, error: { code, message } });
		if (method === "initialize" && !initialized) {
			const version = params?.protocolVersion;
			if (typeof version !== "string") return error(-32602, "A protocol version is required");
			initialized = true;
			return reply({
				protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.find(supported => supported === version) ?? LATEST_PROTOCOL_VERSION,
				capabilities: { tools: {} }, serverInfo: { name: "kemiri", version: "1" },
			});
		}
		if (method === "ping") return reply({});
		if (!ready) return error(-32002, "MCP initialization is incomplete");
		if (method !== "tools/list" && method !== "tools/call") return error(-32601, "Method not supported");
		if (pending >= 4) return error(-32000, "Too many pending tool requests");
		pending++;
		try {
			if (method === "tools/list") {
				const tools = await dispatch<Tool[]>({ method });
				return tools ? reply({ tools }) : error(-32000, "Kemiri MCP is unavailable");
			}
			if (typeof params?.name !== "string") return error(-32602, "A tool name is required");
			return reply(await dispatch<BridgeToolResult>({ method, name: params.name, arguments: params.arguments ?? {} })
				?? bridgeToolError("Kemiri MCP is unavailable or the request is too large."));
		} finally { pending--; }
	};
	// Bound unterminated lines before allocating/parsing a frame; stdout is exclusively MCP.
	let tail: Buffer = Buffer.alloc(0);
	try {
		for await (const chunk of process.stdin) {
			const bytes = Buffer.concat([tail, chunk as Buffer]);
			let start = 0;
			for (let end = bytes.indexOf(10); end >= 0; end = bytes.indexOf(10, start)) {
				if (end - start > BRIDGE_REQUEST_BYTES) return;
				void receive(bytes.subarray(start, end)).catch(() => shutdown.abort());
				start = end + 1;
			}
			tail = bytes.subarray(start);
			if (tail.length > BRIDGE_REQUEST_BYTES) return;
		}
	} finally { shutdown.abort(); }
}
