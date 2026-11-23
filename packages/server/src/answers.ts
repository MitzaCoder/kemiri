import { defineDoc, LiveDoc, type ConversationId, type EntryRecord, type Harness, type Tx } from "@earendil-works/pi-durable";
import type { Answer, AnswerExchange } from "@kemiri/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ServerError } from "./errors.ts";
import { describeContent, splitTaskReference } from "./queued-inputs.ts";
import { stateKind } from "./state-identity.ts";
import { OWNER_CHAT_ENTRY } from "./wire.ts";

type StoredAnswer = Omit<Answer, "related" | "pinned" | "read" | "exchanges" | "filedBy"> &
	Partial<Pick<Answer, "related" | "pinned" | "read" | "exchanges" | "filedBy">>;

// Bound cold replay independently of the board checkpoint, without writing a revision for a read.
const MAX_ANSWER_DELTAS = 64;

type AnswersState = { nextId?: number; answers?: Record<string, StoredAnswer> };
export const AnswersDoc = defineDoc<AnswersState>({
	kind: stateKind("answers"), version: 1, scope: "conversation", history: "latest", fork: "initial", checkpointWhen: (_state, _ops, { deltasSinceBase }) => deltasSinceBase >= MAX_ANSWER_DELTAS, initial: () => ({}),
});

/** Only the latest answering run per coordinator is needed. No chat text or run history here. */
const AnswerTurnDoc = defineDoc<{ first?: number; addedTask?: boolean; answerId?: string; questionEntryId?: number; finished?: boolean }>({
	kind: stateKind("answer-turn"), version: 1, scope: "conversation", history: "latest", fork: "initial", checkpointWhen: () => true, initial: () => ({}),
});

export type OwnerQuestion = { question: string; questionEntryId: number; answerId?: string; taskId?: string };
export function ownerQuestion(entry: EntryRecord): OwnerQuestion | undefined {
	if (entry.kind !== OWNER_CHAT_ENTRY) return undefined;
	const message = entry.model?.find(message => message.role === "user");
	if (!message) return undefined;
	const data = entry.data as { answerId?: string; ownerQuestion?: string; taskId?: string } | undefined;
	const scoped = data?.ownerQuestion === undefined ? splitTaskReference(describeContent(message.content).text) :
		{ text: data.ownerQuestion, taskId: data.taskId };
	return {
		question: scoped.text,
		questionEntryId: entry.id,
		...(data?.answerId === undefined ? {} : { answerId: data.answerId }),
		...(scoped.taskId === undefined ? {} : { taskId: scoped.taskId }),
	};
}

export function shouldFileAnswer(question: string, reply: string): boolean {
	const text = question.trim();
	return !!text && (reply.trim().length >= 600 || (text.length < 400 &&
		(text.endsWith("?") || /^(?:who|what|where|when|why|which|whose|whom|how|is|are|am|was|were|can|could|do|does|did|have|has|had|will|would|should|may|might)\b/i.test(text))));
}

function normalized(stored: StoredAnswer): Answer {
	const { related = [], pinned = false, read = false, exchanges = [], filedBy = "coordinator", ...answer } = JSON.parse(JSON.stringify(stored)) as StoredAnswer;
	return { ...answer, related, pinned, read, exchanges, filedBy };
}

function findAnswer(state: Readonly<AnswersState> | undefined, id: string): StoredAnswer {
	const answer = state?.answers?.[id];
	if (!answer) throw new ServerError("not_found", `Unknown answer ${id}.`);
	return answer;
}

function exchangeOf({ question, answer, at, coordinatorId, coordinatorTitle, filedBy, questionEntryId, entryId }: Answer): AnswerExchange {
	return { question, answer, at, coordinatorId, coordinatorTitle, filedBy,
		...(questionEntryId === undefined ? {} : { questionEntryId }), ...(entryId === undefined ? {} : { entryId }) };
}

export function taskDescriptionFromAnswer(answer: Answer, description?: string): string {
	return [description?.trim(), `### Question\n\n${answer.question}`, `### Answer\n\n${answer.answer}`].filter(Boolean).join("\n\n");
}

type FileAnswer = { title: string; answerId?: string; related: readonly string[]; exchange: AnswerExchange };

export class AnswerStore {
	constructor(readonly harness: Harness, readonly coordinator: ConversationId, readonly changed: (id: string, deleted?: true) => void) {}

