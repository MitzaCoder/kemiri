import { afterEach, expect, test } from "bun:test";
import { createECDH, randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NOTIFICATION_HOLD_MS, type NotificationsAlertEvent } from "@kemiri/protocol";
import { NOTIFICATION_RECENT_FILE_NAME } from "../src/notification-alerts.ts";
import { coordinatorWriter, type BoardService } from "../src/board.ts";
import type { DeployTarget, TaskDeployFact } from "../src/task-deploys.ts";
import { httpEnroll, until } from "./device-auth-test-support.ts";
import { createSetup, TestClient, type TestSetup } from "./support.ts";

const DEVICE = "fixture-device";
const FIXTURE_MODEL = { provider: "faux", modelId: "faux-1" };

async function alertClient(setup: TestSetup, options: { token?: string; features?: string[] } = {}) {
	const client = await TestClient.open(setup.server);
	afterEach(() => client.close());
	const hello = await client.request({ type: "hello", protocolVersion: 1,
		client: { name: "fixture", features: options.features ?? ["in-app-alerts"] },
		...(options.token ? { auth: { accessToken: options.token } } : {}),
	});
	expect(hello).toMatchObject({ type: "hello", features: expect.arrayContaining(["in-app-alerts"]) });
	return client;
}

async function alertFor(client: TestClient, match: (event: NotificationsAlertEvent) => boolean) {
	const event = await client.waitFor(message => message.type === "notifications.alert" && match(message), 4_000).catch(cause => {
		const kinds = client.messages.filter(message => message.type === "notifications.alert").map(event => event.alert.kind);
		throw new Error(`No matching alert (received ${kinds.join(", ")})`, { cause });
	});
	if (event.type !== "notifications.alert") throw new Error("Expected an alert");
	return event;
}

async function recent(client: TestClient, after = 0) {
	const response = await client.request({ type: "notifications.recent", after });
	if (response.type !== "notifications.recent") throw new Error(JSON.stringify(response));
	return response;
}

async function projectOf(client: TestClient, setup: TestSetup, configure = false) {
	const project = await client.request({ type: "projects.add", path: setup.projectDir });
	if (project.type !== "projects.add") throw new Error(JSON.stringify(project));
	const id = project.project.id;
	if (configure) expect(await client.request({ type: "projects.configure", projectId: id, coordinatorModel: FIXTURE_MODEL, workerModels: [FIXTURE_MODEL] })).toMatchObject({ type: "projects.configure" });
	return id;
}

async function submit(client: TestClient, projectId: string, content: string, requestId: string) {
	expect(await client.request({ type: "conversation.submit", projectId, content, requestId })).toMatchObject({ type: "conversation.submit" });
}

const reply = (key: string, projectId: string | null = null) => ({ kind: "reply" as const, key, title: "Synthetic reply", body: "Example reply text", projectId });

async function presence(client: TestClient, visible: boolean, projectId: string | null = null) {
	expect(await client.request({ type: "notifications.presence", deviceId: DEVICE, visible, projectId })).toMatchObject({ type: "notifications.presence" });
}

async function interact(client: TestClient, dropped = 0) {
	expect(await client.request({ type: "notifications.interaction", deviceId: DEVICE, onScreenProjectId: null })).toMatchObject({ type: "notifications.interaction", dropped });
}

