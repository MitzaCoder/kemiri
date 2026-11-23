import { coordinatorSection, countRunningModelOverrides } from "../src/workers.ts";
import { Database } from "bun:sqlite";
import { Value } from "typebox/value";
import { ThreadSummarySchema } from "../../protocol/src/threads.ts";
import { afterEach, describe, expect, it } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineDoc, type JsonObject, type SetTimer } from "@earendil-works/pi-durable";
import { DEFAULT_CHECK_INS, DEFAULT_LONG_PROMPT_CACHE, DEFAULT_UI_PROOF } from "@kemiri/protocol";
import type {
	BoardTask,
	ConversationContext,
	ConversationView,
	ModelRef,
	ThreadSummary,
	WorkersListResponse,
} from "@kemiri/protocol";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { type BoardState, changeOwner, emptyBoardState, askQuestion, openBoard, saveTask } from "../src/board.ts";
import { THREAD_ARCHIVE_AFTER_MS, MAIN_THREADS_SECTION, PEER_THREADS_SECTION, ThreadsDoc, threadInstructions } from "../src/threads.ts";
import { stateKind } from "../src/state-identity.ts";
import { createSetup, entryText, errorOf, TestClient, ViewClient, type TestSetup } from "./support.ts";

it("asks jj background threads to use the namespaced task trailer", () => {
	const instructions = threadInstructions({
		id: "fixture", title: "Fixture", checkout: "/tmp/aiki-fixture-workspace", checkoutKind: "jj", startedBy: "main",
		project: {
			version: 1, id: "fixture", name: "Fixture", path: "/tmp/aiki-fixture-project", createdAt: "2026-01-01T00:00:00Z",
			coordinator: { model: null, thinkingLevel: null }, workerModels: [], checkIns: { ...DEFAULT_CHECK_INS },
			longPromptCache: DEFAULT_LONG_PROMPT_CACHE, keepPromptCacheWarm: true, promptCacheWarmHours: 8,
			uiProof: DEFAULT_UI_PROOF, links: null,
		},
	});
	expect(instructions).toContain("Add an `Kemiri-Task: T…` trailer to commit descriptions.");
});

const cleanups: (() => Promise<void>)[] = [];
const clients: TestClient[] = [];

const FAUX: ModelRef = { provider: "faux", modelId: "faux-1" };
const THREAD_BRIEF = "Triage every open ticket of the Jira project.";
const WORKER_BRIEF = "Read the README and report.";
const SUMMARY = "All tickets triaged: 3 closed, 2 need the user.";

async function setup(options?: Parameters<typeof createSetup>[0]): Promise<TestSetup> {
	const created = await createSetup(options);
	cleanups.push(created.cleanup);
	return created;
}

async function connect(server: TestSetup["server"]): Promise<TestClient> {
	const client = await TestClient.open(server);
	clients.push(client);
	return client;
}

afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

function threadTest(name: string, run: () => Promise<void>): void {
	it(name, run, 90_000);
}

// --- a model that answers as main, as a background thread and as a worker ------------------------------------------

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const block = part as { type?: string; text?: string };
			return block.type === "text" ? (block.text ?? "") : "";
		})
		.join("");
}

function systemOf(request: TranscriptContext): string {
	return request.messages
		.filter((message) => message.role === "system")
		.map((message) => {
			const sections = (message as { sections?: Record<string, string> }).sections;
			return sections === undefined ? textOf((message as { content?: unknown }).content) : Object.values(sections).join("\n");
		})
		.join("\n");
}

type Turn = {
	who: "main" | "thread" | "worker";
	/** The background thread's ID, for a thread's turn. */
	threadId: string | undefined;
	role: string;
	text: string;
	/** The tool whose result is the last message, when it is one. */
	toolName: string | undefined;
	request: TranscriptContext;
	signal: AbortSignal | undefined;
};

type Reply = ReturnType<typeof fauxAssistantMessage>;
type Route = (turn: Turn) => Reply | undefined | Promise<Reply | undefined>;

function turnOf(request: TranscriptContext, signal: AbortSignal | undefined): Turn {
	const system = systemOf(request);
	const thread = /You are the background thread "([^"]+)"/.exec(system) ?? /You are the coordinator .*? \(thread ([^)]+)\)/.exec(system);
	const who = thread !== null ? "thread" : system.includes("You are the worker \"") ? "worker" : "main";
	const last = request.messages.findLast((message) => message.role !== "system") as
		| { role: string; content?: unknown; toolName?: string }
		| undefined;
	return {
		who,
		threadId: thread?.[1],
		role: last?.role ?? "",
		text: textOf(last?.content),
		toolName: last?.role === "toolResult" ? last.toolName : undefined,
		request,
		signal,
	};
}

function call(name: string, args: JsonObject): Reply {
	return fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });
}

/**
 * The default script: main adds a task and starts a thread for it on "Start the thread.", the thread finishes at once,
 * main reviews.
 */
function defaults(turn: Turn, start: JsonObject = {}): Reply {
	if (turn.who === "main") {
		const added = turn.toolName === "board" ? /^Added (T\d+) /.exec(turn.text) : null;
		if (added !== null) return call("thread_start", { title: "Jira run", brief: THREAD_BRIEF, taskId: added[1] as string, ...start });
		if (turn.role === "toolResult") return fauxAssistantMessage("Noted.");
		if (turn.text === "Start the thread.") return call("board", { action: "add_task", title: "Jira run" });
		if (turn.text.startsWith("[thread ")) return fauxAssistantMessage("Reviewed the thread.");
		if (turn.text.startsWith("[from ")) return fauxAssistantMessage("Read the message.");
		return fauxAssistantMessage("Nothing to do.");
	}
	if (turn.who === "thread") {
		if (turn.role === "toolResult") return fauxAssistantMessage("Done.");
		if (turn.text === THREAD_BRIEF) return call("thread_finish", { summary: SUMMARY });
		return fauxAssistantMessage("Thread: nothing to do.");
	}
	if (turn.role === "toolResult") return fauxAssistantMessage("Worker: tool done.");
	return fauxAssistantMessage("## Report\nOutcome: done");
}

function script(test: TestSetup, route: Route = () => undefined, start: JsonObject = {}): void {
	const factory = async (request: TranscriptContext, options: { signal?: AbortSignal } | undefined) => {
		const turn = turnOf(request, options?.signal);
		return (await route(turn)) ?? defaults(turn, start);
	};
	test.faux.setResponses(Array.from({ length: 300 }, () => factory));
}

// --- protocol helpers ------------------------------------------------------------------------------------------------

async function openProject(test: TestSetup): Promise<{ client: TestClient; projectId: string; view: ViewClient }> {
	const client = await connect(test.server);
	expect((await client.hello()).type).toBe("hello");
	const added = await client.request({ type: "projects.add", path: test.projectDir });
	if (added.type !== "projects.add") throw new Error(JSON.stringify(added));
	const projectId = added.project.id;
	const configured = await client.request({
		type: "projects.configure",
		projectId,
		coordinatorModel: FAUX,
		coordinatorThinkingLevel: "low",
		workerModels: [FAUX],
	});
	expect(configured.type).toBe("projects.configure");
	const view = new ViewClient(client);
	await view.start(projectId);
	return { client, projectId, view };
}

async function submit(client: TestClient, projectId: string, content: string, threadId?: string): Promise<void> {
	const response = await client.request({
		type: "conversation.submit",
		projectId,
		requestId: `r-${Math.random().toString(36).slice(2)}`,
		content,
		...(threadId === undefined ? {} : { threadId }),
	});
	if (response.type !== "conversation.submit") throw new Error(JSON.stringify(response));
}

async function threads(client: TestClient, projectId: string, includeArchived = false): Promise<ThreadSummary[]> {
	const response = await client.request({ type: "threads.list", projectId, includeArchived });
	if (response.type !== "threads.list") throw new Error(JSON.stringify(response));
	return response.threads;
}

async function thread(client: TestClient, projectId: string, id: string): Promise<ThreadSummary | undefined> {
	return (await threads(client, projectId, true)).find((candidate) => candidate.id === id);
}

async function context(client: TestClient, projectId: string, options: { threadId?: string; workerId?: string }): Promise<ConversationContext> {
	const response = await client.request({ type: "conversation.context", projectId, ...options });
	if (response.type !== "conversation.context") throw new Error(JSON.stringify(response));
	return response.context;
}

async function workers(client: TestClient, projectId: string, threadId?: string): Promise<WorkersListResponse> {
	const response = await client.request({ type: "workers.list", projectId, ...(threadId === undefined ? {} : { threadId }) });
	if (response.type !== "workers.list") throw new Error(JSON.stringify(response));
	return response;
}

async function until(check: () => Promise<boolean> | boolean, timeoutMs = 30_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("timed out waiting for a condition");
}

function userEntries(view: ConversationView | undefined, prefix: string): ConversationView["entries"] {
	return view?.entries.filter((entry) => entry.kind === "pi.user" && entryText(entry).startsWith(prefix)) ?? [];
}

/** Whether an assistant answer follows the first user entry starting with `prefix`. */
function answeredAfter(view: ConversationView | undefined, prefix: string): boolean {
	const entries = view?.entries ?? [];
	const index = entries.findIndex((entry) => entry.kind === "pi.user" && entryText(entry).startsWith(prefix));
	return index !== -1 && entries.slice(index + 1).some((entry) => entry.kind === "pi.assistant");
}

function toolResultTexts(view: ConversationView | undefined, toolName: string): { text: string; isError: boolean }[] {
	return (view?.entries ?? [])
		.filter((entry) => entry.kind === "pi.tool-result")
		.flatMap((entry) => (entry.model ?? []) as { toolName?: string; content?: unknown; isError?: boolean }[])
		.filter((message) => message.toolName === toolName)
		.map((message) => ({ text: textOf(message.content), isError: message.isError === true }));
}

