import { defineDoc, LiveDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { openBoard } from "../board.ts";
import { stateKind } from "../state-identity.ts";
import { ACP_TOOL_ENTRY, type AcpActivityUpdate, type AcpToolSnapshot, type AcpToolStep } from "./acp-activity.ts";

// Only the current turn needs a durable deduplication index. Tool evidence itself lives in the transcript.
const AcpTurnToolsDoc = defineDoc<{ turnId: string; calls: Record<string, AcpToolSnapshot> }>({
 kind: stateKind("acp-turn-tools"), version: 1, scope: "conversation", history: "latest", fork: "initial",
 checkpointWhen: () => false, initial: () => ({ turnId: "", calls: {} }),
});

const mergePaths = (prior: string[] | undefined, next: string[]) => [...new Set([...(prior ?? []), ...next])].slice(0, 64).sort();

export async function recordAcpActivity(tx: Tx, scope: { conversationId: ConversationId; mainId: ConversationId; taskId: string; turnId: string }, update: AcpActivityUpdate): Promise<void> {
 const live = await tx.doc(LiveDoc, scope.conversationId);
 const first = live.run?.first;
 if (first === undefined || live.run?.afterRun) return;
 if ("plan" in update) {
  const board = await openBoard(tx, scope.mainId);
  const source = Object.values(board.taskActivity?.[scope.taskId]?.sources ?? {}).find(({ actor, state }) => state === "running" &&
   actor.conversationId === scope.conversationId && actor.runId === String(first));
  if (!source) return;
  if (!update.plan.length) delete source.livePlan;
  else if (JSON.stringify(source.livePlan) !== JSON.stringify(update.plan)) source.livePlan = update.plan;
  return;
 }
 const turns = await tx.doc(AcpTurnToolsDoc, scope.conversationId);
 if (turns.turnId !== scope.turnId) { turns.turnId = scope.turnId; turns.calls = {}; }
 const prior = turns.calls[update.callId];
 const kind = update.kind ?? prior?.kind ?? "other";
 const status = prior?.status === "completed" || prior?.status === "failed" || prior?.status === "in_progress" && update.status === "pending"
  ? prior.status : update.status ?? prior?.status ?? "pending";
 const paths = mergePaths(prior?.paths, [...update.paths, ...update.diffPaths]);
 const changedPaths = mergePaths(prior?.changedPaths, [
  ...update.diffPaths, ...(["edit", "delete", "move"].includes(kind) ? paths : []),
 ]);
 const snapshot: AcpToolSnapshot = { kind, status, paths, changedPaths };
 if (JSON.stringify(prior) === JSON.stringify(snapshot)) return;
 turns.calls[update.callId] = snapshot;
 const step: AcpToolStep = { ...snapshot, turnId: scope.turnId, callId: `${scope.turnId}:${update.callId}`, at: update.at };
 await tx.appendEntry(scope.conversationId, { kind: ACP_TOOL_ENTRY, data: step });
}
