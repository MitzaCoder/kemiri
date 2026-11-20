import { ReportResultAppendSchema, type ReportArtifactScope } from "./report-blocks.ts";
import { Type, type Static } from "typebox";
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, Harness, Tx } from "@earendil-works/pi-durable";
import { BoardDoc, type BoardState, ReportCheckInputSchema, boardView, describeTaskInFull, normalizeBoard, workerWriter, writeReportIn } from "./board.ts";
import { errorMessage } from "./errors.ts";
import { LivePlanInputSchema, LivePlanTickSchema } from "./task-live-plan.ts";
import { reportTextWarnings } from "./task-text-style.ts";

export const workerTaskProgressTool = (taskLive: boolean) => ({
	name: "task_progress",
	description:
		"Keep the report of your assigned board task current; the board report is the record of your work. " +
		"Now is written automatically. Optional `now` is a few-word phase, only when it really changes; prefer `addResultBlocks` for finished Results, one fact per block. " +
		"`checks` updates checks by name; `milestone` saves a snapshot of the task. Questions and warnings go in your final report, not here. " +
		(taskLive ? "Use `plan` to write or replace the run plan and `tick` to mark steps done by number. " : "") +
		"With no update fields, reads the task and its eventSeq. You can pass that as coveredEventSeq when writing later, so anything that happened since stays marked.",
	parameters: Type.Object({
		now: Type.Optional(
		Type.String({ description: "Optional few-word phase, only when it really changes. Adds a line to this run’s trail. Now is automatic; empty clears the phase." }),
		),
		addResult: Type.Optional(
		Type.String({ minLength: 1, description: "One finished outcome in a whole sentence, added as a bullet. Put check outcomes in checks, not prose. Link commits with a Kemiri-Task trailer and save files with taskId." }),
		),
		addResultBlocks: Type.Optional(ReportResultAppendSchema),
		checks: Type.Optional(Type.Array(ReportCheckInputSchema, { description: "Checks that ran, with name, result and count if known. Merges by name; other checks stay as they are." })),
		...(taskLive ? { plan: Type.Optional(LivePlanInputSchema), tick: Type.Optional(LivePlanTickSchema) } : {}),
		coveredEventSeq: Type.Optional(Type.Integer({ minimum: 0, description: "Optional: the eventSeq from when you read the task, so anything that happened since stays marked. If omitted, a changed section covers events up to this write." })),
		milestone: Type.Optional(
		Type.String({ minLength: 1, description: 'A few words naming something meaningful that just happened, e.g. "Tests pass". Saves a snapshot.' }),
		),
	}),
});

type WorkerTaskProgressInput = Static<ReturnType<typeof workerTaskProgressTool>["parameters"]>;
type WorkerTaskProgressArgs = Omit<WorkerTaskProgressInput, "plan" | "tick"> & Partial<Pick<WorkerTaskProgressInput, "plan" | "tick">>;
export type WorkerTaskReportScope = { taskId: string; threadId: string; workerId: string };

const progressText = (text: string, taskId?: string) => ({
	output: [{ type: "text" as const, text }],
	...(taskId === undefined ? { isError: true as const } : { details: { taskId } }),
});

/** Both native tools and the official-agent bridge write with the same activity writer and report transaction. */
export async function workerTaskProgress(args: WorkerTaskProgressArgs, options: {
	harness: Harness;
	mainId: ConversationId;
	context: Context;
	scope: WorkerTaskReportScope;
	taskLive: boolean;
	key: string;
	commit: (change: (tx: Tx) => ReturnType<typeof writeReportIn>) => ReturnType<typeof writeReportIn>;
	/** The bridge may see linked IDs, but not the titles/status of other tasks. */
	assignedTaskOnly?: boolean;
	artifactScope?: ReportArtifactScope | undefined;
}) {
	const { harness, mainId, context, scope, taskLive, key, commit } = options;
	const { taskId, threadId, workerId } = scope;
	const planUpdate = taskLive && (args.plan !== undefined || args.tick !== undefined) ? { plan: args.plan, tick: args.tick } : undefined;
	if (args.now === undefined && args.addResult === undefined && args.addResultBlocks === undefined && !args.checks?.length && !planUpdate && args.milestone === undefined) {
		const stored = await harness.snapshot(BoardDoc, mainId, context);
		if (stored === undefined) return progressText("The task no longer exists.");
		const state = normalizeBoard(JSON.parse(JSON.stringify(stored)) as BoardState);
		const board = boardView(state, Date.now(), true);
		const task = board.tasks.find((candidate) => candidate.id === taskId);
		if (task === undefined) return progressText("The task no longer exists.");
		return progressText(describeTaskInFull(task, options.assignedTaskOnly ? { ...board, tasks: [task] } : board, []), taskId);
	}
	try {
		const at = new Date().toISOString();
		const task = await commit((tx) => writeReportIn(tx, mainId, {
			taskId,
			sections: { now: args.now },
			mergeChecks: args.checks,
			planUpdate,
			addResult: args.addResult,
			addResultBlocks: args.addResultBlocks,
			coveredEventSeq: args.coveredEventSeq,
			by: workerWriter(threadId, workerId),
			milestone: args.milestone,
		}, key, at, options.artifactScope));
		const milestone = args.milestone === undefined ? "" : `; milestone "${args.milestone.trim()}" saved`;
		const warnings = reportTextWarnings({ results: args.addResult }, { results: args.addResultBlocks });
		const plan = planUpdate ? " Run plan updated." : "";
		return progressText(`Updated the report of ${task.id} (report r${task.report.revision}${milestone}).${plan}${warnings}`, task.id);
	} catch (error) {
		return progressText(errorMessage(error));
	}
}