	async list(query?: string): Promise<Answer[]> {
		const state = await this.harness.snapshot(AnswersDoc, this.coordinator, BACKGROUND_CONTEXT);
		const terms = query?.trim().toLowerCase().split(/\s+/).filter(Boolean) ?? [];
		return Object.values(state?.answers ?? {}).map(normalized).filter(answer => {
			if (!terms.length) return true;
			const text = [answer.title, answer.id, ...[answer, ...answer.exchanges].flatMap(({ question, answer }) => [question, answer])].join("\n").toLowerCase();
			return terms.every(term => text.includes(term));
		}).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.at.localeCompare(a.at) || Number(b.id.slice(1)) - Number(a.id.slice(1)));
	}

	async get(id: string): Promise<Answer> {
		return normalized(findAnswer(await this.harness.snapshot(AnswersDoc, this.coordinator, BACKGROUND_CONTEXT), id));
	}

	async update(id: string, fields: { pinned?: boolean; read?: boolean }): Promise<Answer> {
		const { answer, changed } = await this.harness.commit(async tx => {
			const stored = findAnswer(await tx.doc(AnswersDoc, this.coordinator), id);
			let changed = false;
			for (const field of ["pinned", "read"] as const) {
				const value = fields[field];
				if (value === undefined || value === (stored[field] ?? false)) continue;
				stored[field] = value;
				changed = true;
			}
			return { answer: normalized(stored), changed };
		}, BACKGROUND_CONTEXT);
		if (changed) this.changed(id);
		return answer;
	}

	async delete(id: string): Promise<void> {
		const deleted = await this.harness.commit(async tx => {
			const state = await tx.doc(AnswersDoc, this.coordinator);
			if (!state.answers?.[id]) return false;
			delete state.answers[id];
			return true;
		}, BACKGROUND_CONTEXT);
		if (deleted) this.changed(id, true);
	}

	async inTransaction(tx: Tx, id: string): Promise<Answer> {
		return normalized(findAnswer(await tx.doc(AnswersDoc, this.coordinator), id));
	}

	async linkTask(tx: Tx, id: string, taskId: string): Promise<void> {
		const stored = findAnswer(await tx.doc(AnswersDoc, this.coordinator), id);
		stored.taskId = taskId;
		stored.related = [...new Set([...(stored.related ?? []), taskId])];
	}

	async recordTaskAdded(tx: Tx, conversationId: ConversationId): Promise<void> {
		const first = (await tx.doc(LiveDoc, conversationId)).run?.first;
		if (first !== undefined) (await this.#turn(tx, conversationId, first)).addedTask = true;
	}

	async fileInTurn(tx: Tx, conversationId: ConversationId, first: number, input: FileAnswer): Promise<Answer> {
		if ((await tx.doc(LiveDoc, conversationId)).run?.first !== first) {
			throw new ServerError("bad_request", "The owner turn has already ended.");
		}
		const answer = await this.#file(tx, input);
		const turn = await this.#turn(tx, conversationId, first);
		turn.answerId = answer.id;
		if (answer.questionEntryId !== undefined) turn.questionEntryId = answer.questionEntryId;
		return answer;
	}

	/** Finalize an explicit answer or file the fallback once, even if afterRun is retried. */
	async finishTurn(conversationId: ConversationId, input: {
		first: number; entryId: number; fallback?: FileAnswer;
	}): Promise<Answer | undefined> {
		const { answer, changed } = await this.harness.commit(async tx => {
			const turn = await tx.doc(AnswerTurnDoc, conversationId);
			const sameTurn = turn.first === input.first;
			if (sameTurn && turn.answerId) {
				const stored = (await tx.doc(AnswersDoc, this.coordinator)).answers?.[turn.answerId];
				// A deletion must not cause the answer to be recreated by the fallback.
				if (!stored) return { answer: undefined, changed: false };
				// Another coordinator may already have appended a newer exchange to the same answer.
				const exchange = stored.questionEntryId === turn.questionEntryId ? stored :
					stored.exchanges?.find(exchange => exchange.questionEntryId === turn.questionEntryId);
				const changed = exchange !== undefined && exchange.entryId !== input.entryId;
				if (!turn.finished) {
					if (changed) exchange.entryId = input.entryId;
					turn.finished = true;
				}
				const answer = normalized(stored);
				return { answer: exchange === undefined ? answer : { ...answer, ...exchangeOf({ ...answer, ...exchange }) }, changed };
			}
			if (input.fallback === undefined || (sameTurn && turn.addedTask)) return { answer: undefined, changed: false };
			// An owner can delete the thread's answer while its follow-up is running. Don't resurrect it.
			if (input.fallback.answerId && !(await tx.doc(AnswersDoc, this.coordinator)).answers?.[input.fallback.answerId]) {
				return { answer: undefined, changed: false };
			}
			const answer = await this.#file(tx, input.fallback);
			const run = await this.#turn(tx, conversationId, input.first);
			run.answerId = answer.id;
			if (answer.questionEntryId !== undefined) run.questionEntryId = answer.questionEntryId;
			run.finished = true;
			return { answer, changed: true };
		}, BACKGROUND_CONTEXT);
		if (answer && changed) this.changed(answer.id);
		return answer;
	}

	async #turn(tx: Tx, conversationId: ConversationId, first: number) {
		const turn = await tx.doc(AnswerTurnDoc, conversationId);
		if (turn.first !== first) {
			turn.first = first;
			delete turn.addedTask;
			delete turn.answerId;
			delete turn.questionEntryId;
			delete turn.finished;
		}
		return turn;
	}

	async #file(tx: Tx, { title, answerId, related, exchange }: FileAnswer): Promise<Answer> {
		const state = await tx.doc(AnswersDoc, this.coordinator);
		const previous = answerId === undefined ? undefined : normalized(findAnswer(state, answerId));
		let id = previous?.id;
		if (id === undefined) {
			const nextId = state.nextId ?? 1;
			id = `A${nextId}`;
			state.nextId = nextId + 1;
		}
		const answer: Answer = {
			...exchange, id, title: exchange.filedBy === "harness" ? previous?.title ?? title : title, read: false, pinned: previous?.pinned ?? false,
			related: [...new Set([...(previous?.related ?? []), ...related])],
			...(previous?.taskId === undefined ? {} : { taskId: previous.taskId }),
			exchanges: previous ? [exchangeOf(previous), ...previous.exchanges] : [],
		};
		state.answers ??= {};
		state.answers[id] = answer;
		return answer;
	}
}
