import { expect, test } from "bun:test";
import { NotificationClearQueue, type PushCard } from "../src/notification-clears.ts";

const now = Date.parse("2026-01-01T12:00:00Z");
const at = new Date(now).toISOString();
const reply: PushCard = { kind: "reply", tag: "chat", at, key: "r1", projectId: "bakery", workerId: null, entryId: 1 };

test("coalesces accepted identities per device without selecting unread replacements", () => {
	const source = new NotificationClearQueue(() => {});
	source.accepted("tablet", reply, now, false);
	const replacement = { ...reply, key: "r2", at: new Date(now + 1).toISOString(), entryId: 2 };
	source.accepted("tablet", replacement, now + 1, false);
	source.accepted("phone", reply, now, false);
	source.accepted("phone", { ...reply, tag: "other", key: "r3" }, now, false);
	source.settle(card => card.entryId === 1, now);
	source.settle(card => card.entryId === 1, now);
	const restarted = new NotificationClearQueue(() => {});
	restarted.load(JSON.parse(JSON.stringify(source.snapshot())));
	expect(restarted.nextDelay(now)).toBe(1000);
	const batches = restarted.batches(now + 1000);
	expect([...batches]).toEqual([
		["tablet", [{ tag: "chat", at, key: "r1" }]],
		["phone", [{ tag: "chat", at, key: "r1" }, { tag: "other", at, key: "r3" }]],
	]);
	for (const [deviceId, batch] of batches) restarted.delivered(deviceId, batch);
	expect(restarted.snapshot().posted.map(({ card }) => card)).toEqual([replacement]);
	expect(restarted.nextDelay(now)).toBe(Infinity);
});

test("splits bursts and removes stale clears instead of replaying them later", () => {
	const queue = new NotificationClearQueue(() => {});
	for (let index = 0; index < 25; index++) queue.accepted("phone", { ...reply, key: String(index) }, now, true);
	const first = queue.batches(now + 1000).get("phone")!;
	expect(first).toHaveLength(16);
	queue.delivered("phone", first);
	expect(queue.batches(now + 2000).get("phone")).toHaveLength(9);
	expect(queue.batches(now + 300_000).size).toBe(0);
});

test("resolves shared limits across computers at reset, not on early local resume", () => {
	const queue = new NotificationClearQueue(() => {});
	const limit: PushCard = { ...reply, kind: "usage_limit_reached", sharedLimitKey: "shared", expiresAt: new Date(now + 6000).toISOString() };
	queue.accepted("early", limit, now, false);
	queue.settle(card => card.kind === "usage_limit_reached", now);
	expect(queue.batches(now + 1000).get("early")?.[0]?.sharedLimitKey).toBeUndefined();
	queue.accepted("reset", limit, now, false);
	expect(queue.batches(now + 5000).get("reset")).toBeUndefined();
	expect(queue.batches(now + 6000).get("reset")).toEqual([{ tag: "chat", at, key: "r1", sharedLimitKey: "shared" }]);
});