function deferredGate(): { promise: Promise<void>; release(): void } {
	let release: () => void = () => undefined;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

/** Hold a model request until the gate opens or the request is aborted (a stop, a restart). */
function hold(gate: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
	return new Promise<void>((resolve) => {
		signal?.addEventListener("abort", () => resolve(), { once: true });
		void gate.then(() => resolve());
	});
}

function fakeClock(start = Date.UTC(2026, 9, 30, 12, 0, 0)): { now(): number; setTimer: SetTimer; advance(ms: number): void } {
	let now = start;
	return {
		now: () => now,
		setTimer: (() => () => undefined) as unknown as SetTimer,
		advance(ms: number): void {
			now += ms;
		},
	};
}

async function resume(test: TestSetup, projectId: string): Promise<void> {
	const { runtime } = await test.server.manager.open(projectId);
	runtime.harness.resume();
}

// --- tests -----------------------------------------------------------------------------------------------------------

describe("background threads", () => {
	threadTest("starts an unnamed job on the project's worker model and thinking level", async () => {
		const delegated = fauxProvider({ provider: "fixture", models: [{ id: "delegate", reasoning: true }] });
		const model = { provider: "fixture", modelId: "delegate" };
		const test = await setup({ configureModels: models => models.setProvider(delegated.provider) });
		const { client, projectId, view } = await openProject(test);
		await client.request({ type: "projects.configure", projectId, workerModels: [{ ...model, thinkingLevel: "high" }] });
		script(test);
		delegated.setResponses(Array.from({ length: 10 }, () => call("thread_finish", { summary: SUMMARY })));
		await submit(client, projectId, "Start the thread.");
		await view.waitForView(value => toolResultTexts(value, "thread_start").length > 0);
		const result = toolResultTexts(view.view, "thread_start")[0]!;
		expect(result.isError).toBe(false);
		expect(result.text).toContain('Started background thread "jira-run" on fixture/delegate');
		expect(result.text).not.toContain("not one of the project's worker models");
		await until(async () => (await thread(client, projectId, "jira-run"))?.status === "done");
		expect(await thread(client, projectId, "jira-run")).toMatchObject({ model, thinkingLevel: "high" });
	});

	threadTest("counts agent-named outside models across the parent, its record-only job, and the job's workers", async () => {
		const outside = fauxProvider({ provider: "fixture", models: [{ id: "outside" }] });
		const model = { provider: "fixture", modelId: "outside" };
		const test = await setup({ configureModels: models => models.setProvider(outside.provider) });
		const { client, projectId, view } = await openProject(test);
		const jobGate = deferredGate();
		const workerGate = deferredGate();
		script(test, turn => {
			if (turn.text === "Start a worker on the alternate model.") return call("worker_spawn", { id: "reader", task: WORKER_BRIEF, model });
		}, { model, onFinish: "record" });
		outside.setResponses(Array.from({ length: 30 }, () => async (request, options) => {
			const turn = turnOf(request, options?.signal);
			if (turn.who === "thread" && turn.text === THREAD_BRIEF) {
				await hold(jobGate.promise, turn.signal);
				return call("worker_spawn", { id: "reader", task: WORKER_BRIEF, model });
			}
			if (turn.who === "worker") await hold(workerGate.promise, turn.signal);
			return fauxAssistantMessage("Reviewed.");
		}));
		await submit(client, projectId, "Start the thread.");
		await view.waitForView(value => toolResultTexts(value, "thread_start").length > 0);
		const started = toolResultTexts(view.view, "thread_start")[0]!;
		expect(started.text).toContain("This model is not one of the project's worker models (faux/faux-1).");
		expect(started.text).toContain("1 run started by an agent on a model outside that list is live in this project.");

		const jobView = new ViewClient(client);
		await jobView.start(projectId, { threadId: "jira-run" });
		jobGate.release();
		await jobView.waitForView(value => toolResultTexts(value, "worker_spawn").length > 0);
		expect(toolResultTexts(jobView.view, "worker_spawn")[0]?.text).toContain("2 runs started by agents on models outside that list are live in this project.");

		await submit(client, projectId, "Start a worker on the alternate model.");
		await view.waitForView(value => toolResultTexts(value, "worker_spawn").length > 0);
		expect(toolResultTexts(view.view, "worker_spawn")[0]?.text).toContain("3 runs started by agents on models outside that list are live in this project.");
		const { runtime } = await test.server.manager.open(projectId);
		expect(await countRunningModelOverrides(runtime.workers)).toBe(3);
		const updated = await client.request({ type: "threads.update", projectId, threadId: "jira-run", model });
		expect(updated.type).toBe("threads.update");
		expect(await countRunningModelOverrides(runtime.workers)).toBe(2);
		workerGate.release();
		await until(async () => (await workers(client, projectId)).workers.every(worker => worker.status !== "running"));
		await until(async () => (await countRunningModelOverrides(runtime.workers)) === 0);
	});

	threadTest("main starts a thread, which works in its own workspace and finishes with a summary main reviews", async () => {
		const test = await setup();
		script(test);
		const { client, projectId, view } = await openProject(test);
		const { runtime } = await test.server.manager.open(projectId);
		await runtime.memory.store.write({
			target: { scope: "global" },
			fileId: "formatting",
			title: "Formatting",
			summary: "Prefer short reports.",
			text: "Synthetic preference.",
		});
		await runtime.memory.store.write({
			target: { scope: "project", projectId },
			fileId: "testing",
			title: "Testing",
			summary: "Run the suite with Bun.",
			text: "Synthetic convention.",
		});
		await submit(client, projectId, "Start the thread.");

		const finished = await view.waitForView((value) => answeredAfter(value, "[thread jira-run finished]"));
		expect(entryText(userEntries(finished, "[thread jira-run finished]")[0]!)).toBe(`[thread jira-run finished]\n${SUMMARY}`);

		const list = await threads(client, projectId);
		expect(list.map((entry) => entry.id)).toEqual(["main", "jira-run"]);
		expect(list[0]).toMatchObject({ main: true, startedBy: null, status: "idle", state: "paused" });
		const record = list[1]!;
		expect(record).toMatchObject({
			title: "Jira run",
			status: "done",
 state: "finished",
			main: false,
			startedBy: "main",
			scheduleId: null,
			model: FAUX,
			thinkingLevel: null,
			onFinish: "review",
			summary: SUMMARY,
			failure: null,
			archived: false,
		});
		expect(record.finishedAt).not.toBeNull();
		expect(record.conversationId).toBeGreaterThan(1);

		// It never works in the project checkout: its own directory under the data directory (no jj here).
		const threadContext = await context(client, projectId, { threadId: "jira-run" });
		expect(threadContext.threadId).toBe("jira-run");
		expect(threadContext.cwd).toBe(join(test.dataDir, "projects", projectId, "threads", "jira-run", "checkout"));
		expect((await stat(threadContext.cwd)).isDirectory()).toBe(true);
		expect(threadContext.systemPrompt).toContain('You are the background thread "jira-run"');
		expect(threadContext.systemPrompt).toContain("worktree add");
		expect(threadContext.systemPrompt).toContain("You are a background thread of the project");
		expect(threadContext.systemPrompt).not.toContain(MAIN_THREADS_SECTION.slice(0, 60));

		// A full coordinator without the tools that start threads or schedules; main without thread_finish.
		const threadTools = threadContext.tools.map((tool) => tool.name);
		for (const name of ["worker_spawn", "board", "history", "codemode", "thread_list", "thread_peek", "thread_send", "thread_finish"]) {
			expect(threadTools).toContain(name);
		}
		expect(threadTools.some((name) => name.startsWith("memory_"))).toBe(true);
		for (const name of ["thread_start", "thread_stop", "thread_archive", "schedule_save"]) expect(threadTools).not.toContain(name);
		const mainContext = await context(client, projectId, {});
		expect(mainContext.threadId).toBe("main");
		const mainTools = mainContext.tools.map((tool) => tool.name);
		for (const name of ["thread_start", "thread_stop", "thread_archive", "thread_send", "schedule_save"]) expect(mainTools).toContain(name);
		expect(mainTools).not.toContain("thread_finish");
		expect(mainContext.systemPrompt).toContain(MAIN_THREADS_SECTION);
		const memorySection = (prompt: string) => prompt.match(/<memory>[\s\S]*?<\/memory>/)?.[0];
		expect(memorySection(threadContext.systemPrompt)).toContain("global:formatting — Formatting: Prefer short reports.");
		expect(memorySection(threadContext.systemPrompt)).toContain("project:testing — Testing: Run the suite with Bun.");
		expect(memorySection(threadContext.systemPrompt)).toBe(memorySection(mainContext.systemPrompt));

		// The thread's transcript can be watched and paged on its own.
		const threadView = new ViewClient(client);
		await threadView.start(projectId, { threadId: "jira-run" });
		expect(threadView.view?.conversation.id).toBe(record.conversationId);
		expect(threadView.view?.entries.some((entry) => entryText(entry) === THREAD_BRIEF)).toBe(true);
		const page = await client.request({ type: "conversation.page", projectId, threadId: "jira-run", order: "ascending" });
		if (page.type !== "conversation.page") throw new Error(JSON.stringify(page));
		expect(page.entries[0]?.conversationId).toBe(record.conversationId);

		// The list was pushed as it changed.
		const pushed = await client.waitFor(
			(message) =>
				message.type === "threads.state" &&
				message.projectId === projectId &&
				message.threads.some((entry) => entry.id === "jira-run" && entry.status === "done" && entry.state === "finished"),
		);
		expect(pushed.type).toBe("threads.state");
	});

	threadTest("files what a thread's worker saves with artifact_save under that thread and worker", async () => {
		const test = await setup();
		script(test, (turn) => {
			if (turn.who === "thread" && turn.text === THREAD_BRIEF) return call("worker_spawn", { id: "maker", task: WORKER_BRIEF });
			if (turn.who === "thread" && turn.toolName === "worker_spawn") return fauxAssistantMessage("Waiting for the maker.");
			if (turn.who === "thread" && turn.text.startsWith("[worker maker reported]")) return call("thread_finish", { summary: SUMMARY });
			if (turn.who === "worker" && turn.text === WORKER_BRIEF) return call("bash", { command: "printf clip > clip.txt" });
			if (turn.who === "worker" && turn.toolName === "bash") return call("artifact_save", { path: "clip.txt", title: "Clip" });
			return undefined;
		});
		const { client, projectId, view } = await openProject(test);
		await submit(client, projectId, "Start the thread.");
		await view.waitForView((value) => answeredAfter(value, "[thread jira-run finished]"));

		const response = await client.request({ type: "artifacts.list", projectId, threadId: "jira-run" });
		if (response.type !== "artifacts.list") throw new Error(JSON.stringify(response));
		expect(response.artifacts.map((artifact) => [artifact.title, artifact.threadId, artifact.workerId])).toEqual([["Clip", "jira-run", "maker"]]);
	});

	threadTest("refuses thread_finish while the thread's own question is open", async () => {
		const test = await setup();
		let refusal: string | undefined;
		script(test, (turn) => {
			if (turn.who === "thread" && turn.text === THREAD_BRIEF) return call("board", { action: "ask", text: "Sunrise or sunset?" });
			if (turn.who === "thread" && turn.toolName === "board") return call("thread_finish", { summary: "Asked; waiting." });
			if (turn.who === "thread" && turn.toolName === "thread_finish") {
				refusal = turn.text;
				return fauxAssistantMessage("Waiting for the answer.");
			}
			return undefined;
		});
		const { client, projectId } = await openProject(test);
		await submit(client, projectId, "Start the thread.");
		await until(() => refusal !== undefined);
		expect(refusal).toContain("Q1 is still open");
		await until(async () => (await thread(client, projectId, "jira-run"))?.status === "idle");
	});

	threadTest("a task handed to a finished thread brings it back", async () => {
		const test = await setup();
		let handed = false;
		script(test, (turn) => {
			if (turn.who === "main" && turn.text === "Hand it over.") return call("board", { action: "add_task", title: "Follow-up" });
			if (turn.who === "main" && turn.toolName === "board" && turn.text.startsWith("Added T2")) {
				return call("board", { action: "claim", id: "T2", expectedRevision: 1 });
			}
			if (turn.who === "main" && turn.toolName === "board" && turn.text.includes("is yours")) {
				return call("board", { action: "handoff", id: "T2", expectedRevision: 2, toThread: "jira-run" });
			}
			if (turn.who === "thread" && turn.text.startsWith('[board] Thread "main" handed T2')) {
				handed = true;
				return fauxAssistantMessage("Taking T2 on.");
			}
			return undefined;
		});
		const { client, projectId } = await openProject(test);
		await submit(client, projectId, "Start the thread.");
		await until(async () => (await thread(client, projectId, "jira-run"))?.status === "done");
		await submit(client, projectId, "Hand it over.");
		await until(() => handed);
		await until(async () => (await thread(client, projectId, "jira-run"))?.status === "idle");
		// The thread released T1, the task it was started for, when it finished.
		expect((await thread(client, projectId, "jira-run"))?.ownedTasks).toEqual(["T2"]);
	});

	threadTest("extracts memories from a background thread's compaction, tracked apart from main's", async () => {
		const test = await setup();
		let extracted = "";
		script(test, (turn) => {
			if (turn.text.includes("conversation to summarize")) return fauxAssistantMessage("## Goal\nTriage.");
			if (turn.text.includes("was just compacted")) {
				extracted = turn.text;
				return fauxAssistantMessage("Nothing worth keeping.");
			}
			if (turn.who === "thread" && turn.text === THREAD_BRIEF) return fauxAssistantMessage("Triaging. ".repeat(4_000));
			return undefined;
		});
		const { client, projectId } = await openProject(test);
		await submit(client, projectId, "Start the thread.");
		await until(async () => (await thread(client, projectId, "jira-run"))?.status === "idle");
		const compacted = await client.request({ type: "conversation.compact", projectId, threadId: "jira-run" });
		expect(compacted.type).toBe("conversation.compact");
		await until(() => extracted.length > 0);
		// The thread's own transcript, not main's.
		expect(extracted).toContain(THREAD_BRIEF);
		const record = await thread(client, projectId, "jira-run");
		await until(async () => {
			const file = Bun.file(join(test.dataDir, "projects", projectId, "memory-extraction.json"));
			if (!(await file.exists())) return false;
			const progress = (await file.json()) as { lastProcessedEntryId: number | null; threads?: Record<string, number> };
			return progress.lastProcessedEntryId === null && progress.threads?.[String(record?.conversationId)] !== undefined;
		});
	});

	for (const onFinish of ["review", "record"] as const) threadTest(`deduplicates a replayed ${onFinish} finish call across restart`, async () => {
		const test = await setup();
		const callId = "synthetic-thread-finish";
		script(test, (turn) => turn.who === "thread" && turn.text === THREAD_BRIEF
			? fauxAssistantMessage([fauxToolCall("thread_finish", { summary: SUMMARY }, { id: callId })], { stopReason: "toolUse" })
			: undefined, { onFinish });
		const { client, projectId, view } = await openProject(test);
		await submit(client, projectId, "Start the thread.");
		await view.waitForView((value) => userEntries(value, "[thread jira-run finished]").length === 1);
		const { runtime } = await test.server.manager.open(projectId);
		await runtime.conversation.waitForIdle(BACKGROUND_CONTEXT);
		expect(await runtime.harness.commit((tx) => tx.submissionByRequest(runtime.conversation.id, `thread-finished:jira-run:${callId}`), BACKGROUND_CONTEXT)).toBeDefined();
		const record = (await runtime.threads.record("jira-run"))!;
		await runtime.threads.finish(record, SUMMARY, callId);
		const server = await test.restart();
		const next = await connect(server);
		await next.hello();
		const { runtime: reopened } = await server.manager.open(projectId);
		await reopened.threads.finish((await reopened.threads.record("jira-run"))!, SUMMARY, callId);
		await reopened.conversation.waitForIdle(BACKGROUND_CONTEXT);
		const nextView = new ViewClient(next);
		await nextView.start(projectId);
		expect(userEntries(nextView.view, "[thread jira-run finished]")).toHaveLength(1);
	});

	threadTest("records a summary without waking main when onFinish is record", async () => {
		const test = await setup();
		script(test, () => undefined, { onFinish: "record" });
		const { client, projectId, view } = await openProject(test);
		await submit(client, projectId, "Start the thread.");
		await view.waitForView((value) => userEntries(value, "[thread jira-run finished]").length === 1);
		await until(async () => (await thread(client, projectId, "jira-run"))?.status === "done");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(answeredAfter(view.view, "[thread jira-run finished]")).toBe(false);
	});

	threadTest("posts a failed turn to main once, and the thread recovers with the next message", async () => {
		const test = await setup();
		let fail = true;
		script(test, (turn) => {
			if (turn.who === "thread" && turn.text === THREAD_BRIEF && fail) {
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider is down" });
			}
			if (turn.who === "thread" && turn.text.startsWith("[from main]")) return call("thread_finish", { summary: SUMMARY });
			return undefined;
		});
		const { client, projectId, view } = await openProject(test);
		await submit(client, projectId, "Start the thread.");
		const failed = await view.waitForView((value) => userEntries(value, "[thread jira-run failed:").length > 0);
		expect(entryText(userEntries(failed, "[thread jira-run failed:")[0]!)).toBe("[thread jira-run failed: provider is down]");
		await until(async () => (await thread(client, projectId, "jira-run"))?.status === "failed");
		expect((await thread(client, projectId, "jira-run"))?.failure).toBe("provider is down");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(userEntries(view.view, "[thread jira-run failed:")).toHaveLength(1);

		// A message wakes it again; it finishes this time.
		fail = false;
		await submit(client, projectId, "[from main] try again", "jira-run");
		await view.waitForView((value) => userEntries(value, "[thread jira-run finished]").length === 1);
		await until(async () => (await thread(client, projectId, "jira-run"))?.status === "done");
	});

	threadTest("keeps one level: a thread cannot start threads", async () => {
		const test = await setup();
		script(test, (turn) => {
			if (turn.who === "thread" && turn.text === THREAD_BRIEF) {
				return call("thread_start", { title: "Nested", brief: "Do something nested." });
			}
			if (turn.who === "thread" && turn.toolName === "thread_start") return call("thread_finish", { summary: "Could not nest." });
			return undefined;
		});
		const { client, projectId, view } = await openProject(test);
		await submit(client, projectId, "Start the thread.");
		await view.waitForView((value) => userEntries(value, "[thread jira-run finished]").length === 1);
		const threadView = new ViewClient(client);
		await threadView.start(projectId, { threadId: "jira-run" });
		const results = toolResultTexts(threadView.view, "thread_start");
		expect(results).toHaveLength(1);
		expect(results[0]?.isError).toBe(true);
		expect((await threads(client, projectId, true)).map((entry) => entry.id)).toEqual(["main", "jira-run"]);
	});

	threadTest("delivers requests and batches of replies without waking an idle thread for replies", async () => {
		const test = await setup();
		const replies = Array.from({ length: 12 }, (_, index) => `Update ${index + 1}`);
		let mainReplies = false;
		script(test, (turn) => {
			if (turn.who === "thread" && turn.text === THREAD_BRIEF) {
				return call("thread_send", { id: "main", message: "Which Jira project?" });
			}
			if (turn.who === "thread" && turn.toolName === "thread_send") return fauxAssistantMessage("Asked main; waiting.");
			if (turn.who === "thread" && turn.text.startsWith("[from main]")) return fauxAssistantMessage("Thread woke up.");
			if (turn.who === "main" && turn.text.startsWith("[from jira-run]")) {
				mainReplies = true;
				return fauxAssistantMessage("Will answer later.");
			}
			if (turn.who === "main" && turn.text === "Answer the thread.") {
				return call("thread_send", { id: "jira-run", message: "Project ABC.", reply: true });
			}
			if (turn.who === "main" && turn.text === "Send the updates.") {
				return fauxAssistantMessage(
					replies.map((message) => fauxToolCall("thread_send", { id: "jira-run", message, reply: true })),
					{ stopReason: "toolUse" },
				);
			}
			return undefined;
		});
		const { client, projectId, view } = await openProject(test);
		await submit(client, projectId, "Start the thread.");

		// The request wakes main, marked as coming from the thread.
		await view.waitForView((value) => answeredAfter(value, "[from jira-run] Which Jira project?"));
		expect(mainReplies).toBe(true);
		await until(async () => (await thread(client, projectId, "jira-run"))?.status === "idle");

		// Main's reply lands in the idle thread without starting a turn there.
		await submit(client, projectId, "Answer the thread.");
		const threadView = new ViewClient(client);
		await threadView.start(projectId, { threadId: "jira-run" });
		await threadView.waitForView((value) => userEntries(value, "[from main] Project ABC.").length === 1);
		await new Promise((resolve) => setTimeout(resolve, 400));
		expect(answeredAfter(threadView.view, "[from main] Project ABC.")).toBe(false);
		expect((await thread(client, projectId, "jira-run"))?.status).toBe("idle");

		await submit(client, projectId, "Send the updates.");
		await view.waitForView((value) => toolResultTexts(value, "thread_send").length === replies.length + 1);
		expect(toolResultTexts(view.view, "thread_send").filter((result) => result.isError)).toHaveLength(0);
		await threadView.waitForView((value) => userEntries(value, "[from main] Update ").length === replies.length);
		expect(userEntries(threadView.view, "[from main] Update ").map(entryText).sort()).toEqual(
			replies.map((message) => `[from main] ${message}`).sort(),
		);
		expect((await thread(client, projectId, "jira-run"))?.status).toBe("idle");
	});

	threadTest("resumes a thread and its workers after a restart with the same memory brief", async () => {
		const test = await setup();
		const gate = deferredGate();
		let attempts = 0;
		script(test, async (turn) => {
			if (turn.who === "thread" && turn.text === THREAD_BRIEF) {
				return call("worker_spawn", { id: "reader", task: WORKER_BRIEF, title: "Read" });
			}
			if (turn.who === "thread" && turn.text.startsWith("[worker reader reported]")) {
				return call("thread_finish", { summary: turn.text });
			}
			if (turn.who === "thread" && turn.toolName === "worker_spawn") return fauxAssistantMessage("Waiting for the reader.");
			if (turn.who === "worker" && turn.text === WORKER_BRIEF) {
				attempts += 1;
				if (attempts === 1) {
					await hold(gate.promise, turn.signal);
					return fauxAssistantMessage("interrupted");
				}
				return fauxAssistantMessage("## Report\nOutcome: done after the restart");
			}
			return undefined;
		});
		const { client, projectId } = await openProject(test);
		await test.server.memory.write({ target: { scope: "global" }, fileId: "worker-brief", title: "Worker brief", text: "Use short reports." });
		await test.server.memory.write({ target: { scope: "project", projectId }, fileId: "worker-brief", title: "Worker brief", text: "Install dependencies in a fresh workspace." });
		await submit(client, projectId, "Start the thread.");
		await until(() => attempts === 1);

		// The thread's worker works in the thread's workspace and is listed under the thread.
		const listed = await workers(client, projectId, "jira-run");
		expect(listed.workers.map((worker) => [worker.id, worker.threadId, worker.status])).toEqual([["reader", "jira-run", "running"]]);
		expect((await workers(client, projectId, "main")).workers).toHaveLength(0);
		expect((await workers(client, projectId)).workers.map((worker) => worker.threadId)).toEqual(["jira-run"]);
		const workerContext = await context(client, projectId, { threadId: "jira-run", workerId: "reader" });
		expect(workerContext.cwd).toBe(join(test.dataDir, "projects", projectId, "threads", "jira-run", "checkout"));
		expect(workerContext.systemPrompt).toContain('workspace of the background thread "jira-run"');
		expect(workerContext.systemPrompt).not.toContain("<memory>");
		expect(workerContext.systemPrompt).not.toContain("Memory index");
		expect(workerContext.systemPrompt).toContain("<project-brief>");
		expect(workerContext.systemPrompt.indexOf("Use short reports.")).toBeLessThan(workerContext.systemPrompt.indexOf("Install dependencies"));
		await test.server.memory.write({ target: { scope: "project", projectId }, fileId: "worker-brief", text: "A different rule for future workers." });
		expect(workerContext.tools.map((tool) => tool.name).filter((name) => name.startsWith("thread_"))).toEqual([]);
		expect(errorOf(await client.request({ type: "workers.list", projectId, threadId: "nope" })).code).toBe("unknown_thread");
		const pushed = await client.waitFor(
			(message) => message.type === "workers.state" && message.workers.some((worker) => worker.threadId === "jira-run"),
		);
		expect(pushed.type).toBe("workers.state");

		const restarted = await test.restart();
		gate.release();
		const next = await connect(restarted);
		expect((await next.hello()).type).toBe("hello");
		const nextView = new ViewClient(next);
		await nextView.start(projectId);
		await nextView.waitForView((value) => userEntries(value, "[thread jira-run finished]").length === 1, 45_000);
		expect(entryText(userEntries(nextView.view, "[thread jira-run finished]")[0]!)).toContain("Outcome: done after the restart");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(userEntries(nextView.view, "[thread jira-run finished]")).toHaveLength(1);
		expect((await thread(next, projectId, "jira-run"))?.status).toBe("done");
		expect((await workers(next, projectId, "jira-run")).workers[0]?.status).toBe("idle");
		const resumedContext = await context(next, projectId, { threadId: "jira-run", workerId: "reader" });
		const briefBlock = (prompt: string) => prompt.slice(prompt.indexOf("<project-brief>"), prompt.indexOf("</project-brief>") + "</project-brief>".length);
		expect(briefBlock(resumedContext.systemPrompt)).toBe(briefBlock(workerContext.systemPrompt));
		expect(resumedContext.systemPrompt).not.toContain("A different rule for future workers.");
	});

	threadTest("lets threads claim tasks with a revision check and routes a question's answer to the thread that asked", async () => {
		const test = await setup({ boardEditDebounceMs: 60_000 });
		let taskRevision = 0;
 const titleGate = deferredGate();
		script(test, async (turn) => {
			if (turn.who === "thread" && turn.text === THREAD_BRIEF) {
				return call("board", { action: "claim", id: "T1", expectedRevision: taskRevision });
			}
			if (turn.who === "thread" && turn.toolName === "board" && turn.text.includes("is yours")) {
				return call("board", { action: "ask", text: "Close stale tickets?", taskId: "T1", blocksWork: false });
			}
			if (turn.who === "thread" && turn.toolName === "board") { await hold(titleGate.promise, turn.signal); return fauxAssistantMessage("Asked; carrying on."); }
			if (turn.who === "thread" && turn.text.startsWith("[board] The user answered")) return fauxAssistantMessage("Got the answer.");
			if (turn.who === "main" && turn.text === "Claim T1.") {
				return call("board", { action: "claim", id: "T1", expectedRevision: taskRevision + 1 });
			}
			return undefined;
		});
		const { client, projectId, view } = await openProject(test);
		const saved = await client.request({
			type: "board.task.save",
			projectId,
			task: { title: "Triage", description: "", acceptance: null, status: "todo", blockedBy: [], blockedReason: null, writeScopes: [] },
		});
		if (saved.type !== "board.task.save") throw new Error(JSON.stringify(saved));
		taskRevision = saved.task.revision;

		await submit(client, projectId, "Start the thread.");
		const board = async () => {
			const response = await client.request({ type: "board.get", projectId });
			if (response.type !== "board.get") throw new Error(JSON.stringify(response));
			return response.board;
		};
		await until(async () => (await board()).tasks.find(task => task.id === "T1")?.activity?.actor?.name === "Jira run");
 expect((await board()).tasks.find(task => task.id === "T1")?.activity?.text).toContain("Jira run");
 titleGate.release();
 await until(async () => (await board()).questions.length === 1);
 await client.waitFor(message => message.type === "project.state" && message.project.id === projectId && message.project.activity?.backgroundJobs?.needsYou === 1);
		const current = await board();
		expect(current.tasks[0]?.ownerThreadId).toBe("jira-run");
		const question = current.questions[0]!;
		expect(question.threadId).toBe("jira-run");
		// T2 is the task main started it for; it claimed T1 itself.
		expect((await thread(client, projectId, "jira-run"))?.ownedTasks).toEqual(["T1", "T2"]);
		expect((await thread(client, projectId, "jira-run"))?.openQuestions).toBe(1);

		// Main cannot take a task another thread holds.
		await submit(client, projectId, "Claim T1.");
		// The first board result is main's add_task for the thread's own task.
		await view.waitForView((value) => toolResultTexts(value, "board").length === 2);
		const refused = toolResultTexts(view.view, "board")[1]!;
		expect(refused.isError).toBe(true);
		expect(refused.text).toContain('claimed by thread "jira-run"');

		// The user's answer goes to the thread that asked, not to main.
 const beforeAnswer = client.messages.length;
		const answered = await client.request({
			type: "board.question.answer",
			projectId,
			questionId: question.id,
			expectedRevision: question.revision,
			answer: "Yes, close them.",
		});
		expect(answered.type).toBe("board.question.answer");
 await until(() => client.messages.slice(beforeAnswer).some(message => message.type === "project.state" && message.project.id === projectId && message.project.activity?.openQuestions === 0 && message.project.activity?.backgroundJobs?.needsYou === 0));
		const threadView = new ViewClient(client);
		await threadView.start(projectId, { threadId: "jira-run" });
		await threadView.waitForView((value) => answeredAfter(value, "[board] The user answered Q1"));
		expect(userEntries(view.view, "[board] The user answered")).toHaveLength(0);
	});

 for (const finished of [false, true]) threadTest(`routes Ask back to a ${finished ? "finished (reviving it)" : "live"} asking thread, with Needs you counts`, async () => {
  const test = await setup({ boardEditDebounceMs: 60_000 });
  const gate = deferredGate();
  script(test, async turn => {
   if (turn.who === "thread" && turn.text === THREAD_BRIEF && !finished) return fauxAssistantMessage("Waiting for work.");
   if (turn.who === "thread" && turn.text.startsWith("[board] The user asked back")) {
    await hold(gate.promise, turn.signal);
    return call("board", { action: "reply_question", id: "Q1", expectedRevision: 2, text: "Here is the clarification." });
   }
   if (turn.who === "thread" && turn.toolName === "board") return fauxAssistantMessage("Clarified the question.");
   return undefined;
  });
  const { client, projectId, view } = await openProject(test);
  await submit(client, projectId, "Start the thread.");
  await until(async () => (await thread(client, projectId, "jira-run"))?.status === (finished ? "done" : "idle"));
  const { runtime } = await test.server.manager.open(projectId);
  await runtime.harness.commit(async tx => {
   const state = await openBoard(tx, runtime.conversation.id);
   askQuestion(state, { text: "Which option?", options: [], taskId: null, threadId: "jira-run", now: new Date().toISOString() });
  }, BACKGROUND_CONTEXT);
  await until(async () => (await thread(client, projectId, "jira-run"))?.openQuestions === 1);
  const response = await client.request({ type: "board.question.clarify", projectId, questionId: "Q1", expectedRevision: 1, text: "Why this option?" });
  expect(response.type).toBe("board.question.clarify");
  await until(async () => {
   const current = await thread(client, projectId, "jira-run");
   return current?.openQuestions === 0 && current.state === "working";
  });
  gate.release();
  const threadView = new ViewClient(client); await threadView.start(projectId, { threadId: "jira-run" });
  await threadView.waitForView(v => v.entries.some(e => entryText(e) === "Clarified the question."));
  expect(userEntries(threadView.view, "[board] The user asked back")).toHaveLength(1);
  expect(userEntries(view.view, "[board] The user asked back")).toHaveLength(0);
  await until(async () => (await thread(client, projectId, "jira-run"))?.state === "needs_you");
 });

	threadTest("stops a thread with its workers and releases its tasks; archives only what no longer works", async () => {
		const test = await setup();
		const gate = deferredGate();
		script(test, async (turn) => {
			if (turn.who === "thread" && turn.text === THREAD_BRIEF) return call("board", { action: "claim", id: "T1", expectedRevision: 1 });
			if (turn.who === "thread" && turn.toolName === "board") return call("worker_spawn", { id: "reader", task: WORKER_BRIEF });
			if (turn.who === "thread" && turn.toolName === "worker_spawn") return fauxAssistantMessage("Waiting.");
			if (turn.who === "worker" && turn.text === WORKER_BRIEF) {
				await hold(gate.promise, turn.signal);
				return fauxAssistantMessage("late");
			}
			return undefined;
		});
		const { client, projectId } = await openProject(test);
		await client.request({
			type: "board.task.save",
			projectId,
			task: { title: "Triage", description: "", acceptance: null, status: "todo", blockedBy: [], blockedReason: null, writeScopes: [] },
		});
		await submit(client, projectId, "Start the thread.");
		await until(async () => (await thread(client, projectId, "jira-run")) !== undefined);
		await until(async () => (await workers(client, projectId, "jira-run")).workers[0]?.status === "running");
 await client.waitFor(message => message.type === "threads.state" && message.projectId === projectId && message.threads.some(t => t.id === "jira-run" && t.runningWorkers === 1 && t.state === "working"));
 await client.waitFor(message => message.type === "project.state" && message.project.id === projectId && message.project.activity?.backgroundJobs?.working === 1);

		const refused = await client.request({ type: "threads.archive", projectId, threadId: "jira-run", archived: true });
		expect(errorOf(refused).code).toBe("bad_request");
		// A running thread's checkout is listed but cannot be cleaned.
		const storage = await client.request({ type: "projects.storage", projectId });
		if (storage.type !== "projects.storage") throw new Error(JSON.stringify(storage));
		const checkout = storage.items.find((item) => item.id === "thread:jira-run");
		expect(checkout).toMatchObject({ kind: "thread", label: "Jira run", removable: false });
		const notCleaned = await client.request({ type: "projects.storage.clean", projectId, itemIds: ["thread:jira-run"] });
		if (notCleaned.type !== "projects.storage.clean") throw new Error(JSON.stringify(notCleaned));
		expect(notCleaned.removed).toEqual([]);
		expect(notCleaned.refused[0]?.id).toBe("thread:jira-run");
		expect(errorOf(await client.request({ type: "threads.stop", projectId, threadId: "main" })).code).toBe("bad_request");
		expect(errorOf(await client.request({ type: "threads.stop", projectId, threadId: "nope" })).code).toBe("unknown_thread");

		const beforeStop = client.messages.length;
		const stopped = await client.request({ type: "threads.stop", projectId, threadId: "jira-run" });
		if (stopped.type !== "threads.stop") throw new Error(JSON.stringify(stopped));
		expect(stopped.thread.status).toBe("stopped");
 await until(() => client.messages.slice(beforeStop).some(message => message.type === "project.state" && message.project.id === projectId && message.project.activity?.backgroundJobs?.working === 0));
		expect((await workers(client, projectId, "jira-run")).workers[0]?.status).toBe("stopped");
		const board = await client.request({ type: "board.get", projectId });
		if (board.type !== "board.get") throw new Error(JSON.stringify(board));
		expect(board.board.tasks[0]?.ownerThreadId).toBeNull();
		gate.release();

		const archived = await client.request({ type: "threads.archive", projectId, threadId: "jira-run", archived: true });
		if (archived.type !== "threads.archive") throw new Error(JSON.stringify(archived));
		expect(archived.thread.archived).toBe(true);
		// Archiving removes the thread's checkout.
		await until(async () => (await stat(checkout!.path).catch(() => undefined)) === undefined);
		expect((await threads(client, projectId)).map((entry) => entry.id)).toEqual(["main"]);
		expect((await threads(client, projectId, true)).map((entry) => entry.id)).toEqual(["main", "jira-run"]);
	});

	threadTest("routes the conversation requests by threadId and refuses an unknown thread", async () => {
		const test = await setup();
		script(test, (turn) => {
			if (turn.who === "thread" && turn.text === "Anything else?") return fauxAssistantMessage("Thread answers the user.");
			return undefined;
		});
		const { client, projectId, view } = await openProject(test);
		await submit(client, projectId, "Start the thread.");
		await view.waitForView((value) => answeredAfter(value, "[thread jira-run finished]"));

		for (const request of [
			{ type: "conversation.watch" },
			{ type: "conversation.page" },
			{ type: "conversation.context" },
			{ type: "conversation.abort" },
			{ type: "conversation.compact" },
			{ type: "conversation.submit", requestId: "x", content: "hello" },
		]) {
			const response = await client.request({ ...request, projectId, threadId: "nope" });
			expect(errorOf(response).code).toBe("unknown_thread");
		}

		// The user types into a finished thread: it works again and answers there, not in main.
		await submit(client, projectId, "Anything else?", "jira-run");
		const threadView = new ViewClient(client);
		await threadView.start(projectId, { threadId: "jira-run" });
		await threadView.waitForView((value) => value.entries.some((entry) => entryText(entry) === "Thread answers the user."));
		expect(view.view?.entries.some((entry) => entryText(entry) === "Anything else?")).toBe(false);
		await until(async () => (await thread(client, projectId, "jira-run"))?.status === "idle");
		expect((await client.request({ type: "conversation.abort", projectId, threadId: "jira-run" })).type).toBe("conversation.abort");

		// The project's activity counts background threads at work or waiting.
		const listed = await client.request({ type: "projects.list" });
		if (listed.type !== "projects.list") throw new Error(JSON.stringify(listed));
		expect(listed.projects.find((project) => project.id === projectId)?.activity?.backgroundThreads).toBe(1);
	});

	threadTest("main's check-ins digest its running background threads", async () => {
		const clock = fakeClock();
		const test = await setup({ now: clock.now, setTimer: clock.setTimer });
		const gate = deferredGate();
		script(test, async (turn) => {
			if (turn.who === "main" && turn.text.startsWith("[check-in]")) return fauxAssistantMessage("All good.");
			if (turn.who === "thread" && turn.text === THREAD_BRIEF) return call("read", { path: "README.md" });
			if (turn.who === "thread" && turn.toolName === "read") {
				await hold(gate.promise, turn.signal);
				return call("thread_finish", { summary: SUMMARY });
			}
			return undefined;
		});
		const { client, projectId, view } = await openProject(test);
		await client.request({ type: "projects.configure", projectId, checkIns: { enabled: true, intervalMinutes: 1 } });
		await submit(client, projectId, "Start the thread.");
		await until(async () => (await thread(client, projectId, "jira-run"))?.current === "Thinking");

		clock.advance(61_000);
		await resume(test, projectId);
		const checked = await view.waitForView((value) => userEntries(value, "[check-in]").length === 1);
		const text = entryText(userEntries(checked, "[check-in]")[0]!);
		expect(text).toContain("1 background thread is still running");
		expect(text).toContain("thread jira-run — Jira run");
		expect(text).toContain("thread_send");
		gate.release();
		await view.waitForView((value) => userEntries(value, "[thread jira-run finished]").length === 1);
	});
});

describe("scheduled threads", () => {
	async function saveThreadSchedule(client: TestClient, projectId: string, onReport: "review" | "record" = "review"): Promise<string> {
		const saved = await client.request({
			type: "schedules.save",
			projectId,
			schedule: {
				title: "Nightly triage",
				brief: THREAD_BRIEF,
				spec: { kind: "interval", everyMinutes: 60 },
				model: null,
				thinkingLevel: "high",
				isolation: "shared",
				onReport,
				enabled: false,
				kind: "thread",
			},
		});
		if (saved.type !== "schedules.save") throw new Error(JSON.stringify(saved));
		return saved.schedule.id;
	}

	threadTest("starts a thread with the user's prompt, skips while it works, and archives it 7 days after it finishes", async () => {
		const clock = fakeClock();
		const test = await setup({ now: clock.now, setTimer: clock.setTimer });
		const gate = deferredGate();
		script(test, async (turn) => {
			if (turn.who === "thread" && turn.text === THREAD_BRIEF) {
				await hold(gate.promise, turn.signal);
				return call("thread_finish", { summary: SUMMARY });
			}
			return undefined;
		});
		const { client, projectId, view } = await openProject(test);
		const scheduleId = await saveThreadSchedule(client, projectId);

		const first = await client.request({ type: "schedules.run", projectId, scheduleId });
		if (first.type !== "schedules.run") throw new Error(JSON.stringify(first));
		expect(first.run.outcome).toBe("started");
		expect(first.run.workerId).toBeNull();
		const threadId = first.run.threadId!;
		expect(threadId.startsWith(`${scheduleId}-`)).toBe(true);
		const started = (await thread(client, projectId, threadId))!;
		expect(started).toMatchObject({ startedBy: "schedule", scheduleId, model: FAUX, thinkingLevel: "high", onFinish: "review" });

		// Its previous thread is not done: the next run is skipped.
		clock.advance(60_000);
		const second = await client.request({ type: "schedules.run", projectId, scheduleId });
		if (second.type !== "schedules.run") throw new Error(JSON.stringify(second));
		expect(second.run.outcome).toBe("skipped");
		expect(second.run.message).toContain("not done");

		gate.release();
		await view.waitForView((value) => userEntries(value, `[thread ${threadId} finished]`).length === 1);
		await until(async () => (await thread(client, projectId, threadId))?.status === "done");

		// Seven days after it finished it leaves the list; it is still there when asked for archived ones.
		clock.advance(THREAD_ARCHIVE_AFTER_MS - 60_000);
		expect((await threads(client, projectId)).map((entry) => entry.id)).toContain(threadId);
		clock.advance(120_000);
		expect((await threads(client, projectId)).map((entry) => entry.id)).not.toContain(threadId);
		expect((await thread(client, projectId, threadId))?.archived).toBe(true);
	});
});

describe("board ownership", () => {
	function boardWithTask(): { state: BoardState; task: BoardTask } {
		const state = emptyBoardState();
		const { after } = saveTask(state, {
			task: { title: "T", description: "", acceptance: null, status: "todo", blockedBy: [], blockedReason: null, writeScopes: [] },
			author: "user",
			now: "2026-11-04T00:00:00.000Z",
		});
		return { state, task: after };
	}
	const now = "2026-11-04T01:00:00.000Z";

	it("claims with a revision check and refuses a task another thread holds", () => {
		const { state, task } = boardWithTask();
		const claimed = changeOwner(state, { taskId: task.id, expectedRevision: task.revision, change: { kind: "claim", threadId: "a" }, now });
		expect(claimed.after.ownerThreadId).toBe("a");
		expect(claimed.after.revision).toBe(task.revision + 1);
		expect(() =>
			changeOwner(state, { taskId: task.id, expectedRevision: task.revision, change: { kind: "claim", threadId: "a" }, now }),
		).toThrow(/revision/);
		expect(() =>
			changeOwner(state, { taskId: task.id, expectedRevision: claimed.after.revision, change: { kind: "claim", threadId: "b" }, now }),
		).toThrow(/claimed by thread "a"/);
	});

	it("lets only the owner or main release or hand a task over", () => {
		const { state, task } = boardWithTask();
		const claimed = changeOwner(state, { taskId: task.id, expectedRevision: task.revision, change: { kind: "claim", threadId: "a" }, now }).after;
		expect(() =>
			changeOwner(state, { taskId: task.id, expectedRevision: claimed.revision, change: { kind: "release", threadId: "b" }, now }),
		).toThrow(/only its owner or main/);
		const handed = changeOwner(state, {
			taskId: task.id,
			expectedRevision: claimed.revision,
			change: { kind: "handoff", threadId: "a", to: "b" },
			now,
		}).after;
		expect(handed.ownerThreadId).toBe("b");
		const taken = changeOwner(state, {
			taskId: task.id,
			expectedRevision: handed.revision,
			change: { kind: "handoff", threadId: "main", to: "main" },
			now,
		}).after;
		expect(taken.ownerThreadId).toBe("main");
		const released = changeOwner(state, { taskId: task.id, expectedRevision: taken.revision, change: { kind: "release", threadId: "main" }, now }).after;
		expect(released.ownerThreadId).toBeNull();
	});
});


const syntheticTask = (title: string) => ({ title, description: "", acceptance: null, status: "todo" as const, blockedBy: [], blockedReason: null, writeScopes: [] });

threadTest("defaults a legacy v1 thread list without rewriting its shape or losing project data", async () => {
	const test = await setup({ boardEditDebounceMs: 60_000 });
	script(test);
	const { projectId } = await openProject(test);
	const { runtime } = await test.server.manager.open(projectId);
	const running = await runtime.threads.create({ title: "Packing", area: "Packing orders." }, "fixture-running");
	const finished = await runtime.threads.create({ title: "Labels", area: "Printing labels." }, "fixture-finished");
	const archived = await runtime.threads.create({ title: "Stock", area: "Counting stock." }, "fixture-archived");
	const conversation = await runtime.threads.conversation(running.id);
	await conversation.submit({ type: "write", entry: { kind: "pi.user", model: [{ role: "user", content: "Preserve this transcript.", timestamp: Date.now() }] } }, BACKGROUND_CONTEXT);
	await runtime.harness.commit(async tx => {
		const board = await openBoard(tx, runtime.conversation.id);
		const now = new Date().toISOString();
		saveTask(board, { task: syntheticTask("Pack one order"), ownerThreadId: running.id, author: "user", now });
		saveTask(board, { task: syntheticTask("Plan tomorrow"), author: "user", now });
		askQuestion(board, { text: "Which package?", options: [], taskId: "T1", now, threadId: running.id });
	}, BACKGROUND_CONTEXT);
	await runtime.memory.store.write({ target: { scope: "project", projectId }, fileId: "packing", title: "Packing", summary: "Fixture", text: "Store packing notes." });
	const previous = await runtime.threads.state();
	const legacy = Object.fromEntries(Object.entries(previous.threads).map(([id, record]) => {
		const { kind, parentThreadId, area, paths, color, order, held, heldAt, ...legacyRecord } = record;
		return [id, { ...legacyRecord, status: id === running.id ? "running" : "done", archived: id === archived.id,
			finishedAt: id === running.id ? null : "2026-01-02T00:00:00Z", summary: id === running.id ? null : "Fixture summary." }];
	}));
	const boardBefore = await runtime.board.state();
	const path = test.server.manager.store.sessionPath(projectId);
	await test.server.stop();
	using db = new Database(path);
	const row = db.query<{ id: number; seq: number }, [string]>(`SELECT documents.id, MAX(seq) AS seq FROM documents
		JOIN document_revisions ON document_id = documents.id WHERE documents.kind = ? GROUP BY documents.id`).get(JSON.stringify(ThreadsDoc.definition.kind));
	if (!row) throw new Error("Fixture thread document not found");
	db.transaction(() => {
		db.run("DELETE FROM document_revisions WHERE document_id = ?", [row.id]);
		db.run("INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (?, ?, 'base', 1, ?)",
			[row.id, row.seq, JSON.stringify({ threads: legacy, createdAt: previous.createdAt })]);
	})();
	const first = await (await test.restart()).manager.open(projectId);
	const normalized = await first.runtime.threads.state();
	expect(normalized.main).toEqual({ title: "General", area: "Everything without a home.", color: null });
	for (const record of Object.values(normalized.threads)) {
		expect(record.kind).toBe("job");
		expect(record.parentThreadId).toBe("main");
		expect(record.conversationId).toBe(legacy[record.id]!.conversationId);
		expect(record.summary).toBe(legacy[record.id]!.summary);
		expect(record.archived).toBe(legacy[record.id]!.archived);
	}
	const retainedMemory = await first.runtime.memory.store.read("project", projectId, "packing");
	expect(JSON.stringify(retainedMemory)).toContain("Store packing notes.");
	const boardAfter = await first.runtime.board.state();
	expect(boardAfter.tasks.map(t => t.ownerThreadId ?? null)).toEqual(boardBefore.tasks.map(t => t.ownerThreadId ?? null));
	expect(boardAfter.questions).toEqual(boardBefore.questions);
	const transcript = await (await first.runtime.threads.conversation(running.id)).entries({}, 20, undefined, BACKGROUND_CONTEXT);
	expect(JSON.stringify(transcript.items)).toContain("Preserve this transcript.");
	const savedVersion = () => db.query<{ version: number; seq: number }, [number]>("SELECT version, seq FROM document_revisions WHERE document_id = ? ORDER BY seq DESC LIMIT 1").get(row.id);
	const stored = await first.runtime.harness.snapshot(ThreadsDoc, first.runtime.conversation.id, BACKGROUND_CONTEXT);
	expect(stored?.main).toBeUndefined();
	for (const record of Object.values(stored?.threads ?? {})) {
		expect(record.kind).toBeUndefined();
		expect(record.parentThreadId).toBeUndefined();
	}
	const versionBefore = savedVersion();
	expect(versionBefore).toEqual({ version: 1, seq: row.seq });
	const second = await (await test.restart()).manager.open(projectId);
	expect((await second.runtime.threads.state()).main).toEqual(normalized.main);
	expect(savedVersion()).toEqual(versionBefore);
});

threadTest("a previous-release v1 reader can edit new thread rows without dropping coordinator data", async () => {
	// This token uses the previous definition and models only the fields its status updater uses.
	const previousThreadsDoc = defineDoc<{
		threads: Record<string, { id: string; status: ThreadSummary["status"]; updatedAt: string }>;
		createdAt: string | null;
	}>({
		kind: stateKind("threads"), version: 1, scope: "conversation", history: "latest", fork: "initial",
		checkpointWhen: () => false, initial: () => ({ threads: {}, createdAt: null }),
	});
	const test = await setup();
	const { projectId } = await openProject(test);
	const { runtime } = await test.server.manager.open(projectId);
	await runtime.threads.update("main", { title: "Default desk" });
	const { id } = await runtime.threads.create({ title: "Packing", area: "Packing orders.", paths: ["packing/**"] }, "rollback-create");
	await runtime.threads.hold(id, true, "rollback-hold");
	await runtime.threads.deliver({ sender: "main", receiver: id, message: "Keep this for resume.", reply: false, callId: "rollback-message" });
	const writer = await (await test.restart()).manager.open(projectId);
	const previous = await writer.runtime.harness.snapshot(previousThreadsDoc, writer.runtime.conversation.id, BACKGROUND_CONTEXT);
	expect(previous?.threads[id]).toMatchObject({ id, status: "idle" });
	const at = "2026-01-02T00:00:00Z";
	await writer.runtime.harness.commit(async tx => {
		const doc = await tx.doc(previousThreadsDoc, writer.runtime.conversation.id);
		const record = doc.threads[id]!;
		record.status = "stopped";
		record.updatedAt = at;
	}, BACKGROUND_CONTEXT);
	const reopened = await (await test.restart()).manager.open(projectId);
	const restored = await reopened.runtime.threads.state();
	expect(restored.main.title).toBe("Default desk");
	expect(restored.threads[id]).toMatchObject({ kind: "coordinator", parentThreadId: "main", area: "Packing orders.", paths: ["packing/**"],
		held: true, heldInputs: [{ content: "[from main] Keep this for resume.", requestId: "thread-message:rollback-message" }],
		status: "stopped", updatedAt: at });
	const path = test.server.manager.store.sessionPath(projectId);
	await test.server.stop();
	using db = new Database(path, { readonly: true });
	const versions = db.query<{ version: number }, [string]>(`SELECT DISTINCT version FROM document_revisions
		JOIN documents ON document_id = documents.id WHERE documents.kind = ?`).all(JSON.stringify(previousThreadsDoc.definition.kind));
	expect(versions).toEqual([{ version: 1 }]);
});

threadTest("keeps coordinator lifecycle, routing and prompt bytes across restarts", async () => {
	const test = await setup({ boardEditDebounceMs: 60_000 });
	const received = new Map<string, string[]>();
	script(test, turn => {
		if (turn.role !== "user") return undefined;
		const who = turn.threadId ?? "main";
		received.set(who, [...(received.get(who) ?? []), turn.text]);
		if (turn.text === "Add a packing task.") return call("board", { action: "add_task", title: "Pack a sample box" });
		return fauxAssistantMessage("Fixture response.");
	});
	let { client, projectId } = await openProject(test);
	let { runtime } = await test.server.manager.open(projectId);
	const request = { type: "threads.create", projectId, title: "Packing", area: "Pack outgoing orders.", paths: ["packing/**"], operationId: "packing-create" };
	const created = await client.request(request);
	if (created.type !== "threads.create") throw new Error(JSON.stringify(created));
	const packing = created.thread.id;
	const second = await client.request({ type: "threads.create", projectId, title: "Stock", area: "Count stored items." });
	if (second.type !== "threads.create") throw new Error(JSON.stringify(second));
	const stock = second.thread.id;
	expect(received.size).toBe(0);
	const initial = await context(client, projectId, { threadId: packing });
	const general = await context(client, projectId, { threadId: "main" });
	const boardTaskRule = 'Every subject the user raises is a task on the project\'s board';
	const boardInputRule = 'Messages starting with "[board]" bring the user\'s edits and answers';
	expect(initial.systemPrompt).toContain(boardTaskRule);
	expect(initial.systemPrompt).toContain(boardInputRule);
	for (const ruleStart of [boardTaskRule, boardInputRule, "Verification has diminishing returns:"]) {
		const generalRule = general.systemPrompt.split("\n").find(line => line.startsWith(ruleStart))!;
		const areaRule = initial.systemPrompt.split("\n").find(line => line.startsWith(ruleStart));
		expect(generalRule).toBeDefined();
		expect(areaRule).toBe(generalRule);
	}
	expect(initial.systemPrompt).toContain("schedule_save when it should recur");
	expect(initial.systemPrompt).toContain('"shared" for reading, searching and work that must touch your checkout');
	expect(initial.systemPrompt).toContain(PEER_THREADS_SECTION);
	expect(initial.systemPrompt).not.toContain("Count stored items.");
	expect(initial.tools.map(tool => tool.name)).not.toContain("thread_finish");
	expect(JSON.stringify(initial.tools)).toBe(JSON.stringify(general.tools));
	for (const shared of [coordinatorSection(runtime.threads.project), PEER_THREADS_SECTION]) {
		expect(general.systemPrompt).toContain(shared);
		expect(initial.systemPrompt).toContain(shared);
	}
	const roster = await threads(client, projectId);
	const legacyKeys = ["kind", "parentThreadId", "area", "paths", "color", "order", "held", "attention", "lastReplyAt", "lastReplyEntryId", "openTasks"];
	for (const row of roster) expect(Value.Check(ThreadSummarySchema, Object.fromEntries(Object.entries(row).filter(([key]) => !legacyKeys.includes(key))))).toBe(true);
	expect(roster[0]).toMatchObject({ id: "main", title: "General", main: true, kind: "coordinator" });
	expect((await client.request({ type: "threads.update", projectId, threadId: "main", title: "Default desk" })).type).toBe("threads.update");
	expect((await client.request({ type: "threads.update", projectId, threadId: packing, title: "Packing desk", operationId: "rename" })).type).toBe("threads.update");
	const renamed = await context(client, projectId, { threadId: packing });
	expect(renamed.systemPrompt).toContain("Packing desk");
	await submit(client, projectId, "Add a packing task.", packing);
	const packingConversation = await runtime.threads.conversation(packing);
	await packingConversation.waitForIdle(BACKGROUND_CONTEXT);
	let task = (await runtime.board.get()).tasks.find(t => t.title === "Pack a sample box")!;
	expect(task).toMatchObject({ ownerThreadId: packing, coordinatorId: packing });
	expect(await runtime.harness.commit(async tx => (await openBoard(tx, runtime.conversation.id)).tasks.find(t => t.id === task.id)?.coordinatorId, BACKGROUND_CONTEXT)).toBeUndefined();
	expect((await context(client, projectId, { threadId: packing })).systemPrompt).toBe(renamed.systemPrompt);
	const holdRequest = { type: "threads.hold", projectId, threadId: packing, held: true, operationId: "pause" };
	expect((await client.request(holdRequest)).type).toBe("threads.hold");
	await runtime.threads.deliver({ sender: stock, receiver: packing, message: "Peer message while held.", reply: false, callId: "peer-message" });
	const edit = await client.request({ type: "board.task.save", projectId, taskId: task.id, expectedRevision: task.revision, task: syntheticTask("Pack two sample boxes") });
	if (edit.type !== "board.task.save") throw new Error(JSON.stringify(edit));
	task = edit.task;
	await runtime.board.flushEdits();
	expect(received.get(packing)).toEqual(["Add a packing task."]);
	expect(received.get("main")).toBeUndefined();
	expect(received.get(stock)).toBeUndefined();
	client = await connect(await test.restart());
	await client.hello();
	({ runtime } = await test.server.manager.open(projectId));
	expect((await client.request(request))).toMatchObject({ type: "threads.create", thread: { id: packing, title: "Packing desk", held: true } });
	const ownerReply = await client.request({ type: "conversation.submit", projectId, taskId: task.id, content: "Owner task reply.", requestId: "owner-reply" });
	if (ownerReply.type !== "conversation.submit") throw new Error(JSON.stringify(ownerReply));
	await (await runtime.threads.conversation(packing)).waitForIdle(BACKGROUND_CONTEXT);
	expect(received.get(packing)).toHaveLength(2);
	expect(received.get(packing)?.at(-1)).toContain("Owner task reply.");
	expect(received.get(packing)?.at(-1)).toContain("Peer message while held.");
	expect(received.get(packing)?.at(-1)).toContain("Pack two sample boxes");
	expect(received.get("main")).toBeUndefined();
	expect((await client.request(holdRequest))).toMatchObject({ type: "threads.hold", thread: { held: false } });
	// Another pause drains one combined input, even when a worker report is queued in its own commit.
	await runtime.threads.hold(packing, true, "second-pause");
	const heldTarget = await runtime.threads.conversation(packing);
	await runtime.harness.commit(async tx => {
		expect(await runtime.workers.coordinators.queueWhileHeld?.(tx, heldTarget.id, "[worker fixture reported] Finished.", "fixture-report")).toBe(true);
	}, BACKGROUND_CONTEXT);
	await runtime.threads.hold(packing, false, "explicit-resume");
	await heldTarget.waitForIdle(BACKGROUND_CONTEXT);
	expect(received.get(packing)?.at(-1)).toContain("[worker fixture reported] Finished.");
	const createdPart = await runtime.board.saveTask({ task: { ...syntheticTask("Pack a part"), parent: task.id } }, "user");
	expect(createdPart.coordinatorId).toBe(packing);
	const selected = await runtime.board.saveTask({ task: syntheticTask("Count one box"), ownerThreadId: stock }, "user");
	expect(selected.coordinatorId).toBe(stock);
	const moved = await client.request({ type: "board.task.save", projectId, taskId: selected.id, expectedRevision: selected.revision, ownerThreadId: packing, task: syntheticTask(selected.title) });
	expect(moved).toMatchObject({ type: "board.task.save", task: { coordinatorId: packing } });
	await heldTarget.waitForIdle(BACKGROUND_CONTEXT);
	await (await runtime.threads.conversation(stock)).waitForIdle(BACKGROUND_CONTEXT);
	expect(received.get(packing)?.at(-1)).toContain(`The user moved ${selected.id} to you`);
	expect(received.get(stock)?.at(-1)).toContain(`The user moved ${selected.id} to Packing desk`);

	const archive = { type: "threads.archive", projectId, threadId: packing, archived: true, moveTasksTo: stock, operationId: "archive" };
	expect((await client.request(archive))).toMatchObject({ type: "threads.archive", thread: { archived: true } });
	expect((await runtime.board.get()).tasks.find(t => t.id === task.id)).toMatchObject({ coordinatorId: stock, ownerThreadId: stock });
	client = await connect(await test.restart());
	await client.hello();
	({ runtime } = await test.server.manager.open(projectId));
	expect((await thread(client, projectId, packing))?.archived).toBe(true);
	expect((await client.request({ type: "threads.archive", projectId, threadId: packing, archived: false, operationId: "restore" }))).toMatchObject({ type: "threads.archive", thread: { archived: false } });
	expect((await client.request(archive))).toMatchObject({ type: "threads.archive", thread: { archived: false } });
	expect((await runtime.board.get()).tasks.find(t => t.id === task.id)?.coordinatorId).toBe(stock);
	expect((await thread(client, projectId, "main"))?.title).toBe("Default desk");
});

threadTest("releases a job's open tasks to its parent coordinator", async () => {
	const test = await setup();
	const { projectId } = await openProject(test);
	const { runtime } = await test.server.manager.open(projectId);
	const parent = await runtime.threads.create({ title: "Packing", area: "Packing orders." }, "parent");
	const child = await runtime.threads.create({ title: "Batch", area: "One batch." }, "fixture-job");
	const record = (await runtime.threads.record(child.id))!;
	runtime.workers.coordinators.add({ ...runtime.threads.placeFor(record), conversationId: record.conversationId + 1_000, kind: "job", parentThreadId: parent.id });
	await runtime.harness.commit(async tx => {
		const board = await openBoard(tx, runtime.conversation.id);
		saveTask(board, { task: syntheticTask("Pack a batch"), ownerThreadId: child.id, author: "user", now: new Date().toISOString() });
	}, BACKGROUND_CONTEXT);
	expect((await runtime.board.get()).tasks[0]).toMatchObject({ ownerThreadId: child.id, coordinatorId: parent.id });
	expect(await runtime.board.releaseThread(child.id, "fixture-release")).toEqual(["T1"]);
	expect((await runtime.board.get()).tasks[0]).toMatchObject({ ownerThreadId: parent.id, coordinatorId: parent.id });
	expect(await runtime.board.releaseThread(child.id, "fixture-release")).toEqual([]);
});

threadTest("awaited peer replies wake idle askers, with durable task history and no duplicate delivery", async () => {
	const test = await setup();
	let peerTurns = 0;
	script(test, turn => {
		if (turn.role !== "user") return undefined;
		if (turn.text.includes("[from ")) peerTurns++;
		return fauxAssistantMessage("Peer work complete.");
	});
	const { client: legacy, projectId } = await openProject(test);
	const client = await connect(test.server);
	await client.request({ type: "hello", protocolVersion: 1, client: { name: "test", features: ["coordinator-messages"] } });
	let { runtime } = await test.server.manager.open(projectId);
	const { id: packing } = await runtime.threads.create({ title: "Packing", area: "Pack orders." }, "peer-packing");
	const { id: stock } = await runtime.threads.create({ title: "Stock", area: "Count orders." }, "peer-stock");
	const taskId = await runtime.harness.commit(async tx => saveTask(await openBoard(tx, runtime.conversation.id), {
		task: { title: "Stock sample boxes", description: "", acceptance: null, status: "todo", blockedBy: [], blockedReason: null, writeScopes: [] },
		author: "user", now: new Date().toISOString(),
	}).after.id, BACKGROUND_CONTEXT);
	const packed = await runtime.threads.conversation(packing);
	const counted = await runtime.threads.conversation(stock);
	const ask = { sender: packing, receiver: stock, message: "How many boxes?", kind: "request", awaitReply: true, taskId, callId: "ask-boxes" } as const;
	const answer = { sender: stock, receiver: packing, message: "Twelve boxes.", kind: "reply", taskId, callId: "reply-boxes" } as const;
	await runtime.threads.deliver(ask);
	await counted.waitForIdle(BACKGROUND_CONTEXT);
	expect(peerTurns).toBe(1);
	await runtime.threads.deliver(answer);
	await packed.waitForIdle(BACKGROUND_CONTEXT);
	expect(peerTurns).toBe(2);
	const event = await client.waitFor(event => event.type === "threads.message" && event.message.id === "thread-message:reply-boxes");
	expect(event).toMatchObject({ answeredRequest: { id: "thread-message:ask-boxes", replied: true, replyId: "thread-message:reply-boxes" } });
	await runtime.threads.deliver(answer);
	for (let n = 0; n < 12; n++) await runtime.threads.deliver({ ...answer, reply: true, kind: undefined, callId: `plain-${n}`, message: `Box update ${n}.` });
	await runtime.threads.deliver({ ...answer, kind: "note", callId: "note-boxes", message: "Use the paper boxes." });
	await packed.waitForIdle(BACKGROUND_CONTEXT);
	expect(peerTurns).toBe(2);
	const oldView = new ViewClient(legacy);
	await oldView.start(projectId, { threadId: packing });
	expect(userEntries(oldView.view, "[from stock]")).toHaveLength(14);
	expect((await runtime.threads.list(false)).find(t => t.id === packing)?.lastReplyAt).toBeNull();
	const page = await client.request({ type: "threads.messages", projectId, taskId, limit: 4 });
	if (page.type !== "threads.messages") throw new Error(JSON.stringify(page));
	expect(page.messages).toHaveLength(4);
	const tail = await client.request({ type: "threads.messages", projectId, taskId, before: page.nextBefore });
	expect(tail).toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({ id: "thread-message:ask-boxes", replied: true })]) });
	const timeline = await client.request({ type: "board.task.timeline", projectId, taskId, grouped: true });
	expect(timeline).toMatchObject({ entries: expect.arrayContaining([expect.objectContaining({ detail: "How many boxes?" })]) });
	runtime = (await (await test.restart()).manager.open(projectId)).runtime;
	await runtime.threads.deliver(ask);
	await runtime.threads.deliver(answer);
	expect((await runtime.threads.messages({ taskId })).messages).toHaveLength(15);
	expect(peerTurns).toBe(2);
});

