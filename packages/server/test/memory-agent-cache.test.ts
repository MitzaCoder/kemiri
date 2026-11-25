import { expect, test } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { memoryAgentTools, runMemoryAgent } from "../src/memory-agent.ts";

test("memory agent seeds and requests the short prompt cache across tool rounds", async () => {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("memory_read", { fileId: "testing" })], { stopReason: "toolUse" }),
		fauxAssistantMessage([fauxToolCall("memory_read", { fileId: "build" })], { stopReason: "toolUse" }),
		fauxAssistantMessage("Done."),
	]);

	const requests: { retention: unknown; sessionId: unknown; lastRole: string | undefined }[] = [];
	const completeSimple = models.completeSimple.bind(models);
	models.completeSimple = (model, context, options) => {
		requests.push({ retention: options?.cacheRetention, sessionId: options?.sessionId, lastRole: context.messages.at(-1)?.role });
		return completeSimple(model, context, options);
	};

	const sessionId = "synthetic-memory-agent-session";
	expect(await runMemoryAgent({
		models,
		model: { provider: "faux", modelId: "faux-1" },
		sessionId,
		systemPrompt: "Review the saved project notes.",
		prompt: "Check the testing and build notes.",
		tools: memoryAgentTools({ scopes: ["project"], archives: false }),
		execute: async (_name, args) => ({ text: `Notes for ${args.fileId}.` }),
	})).toBe("Done.");

	expect(requests).toEqual(["user", "toolResult", "toolResult"].map(lastRole => ({
		retention: "short", sessionId, lastRole,
	})));
});
