/**
 * Extracting memories after a coordinator compaction.
 *
 * When a `pi.compaction` entry lands on the coordinator's conversation, the part of the transcript it replaced is still
 * in storage. This module reads that part and asks the coordinator's model for the durable facts worth keeping: user
 * preferences go to the global scope, project facts to the project scope, and anything memory already holds is updated
 * rather than duplicated. The writes are one commit per scope touched, of kind `extraction`, with the compaction's entry
 * ID as their source, so the app can offer an undo and history can say where a fact came from.
 *
 * Durability: the work is driven by what is in storage, not by an in-memory event. `projects/<id>/memory-extraction.json`
 * keeps the newest compaction entry that was handled, every start (or any later commit) scans the durable entries above
 * it. Failed extractions retain their attempt count and retry on later wakes or starts (at most three attempts). Only
 * success or giving up advances progress; the final failure remains recorded. A crash before the memory commit writes
 * nothing. Failures are logged and never block the conversation.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord/context";
import { contentText } from "@earendil-works/pi-ai";
import type { Models } from "@earendil-works/pi-ai";
import type {
	Conversation,
	Cursor,
	EntryId,
	EntryRecord,
} from "@earendil-works/pi-durable";
import { join } from "node:path";
import { errorMessage } from "./errors.ts";
import { readJsonFile, writeJsonFile } from "./fs-json.ts";
import { MemoryEditor, describeBatchChanges, memoryAgentExecutor, memoryAgentTools, runMemoryAgent } from "./memory-agent.ts";
import { newModelSessionId } from "./model-session.ts";
import type { MemoryStore } from "./memory.ts";
import type { Project, ProjectStore } from "./projects.ts";

/** The file, next to `project.json`, that remembers what was already extracted. */
export const MEMORY_EXTRACTION_FILE = "memory-extraction.json";
/** The `pi.compaction` entry kind. */
const COMPACTION_ENTRY = "pi.compaction";
/** Entries one page of the scan for missed compactions reads. */
const SCAN_PAGE_ENTRIES = 200;
/** A scan stops after this many entries: a backlog that old is not worth an extraction run apiece. */
const SCAN_MAX_ENTRIES = 2_000;
/** Reserve most of the context for instructions, memory tool results and answers (estimated at four chars/token). */
export const EXTRACTION_CONTEXT_FRACTION = 0.2;
/** A long span may use more context to stay within the call cap, but still leaves 60% for the tool loop. */
export const EXTRACTION_MAX_CONTEXT_FRACTION = 0.4;
export const EXTRACTION_DEFAULT_CONTEXT_TOKENS = 32_000;
/** Avoid tiny calls, and bound cost even for models with very large context windows. */
export const EXTRACTION_MIN_CHUNK_CHARS = 8_000;
export const EXTRACTION_MAX_CHUNK_CHARS = 128_000;
export const MAX_EXTRACTION_CHUNKS = 16;
const ESTIMATED_CHARS_PER_TOKEN = 4;
/** Characters of one tool result or message the serialized transcript keeps. */
const EXTRACTION_MESSAGE_CHARS = 1_500;

export const EXTRACTION_SYSTEM_PROMPT = `You keep the durable memory of a coding assistant harness. A conversation was just compacted and its earlier part replaced by a summary, so read that part once more and save what must not be lost.

Save durable facts only:
- to the "global" scope, what is true of the user: preferences, habits, how they like to work, their tools and accounts;
- to the "project" scope, what is true of this project: conventions, decisions and their reasons, gotchas, where things are, how it is built and deployed.

Rules:
- Write facts, not a transcript. No progress reports, no "the user asked", no restating of the task.
- Search first (memory_search, a few phrasings and tags) and update the topic that already holds a fact instead of creating a near-duplicate. Write one \`##\` section per subject.
- Skip anything memory already says. Never write what is merely in the compaction summary and will therefore still be in context.
- Prefer a few well-placed sections in existing topics over new files. Create a topic only for a subject with no home.
- When you are done, answer in one short paragraph saying what you saved, or that nothing was worth keeping.`;

export type MemoryExtractionStoreOptions = {
	projects: ProjectStore;
	log?: (message: string) => void;
};

/** A failed compaction gets at most this many attempts across wakes and restarts. */
export const MAX_EXTRACTION_ATTEMPTS = 3;
export type ExtractionFailure = {
	entryId: number;
	attempts: number;
	outcome: "retry" | "gave_up";
	reason: string;
};
/** Main and background-thread progress, plus the latest failure per conversation. */
type ExtractionRecord = { main: number | null; threads: Record<string, number>; failures: Record<string, ExtractionFailure> };

function entryIdOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * One small JSON file per project recording the newest `pi.compaction` entry that was extracted, main's and each
 * background thread's, so a restart neither repeats an extraction nor needs a table of its own.
 */
export class MemoryExtractionStore {
	readonly #projects: ProjectStore;
	readonly #log: (message: string) => void;
	readonly #cache = new Map<string, ExtractionRecord>();
	#queue: Promise<unknown> = Promise.resolve();

	constructor(options: MemoryExtractionStoreOptions) {
		this.#projects = options.projects;
		this.#log = options.log ?? (() => undefined);
	}

	fileOf(projectId: string): string {
		return join(this.#projects.projectDir(projectId), MEMORY_EXTRACTION_FILE);
	}

	async #record(projectId: string): Promise<ExtractionRecord> {
		const cached = this.#cache.get(projectId);
		if (cached !== undefined) return cached;
		let value: unknown;
		try {
			value = await readJsonFile(this.fileOf(projectId));
		} catch (error) {
			this.#log(`project ${projectId}: ${MEMORY_EXTRACTION_FILE} is unreadable: ${errorMessage(error)}`);
			return { main: null, threads: {}, failures: {} };
		}
		const raw = value as { lastProcessedEntryId?: unknown; threads?: unknown; failures?: Record<string, ExtractionFailure> } | undefined;
		const threads: Record<string, number> = {};
		if (typeof raw?.threads === "object" && raw.threads !== null) {
			for (const [conversationId, entryId] of Object.entries(raw.threads)) {
				const id = entryIdOrNull(entryId);
				if (id !== null) threads[conversationId] = id;
			}
		}
		const failures: Record<string, ExtractionFailure> = {};
		for (const [key, failure] of Object.entries(raw?.failures ?? {})) {
			if (failure && entryIdOrNull(failure.entryId) !== null && Number.isInteger(failure.attempts) && failure.attempts > 0 &&
				(failure.outcome === "retry" || failure.outcome === "gave_up") && typeof failure.reason === "string") failures[key] = failure;
		}
		const record = { main: entryIdOrNull(raw?.lastProcessedEntryId), threads, failures };
		this.#cache.set(projectId, record);
		return record;
	}

	/**
	 * The newest compaction entry already extracted from main (no `conversationId`) or from the background thread with
	 * that conversation, or null when none was.
	 */
	async lastProcessed(projectId: string, conversationId?: number): Promise<number | null> {
		const record = await this.#record(projectId);
		return conversationId === undefined ? record.main : (record.threads[String(conversationId)] ?? null);
	}

	/** Most recent failure for this conversation, retained after giving up. */
	async failure(projectId: string, conversationId?: number): Promise<ExtractionFailure | undefined> {
		return (await this.#record(projectId)).failures[String(conversationId ?? "main")];
	}

	/** A failure is durable before any next attempt; later wakes or starts retry, never the same drain loop. */
	async recordFailure(projectId: string, entryId: number, reason: string, conversationId?: number): Promise<ExtractionFailure> {
		const run = this.#queue.then(async () => {
			const current = await this.#record(projectId);
			const key = String(conversationId ?? "main");
			const previous = current.failures[key];
			const attempts = previous?.entryId === entryId ? previous.attempts + 1 : 1;
			const failure: ExtractionFailure = { entryId, attempts, outcome: attempts >= MAX_EXTRACTION_ATTEMPTS ? "gave_up" : "retry", reason };
			const next = { ...current, failures: { ...current.failures, [key]: failure } };
			await this.#save(projectId, next);
			return failure;
		});
		this.#queue = run.catch((error: unknown) => this.#log(`could not record extraction failure: ${errorMessage(error)}`));
		return run;
	}

	async #save(projectId: string, next: ExtractionRecord): Promise<void> {
		await writeJsonFile(this.fileOf(projectId), { version: 1, lastProcessedEntryId: next.main, threads: next.threads, failures: next.failures });
		this.#cache.set(projectId, next);
	}

	/** Record that a compaction entry was handled. Only moves forward, so a late write cannot rewind it. */
	async markProcessed(projectId: string, entryId: number, conversationId?: number): Promise<void> {
		const run = this.#queue.then(async () => {
			const previous = await this.lastProcessed(projectId, conversationId);
			if (previous !== null && previous >= entryId) return;
			const current = await this.#record(projectId);
			const next: ExtractionRecord =
				conversationId === undefined
					? { ...current, main: entryId }
					: { ...current, threads: { ...current.threads, [String(conversationId)]: entryId } };
			next.failures = { ...next.failures };
			const key = String(conversationId ?? "main");
			if (next.failures[key]?.entryId === entryId && next.failures[key]?.outcome === "retry") delete next.failures[key];
			await this.#save(projectId, next);
		});
		this.#queue = run.catch((error: unknown) => {
			this.#log(`project ${projectId}: could not record the extracted compaction: ${errorMessage(error)}`);
		});
		await run;
	}
}

