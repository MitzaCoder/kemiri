#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

const sessionId = "fake-acp-session";
const profile = process.env.HOME!;
const eventLog = join(profile, "fake-events.jsonl");
const authEvents = join(profile, "..", "fake-auth-events.jsonl");
const settings = JSON.parse(readFileSync(join(profile, "antigravity-acp", "settings.json"), "utf8"));
const nativeAuth = join(profile, "fake-native-auth");
const audit = (event: object) => appendFileSync(authEvents, JSON.stringify(event) + "\n");

if (process.argv.includes("--login")) {
	const expected = `synthetic-${crypto.randomUUID()}`;
	const google = new URL("/o/oauth2/auth", `https://${["accounts", "google", "com"].join(".")}`);
	google.searchParams.set("response_type", "code");
	google.searchParams.set("redirect_uri", `https://${["antigravity", "google"].join(".")}/oauth-callback`);
	google.searchParams.set("state", expected.slice(10));
	audit({ event: "login-started", pid: process.pid, mode: settings.auth.type, hasKey: Boolean(process.env.GEMINI_API_KEY) });
	process.stdout.write(`Open this page:\n  ${google}\n\nPaste the authorization code: `);
	for await (const answer of createInterface({ input: process.stdin })) {
		if (answer !== expected) process.exit(4);
		const token = `fake-native-token-${crypto.randomUUID()}`;
		writeFileSync(nativeAuth, token, { mode: 0o600 });
		process.stdout.write(`${token}\n`);
		process.stderr.write(`${answer}\n`);
		audit({ event: "login-finished" });
		process.exit(0);
	}
	process.exit(3);
}
const record = (event: object) => appendFileSync(eventLog, JSON.stringify(event) + "\n");
const send = (frame: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
const update = (update: object) => send({ method: "session/update", params: { sessionId, update } });
const modelOptions = { configOptions: [{ category: "model", id: "model", currentValue: "other", options: [{ value: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }, { value: "other", name: "Another model" }] }] };
let promptId: number;
let hold = false;
for await (const line of createInterface({ input: process.stdin })) {
	const frame = JSON.parse(line);
	const reply = (result: object) => send({ id: frame.id, result });
	switch (frame.method) {
		case "initialize":
			record({ event: "initialize", version: frame.params.protocolVersion, sanitized: !Object.keys(process.env).some(key => /^(AIKI_|KEMIRI_|ANTHROPIC_API_KEY|GOOGLE_API_KEY)/.test(key)), hasKey: Boolean(process.env.GEMINI_API_KEY), args: process.argv.slice(2) });
			reply({ protocolVersion: 1, agentInfo: { version: "1.5.12" }, agentCapabilities: { loadSession: true, auth: { logout: true } }, authMethods: [{ id: "gemini-api-key" }, { id: "oauth-personal" }] });
			break;
		case "logout":
			audit({ event: "logout", method: frame.params.methodId, hadNativeAuth: existsSync(nativeAuth) });
			if (existsSync(nativeAuth)) unlinkSync(nativeAuth);
			reply({});
			break;
		case "session/new":
		case "session/load":
			record({ event: frame.method, cwd: frame.params.cwd, actualCwd: process.cwd(), sessionId: frame.params.sessionId, mcpServers: frame.params.mcpServers });
			const isKeyMode = settings.auth.type === "gemini-api-key";
			const usesSelectedAuth = isKeyMode ? Boolean(process.env.GEMINI_API_KEY) : existsSync(nativeAuth) && !process.env.GEMINI_API_KEY;
			audit({ event: "open", mode: settings.auth.type, usesSelectedAuth });
			if (existsSync("signed-out") || !usesSelectedAuth) send({ id: frame.id, error: { code: -32000, message: "Authentication required" } });
			else if (frame.method === "session/load") {
				update({ sessionUpdate: "config_option_update", ...modelOptions });
				reply({});
			} else reply({ sessionId, ...modelOptions });
			break;
		case "authenticate":
			audit({ event: "authenticate", method: frame.params.methodId });
			send({ id: frame.id, error: { code: -32000, message: "Authentication required" } });
			break;
		case "session/set_config_option":
			record({ event: "model", model: frame.params.value });
			reply(modelOptions);
			break;
		case "session/prompt": {
			promptId = frame.id;
			const text: string = frame.params.prompt[0].text;
			record({ event: "prompt", text });
			const input = text.split("--- User input ---\n").at(-1)!;
			if (input.includes("DIE_DURING_TURN")) process.exit(42);
			if (input.includes("FAIL_REFRESH")) {
				send({ id: frame.id, error: { code: -32603, message: `Failed to refresh native credential: ${readFileSync(nativeAuth, "utf8")}` } });
				break;
			}
			hold = input.includes("HOLD_TURN");
			update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "Inspecting workspace.\n" } });
			update({ sessionUpdate: "plan", entries: [{ content: "Read fixture", status: "in_progress" }] });
			update({ sessionUpdate: "tool_call", toolCallId: "fake-read", kind: "read", title: "Read fixture", status: "in_progress" });
			send({ id: "permission", method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "fake-read" }, options: [{ optionId: "always", kind: "allow_always" }, { optionId: "once", kind: "allow_once" }] } });
			break;
		}
		case "session/cancel":
			record({ event: "cancel" });
			send({ id: "late-permission", method: "session/request_permission", params: { sessionId, options: [{ optionId: "once", kind: "allow_once" }] } });
			break;
		default:
			if (frame.id === "permission" || frame.id === "late-permission") {
				record({ event: frame.id, selection: frame.result.outcome });
				if (frame.id === "late-permission") send({ id: promptId!, result: { stopReason: "cancelled" } });
				else if (!hold) {
					update({ sessionUpdate: "tool_call_update", toolCallId: "fake-read", status: "completed" });
					update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "## Report\n" } });
					update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Outcome: done from ACP." } });
					send({ id: promptId!, result: { stopReason: "end_turn", usage: { inputTokens: 11, outputTokens: 7 } } });
				}
			}
	}
}
