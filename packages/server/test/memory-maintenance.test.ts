/**
 * Memory maintenance: the nightly run, the run after enough writes, its status and settings.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import type { SetTimer } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { MemoryChange, ModelRef } from "@kemiri/protocol";
import { MemoryMaintenanceStore, maintenanceSlotAtOrBefore, nextMaintenanceSlot } from "../src/memory-maintenance.ts";
import { MAX_WORKER_LESSON_PROMPT_CHARS } from "../src/worker-lessons.ts";
import { createSetup, errorOf, TestClient, type TestSetup } from "./support.ts";

const cleanups: (() => Promise<void>)[] = [];
const clients: TestClient[] = [];

const FAUX: ModelRef = { provider: "faux", modelId: "faux-1" };
const START = Date.parse("2026-11-05T02:00:00Z");

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

/** A clock a test moves by hand; nothing fires on its own, so a test calls `wake()` when it wants the clock to look. */
function fakeClock(start = START): { now(): number; setTimer: SetTimer; advance(ms: number): void } {
	let now = start;
	return {
		now: () => now,
		setTimer: ((callback: () => void, delayMs: number) => {
			void callback;
			void delayMs;
			return () => undefined;
		}) as SetTimer,
		advance(ms: number): void {
			now += ms;
		},
	};
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("timed out waiting for a condition");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function messageText(message: { content?: unknown }): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (typeof part !== "object" || part === null) return "";
			const block = part as { type?: string; text?: string };
			return block.type === "text" ? (block.text ?? "") : "";
		})
		.join("");
}

/** The system prompt of one request: how a run's own calls are told apart from the conversation's. */
function systemText(request: { messages: readonly { role: string; content?: unknown }[] }): string {
	return request.messages
		.filter((message) => message.role === "system")
		.map((message) => messageText(message))
		.join("\n");
}

function toolResultCount(request: { messages: readonly { role: string }[] }): number {
	return request.messages.filter((message) => message.role === "toolResult").length;
}

async function addProject(client: TestClient, path: string): Promise<string> {
	const response = await client.request({ type: "projects.add", path });
	if (response.type !== "projects.add") throw new Error(JSON.stringify(response));
	return response.project.id;
}

async function history(test: TestSetup, scope: "global" | "project", projectId?: string): Promise<MemoryChange[]> {
	return test.server.manager.memory.history(scope, projectId, 20);
}

/** Write one topic straight through the store, the way the coordinator's tool does. */
async function seedTopic(
	test: TestSetup,
	projectId: string,
	input: { fileId: string; heading?: string; text: string; title?: string; tags?: string[] },
): Promise<void> {
	await test.server.manager.memory.write({
		target: { scope: "project", projectId },
		fileId: input.fileId,
		text: input.text,
		...(input.heading === undefined ? {} : { heading: input.heading }),
		...(input.title === undefined ? {} : { title: input.title }),
		...(input.tags === undefined ? {} : { tags: input.tags }),
	});
}