/** One entry of the compacted part as the extraction prompt shows it. */
export function describeCompactedEntry(entry: EntryRecord): string[] {
	const lines: string[] = [];
	for (const message of entry.model ?? []) {
		const text = contentText(message.content).trim();
		switch (message.role) {
			case "user":
				if (text.length > 0) lines.push(`[User]: ${text}`);
				break;
			case "assistant": {
				if (text.length > 0) lines.push(`[Assistant]: ${text}`);
				const calls = message.content.flatMap((block) =>
					block.type === "toolCall" ? [`${block.name}(${JSON.stringify(block.arguments)})`] : [],
				);
				if (calls.length > 0) lines.push(`[Assistant calls]: ${calls.join("; ")}`);
				break;
			}
			case "toolResult":
				if (text.length > 0) lines.push(`[Tool result]: ${text}`);
				break;
			default:
				break;
		}
	}
	return lines.map((line) => (line.length <= EXTRACTION_MESSAGE_CHARS ? line : `${line.slice(0, EXTRACTION_MESSAGE_CHARS)}…`));
}

/** Transcript budgets in characters, derived from the model rather than its provider or name. */
export function extractionChunkBudgets(contextWindow?: number): { preferred: number; maximum: number } {
	const window = contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0
		? contextWindow : EXTRACTION_DEFAULT_CONTEXT_TOKENS;
	const chars = window * ESTIMATED_CHARS_PER_TOKEN;
	const clamp = (fraction: number) => Math.max(EXTRACTION_MIN_CHUNK_CHARS,
		Math.min(EXTRACTION_MAX_CHUNK_CHARS, Math.floor(chars * fraction)));
	return { preferred: clamp(EXTRACTION_CONTEXT_FRACTION), maximum: clamp(EXTRACTION_MAX_CONTEXT_FRACTION) };
}