test("broadcasts before the push hold, ignores push preferences in-app, and dedupes claimed keys", async () => {
	let pushes = 0;
	const scheduled = new Set<() => void>();
	const now = Date.now();
	const setup = await createSetup({ terminals: false, notifications: {
		now: () => now,
		send: async () => { pushes++; return { status: 201, message: null }; },
		schedule: (run, delayMs) => {
			expect(delayMs).toBe(NOTIFICATION_HOLD_MS);
			scheduled.add(run);
			return () => { scheduled.delete(run); };
		},
	} });
	const { notifications } = setup.server;
	const listener = await alertClient(setup);
	const legacy = await alertClient(setup, { features: [] });
	await presence(listener, true);
	// No registered device at all: in-app messages are independent of push.
	await notifications.deliver(reply("before-registration"));
	await alertFor(listener, event => event.alert.key === "before-registration");
	const ecdh = createECDH("prime256v1");
	await notifications.register({
		deviceId: DEVICE, label: "Synthetic browser", backendKey: "fixture",
		subscription: { endpoint: "https://push.example/fixture", keys: {
			p256dh: ecdh.generateKeys().toString("base64url"), auth: randomBytes(16).toString("base64url"),
		} },
		preferences: { kinds: ["reply"], mutedProjects: [], quietHours: null },
	});
	const event = reply("held", "another-project");
	expect(await notifications.deliver(event)).toMatchObject({ skipped: "held" });
	const live = await alertFor(listener, ({ alert }) => alert.key === "held");
	expect(live).toMatchObject({ sound: false, alert: { kind: "reply", level: "important", projectId: "another-project" } });
	expect(pushes).toBe(0);
	expect(scheduled.size).toBe(1);
	expect(await notifications.deliver(event)).toMatchObject({ skipped: "duplicate" });
	await notifications.deliver({ ...reply("push-disabled"), kind: "worker_report" });
	expect(await alertFor(listener, ({ alert }) => alert.key === "push-disabled")).toMatchObject({ alert: { level: "inbox" } });
	expect(scheduled.size).toBe(1);
	const after = await recent(listener, live.alert.seq);
	expect(after.events).toMatchObject([{ type: "alert", alert: { key: "push-disabled" }, resolved: false }]);
	expect(listener.messages.filter(message => message.type === "notifications.alert" && message.alert.key === "held")).toHaveLength(1);
	await legacy.request({ type: "projects.list" });
	expect(legacy.messages.some(message => message.type === "notifications.alert")).toBe(false);

	// A different connection may acknowledge the pop-up; only a later interaction drops the held push.
	const viewer = await alertClient(setup);
	expect(await viewer.request({ type: "notifications.shown", keys: ["held", "unknown"] })).toMatchObject({ type: "notifications.shown" });
	expect(notifications.heldCount).toBe(1);
	await interact(listener, 1);
	expect(notifications.heldCount).toBe(0);
	expect(scheduled.size).toBe(0);
	expect(pushes).toBe(0);
});

test("only the most recent visible signed-in socket is selected for sound", async () => {
	let now = Date.now();
	const setup = await createSetup({ terminals: false, auth: { mode: "optional" }, notifications: { now: () => now } });
	const { accessToken } = await httpEnroll(setup);
	const first = await alertClient(setup, { token: accessToken });
	const second = await alertClient(setup, { token: accessToken });
	const anonymous = await alertClient(setup);
	await presence(first, true);
	await presence(second, true);
	await presence(anonymous, true);
	await interact(first);
	await interact(second); // Same clock tick; the last report still wins.
	await interact(anonymous);
	const soundsFor = async (key: string) => {
		await setup.server.notifications.deliver({ ...reply(key), kind: "disk_low" });
		return Promise.all([first, second].map(async client => (await alertFor(client, ({ alert }) => alert.key === key)).sound));
	};
	expect(await soundsFor("same-tick")).toEqual([false, true]);
	await presence(second, false);
	await interact(second);
	expect(await soundsFor("hidden")).toEqual([true, false]);
	now += 30 * 60_000 + 1;
	expect(await soundsFor("stale")).toEqual([false, false]);
	expect(await anonymous.request({ type: "notifications.recent", after: 0 })).toMatchObject({ type: "error", error: { code: "auth_required" } });
	expect(await anonymous.request({ type: "notifications.shown", keys: ["stale"] })).toMatchObject({ type: "error", error: { code: "auth_required" } });
	expect(anonymous.messages.some(message => message.type === "notifications.alert")).toBe(false);
});

test("archived projects never enter the stream or history", async () => {
	const setup = await createSetup({ terminals: false });
	const client = await alertClient(setup);
	const projectId = await projectOf(client, setup);
	expect(await client.request({ type: "projects.configure", projectId, archived: true })).toMatchObject({ type: "projects.configure" });
	expect(await setup.server.notifications.deliver(reply("archived-reply", projectId))).toMatchObject({ skipped: "filtered" });
	expect((await recent(client)).events).toEqual([]);
	expect(client.messages.some(message => message.type === "notifications.alert")).toBe(false);
});

