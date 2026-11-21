import { defineDoc } from "@earendil-works/pi-durable";
import type { LandingTurn, LandingTurnWaiter } from "@kemiri/protocol";

export const LANDING_TURN_GRANT_ENTRY = "kemiri.landing-turn-grant";
export const LANDING_TURN_NUDGE_MS = 30 * 60 * 1_000;
export const LANDING_TURN_NUDGE_KEY = "held-too-long";

export type LandingTurnAction = "take" | "release" | "status";
export type LandingTurnRequest = { action: LandingTurnAction; taskId?: string; note?: string };

type StoredLandingTurn = Pick<LandingTurn, "holder"> & {
	queue: (LandingTurnWaiter & { note?: string; requestId: string })[];
	/** The same call must not affect a later turn, even after a restart or a new grant. */
	receipts?: Record<string, string>;
	nudged?: boolean;
};

export const LandingTurnDoc = defineDoc<StoredLandingTurn>({
	kind: "kemiri.landing-turn",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	checkpointWhen: () => false,
	initial: () => ({ queue: [] }),
});
