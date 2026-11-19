import type { BoardLiveLine } from '@kemiri/protocol';

type SeenLiveLine = Pick<BoardLiveLine, 'id' | 'at'>;

export function visibleLiveLines(lines: readonly BoardLiveLine[]): BoardLiveLine[] {
	return lines.filter(line => line.kind === 'phase' || line.kind === 'result');
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
