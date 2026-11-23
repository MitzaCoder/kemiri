import { expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { SetTimer } from "@earendil-works/pi-durable";
import type { DrainRunSpend } from "../src/request-log-store.ts";
import { ConversationRequests } from "../src/request-log.ts";
import { CONTINUE_DRAIN_RUNS, KEEP_DRAIN_PAUSED, STOP_DRAIN_RUNS } from "../src/usage-drain-investigation.ts";
import type { NotificationEvent } from "../src/notifications.ts";
import { createSetup, TestClient } from "./support.ts";

const MINUTE = 60_000;
const LOGIN = "opencode-go";
const BASE = Date.parse("2027-01-01T12:00:00Z");
const inexpensive = { provider: LOGIN, modelId: "example-small" };
const expensive = { provider: LOGIN, modelId: "example-large" };

async function until(check: () => boolean | Promise<boolean>) {
	const deadline = Date.now() + 5_000;
	while (!await check() && Date.now() < deadline) await Bun.sleep(10);
	expect(await check()).toBe(true);
}

async function fixture() {
	let now = BASE;
	const timers = new Map<() => void, number>();
	const setTimer: SetTimer = (fire, delay) => { timers.set(fire, now + delay); return () => { timers.delete(fire); }; };
	const advance = (by: number) => {
		now += by;
		for (const [fire, at] of [...timers]) if (at <= now && timers.delete(fire)) fire();
	};
	const subscription = fauxProvider({ provider: LOGIN, models: [{ id: inexpensive.modelId }, { id: expensive.modelId }] });
	const setup = await createSetup({ now: () => now, setTimer, configureModels: models => models.setProvider({ ...subscription.provider,
		auth: { apiKey: { name: "Example plan", resolve: async () => ({ auth: { apiKey: "example-key" } }) } },
	}), subscriptionUsage: { fetch: Object.assign(async () => Response.json({ usage: {} }), { preconnect: fetch.preconnect }) } });
	await setup.credentials.modify(LOGIN, async () => ({ type: "api_key", key: "example-key" }));
	const notices: NotificationEvent[] = [];
	const messages: string[] = [];
	const captureNotices = () => {
		const notify = setup.server.notifications.notify.bind(setup.server.notifications);
		setup.server.notifications.notify = event => {
			if (!notices.some(prior => prior.key === event.key)) notices.push(event);
			notify(event);
		};
	};
	captureNotices();
	let client = await TestClient.open(setup.server); await client.hello();
	let fix: "resume" | "ask" | undefined;
	let failedResume = false;
	let workerAborted = false;
	const route: Parameters<typeof subscription.setResponses>[0][number] = async (context, options) => {
		const last = context.messages.at(-1);
		const text = typeof last?.content === "string" ? last.content : last?.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") ?? "";
		if (text.includes("Make the samples")) {
			await new Promise<void>(resolve => options?.signal?.addEventListener("abort", () => { workerAborted = true; resolve(); }, { once: true }));
			return fauxAssistantMessage("Worker aborted");
		}
		if (text === "Start the preview run") return fauxAssistantMessage(fauxToolCall("worker_spawn", {
			id: "batch-previews", task: "Make the samples", model: expensive, thinkingLevel: "high", isolation: "shared",
		}), { stopReason: "toolUse" });
		if (text.startsWith("[usage]")) {
			messages.push(text);
			const id = /incident (\S+), action resume/.exec(text)?.[1];
			if (id && fix === "resume") return fauxAssistantMessage(fauxToolCall("worker_stop", { id: "batch-previews" }), { stopReason: "toolUse" });
			if (id && fix === "ask") return fauxAssistantMessage(fauxToolCall("usage_pause", { incident: id, action: "ask" }), { stopReason: "toolUse" });
		}
		if (text.includes('Stopped worker "batch-previews"') || text.includes("Give one line")) {
			const facts = messages.findLast(message => message.includes("action resume"))!;
			if (text.includes("Give one line")) failedResume = true;
			return fauxAssistantMessage(fauxToolCall("usage_pause", {
				incident: /incident (\S+), action resume/.exec(facts)![1], action: "resume",
				...(failedResume ? { note: "Stopped the preview worker using the outside model." } : {}),
			}), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("Ready.");
	};
	subscription.setResponses(Array.from({ length: 90 }, () => route));
	const add = async (path: string, name: string) => {
		const result = await client.request({ type: "projects.add", path });
		if (result.type !== "projects.add") throw new Error(JSON.stringify(result));
		const { id } = result.project;
		expect((await client.request({ type: "projects.configure", projectId: id, name, coordinatorModel: inexpensive, workerModels: [inexpensive] })).type).toBe("projects.configure");
		return (await setup.server.manager.open(id)).runtime;
	};
	const primary = await add(setup.projectDir, "Preview studio");
	const second = join(setup.root, "second"); await mkdir(second);
	const other = await add(second, "Separate project");
	const projectId = primary.project.id;
	const coordinator = await primary.threads.create({ title: "Preview coordinator", area: "Make preview images.", model: inexpensive }, "preview-coordinator");
	const coordinatorConversation = await primary.threads.conversation(coordinator.id);
	const issuer = () => setup.server.manager.open(projectId).then(({ runtime }) => runtime);
	const otherSpend: DrainRunSpend = { projectId: other.project.id, conversationId: 812, kind: "worker", model: expensive.modelId,
		workerId: "private-other-run", threadId: "main", requests: 1, apiValue: 2 };
	const coordinatorSpend: DrainRunSpend = { projectId, conversationId: coordinatorConversation.id, kind: "thread", model: inexpensive.modelId,
		workerId: null, threadId: coordinator.id, requests: 1, apiValue: 25 };
	const publish = (spenders: DrainRunSpend[], limitId = "5h", reset = BASE + 180 * MINUTE) => {
		const window = { id: limitId, label: "5-hour limit", windowMinutes: 300, resetsAt: new Date(reset).toISOString() };
		setup.server.usageDrain!.observe(LOGIN, [{ ...window, usedPercent: 60 }], now);
		advance(MINUTE);
		for (const run of spenders) setup.server.requestLog!.store.insert({ ...new ConversationRequests({ projectId: run.projectId, conversationId: run.conversationId,
			identity: { kind: run.kind, workerId: run.workerId, threadId: run.threadId, taskId: null, scheduleId: null },
		}).request({ provider: LOGIN, model: run.model, timestamp: now, usage: { cost: { total: run.apiValue } } },
			{ wake: "user", retention: "short", changes: null, source: "live" }), billing: "subscription", priced: true });
		advance(4 * MINUTE);
		setup.server.usageDrain!.observe(LOGIN, [{ ...window, usedPercent: 82 }], now);
	};
	async function spawn() {
		const submit = await client.request({ type: "conversation.submit", projectId, threadId: coordinator.id, requestId: "spawn", content: "Start the preview run" });
		expect(submit.type).toBe("conversation.submit");
		const worker = async () => (await (await issuer()).workers.state(BACKGROUND_CONTEXT, coordinatorConversation.id)).workers["batch-previews"];
		await until(async () => (await worker())?.status === "running" && subscription.state.callCount >= 3);
		const spend: DrainRunSpend = { projectId, conversationId: (await worker())!.conversationId, kind: "worker",
			workerId: "batch-previews", threadId: coordinator.id, requests: 1, model: expensive.modelId, apiValue: 30 };
		return { spend, worker };
	}
	const pause = () => setup.server.usagePause!.state()[0];
	const question = async () => (await (await issuer()).board.state()).questions.findLast(q => q.usageDrainIncident && q.status === "open");
	const answer = async (text: string) => {
		const q = (await question())!;
		return client.request({ type: "board.question.answer", projectId, questionId: q.id, expectedRevision: q.revision, answer: text });
	};
	const restart = async () => { client.close(); await setup.restart(); captureNotices(); client = await TestClient.open(setup.server); await client.hello(); };
	return { setup, coordinator, coordinatorSpend, otherSpend, messages, notices, issuer, publish, advance, spawn, pause, question, answer, restart,
		setFix: (value: typeof fix) => { fix = value; }, failedResume: () => failedResume, workerAborted: () => workerAborted, client: () => client };
}

it("wakes the spending worker's background coordinator on its own login, fixes once, stays armed and asks on a repeat", async () => {
	const f = await fixture();
	try {
		const { worker, spend } = await f.spawn();
		f.setFix("resume");
		f.publish([spend, f.otherSpend]);
		expect(f.pause()?.drain?.status).toBe("investigating");
		await until(() => f.notices.some(event => event.kind === "usage_drain_paused"));
		expect(f.messages).toHaveLength(1);
		expect(f.messages[0]).toContain('"worker batch-previews" · example-large · thinking high · an agent named this model');
		expect(f.messages[0]).toContain("Other projects on this computer: $2.00 total.");
		expect(f.messages[0]).not.toContain("private-other-run");
		expect(f.failedResume()).toBe(true);
		expect(f.workerAborted()).toBe(true);
		expect((await worker())?.status).toBe("stopped");
		expect(f.pause()).toBeUndefined();
		expect(f.notices.filter(event => event.kind === "usage_drain_paused")).toEqual([expect.objectContaining({
			title: "Paused and fixed: OpenCode Go was draining fast", body: "Stopped the preview worker using the outside model.",
		})]);
		await f.restart();
		f.advance(11 * MINUTE);
		f.publish([spend, f.otherSpend]);
		await until(async () => !!await f.question());
		expect(f.pause()?.drain?.status).toBe("needs-choice");
		expect(f.messages).toHaveLength(1);
		expect(f.notices.filter(event => event.kind === "usage_drain_paused")).toHaveLength(1);
		expect(f.notices.filter(event => event.kind === "board_question")).toHaveLength(1);
	} finally { f.client().close(); }
}, 20_000);

it("keeps the deadline after restart and a Keep paused answer leaves the gate held", async () => {
	const f = await fixture();
	try {
		const { spend } = await f.spawn();
		f.publish([spend]);
		await until(() => f.messages.length === 1);
		f.advance(2 * MINUTE);
		await f.restart();
		f.advance(3 * MINUTE - 1);
		expect(await f.question()).toBeUndefined();
		f.advance(1);
		await until(() => f.pause()?.drain?.questionId !== undefined);
		expect(f.messages).toHaveLength(1);
		expect((await f.answer("something else")).type).toBe("error");
		expect((await f.answer(KEEP_DRAIN_PAUSED)).type).toBe("board.question.answer");
		await until(() => f.pause()?.drain?.status === "kept-paused");
		await f.restart();
		expect(f.pause()?.drain?.status).toBe("kept-paused");
		expect(f.notices.filter(event => event.kind === "board_question")).toHaveLength(1);
		expect(f.notices.filter(event => event.kind === "usage_drain_paused")).toHaveLength(0);
	} finally { f.client().close(); }
}, 20_000);

it("asks immediately when the coordinator spends most and Continue opts out only the same limit until reset", async () => {
	const f = await fixture();
	try {
		f.publish([f.coordinatorSpend, f.otherSpend]);
		await until(() => f.pause()?.drain?.questionId !== undefined);
		expect(f.messages).toHaveLength(0);
		expect((await f.question())?.text).toContain("Preview studio spent most");
		expect((await f.answer(CONTINUE_DRAIN_RUNS)).type).toBe("board.question.answer");
		await until(() => !f.pause());
		await f.restart();
		f.advance(11 * MINUTE);
		f.publish([f.coordinatorSpend]);
		expect(f.pause()).toBeUndefined();
		f.advance(11 * MINUTE);
		f.publish([f.coordinatorSpend], "other-limit");
		await until(() => f.pause()?.drain?.questionId !== undefined);
		expect(f.pause()?.drain?.status).toBe("needs-choice");
	} finally { f.client().close(); }
}, 20_000);

it("asks instead of waking a paused coordinator, then Stop aborts the confirmed outside-model run and requests a restart", async () => {
	const f = await fixture();
	try {
		const { worker, spend } = await f.spawn();
		await (await f.issuer()).threads.hold(f.coordinator.id, true, "owner-pause");
		f.publish([spend, f.otherSpend]);
		await until(() => f.pause()?.drain?.questionId !== undefined);
		expect(f.messages).toHaveLength(0);
		expect((await f.answer(STOP_DRAIN_RUNS)).type).toBe("board.question.answer");
		await until(() => !f.pause());
		expect((await worker())?.status).toBe("stopped");
		expect(f.workerAborted()).toBe(true);
		const threads = (await f.issuer()).threads;
		await threads.hold(f.coordinator.id, false, "owner-resume");
		await until(() => f.messages.some(message => message.includes("Restart it on a project worker model with the same brief.")));
	} finally { f.client().close(); }
}, 20_000);

it("lets the assigned coordinator ask without waiting for the timer", async () => {
	const f = await fixture();
	try {
		const { spend } = await f.spawn();
		f.setFix("ask");
		f.publish([spend]);
		await until(() => f.pause()?.drain?.questionId !== undefined);
		expect(f.messages.some(message => message.includes("action ask"))).toBe(true);
		expect(f.notices.filter(event => event.kind === "usage_drain_paused")).toHaveLength(0);
	} finally { f.client().close(); }
}, 20_000);
