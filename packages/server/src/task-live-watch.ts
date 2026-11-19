import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { LiveDoc, type ConversationId, type EntryId, type Harness, type LiveState } from "@earendil-works/pi-durable";
import type { Board, BoardLivePulse } from "@kemiri/protocol";
import type { TaskArtifactSave } from "./artifacts.ts";
import type { BoardState } from "./board.ts";
import { liveRunFacts, mergeLiveLines, runningLiveSources } from "./task-live.ts";
import { TaskLiveRun } from "./task-live-run.ts";

const LIVE_PUSH_INTERVAL_MS = 2_000;
/** Project-local read side. Board state selects which conversations need live observation. */
type RunWatch = {
 runId?: string | undefined;
 run?: TaskLiveRun | undefined;
 publishedPulse?: BoardLivePulse | undefined;
 stop: Promise<() => Promise<void>>;
};

export class TaskLiveWatch {
 readonly #watches = new Map<number, RunWatch>();
 #stopped = false;
 #timer: ReturnType<typeof setTimeout> | undefined;
 #saves: readonly TaskArtifactSave[] = [];
 #readingSaves = false;
 #savesDirty = true;
 constructor(readonly harness: Harness, readonly publish: () => void, readonly log: (error: unknown) => void,
  readonly readSaves?: () => Promise<readonly TaskArtifactSave[]>) {}

 sync(state: Readonly<BoardState>): void {
  const conversations = new Set(state.tasks.flatMap(task => task.status === "done" || task.status === "dropped" ? [] :
   runningLiveSources(state.taskActivity?.[task.id]).map(source => source.actor.conversationId)));
  for (const [id, watch] of this.#watches) if (!conversations.has(id)) {
   this.#watches.delete(id);
   void watch.stop.then(stop => stop()).catch(this.log);
  }
  for (const id of conversations) if (!this.#watches.has(id)) {
   const watch: RunWatch = { stop: Promise.resolve(async () => {}) };
   this.#watches.set(id, watch);
   watch.stop = this.#watch(id as ConversationId);
  }
  this.#refreshSaves();
 }

 #requestPush(): void {
  if (this.#stopped) return;
  this.#timer ??= setTimeout(() => {
   this.#timer = undefined;
   for (const watch of this.#watches.values()) watch.publishedPulse = watch.run?.pulse;
   this.publish();
  }, LIVE_PUSH_INTERVAL_MS);
  this.#timer.unref?.();
 }

 savesChanged(): void { this.#savesDirty = true; this.#refreshSaves(); }
 #refreshSaves(): void {
  if (this.#stopped || !this.readSaves || !this.#watches.size || !this.#savesDirty || this.#readingSaves) return;
  this.#readingSaves = true;
  this.#savesDirty = false;
  void this.readSaves().then(saves => { this.#saves = saves; this.#requestPush(); }).catch(this.log).finally(() => {
   this.#readingSaves = false;
   this.#refreshSaves();
  });
 }

 async #watch(conversationId: ConversationId): Promise<() => Promise<void>> {
  try {
   const owner = this.#watches.get(conversationId);
   const conversation = await this.harness.conversation(conversationId, BACKGROUND_CONTEXT);
   const watch = conversation && await this.harness.watchDoc(LiveDoc, conversationId, BACKGROUND_CONTEXT);
   if (!conversation || !watch || !owner) return async () => { await watch?.stop(); };
   let signature: string | undefined;
   let lastEntry: EntryId | undefined;
   const update = async (live: Readonly<LiveState> | null) => {
    if (this.#watches.get(conversationId) !== owner) return;
    const active = live?.run && !live.run.afterRun ? live.run : undefined;
    const runId = active ? String(active.first ?? active.taskId) : undefined;
    const writing = live?.generation?.message?.content.some(part => part.type === "text" && !!part.text);
    const next = JSON.stringify([runId, Boolean(live?.generation), Boolean(writing),
     live?.tools?.map(slot => [slot.callId, slot.taskId, slot.status]), live?.nestedTools?.map(slot => [slot.callId, slot.taskId, slot.status])]);
    if (signature === next) return;
    signature = next;
    const observedAt = new Date().toISOString();
    if (runId !== owner.runId) {
     owner.publishedPulse = undefined;
     owner.run = runId ? new TaskLiveRun() : undefined;
     owner.runId = runId;
     lastEntry = undefined;
    }
    const run = owner.run;
    if (run && active?.first !== undefined) {
     let cursor: Parameters<typeof conversation.entries>[2];
     do {
      const page = await conversation.entries({ minEntryId: lastEntry === undefined ? active.first : (lastEntry + 1) as EntryId, order: "ascending" }, 200, cursor, BACKGROUND_CONTEXT);
      for (const entry of page.items) { run.add(entry); lastEntry = entry.id; }
      cursor = page.next;
     } while (cursor !== undefined);
    }
    run?.updatePulse(live, observedAt);
    if (this.#watches.get(conversationId) === owner) this.#requestPush();
   };
   await update(watch.value).catch(this.log);
   watch.start(async event => { if (event.kind === "failed") this.log(event.error); else await update(event.value).catch(this.log); });
   return async () => { await watch.stop(); };
  } catch (error) { this.log(error); return async () => {}; }
 }

 project(board: Board, state: Readonly<BoardState>): Board {
  for (const task of board.tasks) {
   if (!task.live) continue;
   const sources = runningLiveSources(state.taskActivity?.[task.id]);
   const primary = sources.find(source => source.actor.id === task.activity?.actor?.id) ?? sources[0];
   for (const source of sources) {
    const watch = this.#watches.get(source.actor.conversationId);
    const run = watch && watch.runId === source.actor.runId ? watch.run : undefined;
    const facts = liveRunFacts(task.id, source, run, this.#saves.filter(save => save.taskId === task.id && save.conversationId === source.actor.conversationId && save.runId === source.actor.runId));
    task.live.lines = mergeLiveLines(task.live.lines, facts.lines);
    if (source === primary) {
     if (run && watch?.publishedPulse) task.live.pulse = watch.publishedPulse;
     if (facts.counters) task.live.counters = facts.counters;
    }
   }
  }
  return board;
 }

 async stop(): Promise<void> {
  this.#stopped = true;
  if (this.#timer) clearTimeout(this.#timer);
  const watches = [...this.#watches.values()];
  this.#watches.clear();
  await Promise.all(watches.map(watch => watch.stop.then(stop => stop()).catch(this.log)));
 }
}