/** All described entries, oldest first; grow chunks before resorting to dropping the oldest ones. */
export function chunkCompactedPart(entries: readonly EntryRecord[], contextWindow?: number): {
	chunks: string[]; omittedEntries: number; omittedChars: number;
} {
	const { preferred, maximum } = extractionChunkBudgets(contextWindow);
	// An entry larger than a whole chunk (many long messages in one turn) is clipped rather than failing the run, which
	// would only retry the same span and give up.
	const described = entries
		.map(entry => describeCompactedEntry(entry).join("\n\n"))
		.filter(text => text.length > 0)
		.map(text => (text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`));
	const largest = described.reduce((size, text) => Math.max(size, text.length), 0);
	const pack = (budget: number): string[][] => {
		const chunks: string[][] = [];
		let chunk: string[] = [];
		let used = 0;
		for (const text of described) {
			const size = text.length + (chunk.length > 0 ? 2 : 0);
			if (chunk.length > 0 && used + size > budget) {
				chunks.push(chunk);
				chunk = [];
				used = 0;
			}
			used += text.length + (chunk.length > 0 ? 2 : 0);
			chunk.push(text);
		}
		if (chunk.length > 0) chunks.push(chunk);
		return chunks;
	};
	let budget = Math.max(preferred, largest);
	let packed = pack(budget);
	// Doubling keeps planning cheap even for an unusually large backlog.
	while (packed.length > MAX_EXTRACTION_CHUNKS && budget < maximum) {
		budget = Math.min(maximum, budget * 2);
		packed = pack(budget);
	}
	const omitted = packed.slice(0, Math.max(0, packed.length - MAX_EXTRACTION_CHUNKS));
	return {
		chunks: packed.slice(-MAX_EXTRACTION_CHUNKS).map(chunk => chunk.join("\n\n")),
		omittedEntries: omitted.reduce((count, chunk) => count + chunk.length, 0),
		omittedChars: omitted.reduce((count, chunk) => count + chunk.join("\n\n").length, 0),
	};
}

export type MemoryExtractionServiceOptions = {
	/** Read at each use, so a model change applies to the next extraction. */
	project(): Project;
	conversation: Conversation;
	/** Set for a background thread's conversation: its progress is recorded apart from main's. */
	background?: boolean;
	memory: MemoryStore;
	store: MemoryExtractionStore;
	models: Models;
	log?: (message: string) => void;
};

/**
 * One project's extraction: it finds compaction entries that were not extracted yet and runs one extraction for each.
 * Nothing else waits on it, and it runs at most one at a time.
 */
export class MemoryExtractionService {
	readonly #options: MemoryExtractionServiceOptions;
	readonly #log: (message: string) => void;
	#stopWatch: (() => Promise<void>) | undefined;
	#chain: Promise<void> = Promise.resolve();
	#stopped = false;
	#noModelLogged = false;

	constructor(options: MemoryExtractionServiceOptions) {
		this.#options = options;
		this.#log = options.log ?? (() => undefined);
	}

	/** The key the store records this conversation's progress under: none for main. */
	get #trackedConversation(): number | undefined {
		return this.#options.background === true ? this.#options.conversation.id : undefined;
	}

	/** Start watching the conversation and handle any compaction missed while the process was off. */
	async start(): Promise<void> {
		this.#stopped = false;
		try {
			const handle = await this.#options.conversation.watch(BACKGROUND_CONTEXT);
			handle.start(async (call) => {
				if (call.kind === "failed") throw call.error;
				const view = call.value;
				if (this.#stopped) return;
				// Only a new `pi.compaction` entry is worth a look; the durable scan below decides what is new.
				if (view.entries.some((entry) => entry.kind === COMPACTION_ENTRY)) this.wake();
			});
			handle.closed.then(() => {
				this.#stopWatch = undefined;
			});
			this.#stopWatch = async () => {
				await handle.stop();
			};
		} catch (error) {
			this.#log(`could not watch the conversation for compactions: ${errorMessage(error)}`);
		}
		this.wake();
	}

	/** Stop watching and wait for a run in progress, so nothing writes after the owner is gone. */
	async stop(): Promise<void> {
		this.#stopped = true;
		const stop = this.#stopWatch;
		this.#stopWatch = undefined;
		await stop?.().catch(() => undefined);
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, 5_000);
			timer.unref?.();
		});
		await Promise.race([this.#chain.catch(() => undefined), timeout]);
		if (timer !== undefined) clearTimeout(timer);
	}

	/** Look for un-extracted compactions now; the work is queued behind a running extraction, never parallel to it. */
	wake(): void {
		const run = this.#chain.then(() => this.#drain());
		this.#chain = run.catch((error: unknown) => {
			this.#log(`extraction failed: ${errorMessage(error)}`);
		});
	}

	async #drain(): Promise<void> {
		while (!this.#stopped) {
			const entry = await this.#nextCompaction();
			if (entry === undefined) return;
			const projectId = this.#options.project().id;
			const previous = await this.#options.store.failure(projectId, this.#trackedConversation);
			// A crash between recording the final failure and advancing progress must not buy another paid attempt.
			if (previous?.entryId !== entry.id || previous.outcome !== "gave_up") {
				try {
					await this.#extract(entry);
				} catch (error) {
					const failure = await this.#options.store.recordFailure(projectId, entry.id, errorMessage(error), this.#trackedConversation);
					this.#log(`extraction from compaction entry ${entry.id} failed (attempt ${failure.attempts}/${MAX_EXTRACTION_ATTEMPTS}, ${failure.outcome}): ${failure.reason}`);
					if (failure.outcome === "retry") return;
				}
			}
			await this.#options.store.markProcessed(projectId, entry.id, this.#trackedConversation);
		}
	}

	/** The oldest `pi.compaction` entry above the last one handled, reading durable entries only. */
	async #nextCompaction(): Promise<EntryRecord | undefined> {
		const projectId = this.#options.project().id;
		const last = (await this.#options.store.lastProcessed(projectId, this.#trackedConversation)) ?? 0;
		let cursor: Cursor | undefined;
		let scanned = 0;
		while (scanned < SCAN_MAX_ENTRIES) {
			const page = await this.#options.conversation.entries(
				{ minEntryId: (last + 1) as EntryId, order: "ascending" },
				SCAN_PAGE_ENTRIES,
				cursor,
				BACKGROUND_CONTEXT,
			);
			for (const entry of page.items) {
				scanned += 1;
				if (entry.kind === COMPACTION_ENTRY) return entry;
			}
			if (page.next === undefined) return undefined;
			cursor = page.next;
		}
		return undefined;
	}

	/**
	 * The entries a compaction replaced: everything the conversation's context held just before the compaction entry,
	 * minus the summary markers themselves. Read through `context({ at })`, so the head marker of the previous context
	 * is where the range starts.
	 */
	async compactedEntries(entry: EntryRecord): Promise<EntryRecord[]> {
		const head = entry.head;
		if (head === undefined) return [];
		const before = await this.#options.conversation.entries(
			{ maxEntryId: (entry.id - 1) as EntryId, order: "descending" },
			1,
			undefined,
			BACKGROUND_CONTEXT,
		);
		const last = before.items[0];
		if (last === undefined) return [];
		const view = await this.#options.conversation.context(BACKGROUND_CONTEXT, { at: last.id });
		return view.entries.filter(
			(candidate) =>
				candidate.id < head &&
				candidate.kind !== COMPACTION_ENTRY &&
				(candidate.model?.length ?? 0) > 0,
		);
	}

	async #extract(entry: EntryRecord): Promise<void> {
		const project = this.#options.project();
		const agent = await this.#options.conversation.agent(BACKGROUND_CONTEXT);
		if (agent.model === undefined) {
			if (!this.#noModelLogged) {
				this.#log("no coordinator model, so no memories are extracted from compactions");
				this.#noModelLogged = true;
			}
			return;
		}
		this.#noModelLogged = false;
		const compacted = await this.compactedEntries(entry);
		if (compacted.length === 0) return;
		const model = this.#options.models.getModel(agent.model.provider, agent.model.modelId);
		const serialized = chunkCompactedPart(compacted, model?.contextWindow);
		if (serialized.omittedEntries > 0) {
			this.#log(`compaction entry ${entry.id}: skipped ${serialized.omittedEntries} oldest compacted entries (${serialized.omittedChars} serialized characters); extraction capped at ${MAX_EXTRACTION_CHUNKS} chunks`);
		}
		if (serialized.chunks.length === 0) return;
		const editor = new MemoryEditor({
			store: this.#options.memory,
			projectId: project.id,
			scopes: ["global", "project"],
			source: { projectId: project.id, conversationId: this.#options.conversation.id, entryId: entry.id },
			log: this.#log,
		});
		const sessionId = newModelSessionId();
		const answers: string[] = [];
		const tools = memoryAgentTools({ scopes: ["global", "project"], archives: false });
		const execute = memoryAgentExecutor(editor);
		for (const [index, text] of serialized.chunks.entries()) {
			const prompt = [
				`The earlier part of this conversation (entries before ${entry.head}) was just compacted. Here it is, as it was:`,
				`Part ${index + 1} of ${serialized.chunks.length}, oldest first.`,
				index === 0 ? "This is the first part."
					: "Earlier parts were already handled. Their memory writes are staged and visible through the memory tools; search before adding anything.",
				"",
				"<compacted>",
				text,
				"</compacted>",
				...(serialized.omittedEntries > 0
					? ["", `${serialized.omittedEntries} oldest entries were skipped by the safety cap; save only from what is shown.`]
					: []),
				"",
				"Search memory first, then save what is worth keeping. Then answer with what you saved.",
			].join("\n");
			// Fresh messages per part avoid accumulating the transcript; one editor and session belong to the whole run.
			answers.push(await runMemoryAgent({
				models: this.#options.models,
				model: agent.model,
				thinkingLevel: agent.thinkingLevel,
				sessionId,
				systemPrompt: EXTRACTION_SYSTEM_PROMPT,
				prompt,
				tools,
				execute,
				log: this.#log,
			}));
		}
		const answer = answers.filter(text => text.trim().length > 0).join("\n\n");
		const { commits } = await editor.commit({
			kind: "extraction",
			source: { projectId: project.id, conversationId: this.#options.conversation.id, entryId: entry.id },
			render: (scope, changes) => ({
				subject: `memory: extraction from conversation ${this.#options.conversation.id}`,
				body: [
					`Saved from the part of conversation ${this.#options.conversation.id} that the compaction at entry ${entry.id} replaced.`,
					"",
					describeBatchChanges(changes),
					...(answer.trim().length === 0 ? [] : ["", answer.trim()]),
				].join("\n"),
			}),
		});
		if (commits.length === 0) return;
		this.#log(
			`extracted memories from compaction entry ${entry.id} into ${commits
				.map((commit) => `${commit.scope} (${commit.commit.slice(0, 8)})`)
				.join(", ")}`,
		);
	}
}