describe("maintenance", () => {
	const maintenanceReply = (request: TranscriptContext) => {
		if (!systemText(request).includes("You maintain a coding assistant")) return fauxAssistantMessage("Noted.");
		if (toolResultCount(request) === 0) {
			return fauxAssistantMessage(
				[
					fauxToolCall("memory_archive", { fileId: "old-ports", reason: "never retrieved" }),
					fauxToolCall("memory_write", {
						fileId: "testing",
						heading: "Suite",
						text: "Use `bun test`.",
						summary: "How this project runs its tests.",
						tags: ["bun", "testing"],
					}),
				],
				{ stopReason: "toolUse" },
			);
		}
		return fauxAssistantMessage("Archived the stale topic and fixed the summary.");
	};

	it("does nothing without a maintenance model, and says so in status", async () => {
		const clock = fakeClock();
		const test = await setup({ now: clock.now, setTimer: clock.setTimer, timezone: "UTC" });
		const client = await connect(test.server);
		await client.hello();
		const projectId = await addProject(client, test.projectDir);
		await seedTopic(test, projectId, { fileId: "testing", text: "Use `bun test`." });

		const status = await client.request({ type: "memory.status", scope: "project", projectId });
		if (status.type !== "memory.status") throw errorOf(status);
		expect(status.maintenance).toEqual({ model: null, thinkingLevel: null, time: "03:00", afterWrites: 20 });
		expect(status.status.nextMaintenanceAt).toBeNull();
		expect(status.status.lastMaintenance).toBeNull();
		expect(status.status.writesSinceMaintenance).toBe(1);
		expect(status.timezone).toBe("UTC");

		// No model: neither the nightly slot nor the write count starts anything.
		clock.advance(24 * 60 * 60_000);
		test.server.maintenanceClock.wake();
		await sleep(600);
		expect((await history(test, "project", projectId)).length).toBe(1);

		const maintain = await client.request({ type: "memory.maintain", scope: "project", projectId });
		expect(errorOf(maintain).code).toBe("bad_request");
	}, 30_000);

	it("maintains a scope after enough writes, one commit with a readable log", async () => {
		const clock = fakeClock();
		const test = await setup({ now: clock.now, setTimer: clock.setTimer, timezone: "UTC" });
		const client = await connect(test.server);
		await client.hello();
		const projectId = await addProject(client, test.projectDir);

		const saved = await client.request({
			type: "memory.settings.set",
			maintenance: { model: FAUX, thinkingLevel: "low", time: "23:59", afterWrites: 2 },
		});
		if (saved.type !== "memory.settings.set") throw errorOf(saved);
		expect(saved.maintenance.afterWrites).toBe(2);

		const sessions: string[] = [];
		test.faux.setResponses(Array.from({ length: 20 }, () => (request, options) => {
			if (!options?.sessionId) throw new Error("MissingSessionID");
			sessions.push(options.sessionId);
			return maintenanceReply(request);
		}));
		await seedTopic(test, projectId, { fileId: "testing", heading: "Suite", text: "Use `bun test`." });
		await seedTopic(test, projectId, { fileId: "old-ports", title: "Old ports", text: "The server used port 7000." });

		await until(async () => {
			const status = await client.request({ type: "memory.status", scope: "project", projectId });
			return status.type === "memory.status" && status.status.lastMaintenance !== null;
		});
		const status = await client.request({ type: "memory.status", scope: "project", projectId });
		if (status.type !== "memory.status") throw errorOf(status);
		expect(status.status.maintaining).toBe(false);
		expect(status.status.writesSinceMaintenance).toBe(0);
		expect(status.status.lastMaintenance?.outcome).toBe("ok");
		expect(status.status.lastMaintenance?.commit).not.toBeNull();
		expect(sessions.length).toBe(2);
		expect(new Set(sessions).size).toBe(1);
		expect(status.status.recentRuns).toEqual([{ ...status.status.lastMaintenance!, trigger: "writes" }]);
		const persisted = new MemoryMaintenanceStore({ dataDir: test.dataDir });
		expect((await persisted.scopeRecord(`project:${projectId}`)).recentRuns).toEqual(status.status.recentRuns!);
		expect(status.status.nextMaintenanceAt).toBe(
			new Date(nextMaintenanceSlot("23:59", clock.now(), "UTC")).toISOString(),
		);

		const changes = await history(test, "project", projectId);
		const run = changes.find((change) => change.kind === "maintenance");
		if (run === undefined) throw new Error("no maintenance commit");
		expect(run.commit).toBe(status.status.lastMaintenance?.commit ?? "");
		expect([...run.files].sort()).toEqual(["old-ports", "testing"]);
		expect(run.undoable).toBe(true);
		expect(run.message).toContain("memory: maintenance");
		expect(run.message).toContain("- archive old-ports — never retrieved");
		expect(run.message).toContain("- update testing");

		const old = await test.server.manager.memory.read("project", projectId, "old-ports");
		expect(old.file.status).toBe("archived");
		const testing = await test.server.manager.memory.read("project", projectId, "testing");
		expect(testing.file.tags).toEqual(["bun", "testing"]);

		// The run is undoable as a whole.
		const undone = await client.request({ type: "memory.undo", scope: "project", projectId, commit: run.commit });
		if (undone.type !== "memory.undo") throw errorOf(undone);
		expect((await test.server.manager.memory.read("project", projectId, "old-ports")).file.status).toBe("active");

		// A restart does not run it again: nothing changed since the run.
		const before = (await history(test, "project", projectId)).length;
		await test.restart();
		await test.server.maintenanceClock.start();
		await sleep(600);
		expect((await history(test, "project", projectId)).length).toBe(before);
	}, 30_000);

	it("maintains a changed scope at its nightly time and once per night", async () => {
		const clock = fakeClock();
		const test = await setup({ now: clock.now, setTimer: clock.setTimer, timezone: "UTC" });
		const client = await connect(test.server);
		await client.hello();
		const projectId = await addProject(client, test.projectDir);
		await client.request({
			type: "memory.settings.set",
			maintenance: { model: FAUX, thinkingLevel: null, time: "03:00", afterWrites: 100 },
		});
		test.faux.setResponses(Array.from({ length: 20 }, () => maintenanceReply));
		await seedTopic(test, projectId, { fileId: "testing", text: "Use `bun test`." });

		// Finish the initial evaluation before moving fake time. A sleep can expire before the debounced wake
		// has discovered the scope on a loaded machine; first discovering it after 03:00 intentionally skips that night.
		await test.server.maintenanceClock.start();
		expect((await history(test, "project", projectId)).length).toBe(1);

		// Past 03:00: the scope changed since its last run, so it is maintained.
		clock.advance(90 * 60_000);
		expect(maintenanceSlotAtOrBefore("03:00", clock.now(), "UTC")).toBe(START + 60 * 60_000);
		test.server.maintenanceClock.wake();
		await until(async () => {
			const status = await client.request({ type: "memory.status", scope: "project", projectId });
			return status.type === "memory.status" && status.status.lastMaintenance !== null;
		});
		expect((await history(test, "project", projectId)).some((change) => change.kind === "maintenance")).toBe(true);
		const status = await client.request({ type: "memory.status", scope: "project", projectId });
		if (status.type !== "memory.status") throw errorOf(status);
		expect(status.status.lastMaintenance?.outcome).toBe("ok");

		// The same night does not run again; the next night with no changes does not either.
		const after = (await history(test, "project", projectId)).length;
		await test.server.maintenanceClock.start();
		clock.advance(24 * 60 * 60_000);
		await test.server.maintenanceClock.start();
		expect((await history(test, "project", projectId)).length).toBe(after);
	}, 30_000);

	it("records a failed run and runs nothing twice", async () => {
		const clock = fakeClock();
		const test = await setup({ now: clock.now, setTimer: clock.setTimer, timezone: "UTC" });
		const client = await connect(test.server);
		await client.hello();
		const projectId = await addProject(client, test.projectDir);
		await client.request({
			type: "memory.settings.set",
			maintenance: { model: FAUX, thinkingLevel: null, time: "03:00", afterWrites: 1 },
		});
		test.faux.setResponses(
			Array.from({ length: 10 }, () => (request: TranscriptContext) => {
				if (!systemText(request).includes("You maintain a coding assistant")) return fauxAssistantMessage("Noted.");
				return fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider is down" });
			}),
		);
		await seedTopic(test, projectId, { fileId: "testing", text: "Use `bun test`." });

		await until(async () => {
			const status = await client.request({ type: "memory.status", scope: "project", projectId });
			return status.type === "memory.status" && status.status.lastMaintenance !== null;
		});
		const status = await client.request({ type: "memory.status", scope: "project", projectId });
		if (status.type !== "memory.status") throw errorOf(status);
		expect(status.status.lastMaintenance?.outcome).toBe("failed");
		expect(status.status.lastMaintenance?.message).toContain("provider is down");
		expect(status.status.lastMaintenance?.commit).toBeNull();
		expect(status.status.writesSinceMaintenance).toBe(1);
		expect(status.status.recentRuns?.[0]).toMatchObject({ outcome: "failed", trigger: "writes", message: "provider is down" });
		expect((await history(test, "project", projectId)).length).toBe(1);
		const calls = test.faux.state.callCount;
		await test.server.maintenanceClock.start();
		await test.server.maintenanceClock.start();
		expect(test.faux.state.callCount).toBe(calls);
		// A new write triggers another attempt without losing any of the accumulated write count.
		await seedTopic(test, projectId, { fileId: "testing", text: "Use `bun test` from the root." });
		await test.server.maintenanceClock.start();
		expect(test.faux.state.callCount).toBe(calls + 1);
		const retried = await client.request({ type: "memory.status", scope: "project", projectId });
		if (retried.type !== "memory.status") throw errorOf(retried);
		expect(retried.status.writesSinceMaintenance).toBe(2);
		// A new night can retry even without another write; subsequent ticks that night cannot.
		clock.advance(24 * 60 * 60_000);
		await test.server.maintenanceClock.start();
		await test.server.maintenanceClock.start();
		expect(test.faux.state.callCount).toBe(calls + 2);
	}, 30_000);

	it("runs one scope at a time through memory.maintain", async () => {
		const clock = fakeClock();
		const test = await setup({ now: clock.now, setTimer: clock.setTimer, timezone: "UTC" });
		const client = await connect(test.server);
		await client.hello();
		const projectId = await addProject(client, test.projectDir);
		await client.request({
			type: "memory.settings.set",
			maintenance: { model: FAUX, thinkingLevel: null, time: "03:00", afterWrites: 100 },
		});
		let release: (() => void) | undefined;
		let began: () => void = () => undefined;
		const beganPromise = new Promise<void>((resolve) => {
			began = resolve;
		});
		test.faux.setResponses(
			Array.from({ length: 10 }, () => async (request: TranscriptContext) => {
				if (!systemText(request).includes("You maintain a coding assistant")) return fauxAssistantMessage("Noted.");
				began();
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return fauxAssistantMessage("Nothing to change.");
			}),
		);
		await seedTopic(test, projectId, { fileId: "testing", text: "Use `bun test`." });

		const started = await client.request({ type: "memory.maintain", scope: "project", projectId });
		expect(started.type).toBe("memory.maintain");
		await beganPromise;
		await until(async () => {
			const status = await client.request({ type: "memory.status", scope: "project", projectId });
			return status.type === "memory.status" && status.status.maintaining;
		});
		// A second request while it runs starts nothing and does not fail.
		const second = await client.request({ type: "memory.maintain", scope: "project", projectId });
		expect(second.type).toBe("memory.maintain");
		release?.();
		await until(async () => {
			const status = await client.request({ type: "memory.status", scope: "project", projectId });
			return status.type === "memory.status" && !status.status.maintaining;
		});
		const status = await client.request({ type: "memory.status", scope: "project", projectId });
		if (status.type !== "memory.status") throw errorOf(status);
		expect(status.status.lastMaintenance?.outcome).toBe("nothing_to_do");
	}, 30_000);

	it("refuses an unknown project and an unknown model", async () => {
		const clock = fakeClock();
		const test = await setup({ now: clock.now, setTimer: clock.setTimer, timezone: "UTC" });
		const client = await connect(test.server);
		await client.hello();
		const missing = await client.request({ type: "memory.status", scope: "project", projectId: "nope" });
		expect(errorOf(missing).code).toBe("unknown_project");
		const noProject = await client.request({ type: "memory.status", scope: "project" });
		expect(errorOf(noProject).code).toBe("bad_request");
		const badModel = await client.request({
			type: "memory.settings.set",
			maintenance: { model: { provider: "nope", modelId: "nope-1" }, thinkingLevel: null, time: "03:00", afterWrites: 20 },
		});
		expect(errorOf(badModel).code).toBe("unknown_model");
		const global = await client.request({ type: "memory.status", scope: "global" });
		if (global.type !== "memory.status") throw errorOf(global);
		expect(global.status.scope).toBe("global");
		expect(global.status.projectId).toBeNull();
	});
});