test("keeps the recent cursor through restart, caps by count and age, and changes epoch after loss", async () => {
	let now = Date.now();
	const setup = await createSetup({ terminals: false, notifications: { now: () => now } });
	const client = await alertClient(setup);
	for (let i = 0; i < 204; i++) await setup.server.notifications.deliver(reply(`fixture:${i}`));
	const page = await recent(client);
	expect(page.latestSeq).toBe(204);
	expect(page.events).toHaveLength(200);
	expect(page.events[0]).toMatchObject({ type: "alert", alert: { seq: 5 } });
	await setup.restart();
	const reconnected = await alertClient(setup);
	expect(await recent(reconnected, 203)).toMatchObject({ backendEpoch: page.backendEpoch, latestSeq: 204,
		events: [{ type: "alert", alert: { seq: 204 } }] });
	now += 7 * 24 * 60 * 60_000 + 1;
	expect(await recent(reconnected)).toMatchObject({ backendEpoch: page.backendEpoch, latestSeq: 204, events: [] });
	await setup.server.notifications.flush();
	await rm(join(setup.dataDir, "notifications", NOTIFICATION_RECENT_FILE_NAME));
	await setup.restart();
	const restored = await alertClient(setup);
	const reset = await recent(restored, 204);
	expect(reset).toMatchObject({ latestSeq: 0, events: [] });
	expect(reset.backendEpoch).not.toBe(page.backendEpoch);
	await setup.server.notifications.deliver(reply("new-epoch"));
	expect(await recent(restored, 0)).toMatchObject({ latestSeq: 1, events: [{ type: "alert", alert: { backendEpoch: reset.backendEpoch, seq: 1 } }] });
});

const board = (args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall("board", args as never)], { stopReason: "toolUse" });

async function resolved(client: TestClient, tag: string, after: number) {
	const event = await client.waitFor(message => message.type === "notifications.resolved" && message.seq > after && message.tags.includes(tag), 4_000).catch(cause => { throw new Error(`No resolution for ${tag}`, { cause }); });
	if (event.type !== "notifications.resolved") throw new Error("Expected a resolution");
	return event;
}

test("resolves an answered question, a withdrawn warning, and a task that leaves review", async () => {
	const setup = await createSetup({ terminals: false });
	const client = await alertClient(setup);
	const projectId = await projectOf(client, setup, true);
	setup.faux.setResponses([
		board({ action: "add_task", title: "Sort the recipes" }),
		board({ action: "ask", text: "Which folder?", taskId: "T1", choices: [{ label: "Shared", recommended: true }, { label: "Local" }] }),
		board({ action: "ask", kind: "warning", text: "A stale draft remains." }),
		board({ action: "update_task", id: "T1", expectedRevision: 1, status: "review" }),
		fauxAssistantMessage("Ready."), fauxAssistantMessage("Answer received."),
		board({ action: "resolve_question", id: "Q2", expectedRevision: 1 }), fauxAssistantMessage("Retracted."),
	]);
	await submit(client, projectId, "Sort the recipes.", "sort");
	const [{ alert: question }, { alert: warning }, { alert: review }] = await Promise.all([
		alertFor(client, ({ alert }) => alert.questionId === "Q1"),
		alertFor(client, ({ alert }) => alert.questionId === "Q2"),
		alertFor(client, ({ alert }) => alert.kind === "task_review"),
	]);
	expect(question).toMatchObject({ level: "urgent", projectId, taskId: "T1", threadId: "main", questionRevision: 1,
		warning: false, approval: false, choices: [{ label: "Shared", recommended: true }, { label: "Local", recommended: false }] });
	expect(warning).toMatchObject({ level: "important", warning: true, choices: [] });
	expect(await client.request({ type: "board.question.answer", projectId, questionId: "Q1", answer: "Shared", expectedRevision: 1 })).toMatchObject({ type: "board.question.answer" });
	await resolved(client, question.tag, question.seq);
	const currentBoard = await client.request({ type: "board.get", projectId });
	if (currentBoard.type !== "board.get") throw new Error(JSON.stringify(currentBoard));
	const task = currentBoard.board.tasks.find(row => row.id === review.taskId)!;
	expect(await client.request({ type: "board.task.save", projectId, taskId: task.id, expectedRevision: task.revision, task: {
		title: task.title, status: "done", description: "", acceptance: null,
		blockedBy: [], blockedReason: null, writeScopes: [],
	} })).toMatchObject({ type: "board.task.save" });
	await resolved(client, review.tag, review.seq);
	await submit(client, projectId, "Retract the warning.", "retract");
	await resolved(client, warning.tag, warning.seq);
	const history = await recent(client);
	for (const alert of [question, warning, review]) expect(history.events).toContainEqual({ type: "alert", alert, resolved: true });
});

