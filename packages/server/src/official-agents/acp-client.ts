import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const ACP_VERSION = 1;
const SETUP_TIMEOUT_MS = 30_000;
const CANCEL_TIMEOUT_MS = 10_000;

export type AcpUpdate = Record<string, unknown>;
type AcpPermission = { optionId?: string; kind?: string };
export class AcpRpcError extends Error {
	constructor(readonly method: string, readonly code: number, message: string) { super(message); }
}
export class AcpProcessError extends Error {}
export class AcpProtocolError extends Error {}

type AcpSession = {
	sessionId?: string;
	models?: { currentModelId?: string; availableModels?: { modelId: string; name: string }[] };
	configOptions?: { category?: string; id: string; currentValue?: string; options?: { value?: string; name: string; options?: { value: string; name: string }[] }[] }[];
};

type AcpInitialize = {
	protocolVersion?: number;
	agentInfo?: { version?: string };
	agentCapabilities?: { loadSession?: boolean };
	authMethods?: { id: string }[];
};

export class AcpClient {
	readonly #child;
	readonly #pending = new Map<number, { method: string; resolve: (result: unknown) => void; reject: (error: Error) => void }>();
	readonly #exited: Promise<void>;
	#stderrBytes = 0;
	#sequence = 0;
	#failure?: Error;
	#sessionId?: string;
	#loadedConfig?: AcpSession["configOptions"];
	#closing?: Promise<void>;
	#prompt?: Promise<unknown>;
	#update?: (update: AcpUpdate) => void;
	#permission?: (kind: string) => void;

