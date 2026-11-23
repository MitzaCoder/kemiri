import { expect, it } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { HARNESS_FEATURES } from "@kemiri/protocol";
import { BoardDoc, emptyBoardState, type BoardState } from "../src/board.ts";
import { AnswersDoc, shouldFileAnswer } from "../src/answers.ts";
import { OWNER_CHAT_ENTRY } from "../src/wire.ts";
import { TestClient, createSetup, errorOf } from "./support.ts";

const boardCall = (args: Parameters<typeof fauxToolCall>[1]) => fauxAssistantMessage([fauxToolCall("board", args)], { stopReason: "toolUse" });
const savedDetail = "1. Open the sample settings.\n2. Select the violet profile.\n3. Save the label.";

async function fixture(enabled = true) {
	const setup = await createSetup({ features: HARNESS_FEATURES.filter(feature => enabled || feature !== "answers"), boardEditDebounceMs: 60_000 });
	const client = await TestClient.open(setup.server);
	const hello = await client.hello();
	const added = await client.request({ type: "projects.add", path: setup.projectDir });
	if (added.type !== "projects.add") throw errorOf(added);
	const projectId = added.project.id;
	const request = (type: string, fields = {}) => client.request({ type, projectId, ...fields });
	const configured = await request("projects.configure", { coordinatorModel: { provider: "faux", modelId: "faux-1" } });
	if (configured.type !== "projects.configure") throw errorOf(configured);
	const { runtime } = await setup.server.manager.open(projectId);
	const idle = () => runtime.conversation.waitForIdle(BACKGROUND_CONTEXT);
	let sequence = 0;
	const submit = async (content: string, fields = {}) => {
		const response = await request("conversation.submit", { content, requestId: `owner-${++sequence}`, ...fields });
		if (response.type !== "conversation.submit") throw errorOf(response);
		await idle();
	};
	const list = async (fields = {}) => {
		const response = await request("answers.list", fields);
		if (response.type !== "answers.list") throw errorOf(response);
		return response.answers;
	};
	const get = async (answerId: string) => {
		const response = await request("answers.get", { answerId });
		if (response.type !== "answers.get") throw errorOf(response);
		return response.answer;
	};
	return { setup, runtime, client, hello, projectId, submit, request, list, get, idle };
}

it("files the exact owner input, appends older exchanges, and keeps structured reply detail out of report nudges", async () => {
	const { setup, runtime, request, submit, idle, list, get } = await fixture();
	setup.faux.setResponses([boardCall({ action: "answer", title: "Sample settings", answer: savedDetail }), fauxAssistantMessage(savedDetail)]);
	await submit("  Show the sample settings.  ");
	expect(await list()).toEqual([expect.objectContaining({
		id: "A1", question: "  Show the sample settings.  ", answer: savedDetail, filedBy: "coordinator", title: "Sample settings",
		coordinatorId: "main", coordinatorTitle: "General", pinned: false, read: false, exchanges: [], entryId: expect.any(Number),
	})]);
	const board = await runtime.board.state();
	expect(board.tasks).toEqual([]);
	expect(board.chatDetailCounts).toBeDefined();
	expect(Object.values(board.chatDetailCounts!)).toEqual([{ flagged: 0, clean: 1 }]);
	expect(board.reportOutbox?.some(batch => batch.chatDetail)).not.toBe(true);

	setup.faux.setResponses([boardCall({ action: "answer", title: "Sample settings", answer: "Violet remains the default.", answerId: "A1" }), fauxAssistantMessage("Violet remains the default.")]);
	expect(await request("answers.ask", { answerId: "A1", requestId: "follow", question: "Which colour remains the default?" })).toMatchObject({ type: "answers.ask", coordinatorId: "main" });
	await idle();
	expect(await get("A1")).toMatchObject({ question: "Which colour remains the default?", exchanges: [{ question: "  Show the sample settings.  ", answer: savedDetail }] });

	setup.faux.setResponses([boardCall({ action: "answer", title: "Sample settings", answer: "Use the new amber profile." }), fauxAssistantMessage("Use the new amber profile.")]);
	expect(await request("answers.ask", { answerId: "A1", requestId: "again" })).toMatchObject({ type: "answers.ask", coordinatorId: "main" });
	await idle();
	expect(await request("answers.ask", { answerId: "A1", requestId: "again" })).toMatchObject({ type: "answers.ask" });
	await idle();
	expect(await get("A1")).toMatchObject({ question: "  Show the sample settings.  ", answer: "Use the new amber profile.", exchanges: [
		expect.objectContaining({ question: "Which colour remains the default?" }), expect.objectContaining({ answer: savedDetail }),
	] });
	const entries = await runtime.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
	const ownerEntries = entries.items.filter(entry => entry.kind === OWNER_CHAT_ENTRY);
	expect(ownerEntries).toHaveLength(3);
	expect(JSON.stringify(ownerEntries[0]?.model)).toContain("File the new reply with board answer and answerId A1.");
	expect(entries.items.flatMap(entry => entry.model ?? []).filter(message => message.role === "toolResult").map(message => JSON.stringify(message.content))).toEqual(Array(3).fill(expect.stringContaining("Filed A1.")));
});

