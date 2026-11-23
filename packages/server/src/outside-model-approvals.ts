import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { ConversationId, Tx } from "@earendil-works/pi-durable";
import type { ModelRef } from "@kemiri/protocol";
import { type BoardService, askQuestion, DECLINE_OUTSIDE_MODEL_RUN, HARNESS_WRITER, openBoard, START_OUTSIDE_MODEL_RUN } from "./board.ts";
import { errorMessage } from "./errors.ts";
import { normalizeOutsideModelRunLimit } from "./projects.ts";
import type { ThreadService, ThreadStartInput } from "./threads.ts";
import { countRunningModelOverrides, projectWorkerModel, type WorkerService, type WorkerSpawnArgs } from "./workers.ts";

type Commit = <T>(change: (tx: Tx) => Promise<T>) => Promise<T>;
type RunRequest = {
	threadId: string;
	conversationId: number;
} & (
	| { kind: "worker"; args: WorkerSpawnArgs; previousConversationId: number | null }
	| { kind: "job"; args: Omit<ThreadStartInput, "coordinator"> & { id: string } }
);

/** Stored on the project's board, never in the wire view. Keep only the call ID after delivery or withdrawal. */
export type OutsideModelApproval = {
	callId: string;
	conversationId: number;
	request?: RunRequest;
	approved?: boolean;
	outcome?: string;
};

function outsideModelApprovalMessage(questionId: string, status: string): string {
	if (status !== "open") return `This start request was already answered or withdrawn in ${questionId}. Do not retry it; check the outcome message.`;
	return `Not started yet. Waiting for the owner's approval in ${questionId}. It starts by itself if approved, and a message arrives either way. Meanwhile you may start it on a project worker model instead.`;
}

/** Serializes count-through-start across the project's coordinators. No one waits for a human in this queue. */
export class OutsideModelApprovals {
	#agentStarts: Promise<unknown> = Promise.resolve();
	#delivery: Promise<void> = Promise.resolve();

	constructor(
		private readonly board: BoardService,
		private readonly workers: WorkerService,
		private readonly threads: ThreadService,
		private readonly enabled: boolean,
	) {}

	serialize<T>(start: () => Promise<T>): Promise<T> {
		const result = this.#agentStarts.then(start);
		this.#agentStarts = result.catch(() => undefined);
		return result;
	}

	async requestIfAtLimit(model: ModelRef, callId: string, request: RunRequest, commit: Commit, context: Context): Promise<{ id: string; message: string } | undefined> {
		if (!this.enabled) return;
		const state = await this.board.state(context);
		const prior = Object.entries(state.outsideModelApprovals ?? {}).find(([, approval]) => approval.callId === callId && approval.conversationId === request.conversationId)?.[0];
		if (prior) return { id: prior, message: outsideModelApprovalMessage(prior, state.questions.find(question => question.id === prior)?.status ?? "settled") };
		const project = this.workers.project;
		const limit = normalizeOutsideModelRunLimit(project.outsideModelRunLimit);
		if (limit === null || projectWorkerModel(project.workerModels, model)) return;
		const count = await countRunningModelOverrides(this.workers, project.workerModels, context);
		if (count < limit) return;

		const subject = request.kind === "worker" ? `worker ${JSON.stringify(request.args.id)}` : `job ${JSON.stringify(request.args.title)}`;
		const modelName = `${model.provider}/${model.modelId}`;
		const question = await this.board.commitFor(commit, (board, now) => {
			const question = askQuestion(board, {
				text: `Start ${subject} on ${modelName}? This is not a project worker model. ${count} ${count === 1 ? "other run is" : "other runs are"} already running on models outside the list (approval limit: ${limit}).`,
				options: [],
				choices: [
					{ label: START_OUTSIDE_MODEL_RUN, effect: `Starts this one run on ${modelName}.` },
					{ label: DECLINE_OUTSIDE_MODEL_RUN, effect: "Does not start the run. The coordinator can use a project worker model instead." },
				],
				outsideModelApproval: true,
				taskId: request.args.taskId ?? null,
				threadId: request.threadId,
				blocksWork: false,
				now,
			});
			board.outsideModelApprovals ??= {};
			const approvals = board.outsideModelApprovals;
			approvals[question.id] = { callId, conversationId: request.conversationId, request };
			// Keep recent receipts for replayed tool calls without keeping their briefs.
			const receipts = Object.keys(approvals).filter(id => !approvals[id]?.request);
			for (const id of receipts.slice(0, Math.max(0, receipts.length - 500))) delete approvals[id];
			return question;
		}, HARNESS_WRITER, `outside-model-approval:${callId}`);
		this.board.noticeQuestion(question);
		return { id: question.id, message: outsideModelApprovalMessage(question.id, question.status) };
	}

