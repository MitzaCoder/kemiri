import { RESOLVED_PUSH_TARGET_LIMIT, RESOLVED_PUSH_TTL_MS, type NotificationAlert,
	type NotificationResolvedTarget } from "@kemiri/protocol";

/** Only fields needed to settle a card. No message, title, address, or credential is stored. */
export type PushCard = NotificationResolvedTarget & Pick<NotificationAlert,
	"kind" | "projectId" | "coordinatorId" | "threadId" | "workerId" | "taskId" | "taskRevision" |
	"questionId" | "questionRevision" | "entryId" | "answerId" | "expiresAt">;
export type MatchesPushCard = (card: PushCard) => boolean;

export const CLEAR_BATCH_INTERVAL_MS = 1000;
const CARD_RETENTION_MS = 7 * 86_400_000; // The same horizon as the recent alert feed.
const CLEAR_TARGET_BYTES = 1250; // Leaves room for a full v1 relay wrapper and device key.

type PostedCard = { deviceId: string; card: PushCard; retainedUntil: number };
type WaitingClear = { deviceId: string; target: NotificationResolvedTarget; until: number };

function isTarget(value: unknown): value is NotificationResolvedTarget {
	if (value === null || typeof value !== "object") return false;
	const target = value as NotificationResolvedTarget;
	return typeof target.tag === "string" && target.tag.length > 0 && typeof target.at === "string" && Number.isFinite(Date.parse(target.at)) &&
		(target.key === undefined || typeof target.key === "string") && (target.sharedLimitKey === undefined || typeof target.sharedLimitKey === "string");
}

function targetOf({ tag, at, key, sharedLimitKey }: NotificationResolvedTarget): NotificationResolvedTarget {
	return { tag, at, ...(key === undefined ? {} : { key }), ...(sharedLimitKey === undefined ? {} : { sharedLimitKey }) };
}

/** Per-device receipts for accepted notices, and a durable queue of their exact identities to clear. */
export class NotificationClearQueue {
	readonly #cards = new Map<string, PostedCard>();
	readonly #waiting = new Map<string, WaitingClear>();
	constructor(readonly changed: () => void) {}

	load(input: unknown): void {
		if (input === null || typeof input !== "object") return;
		const { posted, waiting } = input as { posted?: PostedCard[]; waiting?: WaitingClear[] };
		if (Array.isArray(posted)) for (const value of posted) {
			if (typeof value?.deviceId === "string" && isTarget(value.card) && Number.isFinite(value.retainedUntil))
				this.#cards.set(this.#clearId(value.deviceId, value.card), value);
		}
		if (Array.isArray(waiting)) for (const value of waiting) {
			if (typeof value?.deviceId === "string" && isTarget(value.target) && Number.isFinite(value.until))
				this.#waiting.set(this.#clearId(value.deviceId, value.target), value);
		}
	}

	snapshot() { return { posted: [...this.#cards.values()], waiting: [...this.#waiting.values()] }; }

	#clearId(deviceId: string, target: NotificationResolvedTarget): string {
		return JSON.stringify([deviceId, target.tag, target.at, target.key ?? null]);
	}

	#enqueue(deviceId: string, card: PushCard, now: number): void {
		const target = targetOf(card);
		// A local override is not proof that other computers sharing this window have resumed.
		if (!card.expiresAt || Date.parse(card.expiresAt) > now) delete target.sharedLimitKey;
		if (Buffer.byteLength(JSON.stringify(target)) > CLEAR_TARGET_BYTES - 2) return;
		const id = this.#clearId(deviceId, target);
		if (!this.#waiting.has(id)) this.#waiting.set(id, { deviceId, target, until: now + RESOLVED_PUSH_TTL_MS });
	}

	accepted(deviceId: string, card: PushCard, now: number, alreadyHandled: boolean): void {
		this.prune(now);
		if (alreadyHandled || (card.expiresAt && Date.parse(card.expiresAt) <= now)) this.#enqueue(deviceId, card, now);
		else {
			this.#cards.set(this.#clearId(deviceId, card), { deviceId, card, retainedUntil: now + CARD_RETENTION_MS });
		}
		this.changed();
	}

	settle(matches: MatchesPushCard, now: number): void {
		this.prune(now);
		let changed = false;
		for (const [id, { deviceId, card }] of this.#cards) if (matches(card)) {
			this.#cards.delete(id);
			this.#enqueue(deviceId, card, now);
			changed = true;
		}
		if (changed) this.changed();
	}

	prune(now: number): void {
		let changed = false;
		for (const [id, value] of this.#cards) if (value.retainedUntil <= now) { this.#cards.delete(id); changed = true; }
		for (const [id, value] of this.#waiting) if (value.until <= now) { this.#waiting.delete(id); changed = true; }
		if (changed) this.changed();
	}

	nextDelay(now: number): number {
		this.prune(now);
		let delay = this.#waiting.size ? CLEAR_BATCH_INTERVAL_MS : Infinity;
		for (const { card } of this.#cards.values()) if (card.expiresAt) {
			const at = Date.parse(card.expiresAt);
			if (Number.isFinite(at)) delay = Math.min(delay, Math.max(CLEAR_BATCH_INTERVAL_MS, at - now));
		}
		return delay;
	}

	batches(now: number): Map<string, NotificationResolvedTarget[]> {
		this.settle(card => card.expiresAt !== undefined && Date.parse(card.expiresAt) <= now, now);
		const batches = new Map<string, NotificationResolvedTarget[]>();
		const filled = new Set<string>();
		for (const { deviceId, target } of this.#waiting.values()) {
			if (filled.has(deviceId)) continue;
			const targets = [...(batches.get(deviceId) ?? []), target];
			if (targets.length > RESOLVED_PUSH_TARGET_LIMIT || Buffer.byteLength(JSON.stringify(targets)) > CLEAR_TARGET_BYTES) {
				filled.add(deviceId);
				continue;
			}
			batches.set(deviceId, targets);
		}
		return batches;
	}

	delivered(deviceId: string, batch: readonly NotificationResolvedTarget[]): void {
		for (const target of batch) this.#waiting.delete(this.#clearId(deviceId, target));
		this.changed();
	}
}