test("resolves the previous question wording without closing its replacement", async () => {
	const setup = await createSetup({ terminals: false });
	const client = await alertClient(setup);
	const projectId = await projectOf(client, setup, true);
	setup.faux.setResponses([
		board({ action: "ask", text: "Which storage?" }), fauxAssistantMessage("Waiting."),
		board({ action: "reply_question", id: "Q1", expectedRevision: 2, text: "Choose how to share drafts.", revisedText: "Which shared folder?", revisedOptions: ["Recipes"] }),
		fauxAssistantMessage("Clarified."),
	]);
	await submit(client, projectId, "Plan storage.", "storage");
	const { alert: initial } = await alertFor(client, ({ alert }) => alert.questionRevision === 1);
	await alertFor(client, ({ alert }) => alert.kind === "reply");
	expect(await client.request({ type: "board.question.clarify", projectId, questionId: "Q1", expectedRevision: 1, text: "What is being stored?" })).toMatchObject({ type: "board.question.clarify" });
	const cleared = await resolved(client, initial.tag, initial.seq);
	const { alert: replacement } = await alertFor(client, ({ alert }) => alert.tag === initial.tag && alert.seq > cleared.seq);
	expect(replacement).toMatchObject({ body: "Choose how to share drafts.", questionRevision: 3, choices: [{ label: "Recipes", recommended: false }] });
	expect(replacement.key).not.toBe(initial.key);
	expect((await recent(client)).events).toContainEqual({ type: "alert", alert: replacement, resolved: false });
});

test("alerts on the main coordinator failure and resolves it when a later turn runs", async () => {
	const setup = await createSetup({ terminals: false });
	const client = await alertClient(setup);
	const projectId = await projectOf(client, setup, true);
	setup.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Example provider unavailable" })]);
	await submit(client, projectId, "Start.", "start");
	const { alert } = await alertFor(client, ({ alert }) => alert.kind === "coordinator_failed");
	expect(alert).toMatchObject({ level: "important", projectId, threadId: "main", coordinatorId: "main", body: "Example provider unavailable" });
	expect(alert.tag).toBe(`coordinator-failed:${projectId}:main`);
	setup.faux.setResponses([fauxAssistantMessage("Recovered.")]);
	await submit(client, projectId, "Retry.", "retry");
	await resolved(client, alert.tag, alert.seq);
});

test("a later successful deploy resolves the previous deploy problem", async () => {
	const setup = await createSetup({ terminals: false });
	const client = await alertClient(setup);
	const attempt = { description: "Synthetic release", message: "Health check failed", commit: "0123456789", at: new Date().toISOString() };
	await setup.server.notifications.deployProblem({ ...attempt, state: "failed" });
	const { alert } = await alertFor(client, ({ alert }) => alert.kind === "deploy_problem");
	expect(alert).toMatchObject({ level: "urgent", projectId: null, tag: "deploy" });
	await setup.server.notifications.deployProblem({ ...attempt, state: "ok", commit: "abcdef", message: null });
	await resolved(client, alert.tag, alert.seq);
});

test("uses the secondary coordinator's chat as the failure target and resolves it on retry", async () => {
	const setup = await createSetup({ terminals: false });
	const client = await alertClient(setup);
	const projectId = await projectOf(client, setup, true);
	const created = await client.request({ type: "threads.create", projectId, title: "Recipe desk", area: "Sort the recipes." });
	if (created.type !== "threads.create") throw new Error(JSON.stringify(created));
	const threadId = created.thread.id;
	setup.faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Example error" })]);
	expect(await client.request({ type: "conversation.submit", projectId, threadId, content: "Start sorting.", requestId: "start-thread" })).toMatchObject({ type: "conversation.submit" });
	const { alert } = await alertFor(client, ({ alert }) => alert.kind === "coordinator_failed");
	expect(alert).toMatchObject({ projectId, coordinatorId: threadId, threadId, body: "Example error" });
	setup.faux.setResponses([fauxAssistantMessage("Recovered.")]);
	expect(await client.request({ type: "conversation.submit", projectId, threadId, content: "Try again.", requestId: "retry-thread" })).toMatchObject({ type: "conversation.submit" });
	await resolved(client, alert.tag, alert.seq);
});