	constructor(command: string, args: readonly string[], cwd: string, env: Record<string, string>, log: (message: string) => void) {
		this.#child = spawn(command, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
		this.#exited = new Promise(resolve => this.#child.once("close", (code, signal) => {
			this.#fail(new AcpProcessError("The agent process died."));
			// Never log bytes from stderr: they can contain arbitrary secrets, paths, and sign-in links.
			if (this.#stderrBytes && !this.#closing) log(`ACP process exited (${signal ?? code ?? "unknown"}); stderr redacted (${this.#stderrBytes} bytes, capped).`);
			resolve();
		}));
		this.#child.on("exit", () => this.#fail(new AcpProcessError("The agent process died.")));
		this.#child.on("error", () => this.#fail(new AcpProcessError("Could not start the agent process.")));
		this.#child.stdin.on("error", () => this.#fail(new AcpProcessError("The agent process closed stdin.")));
		this.#child.stderr.on("data", (chunk: Buffer) => { this.#stderrBytes = Math.min(4096, this.#stderrBytes + chunk.length); });
		// Bound an unterminated frame as well as complete JSON-RPC frames.
		let frameBytes = 0;
		this.#child.stdout.on("data", (chunk: Buffer) => {
			let start = 0;
			while (start < chunk.length) {
				const newline = chunk.indexOf(10, start);
				frameBytes += (newline < 0 ? chunk.length : newline) - start;
				if (frameBytes > 16 * 1024 * 1024) {
					this.#fail(new AcpProtocolError("ACP frame exceeds its size limit."));
					void this.close();
					break;
				}
				if (newline < 0) break;
				frameBytes = 0;
				start = newline + 1;
			}
		});
		const lines = createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
		lines.on("line", line => {
			if (this.#failure || !line.trim()) return;
			try { this.#receive(JSON.parse(line)); }
			catch { this.#fail(new AcpProtocolError("The agent sent an invalid ACP message.")); void this.close(); }
		});
	}

	get alive(): boolean { return !this.#failure && !this.#closing; }

	async open(cwd: string, previousId: string | undefined, authMethod: string): Promise<{ sessionId: string; session: AcpSession; version?: string }> {
		const initialized = await this.#request<AcpInitialize>("initialize", { protocolVersion: ACP_VERSION, clientCapabilities: {}, clientInfo: { name: "kemiri", version: "1" } });
		if (initialized?.protocolVersion !== ACP_VERSION) throw new AcpProtocolError("The agent did not negotiate a supported ACP version.");
		if (previousId && initialized.agentCapabilities?.loadSession !== true) throw new AcpProtocolError("The agent cannot reload its saved ACP session.");
		this.#sessionId = previousId;
		const setup = () => previousId
			? this.#request<AcpSession>("session/load", { sessionId: previousId, cwd, mcpServers: [] })
			: this.#request<AcpSession>("session/new", { cwd, mcpServers: [] });
		let session: AcpSession;
		try { session = await setup(); }
		catch (error) {
			if (!(error instanceof AcpRpcError) || error.code !== -32000 || !initialized.authMethods?.some(method => method.id === authMethod)) throw error;
			await this.#request("authenticate", { methodId: authMethod });
			session = await setup();
		}
		const sessionId = previousId ?? session?.sessionId;
		if (!sessionId || typeof sessionId !== "string") throw new AcpProtocolError("The agent did not return an ACP session ID.");
		this.#sessionId = sessionId;
		return { sessionId, session: { ...session, configOptions: session?.configOptions ?? this.#loadedConfig }, version: initialized.agentInfo?.version };
	}

	/** Model selection is advertised either as a config option or as the older unstable models field. */
	async selectModel(session: AcpSession, modelId: string, publish: (models: { id: string; name: string }[]) => void): Promise<void> {
		const config = session?.configOptions?.find(option => option.category === "model");
		if (config) {
			const models = (config.options ?? []).flatMap(option => option.options ?? (option.value ? [{ value: option.value, name: option.name }] : []));
			publish(models.map(option => ({ id: option.value, name: option.name })));
			if (config.currentValue === modelId) return;
			if (models.some(option => option.value === modelId)) {
				await this.#request("session/set_config_option", { sessionId: this.#sessionId, configId: config.id, value: modelId });
				return;
			}
		} else if (session?.models) {
			const models = session.models.availableModels ?? [];
			publish(models.map(model => ({ id: model.modelId, name: model.name })));
			if (session.models.currentModelId === modelId) return;
			if (models.some(model => model.modelId === modelId)) {
				await this.#request("session/set_model", { sessionId: this.#sessionId, modelId });
				return;
			}
		}
		throw new AcpProtocolError("The requested model is not offered by this agent session. Check the model list and account access.");
	}

	async prompt(text: string, update: (update: AcpUpdate) => void, permission: (kind: string) => void): Promise<{ stopReason?: string; usage?: unknown }> {
		if (!this.alive) throw this.#failure ?? new AcpProcessError("The agent process is closing.");
		this.#update = update;
		this.#permission = permission;
		const prompt = this.#request<{ stopReason?: string; usage?: unknown }>("session/prompt", { sessionId: this.#sessionId, prompt: [{ type: "text", text }] }, 0);
		this.#prompt = prompt;
		try { return await prompt; }
		finally { this.#prompt = this.#update = this.#permission = undefined; }
	}

	close(): Promise<void> {
		// Publish closing before sending cancel so subsequent permission requests are cancelled.
		return this.#closing ??= Promise.resolve().then(async () => {
			if (this.#prompt && !this.#failure) {
				this.#send({ method: "session/cancel", params: { sessionId: this.#sessionId } });
				await this.#within(this.#prompt, CANCEL_TIMEOUT_MS);
			}
			this.#killGroup();
			this.#fail(new AcpProcessError("The agent process was closed."));
			await this.#within(this.#exited, 1000);
		});
	}

	async #within(promise: Promise<unknown>, ms: number): Promise<void> {
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try { await Promise.race([promise.catch(() => undefined), new Promise(resolve => { timeout = setTimeout(resolve, ms); })]); }
		finally { clearTimeout(timeout); }
	}

	#killGroup(): void {
		if (!this.#child.pid) return;
		try { process.kill(-this.#child.pid, "SIGKILL"); }
		catch { this.#child.kill("SIGKILL"); }
	}

	#fail(error: Error): void {
		this.#failure ??= error;
		for (const pending of this.#pending.values()) pending.reject(this.#failure);
		this.#pending.clear();
	}

	#send(frame: object): void { this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`); }

	async #request<T>(method: string, params: object, timeoutMs = SETUP_TIMEOUT_MS): Promise<T> {
		if (this.#failure) throw this.#failure;
		const id = ++this.#sequence;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		try {
			return await new Promise<unknown>((resolve, reject) => {
				this.#pending.set(id, { method, resolve, reject });
				if (timeoutMs) timeout = setTimeout(() => reject(new AcpProtocolError(`The agent timed out during ${method}.`)), timeoutMs);
				this.#send({ id, method, params });
			}) as T;
		} finally { clearTimeout(timeout); this.#pending.delete(id); }
	}

	#receive(frame: { jsonrpc?: string; method?: string; id?: number | string; params?: { sessionId?: string; update?: AcpUpdate; options?: AcpPermission[] }; error?: { code: number; message: string }; result?: unknown }): void {
		if (frame.jsonrpc !== "2.0") throw new Error("Invalid JSON-RPC version");
		if (frame.method === "session/update" && frame.id === undefined) {
			if (!this.#closing && frame.params?.sessionId === this.#sessionId && frame.params?.update) {
				const update = frame.params.update;
				if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) this.#loadedConfig = update.configOptions;
				this.#update?.(update);
			}
		} else if (frame.method && frame.id !== undefined) {
			if (frame.method !== "session/request_permission") {
				this.#send({ id: frame.id, error: { code: -32601, message: "Method not supported by this client" } });
				return;
			}
			const options = frame.params?.options ?? [];
			const option = !this.#closing && this.#prompt && frame.params?.sessionId === this.#sessionId
				? options.find(option => option.kind === "allow_once") ?? options.find(option => option.kind === "allow_always") : undefined;
			this.#send({ id: frame.id, result: { outcome: option?.optionId
				? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } } });
			this.#permission?.(option?.kind ?? "cancelled");
		} else if (typeof frame.id === "number") {
			const pending = this.#pending.get(frame.id);
			if (!pending) return;
			if (frame.error && Number.isInteger(frame.error.code) && typeof frame.error.message === "string") pending.reject(new AcpRpcError(pending.method, frame.error.code, frame.error.message.slice(0, 4096)));
			else if ("result" in frame) pending.resolve(frame.result);
			else throw new Error("Missing JSON-RPC result");
		}
	}
}
