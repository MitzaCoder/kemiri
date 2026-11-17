/** Exercise pi-ai's real provider dispatch and HTTP header adapter, not a mocked completeSimple. */
import { expect, it } from "bun:test";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import type { ModelRef } from "@kemiri/protocol";
import { createSetup, TestClient, errorOf } from "./support.ts";

async function until(check: () => Promise<boolean>) {
	for (let i = 0; i < 600; i++) {
		if (await check()) return;
		await Bun.sleep(20);
	}
	throw new Error("timed out waiting for internal model run");
}

it("real provider sends x-opencode-session for nightly maintenance, extraction and compaction", async () => {
	const sessions: Record<string, string[]> = {};
	let rejected = 0;
	const http = Bun.serve({
		hostname: "127.0.0.1", port: 0,
		async fetch(request) {
			const session = request.headers.get("x-opencode-session");
			if (!session) {
				rejected++;
				return Response.json({ type: "MissingSessionID", message: "Request is missing x-opencode-session" }, { status: 400 });
			}
			const body = await request.json() as { model: string; messages: { role: string; content: unknown }[] };
			const text = JSON.stringify(body.messages);
			const kind = text.includes("You maintain a coding assistant") ? "maintenance"
				: text.includes("You keep the durable memory") ? "extraction"
				: text.includes("conversation to summarize") ? "summary" : "conversation";
			(sessions[kind] ??= []).push(session);
			const editing = kind === "maintenance" || kind === "extraction";
			const toolDone = body.messages.some(message => message.role === "tool");
			const delta = editing && !toolDone ? {
				tool_calls: [{ index: 0, id: "synthetic-call", type: "function", function: {
					name: "memory_write", arguments: JSON.stringify({ fileId: "testing", heading: kind === "maintenance" ? "Suite" : "Watch", text: kind === "maintenance" ? "Use bun test from the root." : "Use bun test --watch while iterating.", scope: "project" }),
				} }],
			} : { content: kind === "summary" ? "## Goal\nRemember the test commands."
				: editing ? "Saved." : text.includes("Say something long") ? "Still going. ".repeat(4_000) : "Noted." };
			const chunk = (delta: unknown, finish_reason: string | null) => `data: ${JSON.stringify({ id: "synthetic-answer", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
			return new Response(chunk({ role: "assistant", ...delta }, null) + chunk({}, editing && !toolDone ? "tool_calls" : "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
		},
	});
	const provider = opencodeGoProvider();
	const base = provider.getModels().find(model => model.api === "openai-completions")!;
	const model = { ...base, id: "synthetic-internal", baseUrl: `http://127.0.0.1:${http.port}/v1`, reasoning: false, contextWindow: 128_000 };
	const ref: ModelRef = { provider: provider.id, modelId: model.id };
	let now = Date.parse("2026-01-01T02:00:00Z");
	const test = await createSetup({ now: () => now, timezone: "UTC", setTimer: () => () => undefined,
		configureModels: models => models.setProvider({ ...provider, getModels: () => [model], getAllModels: () => [model] }),
	});
	let client: TestClient | undefined;
	try {
		await test.credentials.setApiKey(provider.id, "synthetic-key");
		// Negative control: without a session option the real adapter leaves the header absent and gets HTTP 400.
		const negative = await test.models.completeSimple(model, { messages: [{ role: "user", content: "control", timestamp: 1 }] }, { maxRetries: 0 });
		expect(negative.stopReason).toBe("error");
		expect(negative.errorMessage).toContain("MissingSessionID");
		expect(rejected).toBe(1);
		client = await TestClient.open(test.server); await client.hello();
		const added = await client.request({ type: "projects.add", path: test.projectDir });
		if (added.type !== "projects.add") throw errorOf(added);
		const projectId = added.project.id;
		await test.server.manager.memory.write({ target: { scope: "project", projectId }, fileId: "testing", heading: "Suite", text: "Use bun test." });
		const saved = await client.request({ type: "memory.settings.set", maintenance: { model: ref, thinkingLevel: null, time: "03:00", afterWrites: 100 } });
		if (saved.type !== "memory.settings.set") throw errorOf(saved);
		await test.server.maintenanceClock.start();
		now += 90 * 60_000; await test.server.maintenanceClock.start();
		const status = await client.request({ type: "memory.status", scope: "project", projectId });
		if (status.type !== "memory.status") throw errorOf(status);
		expect(status.status.lastMaintenance?.outcome).toBe("ok");
		expect(status.status.lastMaintenance?.commit).toBeTruthy();
		expect(status.status.recentRuns?.[0]?.trigger).toBe("nightly");

		await client.request({ type: "projects.configure", projectId, coordinatorModel: ref, coordinatorThinkingLevel: "off", workerModels: [ref] });
		const page = async () => {
			const response = await client!.request({ type: "conversation.page", projectId, order: "ascending", limit: 500 });
			if (response.type !== "conversation.page") throw errorOf(response);
			return response.entries;
		};
		await client.request({ type: "conversation.submit", projectId, requestId: "facts", content: "Tests use bun. Save durable facts." });
		await until(async () => (await page()).filter(entry => entry.kind === "pi.assistant").length >= 1);
		await client.request({ type: "conversation.submit", projectId, requestId: "long", content: "Say something long" });
		await until(async () => (await page()).filter(entry => entry.kind === "pi.assistant").length >= 2);
		await client.request({ type: "conversation.compact", projectId });
		await until(async () => (await test.server.manager.memory.history("project", projectId, 20)).some(change => change.kind === "extraction"));
		expect((await page()).some(entry => entry.kind === "pi.compaction")).toBe(true);
		for (const kind of ["maintenance", "extraction", "summary", "conversation"]) {
			expect(sessions[kind]?.length).toBeGreaterThan(0);
			expect(new Set(sessions[kind]).size, `${kind} must keep one session across rounds`).toBe(1);
		}
		expect(sessions.summary?.[0]).toBe(sessions.conversation?.[0]);
		expect(sessions.extraction?.[0]).not.toBe(sessions.maintenance?.[0]);
		expect(rejected).toBe(1);
	} finally {
		client?.close(); await test.cleanup(); http.stop(true);
	}
}, 30_000);
