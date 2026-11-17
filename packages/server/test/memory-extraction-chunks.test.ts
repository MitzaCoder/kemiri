import { afterEach, expect, it } from "bun:test";
import { contentText, type TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Conversation, EntryRecord } from "@earendil-works/pi-durable";
import {
	EXTRACTION_DEFAULT_CONTEXT_TOKENS, EXTRACTION_MAX_CHUNK_CHARS, EXTRACTION_MIN_CHUNK_CHARS,
	MAX_EXTRACTION_CHUNKS, MemoryExtractionService, MemoryExtractionStore,
	chunkCompactedPart, describeCompactedEntry, extractionChunkBudgets,
} from "../src/memory-extraction.ts";
import { ProjectStore, type Project } from "../src/projects.ts";
import { createSetup } from "./support.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function span(count: number, chars = 1_100): EntryRecord[] {
	return Array.from({ length: count }, (_, index) => ({
		id: index + 1, conversationId: 1, kind: "pi.user",
		model: [{ role: "user", content: `Entry ${index + 1}: ${index === 0 ? "First fact: tests use bun. "
			: index === count - 1 ? "Last fact: run checks before committing. " : "Synthetic discussion. "}`.padEnd(chars, "."), timestamp: 1 }],
	} as unknown as EntryRecord));
}

function promptOf(request: TranscriptContext): string {
	const message = request.messages.find(message => message.role === "user");
	return message ? contentText(message.content) : "";
}

async function until(check: () => Promise<boolean>) {
	for (let i = 0; i < 400; i++) {
		if (await check()) return;
		await Bun.sleep(10);
	}
	throw new Error("timed out waiting for extraction");
}

async function fixture(entries: EntryRecord[], contextWindow = 16_000) {
	const faux = fauxProvider({ models: [{ id: "chunk-model", contextWindow }] });
	const test = await createSetup({ configureModels: models => models.setProvider(faux.provider) });
	cleanups.push(test.cleanup);
	const compaction = { id: entries.length + 2, kind: "pi.compaction", head: entries.length + 1 } as EntryRecord;
	const conversation = {
		id: 1,
		agent: async () => ({ model: { provider: "faux", modelId: "chunk-model" }, thinkingLevel: "off" }),
		entries: async (query: { minEntryId?: number; maxEntryId?: number }) => ({
			items: query.maxEntryId ? entries.slice(-1) : (query.minEntryId ?? 0) <= compaction.id ? [compaction] : [],
		}),
		context: async () => ({ entries }),
	} as unknown as Conversation;
	const store = new MemoryExtractionStore({ projects: new ProjectStore(test.dataDir) });
	const logs: string[] = [];
	const service = new MemoryExtractionService({
		project: () => ({ id: "p" } as Project), conversation, memory: test.server.manager.memory,
		store, models: test.models, log: line => logs.push(line),
	});
	cleanups.push(() => service.stop());
	return { test, faux, service, store, logs, compaction };
}

it("budgets follow the context window, use a conservative missing-window default and clamp extremes", () => {
	expect(extractionChunkBudgets()).toEqual(extractionChunkBudgets(EXTRACTION_DEFAULT_CONTEXT_TOKENS));
	for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
		expect(extractionChunkBudgets(invalid)).toEqual(extractionChunkBudgets());
	}
	expect(extractionChunkBudgets(1).preferred).toBe(EXTRACTION_MIN_CHUNK_CHARS);
	expect(extractionChunkBudgets(1_000_000).maximum).toBe(EXTRACTION_MAX_CHUNK_CHARS);
	const entries = span(100);
	expect(chunkCompactedPart(entries, 16_000).chunks.length).toBeGreaterThan(chunkCompactedPart(entries, 200_000).chunks.length);
	expect(chunkCompactedPart(entries).chunks).toEqual(chunkCompactedPart(entries, EXTRACTION_DEFAULT_CONTEXT_TOKENS).chunks);
});

