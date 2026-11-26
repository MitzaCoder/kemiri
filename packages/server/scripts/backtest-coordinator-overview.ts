import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { boardView } from "../src/board.ts";
import { buildCoordinatorOverview } from "../src/coordinator-overview.ts";
import { requestWorkClock, time } from "../src/overview-clock.ts";
import { replayOverviewEstimates, type OverviewReplayRequest } from "../src/overview-estimate-replay.ts";
import { readOverviewBoard, readOverviewHistoryForReplay } from "../src/overview-records.ts";
import { topRequest } from "../src/request-attention.ts";
import { openStorageReadOnly } from "../src/request-backfill.ts";
import { stateKind } from "../src/state-identity.ts";

const path = process.argv[2];
if (!path) throw new Error("Pass a private copy of a project's session SQLite file. This script opens it read-only.");
const storage = await openStorageReadOnly(path);
try {
 const state = await readOverviewBoard(storage);
 if (!state) throw new Error("The copy has no board in the configured state namespace.");
 const records = await readOverviewHistoryForReplay(storage, state);
 const threadDocument = await storage.findDocument({ kind: stateKind("threads"), scope: { kind: "conversation", conversationId: ROOT_CONVERSATION_ID } }, "current", BACKGROUND_CONTEXT);
 const threadValue = threadDocument ? (await storage.document(threadDocument.id, "current", BACKGROUND_CONTEXT))?.value : undefined;
 const threads = (threadValue as { threads?: Record<string, { kind?: string; parentThreadId?: string }> } | undefined)?.threads ?? {};
 const coordinatorOf = (owner?: string | null) => owner && threads[owner]?.kind === "coordinator" ? owner : owner && threads[owner]?.parentThreadId || "main";
 const now = Date.now();
 const board = boardView(state, now, true, coordinatorOf, true, true);
 const byId = new Map(board.tasks.map(task => [task.id, task]));
 const requestByTask = new Map(board.tasks.map(task => [task.id, topRequest(task, byId)?.id]));
 const overview = buildCoordinatorOverview({ board, state, records, scope: { projectId: "replay", coordinatorId: null }, coordinatorOf, now });
 const requests = overview.estimateInputs.completed.flatMap((sample): OverviewReplayRequest[] => {
  const task = byId.get(sample.requestId);
  if (!task) return [];
  const members = board.tasks.filter(part => part !== task && requestByTask.get(part.id) === task.id);
  const directParts = members.filter(part => part.parent === task.id).map(part => ({
   created: time(part.createdAt), moves: records.tasks[part.id]?.statuses ?? [],
   fallbackClosedAt: part.status === "done" || part.status === "dropped" ? time(part.settledAt) : NaN,
  }));
  return [{ sample, clock: requestWorkClock(state, records.tasks, task, members,
   state.questions.filter(question => question.taskId !== null && requestByTask.get(question.taskId) === task.id), now),
   canEstimateAt(at) {
    const status = records.tasks[task.id]?.statuses.findLast(move => time(move.at) <= at)?.status;
    return status !== "todo" && status !== "waiting" && status !== "review" && status !== "dropped";
   },
   partsLeft(at) {
    return directParts.filter(part => {
     if (part.created > at) return false;
     const stateAt = part.moves.findLast(move => time(move.at) <= at)?.status;
     return stateAt ? stateAt !== "done" && stateAt !== "dropped" : !(part.fallbackClosedAt <= at);
    }).length;
   },
  }];
 });
 console.log(JSON.stringify({ tasks: board.tasks.length, ...replayOverviewEstimates(requests) }, null, 2));
} finally { await storage.close(BACKGROUND_CONTEXT); }