test("resolves failed workers when their coordinator sends new work or forgets them", async () => {
	const setup = await createSetup({ terminals: false });
	const client = await alertClient(setup);
	const projectId = await projectOf(client, setup, true);
	const workerTool = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });
	setup.faux.setResponses(Array.from({ length: 24 }, () => request => {
		const last = request.messages.findLast(message => message.role !== "system");
		const text = JSON.stringify(last?.content ?? "");
		if (last?.role === "toolResult") return fauxAssistantMessage("Noted.");
		if (text.includes("Sort the fixture recipes.")) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "Example worker error" });
		if (text.includes("Start retry fixture.")) return workerTool("worker_spawn", { id: "retry-worker", task: "Sort the fixture recipes." });
		if (text.includes("Start forget fixture.")) return workerTool("worker_spawn", { id: "forget-worker", task: "Sort the fixture recipes." });
		if (text.includes("Retry the failed worker.")) return workerTool("worker_send", { id: "retry-worker", message: "Check the cookbook." });
		if (text.includes("Forget the failed worker.")) return workerTool("worker_forget", { id: "forget-worker" });
		return fauxAssistantMessage("Reviewed.");
	}));
	await submit(client, projectId, "Start retry fixture.", "spawn-retry");
	const { alert: retry } = await alertFor(client, ({ alert }) => alert.kind === "worker_failed" && alert.workerId === "retry-worker");
	await submit(client, projectId, "Retry the failed worker.", "worker-retry");
	await resolved(client, retry.tag, retry.seq);
	await submit(client, projectId, "Start forget fixture.", "spawn-forget");
	const { alert: forget } = await alertFor(client, ({ alert }) => alert.kind === "worker_failed" && alert.workerId === "forget-worker");
	await submit(client, projectId, "Forget the failed worker.", "worker-forget");
	await resolved(client, forget.tag, forget.seq);
});


const fixtureTask = {
	title: "Check the recipe", description: "", acceptance: null, status: "todo" as const,
	blockedBy: [], blockedReason: null, writeScopes: [],
};

test("steps notify once per changed report version and resolve when cleared or closed", async () => {
	const now = Date.now();
	const setup = await createSetup({ terminals: false, now: () => now });
	const client = await alertClient(setup);
	const projectId = await projectOf(client, setup);
	const { runtime } = await setup.server.manager.open(projectId);
	const task = await runtime.board.saveTask({ task: fixtureTask }, "harness");
	const commit: Parameters<BoardService["writeReport"]>[0] = change => runtime.harness.commit(change, BACKGROUND_CONTEXT);
	const write = (key: string, steps: string) => runtime.board.writeReport(commit, {
		taskId: task.id, sections: { steps, results: key }, by: coordinatorWriter("main"),
	}, key);
	const written = await write("first", "1. Approve the fixture release.");
	expect(written.report.steps).toBe("1. Approve the fixture release.");
	const { alert: first } = await alertFor(client, ({ alert }) => alert.kind === "task_steps");
	expect(first).toMatchObject({ level: "important", taskId: task.id, projectId, title: "Your steps · project", body: `${task.id} ${task.title}` });
	await write("unchanged-steps", "1. Approve the fixture release.");
	expect((await recent(client, first.seq)).events).toEqual([]);
	await write("clear", "");
	await resolved(client, first.tag, first.seq);
	await write("new-version", "1. Approve the fixture release.");
	const { alert: again } = await alertFor(client, ({ alert }) => alert.tag === first.tag && alert.seq > first.seq);
	expect(again.key).not.toBe(first.key); // The clock did not move; a cleared and rewritten list is a fresh version.
	expect(await client.request({ type: "board.task.save", projectId, taskId: task.id, expectedRevision: task.revision,
		task: { ...fixtureTask, status: "dropped" } })).toMatchObject({ type: "board.task.save" });
	await resolved(client, again.tag, again.seq);
	for (const alert of [first, again]) expect((await recent(client)).events).toContainEqual({ type: "alert", alert, resolved: true });
});

