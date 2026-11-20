/**
 * Tasks as the place to read: each task's report, its snapshots, the coordinator's and the worker's tools that write
 * them, and messages that name a task.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { JsonObject } from "@earendil-works/pi-durable";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { LEGACY_HARNESS_FEATURES, type BoardTask, type BoardReportCheck, type BoardQuestionChoice, type BoardTaskSnapshot, type ModelRef } from "@kemiri/protocol";
import {
	type BoardState,
	HARNESS_WRITER,
	type TaskHistoryState,
	addSnapshot,
	askQuestion,
	boardView,
	claimTaskForThread,
	coordinatorWriter,
	emptyBoardState,
	normalizeBoard,
	saveTask,
	summaryBoardView,
	taskForSchedule,
	withTaskReference,
	writeReport,
} from "../src/board.ts";
import { resultsParagraphWarning, wrappedReportParagraph } from "./fixtures/report-paragraph.ts";
import { createSetup, entryText, errorOf, TestClient, ViewClient, type TestSetup } from "./support.ts";

const NOW = "2026-11-05T12:00:00.000Z";
const FAUX: ModelRef = { provider: "faux", modelId: "faux-1" };
const BRIEF = "Read the README and say what it covers.";

const cleanups: (() => Promise<void>)[] = [];
const clients: TestClient[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function boardWith(title: string): BoardState {
	const state = emptyBoardState();
	saveTask(state, {
		task: { title, description: "", acceptance: null, status: "todo", blockedBy: [], blockedReason: null, writeScopes: [] },
		author: "coordinator",
		now: NOW,
	});
	return state;
}

describe("task reports", () => {
	it("gives a task from an older board an empty report", () => {
		const state = boardWith("Old");
		const old = JSON.parse(JSON.stringify(state)) as BoardState;
		delete (old.tasks[0] as Partial<BoardTask>).report;
		delete (old.tasks[0] as Partial<BoardTask>).snapshots;
		expect(boardView(old, Date.parse(NOW), false).tasks[0]).toMatchObject({ report: { now: "", revision: 0, updatedBy: null }, snapshots: 0 });
		expect(normalizeBoard(old).tasks[0]).toMatchObject({ report: { results: "", next: "", revision: 0 }, snapshots: 0 });
	});

	it("keeps old tasks, reports and question options without filling in the new fields", () => {
		const state = boardWith("Old task");
		writeReport(state, { taskId: "T1", sections: { results: "Old results", next: "Old next" }, by: coordinatorWriter("main"), now: NOW });
		askQuestion(state, { taskId: "T1", text: "Ship it?", options: ["Ship", "Wait"], now: NOW });
		const before = boardView(state, Date.parse(NOW), true);
		const reloaded = boardView(normalizeBoard(JSON.parse(JSON.stringify(state)) as BoardState), Date.parse(NOW), true);
		expect(reloaded).toEqual(before);
		expect(reloaded.tasks[0]).not.toHaveProperty("goal");
		for (const name of ["summary", "notDone", "checks"]) expect(reloaded.tasks[0]?.report).not.toHaveProperty(name);
		expect(reloaded.questions[0]).toMatchObject({ options: ["Ship", "Wait"] });
		expect(reloaded.questions[0]).not.toHaveProperty("choices");
	});

	it("does not change Results or Next freshness when rewriting other report fields", () => {
		const state = boardWith("Ship it");
		const by = coordinatorWriter("main");
		const before = writeReport(state, { taskId: "T1", sections: { results: "Prepared the release.", next: "Send the release." }, by, now: NOW });
		const after = writeReport(state, {
			taskId: "T1", sections: { summary: "The release is ready.", notDone: "- Nothing has shipped.", checks: [{ name: "Build", result: "passed" }] },
			by, now: "2026-11-05T13:00:00.000Z", coveredEventSeq: 0, waitsOn: ["Q1"],
		});
		expect(after.report.revision).toBe(before.report.revision + 1);
		expect(after.report.updatedAt).not.toBe(before.report.updatedAt);
		expect(after.report.freshness).toBeDefined();
		expect(after.report.freshness).toEqual(before.report.freshness);
		expect(after.eventSeq).toBe(before.eventSeq);
	});

	it("replaces only the sections a write names and bumps only the report's revision", () => {
		const state = boardWith("Ship it");
		const by = coordinatorWriter("main");
		writeReport(state, { taskId: "T1", sections: { now: "Reading.", next: "Merge." }, by, now: NOW });
		const task = writeReport(state, { taskId: "T1", sections: { now: "Testing." }, addResult: "Tests pass (run 12)", by, now: NOW });
		expect(task.revision).toBe(1);
		expect(task.report).toMatchObject({ now: "Testing.", results: "- Tests pass (run 12)", next: "Merge.", revision: 2, updatedBy: by });
		// The same result twice in a row is a rerun, not a second result.
		writeReport(state, { taskId: "T1", sections: {}, addResult: "- Tests pass (run 12)", by, now: NOW });
		expect(state.tasks[0]?.report.results).toBe("- Tests pass (run 12)");
		expect(() => writeReport(state, { taskId: "T1", sections: {}, by, now: NOW })).toThrow("at least one");
		expect(() => writeReport(state, { taskId: "T9", sections: { now: "x" }, by, now: NOW })).toThrow("No task");
	});

	it("saves a snapshot once per key", () => {
		const state = boardWith("Ship it");
		const task = state.tasks[0] as BoardTask;
		const history: TaskHistoryState = { snapshots: [], keys: [] };
		expect(addSnapshot(history, task, { label: "todo → in_progress", by: HARNESS_WRITER, at: NOW, key: "k1" })).toBe(true);
		expect(addSnapshot(history, task, { label: "todo → in_progress", by: HARNESS_WRITER, at: NOW, key: "k1" })).toBe(false);
		expect(addSnapshot(history, task, { label: "First version", by: HARNESS_WRITER, at: NOW })).toBe(true);
		expect(history.snapshots.map((snapshot) => [snapshot.seq, snapshot.label])).toEqual([
			[1, "todo → in_progress"],
			[2, "First version"],
		]);
		expect(task.snapshots).toBe(2);
	});

	it("puts the task reference in front of a message once", () => {
		expect(withTaskReference("Look again.", "T3")).toBe("[task T3] Look again.");
		expect(withTaskReference("[task T3] Look again.", "T3")).toBe("[task T3] Look again.");
		expect(withTaskReference([{ type: "text", text: "See this." }], "T3")).toEqual([{ type: "text", text: "[task T3] See this." }]);
	});
});

describe("the compaction's board", () => {
	it("shows each open task's now while it fits, and drops it first", () => {
		const state = boardWith("Ship it");
		saveTask(state, {
			task: { title: "Later", description: "", acceptance: null, status: "todo", blockedBy: [], blockedReason: null, writeScopes: [] },
			author: "coordinator",
			now: NOW,
		});
		state.tasks[0]!.status = "in_progress";
		const by = coordinatorWriter("main");
		writeReport(state, { taskId: "T1", sections: { now: "Running the\ntests." }, by, now: NOW });
		writeReport(state, { taskId: "T2", sections: { now: "Waiting for T1." }, by, now: NOW });
		const full = summaryBoardView(state, { now: Date.parse(NOW), since: null, budgetTokens: 100_000 });
		expect(full).toContain("  now: Running the tests.");
		expect(full).toContain("  now: Waiting for T1.");
		const plain = summaryBoardView(state, { now: Date.parse(NOW), since: null, budgetTokens: 0 });
		expect(plain).not.toContain("now:");
		expect(plain).toContain("T1");
	});
});

describe("threads and their tasks", () => {
	it("lets a thread claim its task once, unless another thread holds it or it is closed", () => {
		const state = boardWith("Triage");
		expect(claimTaskForThread(state, { key: "thread-start:c1", taskId: "T1", threadId: "jira", now: NOW })?.after).toMatchObject({
			status: "in_progress",
			ownerThreadId: "jira",
		});
		expect(claimTaskForThread(state, { key: "thread-start:c1", taskId: "T1", threadId: "jira", now: NOW })).toBeUndefined();
		expect(() => claimTaskForThread(state, { key: "thread-start:c2", taskId: "T1", threadId: "other", now: NOW })).toThrow('claimed by thread "jira"');
		saveTask(state, {
			taskId: "T1",
			expectedRevision: 2,
			task: { title: "Triage", description: "", acceptance: null, status: "done", blockedBy: [], blockedReason: null, writeScopes: [] },
			author: "user",
			now: NOW,
		});
		expect(() => claimTaskForThread(state, { key: "thread-start:c3", taskId: "T1", threadId: "jira", now: NOW })).toThrow("only the user reopens");
	});

	it("reuses one task per schedule while it is open, and makes a new one once the user closed it", () => {
		const state = emptyBoardState();
		const first = taskForSchedule(state, { scheduleId: "nightly", title: "Nightly triage", now: NOW }).after;
		expect(first).toMatchObject({ id: "T1", status: "in_progress", scheduleId: "nightly" });
		claimTaskForThread(state, { key: "k1", taskId: "T1", threadId: "nightly-1", now: NOW });
		const again = taskForSchedule(state, { scheduleId: "nightly", title: "Nightly triage", now: NOW }).after;
		expect(again).toMatchObject({ id: "T1", status: "in_progress", ownerThreadId: null });
		const task = state.tasks[0] as BoardTask;
		saveTask(state, {
			taskId: "T1",
			expectedRevision: task.revision,
			task: { title: task.title, description: "", acceptance: null, status: "done", blockedBy: [], blockedReason: null, writeScopes: [] },
			author: "user",
			now: NOW,
		});
		expect(taskForSchedule(state, { scheduleId: "nightly", title: "Nightly triage", now: NOW }).after.id).toBe("T2");
	});
});

async function start(): Promise<{ test: TestSetup; client: TestClient; projectId: string }> {
	const test = await createSetup({ boardEditDebounceMs: 60 });
	cleanups.push(test.cleanup);
	const client = await TestClient.open(test.server);
	clients.push(client);
	await client.hello();
	const added = await client.request({ type: "projects.add", path: test.projectDir });
	if (added.type !== "projects.add") throw errorOf(added);
	const configured = await client.request({ type: "projects.configure", projectId: added.project.id, coordinatorModel: FAUX, workerModels: [FAUX] });
	if (configured.type !== "projects.configure") throw errorOf(configured);
	return { test, client, projectId: added.project.id };
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("timed out waiting for a condition");
}

function call(name: string, args: JsonObject) {
	return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => ((block as { type?: string }).type === "text" ? ((block as { text?: string }).text ?? "") : "")).join("");
}

/** The system prompt, from its sections or its system message. */
function systemOf(request: TranscriptContext): string {
	return request.messages
		.filter((message) => message.role === "system")
		.map((message) => {
			const parts = (message as { sections?: Record<string, string> }).sections;
			return parts === undefined ? textOf((message as { content?: unknown }).content) : Object.values(parts).join("\n");
		})
		.join("\n");
}