it("covers a 400K-character span in four parts at 200K tokens without splitting entries", () => {
	const entries = span(400, 992); // [User]: adds eight characters: exactly 400K before separators.
	const result = chunkCompactedPart(entries, 200_000);
	expect(result.omittedEntries).toBe(0);
	expect(result.chunks).toHaveLength(4);
	expect(result.chunks.join("\n\n")).toBe(entries.flatMap(describeCompactedEntry).join("\n\n"));
	for (const chunk of result.chunks) expect(chunk.length).toBeLessThanOrEqual(EXTRACTION_MAX_CHUNK_CHARS);
});

it("grows chunks within the model budget before dropping anything at the call cap", () => {
	const entries = span(500);
	const result = chunkCompactedPart(entries, 32_000);
	expect(result.omittedEntries).toBe(0);
	expect(result.chunks.length).toBeLessThanOrEqual(MAX_EXTRACTION_CHUNKS);
	expect(result.chunks.some(chunk => chunk.length > extractionChunkBudgets(32_000).preferred)).toBe(true);
	expect(result.chunks.join("\n\n")).toBe(entries.flatMap(describeCompactedEntry).join("\n\n"));
	for (const chunk of result.chunks) expect(chunk.length).toBeLessThanOrEqual(extractionChunkBudgets(32_000).maximum);
});

it("preserves the existing message descriptions and per-message cut", () => {
	const entry = span(1, 5_000)[0]!;
	expect(describeCompactedEntry(entry)[0]?.length).toBe(1_501);
	const oversized = { ...entry, model: Array.from({ length: 100 }, () => entry.model![0]!) } as EntryRecord;
	const clipped = chunkCompactedPart([oversized], 16_000);
	expect(clipped.chunks).toHaveLength(1);
	expect(clipped.chunks[0]!.length).toBe(extractionChunkBudgets(16_000).maximum);
	expect(clipped.chunks[0]!.endsWith("…")).toBe(true);
});