it("files only qualifying owner-started final replies, never a turn that added a task", async () => {
	const { setup, runtime, submit, idle, list } = await fixture();
	setup.faux.setResponses([fauxAssistantMessage("The panel remembers the violet profile.")]);
	await submit("What does the panel remember\nA second line.");
	expect(await list()).toMatchObject([{ title: "What does the panel remember", filedBy: "harness" }]);

	setup.faux.setResponses([fauxAssistantMessage("Noted.")]);
	await submit("Thanks for checking.");
	setup.faux.setResponses([fauxAssistantMessage("The panel remembers the violet profile.")]);
	const harnessTurn = await runtime.conversation.submit({ type: "input", content: "Which profile is selected?" }, BACKGROUND_CONTEXT);
	await harnessTurn.wait(BACKGROUND_CONTEXT);
	await idle();

	setup.faux.setResponses([boardCall({ action: "add_task", title: "Compare profiles" }), fauxAssistantMessage("I will compare the profiles.")]);
	await submit("Could the profile comparison be built?");
	expect((await runtime.board.state()).tasks).toMatchObject([{ title: "Compare profiles" }]);
	expect(await list()).toHaveLength(1);
	expect(shouldFileAnswer("Please take a snapshot.", "x".repeat(600))).toBe(true);
	expect(shouldFileAnswer(`What ${"x".repeat(400)}?`, "Noted.")).toBe(false);
});

