import type { BoardLiveLine, BoardTaskActivity, WorkerSummary } from '@kemiri/protocol';

import { workerHref } from './backends.js';

export type LiveNewsActions = { markWrong(lineId: string): Promise<void>; workLogHref(line: BoardLiveLine, entryId: string): string | undefined };

export function liveNewsWorkLogHref(backendId: string, projectId: string, workers: readonly WorkerSummary[], line: BoardLiveLine, entryId: string): string | undefined {
 const worker = workers.find(worker => worker.conversationId === line.evidence?.conversationId && worker.id === line.actor.name && (worker.threadId ?? 'main') === line.actor.threadId);
 return worker && /^[1-9]\d*$/.test(entryId) ? `${workerHref(backendId, projectId, worker.id, worker.threadId === 'main' ? undefined : worker.threadId)}#entry-${entryId}` : undefined;
}

/** Collapse consecutive matching descriptions without losing the first entry's link. */
export function groupLiveEvidence(steps: NonNullable<BoardLiveLine['evidence']>['steps']) {
 const groups: (typeof steps[number] & { count: number })[] = [];
 for (const step of steps) {
  const previous = groups.at(-1);
  if (previous?.description === step.description) previous.count++;
  else groups.push({ ...step, count: 1 });
 }
 return groups;
}

type SeenLiveLine = Pick<BoardLiveLine, 'id' | 'at'>;

export function visibleLiveLines(lines: readonly BoardLiveLine[], watcher = false): BoardLiveLine[] {
	return lines.filter(line => line.kind === 'phase' || line.kind === 'result' || line.kind === 'fact' || watcher && line.kind === 'auto');
}

/** Only the current actor's phase at the displayed Now timestamp is redundant. */
export function liveTrailBelowNow(lines: readonly BoardLiveLine[], now: BoardTaskActivity, watcher = false): BoardLiveLine[] {
 return visibleLiveLines(lines, watcher).filter(line => !(now.kind === 'working' && line.kind === 'phase' && line.actor.id === now.actor?.id && line.at === now.since && now.text.startsWith(`${line.actor.name} is ${line.text}`)));
}

export function pulseElapsed(since: string, now: number): string {
 const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
 if (!Number.isFinite(seconds)) return '';
 return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`;
}

export function liveSeenKey(backendId: string, projectId: string, taskId: string): string {
	return `aiki.task-live-seen.v1:${JSON.stringify([backendId, projectId, taskId])}`;
}

/** Freeze the divider for a visible visit even as we save the checkpoint for the next one. */
export function visitLiveTrail(storage: Pick<Storage, 'getItem' | 'setItem'>, key: string) {
	let checkpoint: SeenLiveLine | undefined;
	try {
		const saved = JSON.parse(storage.getItem(key) ?? 'null') as Partial<SeenLiveLine> | null;
		if (typeof saved?.id === 'string' && typeof saved.at === 'string') checkpoint = { id: saved.id, at: saved.at };
	} catch { /* Storage can be blocked. */ }
	let previous: Set<string> | undefined;
	let previousNewest: string | undefined;
	return (lines: readonly BoardLiveLine[]) => {
		const newest = lines.at(-1);
		const arrived = previous === undefined ? [] : lines.filter(line => !previous?.has(line.id)).map(line => line.id);
		if (newest && newest.id !== previousNewest) {
			try { storage.setItem(key, JSON.stringify({ id: newest.id, at: newest.at })); } catch { /* Reading the trail still works. */ }
		}
		if (!previous && !checkpoint) checkpoint = newest;
		previous = new Set(lines.map(line => line.id));
		previousNewest = newest?.id;
		const seenIndex = checkpoint ? lines.findLastIndex(line => line.id === checkpoint?.id) : -1;
		// If the checkpoint was evicted or its source ended, a different run's older lines can still be retained.
		const unseen = seenIndex >= 0 ? lines.length - 1 - seenIndex : lines.filter(line => !checkpoint || line.at > checkpoint.at).length;
		return { unseen, arrived };
	};
}
