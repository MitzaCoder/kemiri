import { expect, test } from "bun:test";
import { HARNESS_FEATURES } from "@kemiri/protocol";
import { createSetup, TestClient } from "./support.ts";
import type { TaskDeployFact } from "../src/task-deploys.ts";

const task = { title: "Synthetic task", description: "", acceptance: null, status: "todo" as const, blockedBy: [], blockedReason: null, writeScopes: [] };

function git(path: string, ...args: string[]): string {
	const result = Bun.spawnSync(["git", "-C", path, ...args]);
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}

test("task delivery is opt-in and reads attribution, integration reachability and the latest admitted deploy", async () => {
	const setup = await createSetup();
	const client = await TestClient.open(setup.server);
	try {
		const run = (...args: string[]) => git(setup.projectDir, ...args);
		run("init", "-b", "main");
		run("-c", "user.name=Demo", "-c", "user.email=demo@example.test", "commit", "--allow-empty", "-m", "Baseline");
		const base = run("rev-parse", "HEAD");
		const project = await setup.server.manager.store.add(setup.projectDir);
		const { runtime } = await setup.server.manager.open(project.id);
		await runtime.board.saveTask({ task }, "harness");
		await runtime.board.saveTask({ task }, "harness");
		const hello = await client.hello();
		expect(hello.type === "hello" && hello.features?.includes("task-delivery")).toBe(true);
		const request = async (taskId: string, delivery?: boolean) => {
			const response = await client.request({ type: "board.task.timeline", projectId: project.id, taskId, ...(delivery === undefined ? {} : { delivery }) });
			if (response.type !== "board.task.timeline") throw new Error(`Unexpected ${response.type}`);
			return response.delivery;
		};
		expect(await request("T1", true)).toBeUndefined();
		run("switch", "-c", "work");
		run("-c", "user.name=Demo", "-c", "user.email=demo@example.test", "commit", "--allow-empty", "-m", "First change");
		const hash = run("rev-parse", "HEAD");
		await runtime.taskChanges.declareChanges([hash], ["T1"], "manual");
		expect(await request("T1")).toBeUndefined();
		expect(await request("T1", true)).toEqual({ commits: [hash], integration: { ref: "refs/heads/main", landed: 0 } });
		run("branch", "-f", "main", hash);
		await runtime.taskChanges.poll();
		expect(await request("T1", true)).toEqual({ commits: [hash], integration: { ref: "refs/heads/main", landed: 1 } });

		await runtime.board.configureDeployFeed(true);
		const attempt: TaskDeployFact = { scope: "demo", sequence: 1, order: 1, attemptId: "first", taskIds: ["T1", "T2"], intendedCommit: hash,
			expectedTargets: ["a", "b"], targets: { a: { state: "ok" }, b: { state: "pending" } }, observedAt: new Date().toISOString() };
		await runtime.board.recordDeployAttempt(attempt);
		expect((await request("T1", true))?.deployment).toBe("pending");
		await runtime.board.recordDeployAttempt({ ...attempt, sequence: 2, targets: { a: { state: "ok" }, b: { state: "ok" } } });
		expect((await request("T1", true))?.deployment).toBe("live");
		expect(await request("T2", true)).toBeUndefined();
		await runtime.board.recordDeployAttempt({ ...attempt, sequence: 3, order: 3, attemptId: "second", targets: { a: { state: "ok" }, b: { state: "rolled_back" } } });
		await runtime.board.recordDeployAttempt({ ...attempt, sequence: 4, targets: { a: { state: "ok" }, b: { state: "ok" } } });
		expect((await request("T1", true))?.deployment).toBe("failed");
		await runtime.board.deployFeedAvailability(false);
		expect((await request("T1", true))?.deployment).toBe("unknown");
		await runtime.board.configureDeployFeed(false);
		run("branch", "-f", "main", base);
		await runtime.taskChanges.poll();
		expect(await request("T1", true)).toEqual({ commits: [hash], integration: { ref: "refs/heads/main", landed: 0 } });
		await runtime.taskChanges.declareChanges([hash], ["T2"], "manual");
		expect(await request("T1", true)).toBeUndefined();
	} finally { client.close(); await setup.cleanup(); }
}, 30_000);

test("the server omits delivery when its capability is disabled", async () => {
	const setup = await createSetup({ features: HARNESS_FEATURES.filter(feature => feature !== "task-delivery") });
	const client = await TestClient.open(setup.server);
	try {
		const hello = await client.hello();
		expect(hello.type === "hello" && hello.features?.includes("task-delivery")).toBe(false);
		const project = await setup.server.manager.store.add(setup.projectDir);
		const { runtime } = await setup.server.manager.open(project.id);
		await runtime.board.saveTask({ task }, "harness");
		const response = await client.request({ type: "board.task.timeline", projectId: project.id, taskId: "T1", delivery: true });
		expect(response.type === "board.task.timeline" && response.delivery).toBeUndefined();
	} finally { client.close(); await setup.cleanup(); }
}, 30_000);
