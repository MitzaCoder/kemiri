import { randomBytes, randomUUID } from "node:crypto";
import type { Tool } from "@earendil-works/pi-mcp";
import { BRIDGE_REQUEST_BYTES, BRIDGE_TOKEN_ENV, BRIDGE_URL_ENV, OFFICIAL_AGENT_MCP_PATH, bridgeCommand, bridgeToolError, type AcpStdioMcpServer, type BridgeToolResult } from "./mcp-bridge-command.ts";

export type OfficialAgentMcpScope = {
	isCurrent(): Promise<boolean>;
	tools: readonly Tool[];
	call(name: string, args: unknown, key: string, signal: AbortSignal): Promise<BridgeToolResult>;
};
export type OfficialAgentMcpGrant = { server: AcpStdioMcpServer; revoke(): void };

type Capability = { scope: OfficialAgentMcpScope; lifetime: AbortController; busy: boolean };

/** One backend-owned, loopback-only listener (even if the public API binds a specific non-loopback address). */
export class OfficialAgentMcpBridge {
	readonly #capabilities = new Map<string, Capability>();
	#listener?: ReturnType<typeof Bun.serve<undefined>>;
	#closed = false;

	grant(scope: OfficialAgentMcpScope): OfficialAgentMcpGrant {
		if (this.#closed) throw new Error("The official-agent MCP bridge is shutting down.");
		const listener = this.#listener ??= Bun.serve({
			hostname: "127.0.0.1", port: 0, maxRequestBodySize: BRIDGE_REQUEST_BYTES,
			fetch: (request, server) => {
				if (new URL(request.url).pathname !== OFFICIAL_AGENT_MCP_PATH) return new Response(null, { status: 404 });
				if (server.requestIP(request)?.address !== "127.0.0.1" || request.headers.has("origin")) return new Response(null, { status: 403 });
				return this.#dispatch(request, () => server.timeout(request, 0));
			},
		});
		const token = randomBytes(32).toString("hex");
		const capability: Capability = { scope, lifetime: new AbortController(), busy: false };
		this.#capabilities.set(token, capability);
		return {
			server: { name: "kemiri", ...bridgeCommand(), env: [
				{ name: BRIDGE_URL_ENV, value: new URL(OFFICIAL_AGENT_MCP_PATH, listener.url).href },
				{ name: BRIDGE_TOKEN_ENV, value: token },
			] },
			revoke: () => { this.#capabilities.delete(token); capability.lifetime.abort(); },
		};
	}

	close(): void {
		this.#closed = true;
		for (const capability of this.#capabilities.values()) capability.lifetime.abort();
		this.#capabilities.clear();
		this.#listener?.stop(true);
	}

	async #dispatch(request: Request, disableIdleTimeout: () => void): Promise<Response> {
		const refused = () => new Response(null, { status: 403 });
		const authorization = request.headers.get("authorization");
		const token = /^Bearer ([a-f0-9]{64})$/.exec(authorization ?? "")?.[1];
		const capability = token && this.#capabilities.get(token);
		if (!capability) return refused();
		if (request.method !== "POST") return new Response(null, { status: 405 });
		const { scope, lifetime } = capability;
		const signal = lifetime.signal;
		const json = (body: unknown) => Response.json(body, { headers: { "cache-control": "no-store" } });
		if (capability.busy) return new Response(null, { status: 429 });
		capability.busy = true;
		try {
			const call = await request.json().catch(() => null) as { method?: unknown; name?: unknown; arguments?: unknown } | null;
			if (!await scope.isCurrent() || signal.aborted) return refused();
			if (call?.method === "tools/list") return json(scope.tools);
			if (call?.method !== "tools/call" || typeof call.name !== "string") return new Response(null, { status: 400 });
			if (!scope.tools.some(tool => tool.name === call.name)) return json(bridgeToolError("This tool is not available to this worker."));
			disableIdleTimeout();
			const result = await scope.call(call.name, call.arguments, `official-mcp:${randomUUID()}`, signal);
			return signal.aborted ? refused() : json(result);
		} catch {
			return signal.aborted ? refused() : json(bridgeToolError("Kemiri could not complete this tool call."));
		} finally { capability.busy = false; }
	}
}
