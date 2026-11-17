import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractWorkerLesson, filterWorkerLessonSecrets, MAX_WORKER_LESSONS, MAX_WORKER_LESSON_BYTES, MAX_WORKER_LESSON_PROMPT_CHARS, WorkerLessonStore, workerLessonBatch } from "../src/worker-lessons.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(): Promise<{ dataDir: string; store: WorkerLessonStore }> {
	const dataDir = await mkdtemp(join(tmpdir(), "worker-lessons-"));
	roots.push(dataDir);
	return { dataDir, store: new WorkerLessonStore({ dataDir }) };
}
const report = (text: string) => `## Report\nOutcome: done\nWorth remembering: ${text}`;
const capture = (store: WorkerLessonStore, text: string, workerId = "reader") => store.capture({
	projectId: "project", workerId, taskId: "T12", threadId: null, at: "2026-01-01T00:00:00Z", report: report(text),
});

describe("worker lessons", () => {
	it("extracts single and multi-line report tails and clips after filtering", () => {
		expect(extractWorkerLesson(report("Use bun test."))).toBe("Use bun test.");
		expect(extractWorkerLesson(report("Use bun test.\nUse the portable shell."))).toBe("Use bun test.\nUse the portable shell.");
		expect(extractWorkerLesson(report("Use bun. ".repeat(300)))).toHaveLength(1500);
		expect(extractWorkerLesson("No report field")).toBeNull();
	});

	it("skips empty and none regardless of case and punctuation", () => {
		for (const text of ["", "  \n", "none", "NONE.", "'None'!", "**none**"]) expect(extractWorkerLesson(report(text))).toBeNull();
	});

	it("drops credential-looking lines and private key blocks, keeping safe facts", () => {
		// Synthetic patterns are assembled to keep source hygiene checks from mistaking fixtures for credentials.
		const unsafe = ["Authorization: Bearer " + "example-token", "sk-" + "examplekey", "ghp_" + "examplekey", "xoxb-" + "examplekey",
			"password" + "=example", "api_key" + ": example", "a1".repeat(24), "Ab9+/".repeat(20),
			"-----BEGIN " + "PRIVATE KEY-----", "short private material", "-----END " + "PRIVATE KEY-----"];
		expect(filterWorkerLessonSecrets(["Use bun test.", ...unsafe, "Use sh for scripts."].join("\n"))).toBe("Use bun test.\nUse sh for scripts.");
		expect(extractWorkerLesson(report(unsafe.join("\n")))).toBeNull();
	});

	it("serializes captures, deduplicates repeated worker lessons and survives a new store", async () => {
		const { store, dataDir } = await setup();
		capture(store, "Use bun test.");
		capture(store, "Use bun test.");
		capture(store, "Use bun test.", "another-worker");
		const lessons = await store.list("project");
		expect(lessons).toHaveLength(2);
		expect(new Set(lessons.map((lesson) => lesson.id)).size).toBe(2);
		expect(lessons[0]).toMatchObject({ taskId: "T12", threadId: null, workerId: "reader", text: "Use bun test." });
		expect(await new WorkerLessonStore({ dataDir }).list("project")).toEqual(lessons);
		expect((await stat(join(dataDir, "projects/project/worker-lessons.json"))).mode & 0o777).toBe(0o600);
		await store.consume("project", [lessons[0]!.id]);
		expect(await store.list("project")).toEqual([lessons[1]!]);
	});

	it("drops oldest entries to enforce both count and UTF-8 byte bounds", async () => {
		const { store, dataDir } = await setup();
		for (let i = 0; i < 305; i++) capture(store, `Fact ${i}: use bun test.`);
		let lessons = await store.list("project");
		expect(lessons).toHaveLength(MAX_WORKER_LESSONS);
		expect(lessons[0]!.text).toContain("Fact 5:");
		for (let i = 0; i < 100; i++) capture(store, `Fact ${i}: ${"脚本 ".repeat(500)}`);
		lessons = await store.list("project");
		expect(lessons.length).toBeLessThan(MAX_WORKER_LESSONS);
		expect(lessons.at(-1)!.text).toStartWith("Fact 99:");
		expect(Buffer.byteLength(await readFile(join(dataDir, "projects/project/worker-lessons.json"), "utf8"))).toBeLessThanOrEqual(MAX_WORKER_LESSON_BYTES);
	}, 30_000);

	it("takes whole lessons in order within the prompt cap and leaves later captures untouched", async () => {
		const { store } = await setup();
		for (let i = 0; i < 15; i++) capture(store, `Fact ${i}: ${"use bun. ".repeat(180)}`);
		const all = await store.list("project");
		const batch = workerLessonBatch(all);
		expect(batch.text.length).toBeLessThanOrEqual(MAX_WORKER_LESSON_PROMPT_CHARS);
		expect(batch.lessons.length).toBeGreaterThan(0);
		expect(batch.lessons.length).toBeLessThan(all.length);
		expect(batch.lessons).toEqual(all.slice(0, batch.lessons.length));
		capture(store, "A lesson captured during the run.");
		await store.consume("project", batch.lessons.map((lesson) => lesson.id));
		expect((await store.list("project")).map((lesson) => lesson.text)).toEqual([...all.slice(batch.lessons.length).map((lesson) => lesson.text), "A lesson captured during the run."]);
	});
});