describe("maintenance worker lessons", () => {
	function capture(test: TestSetup, projectId: string, text: string): void {
		test.server.memoryMaintenance.lessons.capture({ projectId, workerId: "reader", taskId: "T12", threadId: "topic",
			at: new Date(START).toISOString(), report: `## Report\nWorth remembering: ${text}` });
	}

	it("keeps lessons without a model; global runs never harvest; project success with no changes consumes", async () => {
		const test = await setup({ now: () => START, timezone: "UTC" });
		const client = await connect(test.server);
		await client.hello();
		const projectId = await addProject(client, test.projectDir);
		capture(test, projectId, "Use the portable shell for scripts.");
		const target = { scope: "project" as const, projectId };
		await test.server.memoryMaintenance.run(target, "nightly");
		expect(await test.server.memoryMaintenance.lessons.list(projectId)).toHaveLength(1);
		await test.server.memoryMaintenance.setSettings({ model: FAUX, thinkingLevel: null, time: "03:00", afterWrites: 100 });
		await test.server.memory.write({ target: { scope: "global" }, fileId: "global-rules", text: "Use clear names." });
		const prompts: string[] = [];
		test.faux.setResponses(Array.from({ length: 8 }, () => (request) => {
			prompts.push(request.messages.map(messageText).join("\n"));
			return fauxAssistantMessage("Nothing to change.");
		}));
		await test.server.memoryMaintenance.run({ scope: "global" }, "manual");
		expect(prompts[0]).not.toContain("Lessons workers reported since the last run");
		expect(prompts[0]).not.toContain("portable shell");
		expect(await test.server.memoryMaintenance.lessons.list(projectId)).toHaveLength(1);
		await test.server.memoryMaintenance.run(target, "nightly");
		expect(prompts.at(-1)).toContain("Lessons workers reported since the last run");
		expect(prompts.at(-1)).toContain("Worker reader; task T12; thread topic; date");
		expect(prompts.at(-1)).toContain("Search existing topics first");
		expect(prompts.at(-1)).toContain("Never save credentials or secrets");
		expect(await test.server.memoryMaintenance.lessons.list(projectId)).toHaveLength(0);
		const record = await test.server.memoryMaintenance.store.scopeRecord(`project:${projectId}`);
		expect(record.lastRun).toMatchObject({ outcome: "nothing_to_do", lessonsConsidered: 1 });
		expect(record.lastRun?.lessonIds).toHaveLength(1);
	}, 30_000);

	it("keeps failed lessons across restart and consumes only the capped batch after success", async () => {
		const test = await setup({ now: () => START, timezone: "UTC" });
		const client = await connect(test.server);
		await client.hello();
		const projectId = await addProject(client, test.projectDir);
		for (let i = 0; i < 15; i++) capture(test, projectId, `Fact ${i}: ${"use the portable shell. ".repeat(80)}`);
		const target = { scope: "project" as const, projectId };
		const all = await test.server.memoryMaintenance.lessons.list(projectId);
		await test.server.memoryMaintenance.setSettings({ model: FAUX, thinkingLevel: null, time: "03:00", afterWrites: 100 });
		test.faux.setResponses([() => { throw new Error("maintenance provider unavailable"); }]);
		await test.server.memoryMaintenance.run(target, "nightly");
		expect(await test.server.memoryMaintenance.lessons.list(projectId)).toEqual(all);
		expect((await test.server.memoryMaintenance.store.scopeRecord(`project:${projectId}`)).lastRun?.outcome).toBe("failed");
		await test.restart();
		let prompt = "";
		test.faux.setResponses([request => { prompt = request.messages.map(messageText).join("\n"); return fauxAssistantMessage("Nothing to change."); }]);
		await test.server.memoryMaintenance.run(target, "manual");
		const record = await test.server.memoryMaintenance.store.scopeRecord(`project:${projectId}`);
		const ids = record.lastRun?.lessonIds ?? [];
		expect(ids.length).toBeGreaterThan(0);
		expect(ids.length).toBeLessThan(all.length);
		expect(prompt.slice(prompt.indexOf("Lessons workers reported since the last run")).length).toBeLessThanOrEqual(MAX_WORKER_LESSON_PROMPT_CHARS);
		expect(prompt).toContain("Fact 0:");
		expect(prompt).not.toContain("Fact 14:");
		expect(await test.server.memoryMaintenance.lessons.list(projectId)).toEqual(all.slice(ids.length));
	}, 30_000);

	it("runs newly discovered lesson-only projects when their first nightly slot is already due", async () => {
		const clock = fakeClock();
		const test = await setup({ now: clock.now, setTimer: clock.setTimer, timezone: "UTC" });
		const client = await connect(test.server);
		await client.hello();
		const projectId = await addProject(client, test.projectDir);
		await test.server.memoryMaintenance.setSettings({ model: FAUX, thinkingLevel: null, time: "03:00", afterWrites: 100 });
		await test.server.maintenanceClock.start();
		// No memory directory existed at the first scan; a report alone makes the project discoverable.
		capture(test, projectId, "Use the portable shell.");
		await test.server.memoryMaintenance.lessons.list(projectId);
		test.faux.setResponses([() => fauxAssistantMessage("Nothing to change.")]);
		clock.advance(90 * 60_000);
		await test.server.maintenanceClock.start();
		expect(await test.server.memoryMaintenance.lessons.list(projectId)).toHaveLength(0);
		const record = await test.server.memoryMaintenance.store.scopeRecord(`project:${projectId}`);
		expect(record.lastRun).toMatchObject({ outcome: "nothing_to_do", lessonsConsidered: 1 });
	}, 30_000);

	it("replays a successful run's interrupted acknowledgement without re-presenting consumed lessons", async () => {
		const test = await setup({ now: () => START, timezone: "UTC" });
		const client = await connect(test.server);
		await client.hello();
		const projectId = await addProject(client, test.projectDir);
		capture(test, projectId, "Old already considered lesson.");
		const old = await test.server.memoryMaintenance.lessons.list(projectId);
		await test.server.memoryMaintenance.setSettings({ model: FAUX, thinkingLevel: null, time: "03:00", afterWrites: 100 });
		test.faux.setResponses(Array.from({ length: 5 }, () => () => fauxAssistantMessage("Nothing to change.")));
		const target = { scope: "project" as const, projectId };
		await test.server.memoryMaintenance.run(target, "manual");
		// Restore the pre-acknowledgement file: the success record is durable but the queue removal was interrupted.
		const { writeJsonFile } = await import("../src/fs-json.ts");
		const { join } = await import("node:path");
		await writeJsonFile(join(test.dataDir, "projects", projectId, "worker-lessons.json"), old);
		await test.restart();
		capture(test, projectId, "New still pending lesson.");
		let prompt = "";
		test.faux.setResponses([request => { prompt = request.messages.map(messageText).join("\n"); return fauxAssistantMessage("Nothing to change."); }]);
		await test.server.memoryMaintenance.run(target, "manual");
		expect(prompt).not.toContain("Old already considered lesson.");
		expect(prompt).toContain("New still pending lesson.");
		expect(await test.server.memoryMaintenance.lessons.list(projectId)).toHaveLength(0);
	}, 30_000);
});
