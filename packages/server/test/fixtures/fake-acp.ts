#!/usr/bin/env bun
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

const sessionId = "fake-acp-session";
const eventLog = join(process.env.HOME!, "fake-events.jsonl");
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
			reply({ protocolVersion: 1, agentInfo: { version: "1.5.12" }, agentCapabilities: { loadSession: true }, authMethods: [{ id: "gemini-api-key" }] });
			break;
		case "session/new":
		case "session/load":
			record({ event: frame.method, cwd: frame.params.cwd, actualCwd: process.cwd(), sessionId: frame.params.sessionId, mcpServers: frame.params.mcpServers });
			if (existsSync("signed-out")) send({ id: frame.id, error: { code: -32000, message: "Authentication required" } });
			else if (frame.method === "session/load") {
				update({ sessionUpdate: "config_option_update", ...modelOptions });
				reply({});
			} else reply({ sessionId, ...modelOptions });
			break;
		case "authenticate":
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
			if (text.includes("DIE_DURING_TURN")) process.exit(42);
			hold = text.includes("HOLD_TURN");
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
