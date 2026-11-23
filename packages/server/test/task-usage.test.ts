import { expect, it } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { BoardTaskInput } from "@kemiri/protocol";
import { ConversationRequests } from "../src/request-log.ts";
import { RequestLogStore, type RequestRow } from "../src/request-log-store.ts";
import { readTaskUsage } from "../src/task-usage.ts";
import { createSetup, TestClient } from "./support.ts";

const DAY = 86_400_000;
const MINUTE = 60_000;
const taskInput = (title: string, fields: Partial<BoardTaskInput> = {}): BoardTaskInput => ({
	title, description: "", acceptance: null, status: "todo", blockedBy: [], blockedReason: null, writeScopes: [], ...fields,
});

function record(store: RequestLogStore, projectId: string, at: number, taskId: string | null, cost: number, overrides: Partial<RequestRow> = {}) {
	store.insert({ ...new ConversationRequests({ projectId, conversationId: 30,
		identity: { kind: "worker", taskId, workerId: "fern", threadId: "main", scheduleId: null },
	}).request({ provider: "synthetic", model: "spruce", timestamp: at, usage: { cost: { total: cost } } },
	{ wake: "user", retention: "short", changes: null, source: "live" }), billing: "subscription", priced: true, ...overrides });
}

it("serves current board totals through archived and moved descendants, excluding provenance and coordinator usage", async () => {
	let now = Date.now() - 10 * DAY;
	const setup = await createSetup({ now: () => now });
	const client = await TestClient.open(setup.server);
	try {
		const hello = await client.hello();
		expect(hello).toMatchObject({ features: expect.arrayContaining(["task-usage"]) });
		const added = await client.request({ type: "projects.add", path: setup.projectDir });
		if (added.type !== "projects.add") throw new Error("Expected a project");
		const projectId = added.project.id;
		const { runtime } = await setup.server.manager.open(projectId);
		for (const task of [taskInput("Root"), taskInput("Part", { parent: "T1" }),
			taskInput("Archived leaf", { parent: "T2", status: "done" }), taskInput("Found separately", { foundWhile: "T1" }),
			taskInput("Other root"), taskInput("Sibling", { parent: "T1" })]) await runtime.board.saveTask({ task }, "user");
		const store = setup.server.requestLog!.store;
		record(store, projectId, now, "T1", 1);
		record(store, projectId, now, "T2", 2);
		record(store, projectId, now, "T3", 3, { kind: "thread", workerId: null, threadId: "map-review", scheduleId: "weekly" });
		record(store, projectId, now, "T4", 9, { billing: "api_key" });
		record(store, projectId, now, "T1", 100, { kind: "main", workerId: null });
		record(store, "other-project", now, "T1", 200);
		record(store, projectId, now - 180 * DAY, "T3", 4);
		expect(store.prune(now)).toBe(1);
		now += 9 * DAY;
		expect((await runtime.board.get(true)).tasks.find(task => task.id === "T3")?.archived).toBe(true);
		const read = (taskId: string) => client.request({ type: "usage.task", projectId, taskId });
		expect(await read("T1")).toMatchObject({ type: "usage.task", own: { requests: 1, apiValue: 1 }, total: { requests: 4, apiValue: 10 }, parts: [
			{ taskId: "T2", parentTaskId: "T1", total: { requests: 3, apiValue: 9 } },
			{ taskId: "T3", parentTaskId: "T2", total: { requests: 2, apiValue: 7 } },
			{ taskId: "T6", parentTaskId: "T1", total: { requests: 0, apiValue: 0 } },
		], conversations: expect.arrayContaining([{ kind: "thread", name: "map-review", threadId: "map-review", workerId: null,
			model: "spruce", providerId: "synthetic", apiValue: 3 }]) });
		expect(await read("T4")).toMatchObject({ own: { requests: 1, apiValue: 9 }, total: { requests: 1, apiValue: 9 }, subscriptions: [],
			payAsYouGo: [{ providerId: "synthetic", cost: 9 }], notes: { unpricedRequests: 0, missingLimitShare: [] } });
		expect(await read("T5")).toMatchObject({ own: { requests: 0, apiValue: 0 }, total: { requests: 0, apiValue: 0 }, parts: [] });
		const expectedRevision = (await runtime.board.get(true)).tasks.find(task => task.id === "T2")!.revision;
		await runtime.board.saveTask({ taskId: "T2", expectedRevision, task: taskInput("Part", { parent: "T5" }) }, "coordinator");
		expect(await read("T1")).toMatchObject({ total: { requests: 1, apiValue: 1 }, parts: [{ taskId: "T6" }] });
		expect(await read("T5")).toMatchObject({ own: { requests: 0, apiValue: 0 }, total: { requests: 3, apiValue: 9 } });
	} finally { client.close(); await setup.cleanup(); }
}, 20_000);