threadTest("landing turn is FIFO, wakes once per grant and survives restart and replay", async () => {
	const test = await setup();
	const grants: string[] = [];
	script(test, turn => {
		if (turn.role === "user" && turn.text === "Take the turn.") return call("project_turn", { action: "take", note: "Sample changes" });
		if (turn.role === "user" && turn.text.startsWith("[turn] The landing turn is yours")) grants.push(turn.threadId ?? "main");
		return undefined;
	});
	const { client, projectId } = await openProject(test);
	let { runtime } = await test.server.manager.open(projectId);
	const { id: shop } = await runtime.threads.create({ title: "Web shop", area: "Storefront." }, "turn-shop");
	const { id: kitchen } = await runtime.threads.create({ title: "Kitchen API", area: "Stock." }, "turn-kitchen");
	await submit(client, projectId, "Take the turn.");
	await runtime.conversation.waitForIdle(BACKGROUND_CONTEXT);
	const take = { action: "take" } as const;
	const release = { action: "release" } as const;
	const status = { action: "status" } as const;
	expect(await runtime.threads.projectTurn(shop, take, "take-shop")).toContain("position 1");
	expect(await runtime.threads.projectTurn(kitchen, take, "take-kitchen")).toContain("position 2");
	expect(await runtime.threads.projectTurn(shop, status, "status-shop")).toMatch(/General.*Sample changes.*Web shop.*Kitchen API/);
	expect(await client.request({ type: "threads.list", projectId })).toMatchObject({ landingTurn: { holder: { coordinatorId: "main" }, queue: [{ coordinatorId: shop }, { coordinatorId: kitchen }] } });
	const general = await context(client, projectId, {});
	const area = await context(client, projectId, { threadId: shop });
	expect(general.systemPrompt).toContain(PEER_THREADS_SECTION);
	expect(area.systemPrompt).toContain(PEER_THREADS_SECTION);
	expect(PEER_THREADS_SECTION).toContain("take it with project_turn");
	const restarted = await test.restart();
	runtime = (await restarted.manager.open(projectId)).runtime;
	expect((await runtime.threads.landingTurn()).queue.map(waiter => waiter.coordinatorId)).toEqual([shop, kitchen]);
	expect(await runtime.threads.projectTurn("main", release, "release-main")).toContain("Web shop");
	await (await runtime.threads.conversation(shop)).waitForIdle(BACKGROUND_CONTEXT);
	expect(await runtime.threads.projectTurn(shop, release, "release-shop")).toContain("Kitchen API");
	await (await runtime.threads.conversation(kitchen)).waitForIdle(BACKGROUND_CONTEXT);
	expect(grants).toEqual([shop, kitchen]);
	await runtime.threads.projectTurn(kitchen, release, "release-kitchen");
	await runtime.threads.projectTurn("main", take, "take-main-again");
	await runtime.threads.projectTurn("main", release, "release-main");
	await runtime.threads.projectTurn(shop, take, "take-shop");
	expect(await runtime.threads.landingTurn()).toMatchObject({ holder: { coordinatorId: "main" }, queue: [] });
	expect(grants).toEqual([shop, kitchen]);
});

