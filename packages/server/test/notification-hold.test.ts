/**
 * Holding notifications while the app is open: a fake clock drives the hold, a recording FCM sender stands in for the push
 * service, and the state file is real (a temp dir), so a restart is a second `Notifier` on the same directory.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { DEFAULT_NOTIFICATION_KINDS, NOTIFICATION_HOLD_MS, type NotificationPreferences } from "@kemiri/protocol";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { FcmSender } from "../src/fcm.ts";
import {
	NotificationPresence,
	NotificationStateStore,
	NotificationStore,
	Notifier,
	createVapidKeys,
	type NotificationEvent,
} from "../src/notifications.ts";

async function temporaryHoldDirectory(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "aiki-hold-"));
	afterEach(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

/** Time that only moves when the test says so; timers fire in order as it passes them. */
class FakeClock {
	now = Date.parse("2026-11-08T12:00:00Z");
	readonly #timers = new Map<number, { at: number; run: () => void }>();
	#next = 0;

	schedule = (run: () => void, delayMs: number): (() => void) => {
		const id = this.#next++;
		this.#timers.set(id, { at: this.now + delayMs, run });
		return () => {
			this.#timers.delete(id);
		};
	};

	get timers(): number {
		return this.#timers.size;
	}

	/** Move time forward, firing every timer that comes due on the way, then let the pushes it started finish. */
	async advance(ms: number, notifier?: Notifier): Promise<void> {
		const end = this.now + ms;
		for (;;) {
			const due = [...this.#timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
			if (due === undefined) break;
			this.#timers.delete(due[0]);
			this.now = Math.max(this.now, due[1].at);
			due[1].run();
		}
		this.now = end;
		await notifier?.flush();
	}
}

const ALL_KINDS: NotificationPreferences["kinds"] = [...DEFAULT_NOTIFICATION_KINDS, "worker_report"];

function preferences(change: Partial<NotificationPreferences> = {}): NotificationPreferences {
	return { kinds: [...ALL_KINDS], mutedProjects: [], quietHours: null, ...change };
}

type Rig = {
	clock: FakeClock;
	presence: NotificationPresence;
	notifier: Notifier;
	/** The device IDs an FCM message went to, in order. */
	sent: { deviceId: string; payload: Record<string, unknown> }[];
	dir: string;
	stateFile: string;
};

const fakeFcm = (sent: Rig["sent"]): FcmSender =>
	({
		projectId: "fake",
		send: async (message: { token: string; data: { payload: string } }) => {
			sent.push({
				deviceId: message.token.replace(/^token-/, ""),
				payload: JSON.parse(message.data.payload) as Record<string, unknown>,
			});
			return { status: 200, message: null, unregistered: false };
		},
	}) as unknown as FcmSender;

async function rig(options: { dir?: string; clock?: FakeClock; presence?: NotificationPresence } = {}): Promise<Rig> {
	const dir = options.dir ?? await temporaryHoldDirectory();
	const clock = options.clock ?? new FakeClock();
	const presence = options.presence ?? new NotificationPresence();
	const sent: Rig["sent"] = [];
	const store = new NotificationStore({ dir });
	await store.read(clock.now);
	const state = new NotificationStateStore({ dir });
	await state.read();
	const notifier = new Notifier({
		store,
		state,
		presence,
		vapid: await createVapidKeys(),
		subject: "https://harness.test",
		fcm: fakeFcm(sent),
		now: () => clock.now,
		schedule: clock.schedule,
	});
	// Flush queued state writes before teardown removes the directory they can recreate.
	afterEach(async () => {
		notifier.stop();
		await notifier.flush();
	});
	return { clock, presence, notifier, sent, dir, stateFile: join(dir, "state.json") };
}

async function register(notifier: Notifier, deviceId: string, change: Partial<NotificationPreferences> = {}): Promise<void> {
	await notifier.register({
		deviceId,
		label: deviceId,
		backendKey: "pc",
		fcmToken: `token-${deviceId}`,
		preferences: preferences(change),
	});
}

const reply = (n = 1, projectId = "p1"): NotificationEvent => ({
	kind: "reply",
	title: "p replied",
	body: "Done.",
	projectId,
	key: `reply:${projectId}:${n}`,
});

describe("holding notifications while the app is open", () => {
	it("pushes at once when no connection is open", async () => {
		const t = await rig();
		await register(t.notifier, "phone");
		const result = await t.notifier.deliver(reply());
		expect(result.deliveries).toHaveLength(1);
		expect(t.sent.map((push) => push.deviceId)).toEqual(["phone"]);
		expect(t.notifier.heldCount).toBe(0);
		expect(t.clock.timers).toBe(0);
	});

	it("does not hold for a connection whose page is hidden, or that never reported", async () => {
		const t = await rig();
		await register(t.notifier, "phone");
		t.presence.set({}, { deviceId: "phone", visible: false, projectId: "p1" });
		await t.notifier.deliver(reply(1));
		expect(t.sent).toHaveLength(1);
	});

	it("holds while a connection is visible and pushes after 15 s without interaction", async () => {
		expect(NOTIFICATION_HOLD_MS).toBe(15_000);
		const t = await rig();
		await register(t.notifier, "phone");
		// The visible page is on the very project: it no longer silences the push.
		t.presence.set({}, { deviceId: "laptop", visible: true, projectId: "p1" });
		const result = await t.notifier.deliver(reply());
		expect(result).toEqual({ skipped: "held", deliveries: [] });
		expect(t.notifier.heldCount).toBe(1);
		await t.clock.advance(14_999, t.notifier);
		expect(t.sent).toHaveLength(0);
		await t.clock.advance(1, t.notifier);
		expect(t.sent.map((push) => push.deviceId)).toEqual(["phone"]);
		// The payload says when the event happened, not when the hold ended.
		expect(t.sent[0]?.payload["at"]).toBe("2026-11-08T12:00:00.000Z");
		expect(t.notifier.heldCount).toBe(0);
	});

	it("drops an on-screen held push on interaction and keeps its dedupe key claimed", async () => {
		const t = await rig();
		await register(t.notifier, "phone");
		const laptop = {};
		t.presence.set(laptop, { deviceId: "laptop", visible: true, projectId: "p1" });
		await t.notifier.deliver(reply(7));
		await t.clock.advance(5_000, t.notifier);
		expect(t.notifier.interaction(laptop)).toBe(1);
		await t.clock.advance(60_000, t.notifier);
		expect(t.sent).toHaveLength(0);
		expect(t.clock.timers).toBe(0);
		// Nothing replays it: not now, not with nobody looking, not as the same event again.
		t.presence.clear();
		expect(await t.notifier.deliver(reply(7))).toEqual({ skipped: "duplicate", deliveries: [] });
		expect(t.sent).toHaveLength(0);
		const state = JSON.parse(await readFile(t.stateFile, "utf8")) as { notified: string[]; held?: unknown[] };
		expect(state.notified).toContain("reply:p1:7");
		expect(state.held).toBeUndefined();
	});

	it("drops the interacting connection's project for every device and pushes the other project after its hold", async () => {
		const t = await rig();
		await register(t.notifier, "phone");
		await register(t.notifier, "tablet");
		const phoneConnection = {};
		const tabletConnection = {};
		t.presence.set(phoneConnection, { deviceId: "phone", visible: true, projectId: "p1" });
		t.presence.set(tabletConnection, { deviceId: "tablet", visible: true, projectId: "p1" });
		await t.notifier.deliver(reply(1, "p1"));
		await t.clock.advance(3_000, t.notifier);
		await t.notifier.deliver(reply(2, "p2"));
		t.presence.set(tabletConnection, { deviceId: "tablet", visible: true, projectId: "p2" });
		expect(t.notifier.interaction(tabletConnection)).toBe(1);
		// Later events on the same project are not affected by the old interaction.
		await t.notifier.deliver(reply(3, "p2"));
		await t.clock.advance(11_999, t.notifier);
		expect(t.sent).toHaveLength(0);
		await t.clock.advance(1, t.notifier);
		expect(t.sent.map((push) => push.deviceId).sort()).toEqual(["phone", "tablet"]);
		expect(t.sent.map((push) => push.payload["projectId"])).toEqual(["p1", "p1"]);
		await t.clock.advance(3_000, t.notifier);
		expect(t.sent.map((push) => push.payload["projectId"])).toEqual(["p1", "p1", "p2", "p2"]);
	});

	it("pushes backend-wide events after the hold despite interaction", async () => {
		const t = await rig();
		await register(t.notifier, "phone");
		const laptop = {};
		t.presence.set(laptop, { deviceId: "laptop", visible: true, projectId: "p1" });
		await t.notifier.deliver({ kind: "disk_low", title: "Disk low", body: "Free some disk space." });
		await t.notifier.deliver(reply());
		expect(t.notifier.interaction(laptop)).toBe(1);
		await t.clock.advance(14_999, t.notifier);
		expect(t.sent).toHaveLength(0);
		await t.clock.advance(1, t.notifier);
		expect(t.sent.map((push) => push.payload)).toMatchObject([{ kind: "disk_low", projectId: null }]);
	});

	it("drops nothing when the visible project is on another backend", async () => {
		const t = await rig();
		await register(t.notifier, "phone");
		const laptop = {};
		t.presence.set(laptop, { deviceId: "laptop", visible: true, projectId: null });
		await t.notifier.deliver(reply());
		expect(t.notifier.interaction(laptop)).toBe(0);
		await t.clock.advance(15_000, t.notifier);
		expect(t.sent.map((push) => push.payload)).toMatchObject([{ kind: "reply", projectId: "p1" }]);
	});

	it("times each event from its own moment", async () => {
		const t = await rig();
		await register(t.notifier, "phone");
		t.presence.set({}, { deviceId: "laptop", visible: true, projectId: null });
		await t.notifier.deliver(reply(1));
		await t.clock.advance(10_000, t.notifier);
		await t.notifier.deliver(reply(2));
		await t.clock.advance(5_000, t.notifier);
		expect(t.sent).toHaveLength(1);
		await t.clock.advance(10_000, t.notifier);
		expect(t.sent).toHaveLength(2);
	});

	it("keeps holding when the page goes hidden, and still pushes at 15 s", async () => {
		const t = await rig();
		await register(t.notifier, "phone");
		const connection = {};
		t.presence.set(connection, { deviceId: "laptop", visible: true, projectId: "p1" });
		await t.notifier.deliver(reply());
		await t.clock.advance(4_000, t.notifier);
		t.presence.set(connection, { deviceId: "laptop", visible: false, projectId: "p1" });
		expect(t.notifier.interaction(connection)).toBe(0);
		await t.clock.advance(10_999, t.notifier);
		expect(t.sent).toHaveLength(0);
		await t.clock.advance(1, t.notifier);
		expect(t.sent).toHaveLength(1);
	});

	it("keeps holding when the connection closes during the hold", async () => {
		const t = await rig();
		await register(t.notifier, "phone");
		const connection = {};
		t.presence.set(connection, { deviceId: "laptop", visible: true, projectId: "p1" });
		await t.notifier.deliver(reply());
		t.presence.remove(connection);
		await t.clock.advance(15_000, t.notifier);
		expect(t.sent).toHaveLength(1);
	});

	it("applies mutes, kinds and quiet hours when the hold ends, not only when it starts", async () => {
		const t = await rig();
		// 12:00Z is 14:00 in Bucharest, inside the "quiet" device's 13:00-15:00.
		await register(t.notifier, "muted-later");
		await register(t.notifier, "quiet", {
			quietHours: { start: "13:00", end: "15:00", timezone: "Europe/Bucharest", allowFailures: true },
		});
		await register(t.notifier, "no-replies", { kinds: ["worker_failed"] });
		await register(t.notifier, "plain-but-muted", { mutedProjects: ["p1"] });
		await register(t.notifier, "plain");
		t.presence.set({}, { deviceId: "laptop", visible: true, projectId: null });
		await t.notifier.deliver(reply());
		// The user mutes the project for this device while the event waits.
		await register(t.notifier, "muted-later", { mutedProjects: ["p1"] });
		await t.clock.advance(15_000, t.notifier);
		expect(t.sent.map((push) => push.deviceId)).toEqual(["plain"]);

		// A failure comes through quiet hours for the device that allows it, held or not.
		await t.notifier.deliver({ kind: "worker_failed", title: "Worker failed", body: "x", projectId: "p1", workerId: "w1" });
		await t.clock.advance(15_000, t.notifier);
		expect(t.sent.slice(1).map((push) => push.deviceId).sort()).toEqual(["no-replies", "plain", "quiet"]);
	});

	it("mutes one project's pushes until the deadline, leaving other projects and devices alone", async () => {
		const t = await rig();
		const until = t.clock.now + 60_000;
		await register(t.notifier, "phone", { projectMutes: [{ projectId: "p1", until }], mutedProjects: ["legacy"] });
		await register(t.notifier, "other-device");
		await t.notifier.deliver(reply());
		expect(t.sent.map(push => push.deviceId)).toEqual(["other-device"]);
		await t.notifier.deliver(reply(1, "p2"));
		expect(t.sent.slice(1).map(push => push.deviceId)).toEqual(["phone", "other-device"]);
		await t.clock.advance(60_000, t.notifier);
		await t.notifier.deliver(reply(2));
		expect(t.sent.slice(3).map(push => push.deviceId)).toEqual(["phone", "other-device"]);
		await t.notifier.deliver(reply(1, "legacy"));
		expect(t.sent.slice(5).map(push => push.deviceId)).toEqual(["other-device"]);
		await t.notifier.flush();
		const raw = await Bun.file(join(t.dir, "devices.json")).json();
		expect(raw.devices[0].preferences).not.toHaveProperty("projectMutes");
		expect(raw.devices[0].preferences.mutedProjects).toEqual(["legacy"]);
	});

	it("admits a held push when its only device's mute expires before the hold ends", async () => {
		const t = await rig();
		await register(t.notifier, "phone", { projectMutes: [{ projectId: "p1", until: t.clock.now + 5_000 }] });
		t.presence.set({}, { deviceId: "browser", visible: true, projectId: null });
		expect(await t.notifier.deliver(reply())).toMatchObject({ skipped: "held" });
		await t.clock.advance(14_999, t.notifier);
		expect(t.sent).toHaveLength(0);
		await t.clock.advance(1, t.notifier);
		expect(t.sent.map(push => push.deviceId)).toEqual(["phone"]);
	});

	it("a whole-backend mute hides all alert kinds, including backend-wide failures, until cleared or expired", async () => {
		const t = await rig();
		const failure = { kind: "disk_low" as const, title: "Fixture", body: "Low disk." };
		await register(t.notifier, "phone", { backendMute: {} });
		await t.notifier.deliver(reply());
		await t.notifier.deliver(failure);
		expect(t.sent).toHaveLength(0);
		await register(t.notifier, "phone", { backendMute: { until: t.clock.now + 5_000 } });
		await t.notifier.deliver(failure);
		expect(t.sent).toHaveLength(0);
		await t.clock.advance(5_000, t.notifier);
		await t.notifier.deliver(failure);
		expect(t.sent.map(push => push.deviceId)).toEqual(["phone"]);
		await register(t.notifier, "phone", { backendMute: {} });
		await register(t.notifier, "phone"); // An omitted optional field in a full preference update clears it.
		await t.notifier.deliver(reply(2));
		expect(t.sent).toHaveLength(2);
	});

	it("writes the rollback-readable v1 device shape, and only expiry fields are pruned or ignored on read", async () => {
		const t = await rig();
		const until = t.clock.now + 10_000;
		await register(t.notifier, "phone", {
			mutedProjects: ["legacy"], projectMutes: [{ projectId: "timed", until }], backendMute: { until },
		});
		const file = join(t.dir, "devices.json");
		const raw = await Bun.file(file).json();
		const legacyFile = Type.Object({ version: Type.Literal(1), devices: Type.Array(Type.Object({
			deviceId: Type.String(), fcmToken: Type.String(), backendKey: Type.String(),
			preferences: Type.Object({ kinds: Type.Array(Type.String()), mutedProjects: Type.Array(Type.String()), quietHours: Type.Null() }),
		})) });
		expect(Value.Check(legacyFile, raw)).toBe(true);
		expect(raw.devices[0].preferences).toMatchObject({ mutedProjects: ["legacy"], projectMutes: [{ projectId: "timed", until }], backendMute: { until } });
		const after = new NotificationStore({ dir: t.dir });
		await after.read(until);
		expect(after.get("phone")?.preferences).toStrictEqual(preferences({ mutedProjects: ["legacy"] }));
		raw.devices[0].preferences.projectMutes.push({ projectId: "bad", until: "bad-date" }, { projectId: "untimed" });
		raw.devices[0].preferences.backendMute = { until: null };
		await Bun.write(file, JSON.stringify(raw));
		const cleaned = new NotificationStore({ dir: t.dir });
		await cleaned.read(t.clock.now);
		expect(cleaned.get("phone")?.preferences).toStrictEqual(preferences({
			mutedProjects: ["legacy", "untimed"], projectMutes: [{ projectId: "timed", until }],
		}));
	});

	it("does not hold, or write anything down, for an event no device wants", async () => {
		const t = await rig();
		await register(t.notifier, "muted", { mutedProjects: ["p1"] });
		t.presence.set({}, { deviceId: "laptop", visible: true, projectId: null });
		const result = await t.notifier.deliver(reply());
		expect(result.skipped).toBe("filtered");
		expect(t.notifier.heldCount).toBe(0);
		expect(t.clock.timers).toBe(0);
	});

	it("still dedupes an event that is held, and claims its key even though nothing is pushed", async () => {
		const t = await rig();
		await register(t.notifier, "phone");
		t.presence.set({}, { deviceId: "laptop", visible: true, projectId: null });
		await t.notifier.deliver(reply(1));
		expect(await t.notifier.deliver(reply(1))).toEqual({ skipped: "duplicate", deliveries: [] });
		expect(t.notifier.heldCount).toBe(1);
	});

	it("a test push is never held", async () => {
		const t = await rig();
		await register(t.notifier, "phone");
		t.presence.set({}, { deviceId: "laptop", visible: true, projectId: null });
		await t.notifier.test("phone");
		expect(t.sent).toHaveLength(1);
	});
});

describe("a restart during a hold", () => {
	async function restartAfter(downMs: number): Promise<{ before: Rig; after: Rig }> {
		const before = await rig();
		await register(before.notifier, "phone");
		before.presence.set({}, { deviceId: "laptop", visible: true, projectId: "p1" });
		await before.notifier.deliver(reply(1));
		await before.clock.advance(4_000, before.notifier);
		// The process ends: timers die with it, the state file stays.
		before.notifier.stop();
		await before.notifier.flush();
		const clock = new FakeClock();
		clock.now = before.clock.now + downMs;
		const after = await rig({ dir: before.dir, clock });
		return { before, after };
	}

	it("carries on with the rest of the hold, so a reconnecting client can still drop it", async () => {
		const { before, after } = await restartAfter(2_000);
		expect(before.sent).toHaveLength(0);
		expect(after.notifier.heldCount).toBe(1);
		after.notifier.restore();
		// 4 s were served, 2 s the server was down: 9 s remain.
		await after.clock.advance(8_999, after.notifier);
		expect(after.sent).toHaveLength(0);
		await after.clock.advance(1, after.notifier);
		expect(after.sent.map((push) => push.deviceId)).toEqual(["phone"]);
		expect(after.sent[0]?.payload["at"]).toBe("2026-11-08T12:00:00.000Z");
	});

	it("can be dropped by an interaction after the restart", async () => {
		const { after } = await restartAfter(1_000);
		after.notifier.restore();
		const reconnected = {};
		after.presence.set(reconnected, { deviceId: "laptop", visible: true, projectId: "p1" });
		expect(after.notifier.interaction(reconnected)).toBe(1);
		await after.clock.advance(60_000, after.notifier);
		expect(after.sent).toHaveLength(0);
		expect(await after.notifier.deliver(reply(1))).toEqual({ skipped: "duplicate", deliveries: [] });
	});

	it("pushes at once when the hold ran out while the server was down, and only once", async () => {
		const { after } = await restartAfter(60_000);
		after.notifier.restore();
		await after.clock.advance(0, after.notifier);
		expect(after.sent.map((push) => push.deviceId)).toEqual(["phone"]);
		// A second restart finds nothing left to send.
		after.notifier.stop();
		await after.notifier.flush();
		const third = await rig({ dir: after.dir, clock: after.clock });
		third.notifier.restore();
		await third.clock.advance(60_000, third.notifier);
		expect(third.sent).toHaveLength(0);
		expect(third.notifier.heldCount).toBe(0);
	});

	it("ignores a held entry in the state file that is not an event", async () => {
		const dir = await temporaryHoldDirectory();
		await Bun.write(
			join(dir, "state.json"),
			JSON.stringify({ version: 1, deployAttempt: null, notified: [], held: [{ id: 1 }, { id: "x", at: "a", dueAt: 1, event: { kind: "nope" } }] }),
		);
		const t = await rig({ dir });
		expect(t.notifier.heldCount).toBe(0);
	});
});
