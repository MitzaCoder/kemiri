import { getContext, setContext } from 'svelte';
import type { LandingTurn, ThreadSummary } from '@kemiri/protocol';
import { coordinatorOfThread } from './coordinators.js';

export function landingTurnPresentation(turn: LandingTurn | undefined, roster: readonly ThreadSummary[]) {
	if (!turn) return undefined;
	const coordinator = (id: string) => {
		const thread = roster.find(row => row.id === id);
		return { id, title: thread?.title ?? (id === 'main' ? 'General' : id), thread };
	};
	return {
		holder: turn.holder && { ...coordinator(turn.holder.coordinatorId), taskId: turn.holder.taskId },
		waiting: turn.queue.map(waiter => coordinator(waiter.coordinatorId))
	};
}

type LandingTurnPresentation = ReturnType<typeof landingTurnPresentation>;

export function otherLandingTurnWaiters(turn: LandingTurnPresentation, askingThread: string | null | undefined, roster: readonly ThreadSummary[]): string[] {
	const coordinator = coordinatorOfThread(askingThread, roster);
	if (!turn || (turn.holder?.id !== coordinator && !turn.waiting.some(waiter => waiter.id === coordinator))) return [];
	return turn.waiting.filter(waiter => waiter.id !== coordinator).map(waiter => waiter.title);
}

const LANDING_TURN = Symbol('landing turn');
export function provideLandingTurn(read: () => { turn: LandingTurnPresentation; threads: readonly ThreadSummary[] }) { setContext(LANDING_TURN, read); }
export function useLandingTurn() { return getContext<(() => { turn: LandingTurnPresentation; threads: readonly ThreadSummary[] }) | undefined>(LANDING_TURN); }