for (const lifecycle of ["pause", "stop", "archive", "fail"] as const) {
	threadTest(`landing turn advances after holder ${lifecycle} and skips a paused waiter`, async () => {
		const test = await setup();
		script(test, turn => turn.text === "Fail this turn." ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "Fixture failure" }) : undefined);
		const { client, projectId } = await openProject(test);
		const { runtime } = await test.server.manager.open(projectId);
		const { id: holder } = await runtime.threads.create({ title: "Packing", area: "Pack orders." }, "holder");
		const { id: skipped } = await runtime.threads.create({ title: "Stock", area: "Count orders." }, "skipped");
		await runtime.threads.projectTurn(holder, { action: "take" }, "take-holder");
		await runtime.threads.projectTurn(skipped, { action: "take" }, "take-skipped");
		await runtime.threads.projectTurn("main", { action: "take" }, "take-main");
		await runtime.threads.hold(skipped, true, "pause-waiter");
		expect((await runtime.threads.landingTurn()).queue.map(waiter => waiter.coordinatorId)).toEqual(["main"]);
		if (lifecycle === "pause") await runtime.threads.hold(holder, true, "pause-holder");
		if (lifecycle === "stop") await runtime.threads.stopThread(holder);
		if (lifecycle === "archive") await runtime.threads.archive(holder, true);
		if (lifecycle === "fail") await submit(client, projectId, "Fail this turn.", holder);
		await client.waitFor(event => event.type === "threads.state" && event.landingTurn?.holder?.coordinatorId === "main");
		await runtime.conversation.waitForIdle(BACKGROUND_CONTEXT);
		expect(await runtime.threads.landingTurn()).toMatchObject({ holder: { coordinatorId: "main" }, queue: [] });
	});
}

