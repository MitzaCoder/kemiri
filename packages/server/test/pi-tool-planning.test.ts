import { expect, test } from "bun:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { createRegistry, defineExtension, Harness, type ToolRegistration } from "@earendil-works/pi-durable";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";

const DEFER_TOOL_DESCRIPTIONS = "KEMIRI_DEFER_TOOL_DESCRIPTION_CHANGES";

function declarations(description: string, parameters = { type: "object" }): ToolRegistration[] {
	const tool = (name: string, description: string, parameters: object): ToolRegistration => ({
		name, description, parameters, execute: async () => ({ output: [] }),
	});
	return [tool("first", "First tool", { type: "object" }), tool("middle", description, parameters), tool("last", "Last tool", { type: "object" })];
}

async function withToolPlanning(deferDescriptions: boolean, run: (session: {
	turn: () => Promise<readonly Message[]>;
	install: (tools: ToolRegistration[]) => void;
	compact: () => Promise<void>;
}) => Promise<void>): Promise<void> {
	const previous = process.env[DEFER_TOOL_DESCRIPTIONS];
	const registry = createRegistry();
	let extension = defineExtension({ name: "tool-planning-test", tools: declarations("Old description") });
	registry.install(extension);
	const requests: (readonly Message[])[] = [];
	const faux = fauxProvider();
	faux.setResponses(Array.from({ length: 8 }, () => (request) => {
		requests.push(request.messages);
		return fauxAssistantMessage("The answer.");
	}));
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(new MemoryStorage(), { registry, models, settings: { compaction: { keepRecentTokens: 1 } } }, context);
	try {
		process.env[DEFER_TOOL_DESCRIPTIONS] = deferDescriptions ? "1" : "0";
		const conversation = await harness.root(context);
		await conversation.configure({ model: { provider: "faux", modelId: "faux-1" }, extensions: [extension] }, context);
		let turns = 0;
		await run({
			turn: async () => {
				turns += 1;
				const before = requests.length;
				const submission = await conversation.submit({ type: "input", content: `Question ${turns}`, requestId: `turn-${turns}` }, context);
				await submission.wait(context);
				expect(requests).toHaveLength(before + 1);
				return requests.at(-1)!;
			},
			install: (tools) => {
				registry.uninstall(extension);
				extension = defineExtension({ name: extension.name, tools });
				registry.install(extension);
			},
			compact: async () => {
				await conversation.compact(undefined, context);
				await conversation.waitForIdle(context);
			},
		});
	} finally {
		if (previous === undefined) delete process.env[DEFER_TOOL_DESCRIPTIONS];
		else process.env[DEFER_TOOL_DESCRIPTIONS] = previous;
		await harness.close(context);
	}
}

function toolUpdates(messages: readonly Message[]) {
	return messages.slice(1).filter((message) => message.role === "system" && (message.toolsAdded || message.toolsRemoved));
}

test("replaces just the changed middle tool and does not resend tools on the next turn", async () => {
	await withToolPlanning(false, async ({ install, turn }) => {
		const before = await turn();
		const original = getCurrentTools(before);
		expect(original.map(tool => tool.name)).toEqual(["first", "middle", "last"]);
		install(declarations("New description"));
		const after = await turn();
		expect(after[0]).toEqual(before[0]);
		expect(toolUpdates(after)).toEqual([expect.objectContaining({
			toolsRemoved: [{ name: "middle" }],
			toolsAdded: [{ name: "middle", description: "New description", parameters: { type: "object" } }],
		})]);
		expect(getCurrentTools(after)).toEqual([original[0], original[2], { ...original[1], description: "New description" }]);

		const next = await turn();
		expect(toolUpdates(next)).toEqual(toolUpdates(after));
	});
});

test("can defer description changes until compaction without deferring schema changes", async () => {
	await withToolPlanning(true, async ({ install, turn, compact }) => {
		const original = getCurrentTools(await turn());
		install(declarations("New description"));
		const deferred = await turn();
		expect(getCurrentTools(deferred)).toEqual(original);
		expect(toolUpdates(deferred)).toEqual([]);

		await compact();
		const compacted = await turn();
		expect(getCurrentTools(compacted).map(tool => [tool.name, tool.description])).toEqual([
			["first", "First tool"], ["middle", "New description"], ["last", "Last tool"],
		]);

		const parameters = { type: "object", properties: { query: { type: "string" } }, required: ["query"] };
		install(declarations("Description for the new schema", parameters));
		expect(toolUpdates(await turn())).toEqual([expect.objectContaining({
			toolsRemoved: [{ name: "middle" }],
			toolsAdded: [{ name: "middle", description: "Description for the new schema", parameters }],
		})]);
	});
});