	/** The board answer is already committed. Deliver settled starts now or when the project reopens after a restart. */
	deliver(): Promise<void> {
		this.#delivery = this.#delivery.then(async () => {
			const state = await this.board.state();
			for (const [id, approval] of Object.entries(state.outsideModelApprovals ?? {})) {
				if (approval.approved === undefined || !approval.request) continue;
				try {
					await this.#deliverOne(id, approval, approval.request);
				} catch (error) {
					this.workers.log(`could not deliver outside-model approval ${id}: ${errorMessage(error)}`);
				}
			}
		}).catch(error => this.workers.log(`could not read outside-model approvals: ${errorMessage(error)}`));
		return this.#delivery;
	}

	async #deliverOne(id: string, approval: OutsideModelApproval, request: RunRequest): Promise<void> {
		const subject = request.kind === "worker" ? `worker ${request.args.id}` : `job ${request.args.id}`;
		const started = `[${subject} started after the owner's approval in ${id}]`;
		const notStarted = (reason: string) => `[${subject} was not started: ${reason}]`;
		const commit: Commit = change => this.workers.harness.commit(change, BACKGROUND_CONTEXT);
		const mainId = this.workers.coordinator.id as ConversationId;
		// Record success in the very transaction that starts the run. A restart between start and notice only retries the notice.
		const startAndRecord: Commit = change => commit(async tx => {
			const state = await openBoard(tx, mainId);
			const result = await change(tx);
			state.outsideModelApprovals![id]!.outcome = started;
			return result;
		});
		let outcome = approval.outcome;
		if (!outcome) {
			if (!approval.approved) outcome = notStarted(`the owner declined ${id}. Use a project worker model, or ask the owner`);
			else outcome = await this.serialize(async () => {
				const place = this.workers.placeOf(request.conversationId);
				const thread = request.threadId === "main" ? undefined : await this.threads.record(request.threadId);
				if (this.workers.project.archived || place?.threadId !== request.threadId || (request.threadId !== "main" && (!thread || thread.archived || thread.held))) {
					return notStarted("the original caller is no longer available");
				}
				try {
					if (request.kind === "worker") {
						const result = await this.workers.spawnAgentWorker(request.args, { conversationId: request.conversationId as ConversationId, callId: approval.callId,
							commit: startAndRecord, previousConversationId: request.previousConversationId }, BACKGROUND_CONTEXT);
						if (result.isError) return notStarted(result.output[0]!.text);
						this.workers.harness.resume();
						return started;
					}
					const result = await this.threads.start(request.args, startAndRecord);
					return result.ok ? started : notStarted(result.message);
				} catch (error) {
					// A post-commit error must not report that an already started run was refused.
					return (await this.board.state()).outsideModelApprovals?.[id]?.outcome ?? notStarted(errorMessage(error));
				}
			});
		}
		await this.board.deliverOutsideModelOutcome(request.threadId, id, outcome);
		await commit(async tx => {
			const state = await openBoard(tx, mainId);
			state.outsideModelApprovals![id] = { callId: approval.callId, conversationId: request.conversationId };
		});
	}
}
