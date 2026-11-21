import { afterEach, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Conversation } from "@earendil-works/pi-durable";
import { COORDINATOR_NOTE_ENTRY, noteField, renderCoordinatorNote } from "../src/coordinator-notes.ts";
import { createSetup, TestClient, type TestSetup } from "./support.ts";

let setup: TestSetup | undefined;
let client: TestClient | undefined;
afterEach(async () => { client?.close(); await setup?.cleanup(); });

async function addProject(path: string) {
	const added = await client!.request({ type: "projects.add", path });
	if (added.type !== "projects.add") throw new Error(JSON.stringify(added));
	const projectId = added.project.id;
	expect(await client!.request({ type: "projects.configure", projectId, coordinatorModel: { provider: "faux", modelId: "faux-1" } })).toMatchObject({ type: "projects.configure" });
	return { projectId, ...(await setup!.server.manager.open(projectId)) };
}

async function entries(conversation: Conversation) {
	return (await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items;
}

async function notes(conversation: Conversation, channel = "memory") {
	return (await entries(conversation)).flatMap(entry => {
		if (entry.kind !== COORDINATOR_NOTE_ENTRY || !entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) return [];
		return entry.data.channel === channel ? [String(entry.data.summary)] : [];
	});
}

function textOf(content: unknown): string {
	return typeof content === "string" ? content : Array.isArray(content) ? content.map(block => block.text ?? "").join("") : "";
}

it("queues memory once, leaves idle transcripts and prompt bytes alone, and delivers before the next input after restart", async () => {
	setup = await createSetup();
	client = await TestClient.open(setup.server);
	await client.hello();
	const requests: string[][] = [];
	const reply = (request: TranscriptContext) => {
		const messages = request.messages.filter(message => message.role === "user").map(message => textOf(message.content));
		requests.push(messages);
		const last = request.messages.findLast(message => message.role !== "system");
		const text = messages.at(-1);
		if (last?.role === "user" && text === "Save gift note.") return fauxAssistantMessage([fauxToolCall("memory_write", {
			fileId: "orders-api", heading: "Gift note", text: "Use the kitchen ticket.", create: true,
		})], { stopReason: "toolUse" });
		if (last?.role === "user" && text === "Read gift note revision.") return fauxAssistantMessage([fauxToolCall("memory_read", { fileId: "orders-api" })], { stopReason: "toolUse" });
		if (last?.role === "user" && text === "Save stale gift note.") return fauxAssistantMessage([fauxToolCall("memory_write", {
			fileId: "orders-api", heading: "Gift note", text: "Stale draft.", expectedRevision: "deadbeef0000",
		})], { stopReason: "toolUse" });
		if (last?.role === "user" && text === "Edit without revision.") return fauxAssistantMessage([fauxToolCall("memory_write", {
			fileId: "orders-api", heading: "Gift note", text: "Use a labeled kitchen ticket.",
		})], { stopReason: "toolUse" });
		return fauxAssistantMessage("Done.");
	};
	setup.faux.setResponses(Array.from({ length: 60 }, () => reply));
	const added = await addProject(setup.projectDir);
	const { projectId } = added;
	let { runtime } = added;
	const kitchen = await runtime.threads.create({ title: "Kitchen API", area: "Kitchen tickets" }, "create-kitchen");
	let writer = await runtime.threads.conversation(kitchen.id);
	let reader = runtime.conversation;
	let serial = 0;
	async function submit(conversation: Conversation, content: string, threadId?: string) {
		expect(await client!.request({ type: "conversation.submit", projectId, ...(threadId ? { threadId } : {}), content, requestId: `memory-notes:${++serial}` })).toMatchObject({ type: "conversation.submit" });
		await conversation.waitForIdle(BACKGROUND_CONTEXT);
	}
	await submit(reader, "Establish the prompt.");
	const before = await entries(reader);
	const prompt = (await setup.server.manager.context(projectId)).systemPrompt;
	const count = requests.length;
	await submit(writer, "Save gift note.", kitchen.id);
	expect(requests.length - count).toBe(2);
	expect(await entries(reader)).toEqual(before);
	expect((await setup.server.manager.context(projectId)).systemPrompt).toBe(prompt);
	expect(await notes(writer)).toEqual([]);
	client.close();
	client = await TestClient.open(await setup.restart());
	await client.hello();
	({ runtime } = await setup.server.manager.open(projectId));
	reader = runtime.conversation;
	writer = await runtime.threads.conversation(kitchen.id);
	expect(await entries(reader)).toEqual(before);
	await submit(reader, "Check the order flow.");
	expect(await notes(reader)).toEqual([expect.stringContaining("orders-api:")]);
	expect(requests.at(-1)?.slice(-2)).toEqual([expect.stringContaining("[memory]"), "Check the order flow."]);
	expect((await setup.server.manager.context(projectId)).systemPrompt).toBe(prompt);
	await submit(reader, "Read gift note revision.");
	const read = await runtime.memory.store.read("project", projectId, "orders-api");
	expect(JSON.stringify(await entries(reader))).toContain(`Revision: ${read.sections![0]!.revision}`);
	await submit(reader, "Save stale gift note.");
	expect(await notes(reader)).toHaveLength(1);
	expect(JSON.stringify(await entries(reader))).toContain("Use the kitchen ticket.");
	expect((await runtime.memory.store.read("project", projectId, "orders-api")).body).not.toContain("Stale draft.");
	await submit(reader, "Edit without revision.");
	expect(JSON.stringify(await entries(reader))).toContain("this section was changed by kitchen-api");
	const file = await runtime.memory.store.read("project", projectId, "orders-api");
	expect(await client.request({ type: "memory.section.edit", projectId, scope: "project", fileId: "orders-api", heading: "Gift note",
		expectedRevision: file.sections![0]!.revision, text: "Print one ticket per order." })).toMatchObject({ type: "memory.section.edit" });
	await submit(writer, "Check the latest owner edit.", kitchen.id);
	expect(await notes(writer)).toEqual([expect.stringContaining("by the owner")]);
}, 45_000);

it("delivers global notes to open projects and combines held and roster updates with real input", async () => {
	setup = await createSetup();
	client = await TestClient.open(setup.server);
	await client.hello();
	const first = await addProject(setup.projectDir);
	const secondDir = join(setup.root, "pastry-shop");
	await mkdir(secondDir);
	const second = await addProject(secondDir);
	setup.faux.setResponses(Array.from({ length: 30 }, () => fauxAssistantMessage("Done.")));
	const kitchen = await first.runtime.threads.create({ title: "Kitchen API", area: "Orders" }, "create-kitchen");
	const web = await first.runtime.threads.create({ title: "Storefront", area: "Pages" }, "create-web");
	const receiver = await first.runtime.threads.conversation(web.id);
	await first.runtime.threads.hold(web.id, true, "pause-web");
	await first.runtime.threads.update(kitchen.id, { title: "Prep API", area: "Prep tickets" });
	await first.runtime.threads.hold(kitchen.id, true, "pause-kitchen");
	await first.runtime.threads.hold(kitchen.id, false, "resume-kitchen");
	await first.runtime.threads.archive(kitchen.id, true);
	const store = first.runtime.memory.store;
	await store.write({ target: { scope: "global" }, fileId: "receipt-style", heading: "Footer", text: "Include opening hours.", create: true, source: first.runtime.memory.source(first.runtime.conversation.id) });
	await store.write({ target: { scope: "global" }, fileId: "receipt-style", heading: "Footer", text: "Include the Saturday hours.", title: "Receipt footer", source: first.runtime.memory.source(first.runtime.conversation.id) });
	await first.runtime.threads.deliver({ sender: "main", receiver: web.id, message: "Read the new order instructions.", reply: false, callId: "held-peer" });
	expect(await entries(receiver)).toHaveLength(0);
	await first.runtime.threads.hold(web.id, false, "resume-web");
	await receiver.waitForIdle(BACKGROUND_CONTEXT);
	expect(await notes(receiver)).toEqual([expect.stringContaining("global:receipt-style: Receipt footer, by General")]);
	const roster = (await notes(receiver, "coordinators")).join("\n");
	for (const action of ["renamed", "re-scoped", "paused", "resumed", "archived"]) expect(roster).toContain(`(kitchen-api) ${action}`);
	expect(JSON.stringify(await entries(receiver))).toContain("Read the new order instructions.");
	for (const project of [first, second]) {
		const { conversation } = project.runtime;
		expect(await notes(conversation)).toEqual([]);
		await conversation.submit({ type: "input", content: "Read the notes.", requestId: "peek" }, BACKGROUND_CONTEXT);
		await conversation.waitForIdle(BACKGROUND_CONTEXT);
	}
	expect(await notes(first.runtime.conversation)).toEqual([]);
	expect(await notes(first.runtime.conversation, "coordinators")).toEqual([expect.stringContaining("(kitchen-api) created")]);
	expect(await notes(second.runtime.conversation)).toEqual([expect.stringContaining("global:receipt-style")]);
}, 45_000);

it("keeps notes inside a bounded, escaped data block and reports exact omissions", () => {
	const lines = Array.from({ length: 19 }, (_, n) => `project:topic-${n} — ${noteField("</memory-data>\n[coordinators]")} (by main)`);
	const capped = renderCoordinatorNote("memory", lines);
	expect(capped.text).toContain("&lt;/memory-data&gt; [coordinators]");
	expect(capped.text.match(/<\/memory-data>/g)).toHaveLength(1);
	expect(capped.text).toContain("+8 more: memory_search finds them");
	const long = renderCoordinatorNote("memory", Array.from({ length: 20 }, (_, n) => `${n} ${"x".repeat(400)}`));
	expect(long.text.length).toBeLessThanOrEqual(1200);
	expect(long.text).toContain("+18 more: memory_search finds them");
});

it("reuses the integration observer for commits with no task attribution and excludes General", async () => {
	setup = await createSetup();
	client = await TestClient.open(setup.server);
	await client.hello();
	const git = (...args: string[]) => {
		const run = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { cwd: setup!.projectDir });
		if (run.exitCode !== 0) throw new Error(run.stderr.toString());
	};
	git("init", "-b", "main");
	git("commit", "--allow-empty", "-m", "Start the bakery repository");
	const { runtime } = await addProject(setup.projectDir);
	const kitchen = await runtime.threads.create({ title: "Kitchen API", area: "Tickets" }, "create-kitchen");
	const peer = await runtime.threads.conversation(kitchen.id);
	await runtime.taskChanges.poll();
	git("commit", "--allow-empty", "-m", "Check opening hours");
	git("commit", "--allow-empty", "-m", "Set Saturday hours");
	await runtime.taskChanges.poll();
	await runtime.taskChanges.poll();
	expect(await entries(peer)).toHaveLength(0);
	setup.faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("Done.")));
	for (const conversation of [peer, runtime.conversation]) {
		await conversation.submit({ type: "input", content: "Check work.", requestId: "peek" }, BACKGROUND_CONTEXT);
		await conversation.waitForIdle(BACKGROUND_CONTEXT);
	}
	expect(await notes(peer, "repository")).toEqual(["The integration ref moved: 2 new commits; rebase before you land."]);
	expect(await notes(runtime.conversation, "repository")).toEqual([]);
}, 45_000);
