import { afterEach, expect, it } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { GenerationHooks, HookApi } from "@earendil-works/pi-durable";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkerWorkspaceExtension, type WorkerRecord } from "../src/workers.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(isolation: "shared" | "workspace" = "workspace") {
	const root = await mkdtemp(join(tmpdir(), "kemiri-workspace-hook-"));
	roots.push(root);
	const logs: string[] = [];
	const memos = new Map<string, unknown>();
	const record: WorkerRecord = {
		id: "worker", title: "test", conversationId: 2, isolation, workspacePath: root,
		model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: null,
		status: "running", spawnedByCallId: null, taskId: null,
		createdAt: "", updatedAt: "", lastReport: null, failure: null, anchorTaskId: 1,
	};
	const service: Parameters<typeof createWorkerWorkspaceExtension>[0] = {
		workerOf: async () => ({ record, threadId: "main" }),
		project: { path: root },
		log: (line: string) => logs.push(line),
	};
	const api = {
		conversationId: 2,
		memo: async (key: string, candidate: unknown) => {
			if (candidate !== BACKGROUND_CONTEXT && !memos.has(key)) memos.set(key, candidate);
			return memos.get(key);
		},
	} as unknown as HookApi;
	const handlers = createWorkerWorkspaceExtension(service).hooks![0]!.handlers as GenerationHooks;
	const request = { messages: [{ role: "user" as const, content: "Do the task.", timestamp: 0 }] };
	return { root, logs, memos, record, service, api, request, check: () => handlers.beforeRequest(request, api, BACKGROUND_CONTEXT) };
}

it("surfaces a failure to the worker, logs it once, and never retries during that generation", async () => {
	const f = await fixture();
	const first = await f.check();
	expect(first?.messages.at(-1)?.content).toContain("could not keep your jj workspace current");
	expect(f.logs).toHaveLength(1);
	// Even if the directory becomes a valid repository, the same generation must retain its failure, not retry.
	const child = Bun.spawn(["jj", "git", "init"], { cwd: f.root, stdout: "pipe", stderr: "pipe" });
	expect(await child.exited).toBe(0);
	const again = await f.check();
	expect(again?.messages.at(-1)?.content).toBe(first?.messages.at(-1)?.content);
	expect(f.logs).toHaveLength(1);
});

it("does nothing to shared workers or coordinators", async () => {
	const f = await fixture("shared");
	expect(await f.check()).toBeUndefined();
	expect(f.memos.size).toBe(0);
	f.service.workerOf = async () => undefined;
	expect(await f.check()).toBeUndefined();
	expect(f.logs).toHaveLength(0);
});

it("reports an interrupted update with recovery coordinates without repeating it", async () => {
	const f = await fixture();
	f.memos.set("worker-workspace-update", { change: "kkkkkkkk", operation: "abc123" });
	const response = await f.check();
	expect(response?.messages.at(-1)?.content).toContain("update was interrupted");
	expect(response?.messages.at(-1)?.content).toContain("change_id(kkkkkkkk)");
	expect(response?.messages.at(-1)?.content).toContain("abc123");
	expect(response?.messages.at(-1)?.content).not.toContain("not a jj repo");
	await f.check();
	expect(f.logs).toHaveLength(1);
});

it("updates at a generation boundary and sends a replay-safe recovery note without needing a board task", async () => {
	const f = await fixture();
	const repo = join(f.root, "repo");
	const workspace = join(f.root, "worker");
	await mkdir(repo);
	f.service.project.path = repo;
	async function jj(cwd: string, ...args: string[]) {
		const child = Bun.spawn(["jj", "--config", "user.name=Test", "--config", "user.email=test@example.com", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
		expect({ code, stderr }).toMatchObject({ code: 0 });
		return stdout;
	}
	await jj(repo, "git", "init");
	await writeFile(join(repo, "base.txt"), "base\n");
	await jj(repo, "commit", "-m", "base");
	await jj(repo, "workspace", "add", workspace, "--name", "worker", "--revision", "@");
	f.record.workspacePath = workspace;
	await writeFile(join(workspace, "precious.txt"), "worker edit\n");
	await writeFile(join(repo, "base.txt"), "rewrite\n");
	await jj(repo, "describe", "-m", "rewritten");
	const response = await f.check();
	expect(response?.messages.at(-1)?.content).toContain("harness ran `jj workspace update-stale`");
	expect(response?.messages.at(-1)?.content).toContain("NOT in the working copy");
	expect(f.memos.has("worker-workspace-update")).toBe(true);
	const again = await f.check();
	expect(again?.messages.at(-1)?.content).toBe(response?.messages.at(-1)?.content);
	expect(f.logs).toHaveLength(0);
});