function lastOf(request: TranscriptContext): { role: string; text: string; toolName: string | undefined } {
	const last = request.messages.findLast((message) => message.role !== "system") as
		| { role: string; content?: unknown; toolName?: string }
		| undefined;
	return { role: last?.role ?? "", text: textOf(last?.content), toolName: last?.role === "toolResult" ? last.toolName : undefined };
}

/** The tools main's conversation (or a worker's) offers. */
async function toolsOf(client: TestClient, projectId: string, workerId?: string): Promise<string[]> {
	const response = await client.request({ type: "conversation.context", projectId, ...(workerId === undefined ? {} : { workerId }) });
	if (response.type !== "conversation.context") throw errorOf(response);
	return response.context.tools.map((tool) => tool.name);
}

describe("reports through the tools", () => {
	it("keeps manual steps on the task and in history, and negotiates the new state kind", async () => {
		const { test, client: legacy, projectId } = await start();
		const current = await TestClient.open(test.server);
		clients.push(current);
		const hello = await current.request({ type: "hello", protocolVersion: 1, client: { name: "test", features: ["task-steps"] } });
		if (hello.type !== "hello") throw errorOf(hello);
		expect(hello.features).toContain("task-steps");

		const taskInput = { title: "Update a setting", description: "", acceptance: null, status: "todo", blockedBy: [], blockedReason: null, writeScopes: [] };
		const parent = await legacy.request({ type: "board.task.save", projectId, task: taskInput });
		if (parent.type !== "board.task.save") throw errorOf(parent);
		const saved = await legacy.request({ type: "board.task.save", projectId, task: { ...taskInput, parent: parent.task.id } });
		if (saved.type !== "board.task.save") throw errorOf(saved);
		const id = saved.task.id;
		const steps = "1. Open Settings.\n2. Set the timeout to `30`.\n3. Verify the setting:\n\n   ```sh\n   example-cli config get timeout --revision a1b2c3d\n   ```";
		const pointer = "See chat for the commands. Start from a1b2c3d.";
		const toolResults: string[] = [];
		test.faux.setResponses(Array.from({ length: 30 }, () => (request: TranscriptContext) => {
			const { role, text } = lastOf(request);
			if (role === "toolResult") toolResults.push(text);
			if (text === "File the steps.") return call("board", { action: "write_report", id, steps: pointer });
			if (text.startsWith(`Rewrote the report of ${id} (report r1`)) return call("board", { action: "write_report", id, steps, milestone: "Steps ready" });
			if (text.startsWith(`Rewrote the report of ${id} (report r2`)) return call("board", { action: "write_report", id, next: "Verify the change.", results: "- Test config prepared" });
			if (text.startsWith(`Rewrote the report of ${id} (report r3`)) return call("board", { action: "show_task", id });
			if (text === "Clear the steps.") return call("board", { action: "write_report", id, steps: "" });
			return fauxAssistantMessage("Noted.");
		}));
		const readBoard = async (client: TestClient) => {
			const reply = await client.request({ type: "board.get", projectId });
			if (reply.type !== "board.get") throw errorOf(reply);
			return reply.board;
		};
		const submit = async (content: string, requestId: string) => {
			const reply = await legacy.request({ type: "conversation.submit", projectId, content, requestId });
			if (reply.type !== "conversation.submit") throw errorOf(reply);
		};
		await submit("File the steps.", "write-steps");
		await until(() => toolResults.some(text => text.includes("Your steps:")));
		expect(toolResults[0]).toContain("This points at the chat.");
		expect(toolResults[0]).toContain("Your steps, “See chat for the commands.…”: Leave commit hashes and change IDs out of prose.");
		expect(toolResults[1]).toBe(`Rewrote the report of ${id} (report r2; milestone "Steps ready" saved).`);
		expect(toolResults.at(-1)).toContain(`Your steps:\n${steps}\nresults: - Test config prepared\nnext: Verify the change.`);

		await current.waitFor(message => message.type === "board.state" && message.board.tasks.some(task => task.id === id && task.state?.kind === "steps_needed"));
		await legacy.waitFor(message => message.type === "board.state" && message.board.tasks.some(task => task.id === id && task.state?.kind === "review"));
		const board = await readBoard(current);
		const part = board.tasks.find(task => task.id === id)!;
		expect(part.report.steps).toBe(steps);
		expect(part.state).toMatchObject({ group: "needs_you", kind: "steps_needed", since: part.report.stepsWrittenAt, sentence: { text: "Your steps", ageFormat: "none" } });
		expect(board.tasks.find(task => task.id === parent.task.id)).toMatchObject({ subtaskStates: ["steps_needed"], activity: { text: "0 of 1 parts done · 1 needs you" } });
		const legacyBoard = await readBoard(legacy);
		expect(legacyBoard.tasks.find(task => task.id === id)).toMatchObject({ state: { group: "needs_you", kind: "review" } });
		expect(legacyBoard.tasks.find(task => task.id === parent.task.id)?.subtaskStates).toEqual(["review"]);
		const stale = await legacy.request({ type: "board.report.stale", projectId, taskId: id, sections: ["next"], reason: "Confirm the latest value" });
		expect(stale).toMatchObject({ type: "board.report.stale", task: { id, state: { kind: "review" } } });
		const updated = await legacy.request({ type: "board.task.save", projectId, taskId: id, expectedRevision: part.revision, task: { ...taskInput, parent: parent.task.id } });
		expect(updated).toMatchObject({ type: "board.task.save", task: { id, state: { kind: "review" } } });

		await submit("Clear the steps.", "clear-steps");
		await until(async () => (await readBoard(current)).tasks.some(task => task.id === id && task.state?.kind === "todo"));
		const cleared = (await readBoard(current)).tasks.find(task => task.id === id)!;
		expect(cleared.report.steps).toBeUndefined();
		expect(cleared.report.next).toBe("Verify the change.");
		const history = await current.request({ type: "board.task.history", projectId, taskId: id });
		if (history.type !== "board.task.history") throw errorOf(history);
		expect(history.snapshots.find(snapshot => snapshot.label === "Steps ready")?.report.steps).toBe(steps);
	}, 30_000);

	it("writes the optional task fields with board tools and keeps them in history", async () => {
		const { test, client, projectId } = await start();
		const current = await TestClient.open(test.server);
		clients.push(current);
		const hello = await current.request({ type: "hello", protocolVersion: 1, client: { name: "test", features: ["task-fields"] } });
		if (hello.type !== "hello") throw errorOf(hello);
		expect(hello.features).toContain("task-fields");
		expect(LEGACY_HARNESS_FEATURES).not.toContain("task-fields");

		const goal = "Send the release to the pilot group.";
		const summary = "The release is ready from a1b2c3d.";
		const notDone = "- The pilot still needs b2c3d4e.";
		const checks: BoardReportCheck[] = [{ name: "Tests", result: "passed", count: 3, at: NOW }, { name: "Build", result: "failed", note: "Missing icon", at: NOW }];
		const choices: BoardQuestionChoice[] = [{ label: "Send it", effect: "The pilot gets c3d4e5f tonight.", recommended: true }, { label: "Wait" }];
		const toolResults: string[] = [];
		const calls = new Map<string, JsonObject>();
		test.faux.setResponses(Array.from({ length: 80 }, () => (request: TranscriptContext) => {
			const { role, text, toolName } = lastOf(request);
			if (toolName === "board") toolResults.push(text);
			const args = role === "user" ? calls.get(text) : undefined;
			return args ? call("board", args) : fauxAssistantMessage("Noted.");
		}));
		const runBoard = async (args: JsonObject) => {
			const index = toolResults.length;
			const content = `Board action ${index}.`;
			calls.set(content, args);
			const reply = await client.request({ type: "conversation.submit", projectId, content, requestId: `task-fields-${index}` });
			if (reply.type !== "conversation.submit") throw errorOf(reply);
			await until(() => toolResults.length > index);
			return toolResults[index]!;
		};
		const readBoard = async () => {
			const reply = await client.request({ type: "board.get", projectId });
			if (reply.type !== "board.get") throw errorOf(reply);
			return reply.board;
		};

		const id = "T1";
		expect(await runBoard({ action: "add_task", title: "Prepare the release", goal })).toContain("Added T1");
		expect((await readBoard()).tasks[0]?.goal).toBe(goal);
		const revisedGoal = "Send the release to a smaller pilot group.";
		expect(await runBoard({ action: "update_task", id, expectedRevision: 1, goal: revisedGoal })).toContain("Updated T1");
		const refused = await runBoard({ action: "ask", taskId: id, text: "Send it?", choices: [{ label: "Yes", recommended: true }, { label: "No", recommended: true }] });
		expect(refused).toContain("At most one choice can be recommended.");
		expect((await readBoard()).questions).toEqual([]);
		const asked = await runBoard({ action: "ask", taskId: id, text: "Send it?", choices, options: ["Ignored"] });
		expect(asked).toContain("Choice 1 effect");
		expect((await readBoard()).questions[0]).toMatchObject({ id: "Q1", choices, options: ["Send it", "Wait"] });
		const answer = await client.request({ type: "board.question.answer", projectId, questionId: "Q1", expectedRevision: 1, answer: "Send it" });
		expect(answer).toMatchObject({ type: "board.question.answer", question: { status: "answered", answer: "Send it" } });
		expect(await runBoard({ action: "ask", taskId: id, text: "Send a note too?", options: ["Yes", "No"] })).toContain("Asked Q2");
		const legacy = (await readBoard()).questions.find(q => q.id === "Q2");
		expect(legacy).toMatchObject({ options: ["Yes", "No"] });
		expect(legacy).not.toHaveProperty("choices");

		const wrote = await runBoard({ action: "write_report", id, summary, notDone, checks, milestone: "Release ready" });
		expect(wrote).toContain("Summary,");
		expect(wrote).toContain("Not done,");
		await runBoard({ action: "write_report", id, results: "- Prepared the release.", next: "Send the release." });
		expect((await readBoard()).tasks[0]).toMatchObject({ goal: revisedGoal, report: { summary, notDone, checks } });
		const shown = await runBoard({ action: "show_task", id });
		for (const text of [`goal: ${revisedGoal}`, `summary: ${summary}\nresults:`, `Not done:\n${notDone}`, "Tests: passed (3)", "Build: failed", "Send it (recommended) — The pilot gets c3d4e5f tonight."]) {
			expect(shown).toContain(text);
		}

		await runBoard({ action: "write_report", id, checks: [checks[1]!] });
		expect((await readBoard()).tasks[0]?.report.checks).toEqual([checks[1]!]);
		await runBoard({ action: "write_report", id, summary: "", notDone: "", checks: [] });
		await runBoard({ action: "update_task", id, expectedRevision: 2, goal: null });
		const cleared = (await readBoard()).tasks[0]!;
		expect(cleared.goal).toBeNull();
		for (const name of ["summary", "notDone", "checks"]) expect(cleared.report).not.toHaveProperty(name);
		expect(cleared.report).toMatchObject({ results: "- Prepared the release.", next: "Send the release." });
		const history = await client.request({ type: "board.task.history", projectId, taskId: id });
		if (history.type !== "board.task.history") throw errorOf(history);
		expect(history.snapshots[0]).toMatchObject({ label: "Release ready", goal: revisedGoal, report: { summary, notDone, checks }, questionChoices: [{ questionId: "Q1", choices }] });
	}, 30_000);

	it("lets a task's worker and the coordinator write its report, saves milestones, and lists the history", async () => {
		const { test, client, projectId } = await start();
		let workerTurns = 0;
		const results: string[] = [];
		const factory = (request: TranscriptContext) => {
			const system = systemOf(request);
			const { role, text, toolName } = lastOf(request);
			if (system.includes('You are the worker "')) {
				workerTurns += 1;
				if (text === BRIEF) return call("task_progress", { now: "Reading the README.", addResult: wrappedReportParagraph, checks: [{ name: "Tests", result: "failed" }, { name: "Build", result: "passed", at: NOW }], milestone: "README read" });
				if (role === "toolResult") results.push(text);
				if (toolName === "task_progress" && text.includes('milestone "README read"')) return call("task_progress", { checks: [{ name: "Tests", result: "passed", count: 4 }] });
				return fauxAssistantMessage("## Report\nOutcome: done");
			}
			if (text === "[task T1, feedback F1] Read the README.") return call("worker_spawn", { id: "reader", task: BRIEF, taskId: "T1" });
			if (text === "Taskless.") return call("worker_spawn", { id: "free", task: "Look around." });
			if (text === "Wrap up.") return call("board", { action: "write_report", id: "T1", next: "Check the summary.", milestone: "Ready" });
			if (toolName === "board" && text.startsWith("Rewrote")) return call("board", { action: "show_task", id: "T1" });
			if (role === "toolResult") {
				results.push(text);
				return fauxAssistantMessage("Done.");
			}
			return fauxAssistantMessage("Noted.");
		};
		test.faux.setResponses(Array.from({ length: 60 }, () => factory));

		// A message naming a task the board does not have is refused.
		const refused = await client.request({ type: "conversation.submit", projectId, requestId: "r0", content: "Hello.", taskId: "T1" });
		expect(refused).toMatchObject({ type: "error", error: { code: "unknown_task" } });

		const save = await client.request({
			type: "board.task.save",
			projectId,
			task: { title: "Read the README", description: "", acceptance: null, status: "todo", blockedBy: [], blockedReason: null, writeScopes: [] },
		});
		if (save.type !== "board.task.save") throw errorOf(save);
		// The message is filed under T1, with the prefix in front.
		const view = new ViewClient(client);
		await view.start(projectId);
		await client.request({ type: "conversation.submit", projectId, requestId: "r1", content: "Read the README.", taskId: "T1" });
		await view.waitForView((value) => value.entries.some((entry) => entryText(entry) === "[task T1, feedback F1] Read the README."));
		await until(async () => {
			const board = await client.request({ type: "board.get", projectId });
			return board.type === "board.get" && board.board.tasks.some((task) => task.id === "T1" && task.report.revision === 2);
		});

		const board = await client.request({ type: "board.get", projectId });
		if (board.type !== "board.get") throw errorOf(board);
		const task = board.board.tasks.find((candidate) => candidate.id === "T1") as BoardTask;
		expect(results).toContain(`Updated the report of T1 (report r1; milestone "README read" saved).\n${resultsParagraphWarning}`);
		expect(task.report).toMatchObject({
			now: task.activity?.text,
			results: `- ${wrappedReportParagraph}`,
			checks: [{ name: "Tests", result: "passed", count: 4, at: expect.any(String) }, { name: "Build", result: "passed", at: NOW }],
			revision: 2,
			updatedBy: { author: "worker", threadId: "main", workerId: "reader" },
		});
		// The worker's spawn moved the task (one snapshot), its milestone saved another.
		expect(task.snapshots).toBe(2);
		expect(await toolsOf(client, projectId, "reader")).toContain("task_progress");
		expect(await toolsOf(client, projectId)).not.toContain("task_progress");

		await client.request({ type: "conversation.submit", projectId, requestId: "r2", content: "Wrap up." });
		await until(() => results.some((text) => text.includes("Report (r3")));
		const shown = results.find((text) => text.includes("Report (r3")) as string;
		expect(shown).toContain("next: Check the summary.");
		expect(shown).toContain("Workers: reader");
		expect(shown).toContain("#3");

		const history = await client.request({ type: "board.task.history", projectId, taskId: "T1" });
		if (history.type !== "board.task.history") throw errorOf(history);
		expect(history.snapshots.map((snapshot: BoardTaskSnapshot) => snapshot.label)).toEqual(["todo → in_progress", "README read", "Ready"]);
		expect(history.snapshots[2]?.report.next).toBe("Check the summary.");
		expect(history.snapshots[1]?.report.checks?.[0]).toMatchObject({ name: "Tests", result: "failed" });
		expect(history.snapshots[2]?.report.checks).toEqual(task.report.checks);
		const missing = await client.request({ type: "board.task.history", projectId, taskId: "T9" });
		expect(missing).toMatchObject({ type: "error", error: { code: "unknown_task" } });

		// A worker without a task gets no task_progress.
		await client.request({ type: "conversation.submit", projectId, requestId: "r3", content: "Taskless." });
		await until(() => workerTurns >= 4);
		expect(await toolsOf(client, projectId, "free")).not.toContain("task_progress");
	}, 30_000);
});
