import { afterEach, expect, it } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryExtractionService, MemoryExtractionStore } from "../src/memory-extraction.ts";
import { MemoryMaintenanceStore } from "../src/memory-maintenance.ts";
import { ProjectStore, type Project } from "../src/projects.ts";
import { createSetup } from "./support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function until(check: () => Promise<boolean>) {
	for (let i = 0; i < 200; i++) {
		if (await check()) return;
		await Bun.sleep(10);
	}
	throw new Error("timed out");
}

async function extractionFixture() {
	const test = await createSetup(); cleanups.push(test.cleanup);
	const projects = new ProjectStore(test.dataDir);
	const logs: string[] = [];
	const entry = { id: 3, kind: "pi.compaction", head: 2 } as EntryRecord;
	const old = { id: 1, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: "Use bun for tests.", timestamp: 1 }] } as unknown as EntryRecord;
	const conversation = {
		id: 1,
		agent: async () => ({ model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" }),
		entries: async (query: { minEntryId?: number; maxEntryId?: number }) => ({ items: query.maxEntryId ? [old] : (query.minEntryId ?? 0) <= 3 ? [entry] : [] }),
		context: async () => ({ entries: [old] }),
	} as unknown as Conversation;
	const store = () => new MemoryExtractionStore({ projects });
	const make = (progress: MemoryExtractionStore) => {
		const service = new MemoryExtractionService({ project: () => ({ id: "p" } as Project), conversation, memory: test.server.manager.memory, store: progress, models: test.models, log: line => logs.push(line) });
		cleanups.push(() => service.stop());
		return service;
	};
	return { test, logs, store, make };
}

it("failed extraction retries at a later wake, survives restart and gives up after three attempts", async () => {
	const f = await extractionFixture();
	let calls = 0;
	f.test.faux.setResponses(Array.from({ length: 10 }, () => () => {
		calls++;
		return fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic provider down" });
	}));
	let store = f.store(); let service = f.make(store);
	service.wake();
	await until(async () => (await store.failure("p"))?.attempts === 1);
	expect(await store.lastProcessed("p")).toBeNull();
	await service.stop(); // A new service over a newly read state file resumes the same compaction.
	store = f.store(); service = f.make(store);
	service.wake();
	await until(async () => (await store.failure("p"))?.attempts === 2);
	expect(await store.lastProcessed("p")).toBeNull();
	service.wake();
	await until(async () => await store.lastProcessed("p") === 3);
	expect(await store.failure("p")).toEqual({ entryId: 3, attempts: 3, outcome: "gave_up", reason: "synthetic provider down" });
	await service.stop();
	store = f.store(); service = f.make(store); service.wake(); await service.stop();
	expect(calls).toBe(3);
	expect(f.logs.some(line => line.includes("gave_up"))).toBe(true);
});

it("a restart between final failure and progress write does not buy another model attempt", async () => {
	const f = await extractionFixture();
	const store = f.store();
	for (let i = 0; i < 3; i++) await store.recordFailure("p", 3, "offline");
	const reopened = f.store(); const service = f.make(reopened);
	service.wake(); await until(async () => await reopened.lastProcessed("p") === 3);
	expect(f.test.faux.state.callCount).toBe(0);
	expect((await reopened.failure("p"))?.outcome).toBe("gave_up");
});

it("an extraction can recover on its second attempt, commit and clear pending failure", async () => {
	const f = await extractionFixture(); const store = f.store(); const service = f.make(store);
	f.test.faux.setResponses([
		fauxAssistantMessage("", { stopReason: "error", errorMessage: "temporary failure" }),
		(_request, options) => {
			if (!options?.sessionId) throw new Error("MissingSessionID");
			return fauxAssistantMessage([fauxToolCall("memory_write", { fileId: "testing", text: "Use bun for tests.", scope: "project" })], { stopReason: "toolUse" });
		},
		fauxAssistantMessage("Saved."),
	]);
	service.wake(); await until(async () => (await store.failure("p"))?.attempts === 1);
	service.wake(); await until(async () => await store.lastProcessed("p") === 3);
	expect(await store.failure("p")).toBeUndefined();
	expect((await f.test.server.manager.memory.history("project", "p", 10))[0]?.kind).toBe("extraction");
});

it("old extraction and maintenance state files load; recent maintenance history is capped at ten", async () => {
	const root = await mkdtemp(join(tmpdir(), "memory-legacy-"));
	cleanups.push(() => rm(root, { recursive: true, force: true }));
	const projects = new ProjectStore(root);
	const extraction = new MemoryExtractionStore({ projects });
	await Bun.write(extraction.fileOf("p"), JSON.stringify({ version: 1, lastProcessedEntryId: 7, threads: { "2": 9 } }));
	expect(await extraction.lastProcessed("p")).toBe(7);
	expect(await extraction.lastProcessed("p", 2)).toBe(9);
	expect(await extraction.failure("p")).toBeUndefined();
	const store = new MemoryMaintenanceStore({ dataDir: root });
	const lastRun = { at: "2026-01-01T00:00:00Z", outcome: "failed", commit: null, message: "offline" } as const;
	await Bun.write(store.file, JSON.stringify({ version: 1, scopes: { global: { lastRunHead: "old-head", nightlyAt: lastRun.at, lastRun } } }));
	expect(await store.scopeRecord("global")).toEqual({ lastRunHead: "old-head", nightlyAt: lastRun.at, lastRun, lastAttemptHead: null, recentRuns: [] });
	await store.updateScope("global", { recentRuns: Array.from({ length: 12 }, (_, i) => ({ ...lastRun, at: String(i), trigger: "manual" as const })) });
	const reopened = new MemoryMaintenanceStore({ dataDir: root });
	expect((await reopened.scopeRecord("global")).recentRuns.map(run => run.at)).toEqual(Array.from({ length: 10 }, (_, i) => String(i)));
});