threadTest("landing turn nudges once, without waking the holder", async () => {
	let now = Date.now();
	const test = await setup({ now: () => now });
	let requests = 0;
	let nudges = 0;
	script(test, ({ request }) => {
		requests++;
		nudges += request.messages.filter(m => m.role === "user" && textOf(m.content).startsWith("[turn] Landing turn status:")).length;
		return fauxAssistantMessage("Fixture response.");
	});
	const { client, projectId } = await openProject(test);
	const { runtime } = await test.server.manager.open(projectId);
	await runtime.threads.projectTurn("main", { action: "take" }, "take-main");
	now += 31 * 60_000;
	await runtime.threads.nudgeLandingTurn();
	await runtime.threads.nudgeLandingTurn();
	expect(requests).toBe(0);
	await submit(client, projectId, "Check the task.");
	await runtime.conversation.waitForIdle(BACKGROUND_CONTEXT);
	expect(nudges).toBe(1);
	await runtime.threads.nudgeLandingTurn();
	const page = await runtime.conversation.entries({ order: "descending" }, 50, undefined, BACKGROUND_CONTEXT);
	expect(page.items.filter(item => item.kind === "kemiri.coordinator-note")).toHaveLength(1);
});

threadTest("board add_task hints at near-duplicates across coordinators but still adds them", async () => {
	const test = await setup();
	const added: string[] = [];
	script(test, turn => {
		if (turn.role === "user" && turn.text.startsWith("Add: ")) return call("board", { action: "add_task", title: turn.text.slice(5) });
		if (turn.toolName === "board") added.push(turn.text);
		return fauxAssistantMessage("Fixture response.");
	});
	const { client, projectId } = await openProject(test);
	const { runtime } = await test.server.manager.open(projectId);
	const { id } = await runtime.threads.create({ title: "Kitchen API", area: "Stock." }, "title-kitchen");
	await submit(client, projectId, "Add: Publish daily bake quantities", id);
	await (await runtime.threads.conversation(id)).waitForIdle(BACKGROUND_CONTEXT);
	await submit(client, projectId, "Add: Publish daily bake quantities online!");
	await runtime.conversation.waitForIdle(BACKGROUND_CONTEXT);
	await submit(client, projectId, "Add: Print price cards");
	await runtime.conversation.waitForIdle(BACKGROUND_CONTEXT);
	expect(added[1]).toMatch(/^Added T2.*Similar open tasks: T1 "Publish daily bake quantities" \("Kitchen API"\)/);
	expect(added[2]).toMatch(/^Added T3/);
	expect(added[2]).not.toContain("Similar open tasks");
});