it("searches, pins, marks read, deletes, and makes requests with links in both directions", async () => {
	const { setup, runtime, client, projectId, submit, request, list, get, idle } = await fixture();
	const legacy = await TestClient.open(setup.server);
	await legacy.hello();
	try {
		expect(await list({ subscribe: true })).toEqual([]);
		setup.faux.setResponses([fauxAssistantMessage("Use blue envelopes."), fauxAssistantMessage("Use a small crate.")]);
		await submit("Which envelopes should we use?");
		await submit("What should we ship the samples in?");
		await client.waitFor(message => message.type === "answers.changed" && message.answerId === "A2");
		expect(await list()).toMatchObject([{ id: "A2" }, { id: "A1" }]);
		expect(await list({ query: "blue envelopes" })).toMatchObject([{ id: "A1" }]);
		expect(await request("answers.update", { answerId: "A1", pinned: true, read: true })).toMatchObject({ type: "answers.update", answer: { pinned: true, read: true } });
		expect(await list()).toMatchObject([{ id: "A1" }, { id: "A2" }]);
		const changes = () => client.messages.filter(message => message.type === "answers.changed").length;
		const before = changes();
		await request("answers.update", { answerId: "A1", pinned: true, read: true });
		expect(changes()).toBe(before);

		setup.faux.setResponses([boardCall({ action: "add_task", title: "Send envelopes", description: "Ship a sample pack.", fromAnswer: "A1" }), fauxAssistantMessage("The request is ready.")]);
		await submit("Turn the envelopes answer into a request.");
		expect(await get("A1")).toMatchObject({ taskId: "T1", related: ["T1"] });
		const ownerTask = { answerId: "A2", title: "Pack the samples", description: "Pack three samples." };
		expect(await request("answers.turnIntoTask", ownerTask)).toMatchObject({ type: "answers.turnIntoTask", taskId: "T2" });
		expect(await request("answers.turnIntoTask", ownerTask)).toMatchObject({ type: "answers.turnIntoTask", taskId: "T2" });
		expect(await get("A2")).toMatchObject({ taskId: "T2", related: ["T2"] });
		setup.faux.setResponses([fauxAssistantMessage("Noted.")]);
		await runtime.board.flushEdits();
		await idle();
		const entries = await runtime.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
		expect(entries.items.some(entry => entry.kind === "pi.user" && JSON.stringify(entry.model).includes('[board] The user changed the board:') && JSON.stringify(entry.model).includes('Pack the samples'))).toBe(true);
		const tasks = (await runtime.board.get()).tasks;
		expect(tasks).toMatchObject([
			{ id: "T1", fromAnswer: "A1", parent: null, description: "Ship a sample pack.\n\n### Question\n\nWhich envelopes should we use?\n\n### Answer\n\nUse blue envelopes." },
			{ id: "T2", fromAnswer: "A2", parent: null, createdBy: "user", description: "Pack three samples.\n\n### Question\n\nWhat should we ship the samples in?\n\n### Answer\n\nUse a small crate." },
		]);
		type OldBoardState = Omit<BoardState, "tasks"> & { tasks: Omit<BoardState["tasks"][number], "fromAnswer">[] };
		const oldBoard = defineDoc<OldBoardState>({
			kind: BoardDoc.definition.kind, version: 1, scope: "conversation", history: "latest", fork: "initial",
			checkpointWhen: () => false, initial: emptyBoardState,
		});
		const stored = await runtime.harness.snapshot(oldBoard, runtime.conversation.id, BACKGROUND_CONTEXT);
		expect(stored?.tasks.map(task => task.title)).toEqual(["Send envelopes", "Pack the samples"]);
		const oldTask = tasks[0]!;
		const { description, acceptance, status, blockedBy, blockedReason, writeScopes } = oldTask;
		const legacySave = { type: "board.task.save", projectId, taskId: oldTask.id, expectedRevision: oldTask.revision,
			task: { description, acceptance, status, blockedBy, blockedReason, writeScopes, title: "Send blue envelopes" } };
		expect(await legacy.request(legacySave)).toMatchObject({ type: "board.task.save", task: { fromAnswer: "A1" } });

		expect(await request("answers.delete", { answerId: "A1" })).toMatchObject({ type: "answers.delete" });
		await client.waitFor(message => message.type === "answers.changed" && message.answerId === "A1" && message.deleted === true);
		expect(await request("answers.get", { answerId: "A1" })).toMatchObject({ type: "error", error: { code: "not_found" } });
		expect(legacy.messages.some(message => message.type === "answers.changed")).toBe(false);
		expect((await runtime.board.get()).tasks[0]).toMatchObject({ fromAnswer: "A1" });
	} finally {
		legacy.close();
	}
});

it("leaves prompts, requests, and turn storage alone with Answers disabled", async () => {
	const { setup, hello, runtime, request, submit } = await fixture(false);
	expect(hello).not.toMatchObject({ features: expect.arrayContaining(["answers"]) });
	expect(await request("answers.list")).toMatchObject({ type: "error", error: { code: "unknown_request" } });
	const context = await request("conversation.context");
	expect(context).toMatchObject({ type: "conversation.context", context: { systemPrompt: expect.stringContaining("Every subject the user raises is a task") } });
	setup.faux.setResponses([fauxAssistantMessage("The sample is ready.")]);
	await submit("Is the sample ready?");
	expect(runtime.board.answers).toBeUndefined();
	expect(await runtime.harness.snapshot(AnswersDoc, runtime.conversation.id, BACKGROUND_CONTEXT)).toBeUndefined();
});