test("review covers steps written in the same coordinator turn, not later steps on a task in review", async () => {
	const setup = await createSetup({ terminals: false });
	const client = await alertClient(setup);
	const projectId = await projectOf(client, setup, true);
	setup.faux.setResponses([
		board({ action: "add_task", title: "First recipe" }),
		board({ action: "add_task", title: "Second recipe" }),
		board({ action: "write_report", id: "T1", steps: "1. Check the recipe." }),
		board({ action: "update_task", id: "T1", expectedRevision: 1, status: "review" }),
		board({ action: "update_task", id: "T2", expectedRevision: 1, status: "review" }),
		board({ action: "write_report", id: "T2", steps: "1. Check the instructions." }),
		fauxAssistantMessage("Both recipes are ready."),
		board({ action: "write_report", id: "T1", steps: "1. Approve the new wording." }),
		fauxAssistantMessage("The first recipe has a new step."),
	]);
	await submit(client, projectId, "Prepare both recipes.", "recipes");
	await alertFor(client, ({ alert }) => alert.kind === "task_review" && alert.taskId === "T1");
	await alertFor(client, ({ alert }) => alert.kind === "task_review" && alert.taskId === "T2");
	await alertFor(client, ({ alert }) => alert.kind === "reply" && alert.body === "Both recipes are ready.");
	const { runtime } = await setup.server.manager.open(projectId);
	await until(async () => Object.keys((await runtime.board.state()).taskStepsNotices ?? {}).length === 0);
	expect((await recent(client)).events.filter(entry => entry.type === "alert" && entry.alert.kind === "task_steps")).toEqual([]);
	await submit(client, projectId, "Add a new manual step.", "steps");
	expect(await alertFor(client, ({ alert }) => alert.kind === "task_steps")).toMatchObject({ alert: { taskId: "T1", level: "important" } });
});

test("a project deploy reports once per attempt and only a current success of that project resolves it", async () => {
	const setup = await createSetup({ terminals: false });
	const client = await alertClient(setup);
	const projectId = await projectOf(client, setup);
	const { runtime } = await setup.server.manager.open(projectId);
	const secondDir = join(setup.root, "second-project");
	await mkdir(secondDir);
	const second = await setup.server.manager.store.add(secondDir);
	const { runtime: other } = await setup.server.manager.open(second.id);
	const task = await runtime.board.saveTask({ task: fixtureTask }, "harness");
	const now = new Date().toISOString();
	const outcome = (sequence: number, order: number, attemptId: string, one: DeployTarget["state"], two: DeployTarget["state"]): TaskDeployFact => ({
		scope: "fixture-feed", taskIds: [task.id], order, attemptId, sequence,
		intendedCommit: "a".repeat(40), expectedTargets: ["one", "two"], observedAt: now,
		targets: { one: { state: one }, two: { state: two } },
	});
	await runtime.board.recordDeployAttempt(outcome(1, 1, "first", "running", "pending"));
	await runtime.board.recordDeployAttempt(outcome(2, 2, "second", "failed", "pending"));
	const { alert } = await alertFor(client, ({ alert }) => alert.kind === "deploy_problem" && alert.projectId === projectId);
	expect(alert).toMatchObject({ projectId, taskId: task.id, level: "urgent", body: "Deploy failed on 1 of 2 targets" });
	await runtime.board.recordDeployAttempt(outcome(2, 2, "second", "failed", "pending"));
	await runtime.board.recordDeployAttempt(outcome(3, 2, "second", "rolled_back", "ok"));
	await runtime.board.recordDeployAttempt(outcome(4, 1, "first", "ok", "ok")); // Late completion of an older attempt.
	await runtime.board.recordDeployAttempt(outcome(5, 3, "third", "ok", "pending"));
	await other.board.recordDeployAttempt(outcome(1, 1, "other", "ok", "ok"));
	const backend = { commit: "abcdef", description: "Backend fixture", at: now };
	await setup.server.notifications.deployProblem({ ...backend, state: "failed", message: "Example failure" });
	const { alert: backendAlert } = await alertFor(client, ({ alert }) => alert.kind === "deploy_problem" && alert.projectId === null);
	await runtime.board.recordDeployAttempt(outcome(6, 3, "third", "ok", "ok"));
	const recovery = await resolved(client, alert.tag, alert.seq);
	expect(recovery.tags).toEqual([alert.tag]);
	expect((await recent(client)).events).toContainEqual({ type: "alert", alert: backendAlert, resolved: false });
	expect((await recent(client, alert.seq)).events.filter(entry => entry.type === "alert" && entry.alert.projectId === projectId)).toEqual([]);
	await runtime.board.recordDeployAttempt(outcome(7, 2, "second", "failed", "pending")); // No stale re-alert after recovery.
	await runtime.board.recordDeployAttempt(outcome(8, 8, "fourth", "rolled_back", "ok"));
	const { alert: next } = await alertFor(client, ({ alert: newer }) => newer.tag === alert.tag && newer.seq > recovery.seq);
	expect(next.title).toBe("Deploy rolled back · project");
	expect(next.key).not.toBe(alert.key);
	await setup.server.notifications.deployProblem({ ...backend, state: "ok", message: null });
	await resolved(client, backendAlert.tag, backendAlert.seq);
	expect((await recent(client)).events).toContainEqual({ type: "alert", alert: next, resolved: false });
});