it("adds measured and pooled binding-window shares without guessing unobserved periods", async () => {
	const now = Date.now();
	const store = RequestLogStore.open(":memory:");
	try {
		function period(start: number, points: number, taskCost: number, otherCost: number) {
			const reading = (at: number, usedPercent: number) => store.ledger.reading("synthetic", {
				id: "week", label: "Weekly limit", windowMinutes: 10_080,
				usedPercent, resetsAt: new Date(start + 10_080 * MINUTE).toISOString(), source: "usage_api",
			}, at);
			reading(start, 0);
			record(store, "project", start + MINUTE, "T1", taskCost);
			record(store, "project", start + MINUTE, null, otherCost);
			reading(start + 2 * MINUTE, points);
		}
		period(now - 21 * DAY, 10, 4, 16); // $2 per point locally.
		period(now - 14 * DAY, 2, 9, 1); // Below five; pool gives $30 / 12 points, not $10 / 2.
		record(store, "project", now, "T1", 0, { priced: false, provider: "unmetered" });
		const report = await readTaskUsage({ store, projectId: "project", taskId: "T1", tasks: [{ id: "T1", title: "Atlas" }],
			label: id => id, billingFor: async () => null, threadNames: async () => new Map(), now });
		expect(report.subscriptions.find(row => row.providerId === "synthetic")?.bindingWindow?.share).toBeCloseTo((4 / 2 + 9 / (30 / 12)) / 100);
		expect(report.subscriptions.find(row => row.providerId === "unmetered")?.bindingWindow).toBeNull();
		expect(report.notes).toEqual({ unpricedRequests: 1, missingLimitShare: ["unmetered"] });
	} finally { store.close(); }
});

it("attributes requests after worker_send reassignment to the new task", async () => {
	const setup = await createSetup();
	try {
		const project = await setup.server.manager.store.add(setup.projectDir);
		await setup.server.manager.configure(project.id, { coordinatorModel: { provider: "faux", modelId: "faux-1" } });
		const { runtime } = await setup.server.manager.open(project.id);
		for (const title of ["First task", "Next task"]) await runtime.board.saveTask({ task: taskInput(title) }, "coordinator");
		setup.faux.setResponses(Array.from({ length: 25 }, () => request => {
			const last = request.messages.findLast(message => message.role !== "system");
			if (last?.role === "user" && last.content === "Start the worker") return fauxAssistantMessage([fauxToolCall("worker_spawn", {
				id: "fern", title: "First task", task: "Read the sample", taskId: "T1", model: { provider: "faux", modelId: "faux-1" },
			})], { stopReason: "toolUse" });
			if (last?.role === "user" && last.content === "Move the worker") return fauxAssistantMessage([fauxToolCall("worker_send", {
				id: "fern", taskId: "T2", message: "Read the next sample", title: "Next task",
			})], { stopReason: "toolUse" });
			return fauxAssistantMessage("The sample is ready.");
		}));
		const log = setup.server.requestLog!;
		const queries = { projectId: project.id, from: 0, to: Date.now() + DAY };
		for (const [text, taskId] of [["Start the worker", "T1"], ["Move the worker", "T2"]] as const) {
			const submitted = await runtime.conversation.submit({ type: "input", content: text, requestId: text }, BACKGROUND_CONTEXT);
			await submitted.wait(BACKGROUND_CONTEXT);
			let logged = false;
			for (let attempt = 0; attempt < 200; attempt++) {
				const worker = (await runtime.workers.state()).workers.fern;
				await log.flush();
				if (worker?.status === "idle" && worker.taskId === taskId && log.store.rows(queries).some(row => row.workerId === "fern" && row.taskId === taskId)) {
					logged = true;
					break;
				}
				await Bun.sleep(20);
			}
			expect(logged).toBe(true);
		}
		expect(log.store.rows(queries).filter(row => row.workerId === "fern").map(row => row.taskId)).toEqual(["T1", "T2"]);
		expect(log.store.taskUsage(project.id, ["T1", "T2"]).map(row => [row.task_id, row.requests])).toEqual([["T1", 1], ["T2", 1]]);
	} finally { await setup.cleanup(); }
}, 20_000);
