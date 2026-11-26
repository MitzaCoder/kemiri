import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, ROOT_CONVERSATION_ID, type DocumentId, type Storage, type StorageWrite } from "@earendil-works/pi-durable";
import type { BoardWriter, BoardTask, BoardTimelineFact } from "@kemiri/protocol";
import type { BoardState, TaskHistoryState } from "./board.ts";
import { stateKind } from "./state-identity.ts";
import { foldLegacyEvents } from "./task-timeline.ts";

export type OverviewStatus = { status: BoardTask["status"]; at: string; by: BoardWriter["author"]; parts?: number };
export type OverviewRun = { at: string; endAt: string; outcome: string; source: string; workerId?: string; conversationId?: number };
export type OverviewDeploy = { at: string; outcome: string };
export type OverviewTaskRecord = { statuses: OverviewStatus[]; runs?: Record<string, OverviewRun>; deploys?: Record<string, OverviewDeploy> };
export type OverviewRecords = { backfilled?: true; tasks: Record<string, OverviewTaskRecord> };

// A compact table of task-keyed rows in the project's SQLite session. The board and the table commit together.
export const OverviewRecordsDoc = defineDoc<OverviewRecords>({
 kind: stateKind("overview-records"), version: 1, scope: "conversation", history: "latest", fork: "initial",
 checkpointWhen: (_table, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
 initial: () => ({ tasks: {} }),
});

// These drafts live only as long as the corresponding transaction drafts.
const recordsByHistory = new WeakMap<TaskHistoryState, OverviewRecords>();
export function linkOverviewHistory(history: TaskHistoryState, records: OverviewRecords): TaskHistoryState {
 recordsByHistory.set(history, records);
 return history;
}

function taskRecord(records: OverviewRecords, taskId: string): OverviewTaskRecord {
 records.tasks[taskId] ??= { statuses: [] };
 return records.tasks[taskId]!;
}

export function recordOverviewStatus(records: OverviewRecords, task: Pick<BoardTask, "id" | "status">, at: string, by: BoardWriter["author"], parts?: number): void {
 const statuses = taskRecord(records, task.id).statuses;
 if (statuses.at(-1)?.status !== task.status) statuses.push({ status: task.status, at, by, ...(parts === undefined ? {} : { parts }) });
}

function recordTimelineFact(records: OverviewRecords, taskId: string, fact: Omit<BoardTimelineFact, "revision" | "factCount">): void {
 if (fact.source === "worker" || fact.source === "thread") {
  const row = taskRecord(records, taskId);
  row.runs ??= {};
  const run = { at: fact.at, endAt: fact.endAtForLive ?? fact.endAt, outcome: fact.outcome, source: fact.source,
   ...(fact.source === "worker" && fact.ref ? { workerId: fact.ref } : {}),
   ...(fact.actor ? { conversationId: fact.actor.conversationId } : {}),
  };
  if (JSON.stringify(row.runs[fact.id]) !== JSON.stringify(run)) row.runs[fact.id] = run;
 } else if (fact.source === "deploy" && fact.ref) {
  const row = taskRecord(records, taskId);
  row.deploys ??= {};
  const deploy = { at: fact.endAt, outcome: fact.outcome };
  if (JSON.stringify(row.deploys[fact.ref]) !== JSON.stringify(deploy)) row.deploys[fact.ref] = deploy;
 }
}

export function recordOverviewFact(history: TaskHistoryState, taskId: string, fact: Omit<BoardTimelineFact, "revision" | "factCount">): void {
 const records = recordsByHistory.get(history);
 if (records) recordTimelineFact(records, taskId, fact);
}

/** On legacy feature sets where worker lifecycle facts are not recorded, fold the events that remain. */
export function recordOverviewLegacyWorker(history: TaskHistoryState, taskId: string): void {
 const records = recordsByHistory.get(history);
 if (!records) return;
 for (const fact of foldLegacyEvents(taskId, (history.events ?? []).filter(entry => entry.kind === "worker"), history.timelineEntries ?? [])) recordTimelineFact(records, taskId, fact);
}

const root = { kind: "conversation", conversationId: ROOT_CONVERSATION_ID } as const;
async function storedValue<T>(storage: Storage, kind: string, key?: string): Promise<T | undefined> {
 const record = await storage.findDocument({ kind, scope: root, ...(key === undefined ? {} : { key }) }, "current", BACKGROUND_CONTEXT);
 return record && (await storage.document(record.id, "current", BACKGROUND_CONTEXT))?.value as T | undefined;
}

export const readOverviewRecords = (storage: Storage) => storedValue<OverviewRecords>(storage, stateKind("overview-records"));
export const readOverviewBoard = (storage: Storage) => storedValue<BoardState>(storage, stateKind("board"));

/** Runs only on the board-storage worker before a Harness can open the project for writes. */
export async function backfillOverviewRecords(storage: Storage, maxPages = Infinity): Promise<void> {
 const address = { kind: stateKind("overview-records"), scope: root };
 const document = await storage.findDocument(address, "current", BACKGROUND_CONTEXT);
 const records = await readOverviewRecords(storage) ?? { tasks: {} };
 if (records.backfilled) return;
 const board = await readOverviewBoard(storage);
 if (!board) return;
 const pending = board.tasks.filter(task => !Object.hasOwn(records.tasks, task.id));
 const id = document?.id ?? await storage.mintId<DocumentId>();
 let created = document !== undefined;
 const save = async () => {
  const content = { kind: "base", version: 1, value: records } as const;
  const write: StorageWrite = created ? { type: "document.change", id, content }
   : { type: "document.create", record: { ...address, id, history: "latest", fork: "initial" }, content };
  const receipt = await storage.commit([[write]], () => {}, BACKGROUND_CONTEXT);
  if (receipt.stored !== 1) throw receipt.refused ?? new Error("Overview records were not saved");
  created = true;
 };
 const pageSize = 32;
 const limit = Math.min(pending.length, maxPages * pageSize);
 for (let offset = 0; offset < limit; offset += pageSize) {
  for (const task of pending.slice(offset, offset + pageSize)) {
   taskRecord(records, task.id);
   const history = await storedValue<TaskHistoryState>(storage, stateKind("board-history"), task.id);
   for (const snapshot of history?.snapshots ?? []) recordOverviewStatus(records, { id: task.id, status: snapshot.status }, snapshot.at, snapshot.by.author);
   const row = records.tasks[task.id]!;
   if (row.statuses.at(-1)?.status !== task.status) {
    // If the original transition is unavailable, don't pretend creation or an edit was the start of work.
    const tracked = board.taskActivity?.[task.id];
    const at = task.settledAt ?? (tracked?.status === task.status ? tracked.statusSince : undefined) ?? (task.status === "todo" ? task.createdAt : undefined);
    if (at) recordOverviewStatus(records, task, at, board.taskClosures?.[task.id]?.by ?? task.updatedBy);
   }
   const curated = history?.timelineEntries ?? [];
   for (const fact of [...curated, ...foldLegacyEvents(task.id, history?.events ?? [], curated)]) recordTimelineFact(records, task.id, fact);
  }
  if (offset + pageSize >= pending.length) records.backfilled = true;
  await save();
 }
 if (!pending.length) { records.backfilled = true; await save(); }
}