threadTest("hot swaps an area's model and worker default without replacing its conversation", async () => {
	const alternate = fauxProvider({ provider: "fixture", models: [{ id: "faux-2", reasoning: true }] });
	const newModel = { provider: "fixture", modelId: "faux-2" };
	const workerOnly = { provider: "antigravity", modelId: "gemini-3.8-flash" };
	const test = await setup({
		configureModels: models => models.setProvider(alternate.provider),
		antigravityCommand: new URL("./fixtures/fake-acp.ts", import.meta.url).pathname,
	});
	let { client, projectId } = await openProject(test);
	const created = await client.request({ type: "threads.create", projectId, title: "Packing", area: "Pack sample orders." });
	if (created.type !== "threads.create") throw errorOf(created);
	const threadId = created.thread.id;
	const { runtime } = await test.server.manager.open(projectId);
	const conversation = await runtime.threads.conversation(threadId);
	const sibling = await runtime.threads.create({ title: "Stock", area: "Count stored items." }, "stock-model-test");

	const running = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	script(test, async turn => {
		if (turn.text !== "Remember the old label.") return undefined;
		running.resolve();
		await finish.promise;
		return fauxAssistantMessage("The old label is saved.");
	});
	alternate.setResponses(Array.from({ length: 16 }, () => (request, options, _state, model) => {
		const turn = turnOf(request, options?.signal);
		const hasPriorReply = request.messages.some(message => message.role === "assistant" && textOf(message.content) === "The old label is saved.");
		if (turn.text === "Check the new model.") return fauxAssistantMessage(`${model.id}, ${options?.reasoning}, prior reply: ${hasPriorReply}`);
		if (turn.who === "thread" && turn.text === "Delegate a label check.") {
			return call("worker_spawn", { id: "labels", task: "Check the sample labels." });
		}
		return fauxAssistantMessage("Fixture response.");
	}));
	const chat = new ViewClient(client);
	await chat.start(projectId, { threadId });
	await submit(client, projectId, "Remember the old label.", threadId);
	try {
		await running.promise;
		const updated = await client.request({ type: "threads.update", projectId, threadId, model: newModel,
			thinkingLevel: "high", workerModel: { ...newModel, thinkingLevel: "medium" } });
		expect(updated).toMatchObject({ type: "threads.update", thread: { conversationId: conversation.id,
			model: newModel, thinkingLevel: "high", workerModel: { ...newModel, thinkingLevel: "medium" } } });
	} finally {
		finish.resolve();
	}
	await chat.waitForView(value => value.entries.some(entry => entryText(entry) === "The old label is saved."));
	await conversation.waitForIdle(BACKGROUND_CONTEXT);
	await submit(client, projectId, "Check the new model.", threadId);
	await chat.waitForView(value => value.entries.some(entry => entryText(entry) === "faux-2, high, prior reply: true"));
	for (const fields of [{ model: workerOnly }, { workerModel: { provider: "missing", modelId: "missing" } }]) {
		expect(await client.request({ type: "threads.update", projectId, threadId, ...fields })).toMatchObject({ type: "error", error: { code: "bad_request" } });
	}

	const restarted = await test.restart();
	client = await connect(restarted);
	expect(await client.hello()).toMatchObject({ type: "hello", features: expect.arrayContaining(["thread-model-settings"]) });
	const reopenedChat = new ViewClient(client);
	await reopenedChat.start(projectId, { threadId });
	const restored = await threads(client, projectId);
	expect(restored.find(row => row.id === threadId)).toMatchObject({ conversationId: conversation.id,
		model: newModel, thinkingLevel: "high", workerModel: { ...newModel, thinkingLevel: "medium" } });
	for (const id of ["main", sibling.id]) {
		const row = restored.find(row => row.id === id);
		expect(row?.model).toEqual(FAUX);
		expect(row?.thinkingLevel).toBe("low");
		expect(row?.workerModel).toBeUndefined();
	}
	await submit(client, projectId, "Delegate a label check.", threadId);
	await reopenedChat.waitForView(value => toolResultTexts(value, "worker_spawn").some(result => !result.isError));
	expect((await workers(client, projectId, threadId)).workers).toMatchObject([{ id: "labels", model: newModel, thinkingLevel: "medium" }]);
	expect((await workers(client, projectId)).defaults.model).toEqual(FAUX);
	const reset = await client.request({ type: "threads.update", projectId, threadId, workerModel: null });
	if (reset.type !== "threads.update") throw errorOf(reset);
	expect(reset.thread.workerModel).toBeUndefined();
	expect((await restarted.manager.open(projectId)).runtime.workers.coordinators.placeOfThread(threadId)?.workerModel).toBeUndefined();
});