it("all parts reach the fake model oldest first, sharing staged writes, one session and one commit per scope", async () => {
	const entries = span(100);
	const f = await fixture(entries);
	const expected = chunkCompactedPart(entries, 16_000).chunks;
	const prompts: string[] = [];
	const sessions: string[] = [];
	let laterReads = 0;
	f.faux.setResponses(Array.from({ length: 100 }, () => (request, options) => {
		sessions.push(options?.sessionId ?? "");
		const prompt = promptOf(request);
		const part = Number(/Part (\d+) of/.exec(prompt)?.[1]);
		const results = request.messages.filter(message => message.role === "toolResult");
		if (results.length === 0) {
			prompts.push(prompt);
			if (part > 1) {
				expect(prompt).toContain("Earlier parts were already handled");
				return fauxAssistantMessage([fauxToolCall("memory_read", { fileId: "testing", scope: "project" })], { stopReason: "toolUse" });
			}
			return fauxAssistantMessage(["project", "global"].map(scope => fauxToolCall("memory_write", {
				scope, fileId: "testing", heading: "First", text: "First fact: tests use bun.",
			})), { stopReason: "toolUse" });
		}
		if (part > 1 && results.length === 1) {
			expect(contentText(results[0]!.content)).toContain("First fact: tests use bun.");
			laterReads++;
			if (part === expected.length) return fauxAssistantMessage(["project", "global"].map(scope => fauxToolCall("memory_write", {
				scope, fileId: "testing", heading: "Last", text: "Last fact: run checks before committing.",
			})), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("Saved.");
	}));
	f.service.wake();
	await until(async () => await f.store.lastProcessed("p") === f.compaction.id);
	expect(prompts).toHaveLength(expected.length);
	expect(laterReads).toBe(expected.length - 1);
	expect(new Set(sessions).size).toBe(1);
	expect(sessions[0]).not.toBe("");
	for (const [index, prompt] of prompts.entries()) {
		expect(prompt).toContain(`Part ${index + 1} of ${expected.length}`);
		expect(prompt.split("<compacted>\n")[1]?.split("\n</compacted>")[0]).toBe(expected[index]);
	}
	expect(prompts[0]).toContain("First fact");
	expect(prompts.at(-1)).toContain("Last fact");
	for (const scope of ["project", "global"] as const) {
		const history = await f.test.server.manager.memory.history(scope, scope === "project" ? "p" : undefined, 20);
		expect(history).toHaveLength(1);
		expect(history[0]?.kind).toBe("extraction");
		expect(history[0]?.source).toMatchObject({ conversationId: 1, entryId: f.compaction.id });
		const read = await f.test.server.manager.memory.read(scope, scope === "project" ? "p" : undefined, "testing");
		expect(read.file.headings).toEqual(["First", "Last"]);
	}
});

it("keeps the newest chunks at the safety cap and logs the exact skipped entries and characters", async () => {
	const entries = span(1_000);
	const expected = chunkCompactedPart(entries, 16_000);
	expect(expected.chunks).toHaveLength(MAX_EXTRACTION_CHUNKS);
	expect(expected.omittedEntries).toBeGreaterThan(0);
	expect(expected.chunks.join("\n\n")).toBe(entries.slice(expected.omittedEntries).flatMap(describeCompactedEntry).join("\n\n"));
	const f = await fixture(entries);
	const prompts: string[] = [];
	f.faux.setResponses(Array.from({ length: 20 }, () => request => {
		prompts.push(promptOf(request));
		return fauxAssistantMessage("Nothing worth keeping.");
	}));
	f.service.wake();
	await until(async () => await f.store.lastProcessed("p") === f.compaction.id);
	expect(prompts).toHaveLength(MAX_EXTRACTION_CHUNKS);
	expect(prompts[0]).not.toContain("First fact");
	expect(prompts.at(-1)).toContain("Last fact");
	expect(f.logs).toContain(`compaction entry ${f.compaction.id}: skipped ${expected.omittedEntries} oldest compacted entries (${expected.omittedChars} serialized characters); extraction capped at ${MAX_EXTRACTION_CHUNKS} chunks`);
});

it("a later chunk failure discards all staged writes and records a retry; a later wake replays the whole span", async () => {
	const f = await fixture(span(30));
	let fail = true;
	let firstParts = 0;
	f.faux.setResponses(Array.from({ length: 100 }, () => request => {
		const part = Number(/Part (\d+) of/.exec(promptOf(request))?.[1]);
		if (part === 2 && fail) return fauxAssistantMessage("", { stopReason: "error", errorMessage: "synthetic chunk failure" });
		if (part === 1 && !request.messages.some(message => message.role === "toolResult")) {
			firstParts++;
			return fauxAssistantMessage(["project", "global"].map(scope => fauxToolCall("memory_write", {
				scope, fileId: "testing", text: "Use bun for tests.",
			})), { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("Saved.");
	}));
	f.service.wake();
	await until(async () => (await f.store.failure("p"))?.attempts === 1);
	expect(await f.store.lastProcessed("p")).toBeNull();
	expect(await f.store.failure("p")).toMatchObject({ entryId: f.compaction.id, attempts: 1, outcome: "retry", reason: "synthetic chunk failure" });
	for (const scope of ["project", "global"] as const) {
		expect(await f.test.server.manager.memory.history(scope, scope === "project" ? "p" : undefined, 20)).toHaveLength(0);
		await expect(f.test.server.manager.memory.read(scope, scope === "project" ? "p" : undefined, "testing")).rejects.toMatchObject({ code: "unknown_memory" });
	}
	fail = false;
	f.service.wake();
	await until(async () => await f.store.lastProcessed("p") === f.compaction.id);
	expect(await f.store.failure("p")).toBeUndefined();
	expect(firstParts).toBe(2);
	for (const scope of ["project", "global"] as const) {
		expect(await f.test.server.manager.memory.history(scope, scope === "project" ? "p" : undefined, 20)).toHaveLength(1);
	}
});
