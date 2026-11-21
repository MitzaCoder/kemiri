import type { TranscriptContext } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createSetup, TestClient } from "../test/support.ts";

const origin = process.env.MEMORY_NOTES_WEB_ORIGIN ?? "http://127.0.0.1:5296";
const output = process.env.MEMORY_NOTES_DEMO_OUTPUT ?? "/tmp/memory-notes-demo.json";
const setup = await createSetup({ allowedOrigins: [origin], terminals: false, log: console.error });
const client = await TestClient.open(setup.server);
try {
	await client.hello();
	const added = await client.request({ type: "projects.add", path: setup.projectDir });
	if (added.type !== "projects.add") throw new Error(JSON.stringify(added));
	const projectId = added.project.id;
	await client.request({ type: "projects.configure", projectId, name: "Bakery shop", coordinatorModel: { provider: "faux", modelId: "faux-1" } });
	const { runtime } = await setup.server.manager.open(projectId);
	const kitchen = await runtime.threads.create({ title: "Kitchen API", area: "Order payloads and kitchen tickets." }, "demo-kitchen");
	const reply = (request: TranscriptContext) => {
		const last = request.messages.findLast(message => message.role !== "system");
		const text = last?.role === "user" && (typeof last.content === "string" ? last.content : last.content.map(block => block.type === "text" ? block.text : "").join(""));
		if (text === "Save the gift note field.") return fauxAssistantMessage([fauxToolCall("memory_write", {
			fileId: "orders-api", title: "Gift note field", heading: "Kitchen tickets", create: true,
			text: "Optional gift notes appear on the kitchen ticket, never on the public receipt.",
		})], { stopReason: "toolUse" });
		return fauxAssistantMessage(last?.role === "toolResult" ? "Saved the gift note rule in shared memory." : "I’ll check the shared order notes before changing the bakery storefront.");
	};
	setup.faux.setResponses(Array.from({ length: 40 }, () => reply));
	const turn = async (content: string, threadId?: string) => {
		const submitted = await client.request({ type: "conversation.submit", projectId, content, requestId: `demo:${content}`, ...(threadId ? { threadId } : {}) });
		if (submitted.type !== "conversation.submit") throw new Error(JSON.stringify(submitted));
		const conversation = threadId ? await runtime.threads.conversation(threadId) : runtime.conversation;
		await conversation.waitForIdle(BACKGROUND_CONTEXT);
	};
	await turn("What should we check before changing the storefront?");
	if (process.env.MEMORY_NOTES_DEMO_SEED === "1") {
		await turn("Save the gift note field.", kitchen.id);
		await turn("Check the bakery order flow.");
	}
	await Bun.write(output, JSON.stringify({ projectId, threadId: kitchen.id, pid: process.pid, root: setup.root,
		backends: [{ id: "bakery-demo", name: "Bakery demo", url: setup.server.url }] }));
	console.log(`Bakery memory demo ready: ${output}`);
	await new Promise<void>(resolve => process.once("SIGTERM", () => resolve()));
} finally {
	client.close();
	await setup.cleanup();
}