threadTest("routes an area’s job summary, failure and released tasks to its parent", async () => {
	const test = await setup();
	const { client, projectId, view: general } = await openProject(test);
	script(test, turn => {
		if (turn.text === "Start the label audit.") return call("thread_start", { title: "Label audit", brief: "Audit the sample labels.", taskId: task.id, onFinish: "review" });
		if (turn.text === "Finish the audit.") return call("thread_finish", { summary: "Labels checked." });
		if (turn.text === "Fail the audit.") return fauxAssistantMessage("", { stopReason: "error", errorMessage: "sample failure" });
		return fauxAssistantMessage("Fixture response.");
	});
	const { runtime } = await test.server.manager.open(projectId);
	const parent = await runtime.threads.create({ title: "Deliveries", area: "Courier pickup." }, "deliveries");
	const task = await runtime.board.saveTask({ task: syntheticTask("Sample label audit"), ownerThreadId: parent.id }, "user");
	const parentView = new ViewClient(client);
	await parentView.start(projectId, { threadId: parent.id });
	await submit(client, projectId, "Start the label audit.", parent.id);
	await until(async () => (await thread(client, projectId, "label-audit"))?.parentThreadId === parent.id);
	const job = (await runtime.threads.record("label-audit"))!;
	expect(await client.request({ type: "threads.update", projectId, threadId: job.id, thinkingLevel: "high", workerModel: { ...FAUX, thinkingLevel: "medium" } }))
		.toMatchObject({ type: "threads.update", thread: { kind: "job", conversationId: job.conversationId, thinkingLevel: "high", workerModel: { ...FAUX, thinkingLevel: "medium" } } });
	expect((await runtime.board.get()).tasks.find(row => row.id === task.id)).toMatchObject({ ownerThreadId: job.id, coordinatorId: parent.id });
	const jobView = new ViewClient(client);
	await jobView.start(projectId, { threadId: job.id });
	await submit(client, projectId, "Fail the audit.", job.id);
	await parentView.waitForView(value => userEntries(value, "[thread label-audit failed:").length === 1);
	await until(async () => (await runtime.board.get()).tasks.find(row => row.id === task.id)?.ownerThreadId === parent.id);
	await submit(client, projectId, "Finish the audit.", job.id);
	await parentView.waitForView(value => userEntries(value, "[thread label-audit finished]").length === 1);
	expect(userEntries(general.view, "[thread label-audit")).toHaveLength(0);
	const kept = await client.request({ type: "threads.update", projectId, threadId: job.id, promote: true, area: "Label standards.", operationId: "keep-audit" });
	expect(kept).toMatchObject({ type: "threads.update", thread: { kind: "coordinator", id: job.id, conversationId: job.conversationId, status: "idle" } });
	const promoted = await runtime.threads.record(job.id);
	expect(promoted?.parentThreadId).toBeUndefined();
	expect(promoted?.checkout).toBe(job.checkout);
	const after = await context(client, projectId, { threadId: job.id });
	expect(after.systemPrompt).toContain("Label standards.");
	expect(after.tools.map(tool => tool.name)).not.toContain("thread_finish");
	expect(userEntries(jobView.view, "Audit the sample labels.")).toHaveLength(1);
});

threadTest("keeps a live job’s task and refuses to archive its busy parent", async () => {
	const test = await setup();
	const { projectId } = await openProject(test);
	const { runtime } = await test.server.manager.open(projectId);
	const parent = await runtime.threads.create({ title: "Dispatch", area: "Dispatch routes." }, "dispatch");
	script(test, () => fauxAssistantMessage("Fixture response."));
	const task = await runtime.board.saveTask({ task: syntheticTask("Count courier bags"), ownerThreadId: parent.id }, "user");
	const started = await runtime.threads.start({ title: "Count courier bags", brief: "Count bags.", model: null,
		thinkingLevel: null, onFinish: "review", startedBy: "main", parentThreadId: parent.id, scheduleId: null, taskId: task.id, key: "bags" });
	if (!started.ok) throw new Error(started.message);
	await until(async () => (await runtime.threads.record(started.record.id))?.status === "idle");
	await runtime.harness.commit(async tx => { (await tx.doc(ThreadsDoc, runtime.conversation.id)).threads[started.record.id]!.status = "running"; }, BACKGROUND_CONTEXT);
	expect(await runtime.workers.runningThreads(parent.conversationId)).toBe(1);
	expect(await runtime.workers.runningThreads(runtime.conversation.id)).toBe(0);
	const digests = await runtime.threads.checkIns.digests(parent.id, Date.now(), 1000, BACKGROUND_CONTEXT);
	expect(digests[0]).toContain(started.record.id);
	await expect(runtime.threads.archive(parent.id, true)).rejects.toThrow("background jobs");
	await runtime.threads.update(started.record.id, { promote: true, area: "Courier bag inventory." });
	expect((await runtime.board.get()).tasks.find(row => row.id === task.id)).toMatchObject({ ownerThreadId: started.record.id, coordinatorId: started.record.id });
});
