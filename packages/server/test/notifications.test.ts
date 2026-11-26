/**
 * Web Push notifications: the crypto a real push service checks, the filtering rules, and every event source firing once.
 *
 * The push service is fake but the wire is real: the server encrypts and signs with `web-push`, posts with `fetch` to a
 * local `Bun.serve`, and this file decrypts the RFC 8291 body and verifies the VAPID JWT with WebCrypto — the checks a
 * real push service makes. No network, no service worker.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Conversation, JsonObject } from "@earendil-works/pi-durable";
import type { ConversationView, ModelRef, NotificationPreferences } from "@kemiri/protocol";
import { DEFAULT_NOTIFICATION_KINDS } from "@kemiri/protocol";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	DEFAULT_ACTIVITY,
	ProjectActivityService,
	type CompactionFailureNotice,
	type ReplyNotice,
} from "../src/activity.ts";
import {
	KEPT_NOTIFIED_KEYS,
	NotificationPresence,
	NotificationStateStore,
	NotificationStore,
	Notifier,
	createVapidKeys,
	inQuietHours,
	loadOrCreateVapidKeys,
	notificationBlocked,
	notificationPayload,
	notificationTag,
	replyNotification,
	resolveVapidKeyFile,
	resolveVapidSubject,
	vapidKeysWork,
} from "../src/notifications.ts";
import { fakeOAuthProvider } from "./fake-oauth-provider.ts";
import { createSetup, errorOf, TestClient, ViewClient, type TestSetup } from "./support.ts";

const cleanups: (() => Promise<void>)[] = [];
const clients: TestClient[] = [];
const services: FakePushService[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	for (const service of services.splice(0)) service.stop();
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const FAUX: ModelRef = { provider: "faux", modelId: "faux-1" };
const APP_ORIGIN = "https://harness.test";

const ALL_KINDS: NotificationPreferences["kinds"] = [
	...DEFAULT_NOTIFICATION_KINDS,
	"worker_report",
	"task_review",
	"schedule_done",
	"compaction_failed",
	"maintenance_failed",
];

function preferences(change: Partial<NotificationPreferences> = {}): NotificationPreferences {
	return { kinds: [...ALL_KINDS], mutedProjects: [], quietHours: null, ...change };
}

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "aiki-notify-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	return dir;
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("timed out waiting for a condition");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function base64url(bytes: Uint8Array | ArrayBuffer): string {
	return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
}

function bytesOf(source: Uint8Array): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(source.length);
	copy.set(source);
	return copy;
}

// --- the fake push service ----------------------------------------------------------------------------------------

type FakeSubscription = { id: string; privateKey: CryptoKey; auth: string; status: number };

/** One push the fake service received, with the payload it could decrypt. */
type ReceivedPush = {
	id: string;
	headers: Record<string, string>;
	payload: Record<string, unknown> | undefined;
	/** Why the payload could not be decrypted, when that happened. */
	decryptError: string | undefined;
};

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey("raw", bytesOf(ikm), "HKDF", false, ["deriveBits"]);
	return new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: "HKDF", hash: "SHA-256", salt: bytesOf(salt), info: bytesOf(info) },
			key,
			length * 8,
		),
	);
}

const encoder = new TextEncoder();

/**
 * RFC 8291 aes128gcm as a browser performs it: the body is salt(16) | record size(4) | key id length(1) | the
 * sender's public key | one encrypted record, and the keys come from ECDH with the subscription's private key plus
 * HKDF over the auth secret.
 */
async function decryptPush(
	subscription: FakeSubscription,
	uaPublic: Uint8Array,
	body: Uint8Array,
): Promise<string> {
	const salt = body.subarray(0, 16);
	const idLength = body[20]!;
	const senderPublic = body.subarray(21, 21 + idLength);
	const ciphertext = body.subarray(21 + idLength);
	const senderKey = await crypto.subtle.importKey(
		"raw",
		bytesOf(senderPublic),
		{ name: "ECDH", namedCurve: "P-256" },
		false,
		[],
	);
	const shared = new Uint8Array(
		await crypto.subtle.deriveBits(
			{ name: "ECDH", public: senderKey },
			subscription.privateKey,
			256,
		),
	);
	const keyInfo = Buffer.concat([
		Buffer.from(encoder.encode("WebPush: info\0")),
		Buffer.from(uaPublic),
		Buffer.from(senderPublic),
	]);
	const ikm = await hkdf(shared, Buffer.from(subscription.auth, "base64url"), keyInfo, 32);
	const cek = await hkdf(ikm, salt, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(ikm, salt, encoder.encode("Content-Encoding: nonce\0"), 12);
	const key = await crypto.subtle.importKey("raw", bytesOf(cek), "AES-GCM", false, ["decrypt"]);
	const plain = new Uint8Array(
		await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytesOf(nonce) }, key, bytesOf(ciphertext)),
	);
	// The last byte is the padding delimiter; everything before it is the payload.
	let end = plain.length - 1;
	while (end >= 0 && plain[end] === 0) end -= 1;
	if (end < 0 || plain[end] !== 0x02) throw new Error("no padding delimiter");
	return new TextDecoder().decode(plain.subarray(0, end));
}

/** A push service on loopback: it holds each subscription's private key and answers with a status of its choosing. */
class FakePushService {
	readonly pushes: ReceivedPush[] = [];
	readonly #subscriptions = new Map<string, FakeSubscription & { publicKey: Uint8Array }>();
	#server: ReturnType<typeof Bun.serve> | undefined;
	#sequence = 0;

	get url(): string {
		const server = this.#server;
		if (server === undefined) throw new Error("the fake push service is not running");
		return `http://127.0.0.1:${server.port}`;
	}

	start(): void {
		this.#server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async (request) => {
				const url = new URL(request.url);
				const id = url.pathname.split("/").pop() ?? "";
				const subscription = this.#subscriptions.get(id);
				const body = new Uint8Array(await request.arrayBuffer());
				const headers: Record<string, string> = {};
				request.headers.forEach((value, name) => {
					headers[name.toLowerCase()] = value;
				});
				if (subscription === undefined) return new Response("unknown subscription", { status: 404 });
				const record: ReceivedPush = { id, headers, payload: undefined, decryptError: undefined };
				try {
					const text = await decryptPush(subscription, subscription.publicKey, body);
					record.payload = JSON.parse(text) as Record<string, unknown>;
				} catch (error) {
					record.decryptError = error instanceof Error ? error.message : String(error);
				}
				this.pushes.push(record);
				return new Response(null, { status: subscription.status });
			},
		});
		this.#server.unref?.();
	}

	/** A browser subscription, with its keys and the endpoint that leads back here. */
	async subscribe(status = 201): Promise<{
		subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
		publicKey: Uint8Array;
	}> {
		const keys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
		const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
		const publicKey = Buffer.concat([
			Buffer.from([0x04]),
			Buffer.from(jwk.x ?? "", "base64url"),
			Buffer.from(jwk.y ?? "", "base64url"),
		]);
		const auth = base64url(crypto.getRandomValues(new Uint8Array(16)));
		const id = `sub-${++this.#sequence}`;
		this.#subscriptions.set(id, { id, privateKey: keys.privateKey, publicKey, auth, status });
		return {
			subscription: { endpoint: `${this.url}/push/${id}`, keys: { p256dh: base64url(publicKey), auth } },
			publicKey: new Uint8Array(publicKey),
		};
	}

	setStatus(endpoint: string, status: number): void {
		const id = endpoint.split("/").pop() ?? "";
		const subscription = this.#subscriptions.get(id);
		if (subscription === undefined) throw new Error(`no fake subscription for ${endpoint}`);
		subscription.status = status;
	}

	ofKind(kind: string): ReceivedPush[] {
		return this.pushes.filter((push) => push.payload?.["kind"] === kind);
	}

	stop(): void {
		this.#server?.stop(true);
		this.#server = undefined;
	}
}

function startPush(): FakePushService {
	const service = new FakePushService();
	service.start();
	services.push(service);
	return service;
}

/** Verify the VAPID JWT a push carries with the public key the backend answers in `notifications.config`. */
async function verifyVapidJwt(authorization: string, publicKey: string): Promise<Record<string, unknown>> {
	const match = /^vapid t=([^,]+), k=(.+)$/.exec(authorization);
	expect(match).not.toBeNull();
	const jwt = match![1]!;
	const header = match![2]!;
	expect(header).toBe(publicKey);
	const [encodedHeader, encodedPayload, signature] = jwt.split(".");
	const key = await crypto.subtle.importKey(
		"raw",
		bytesOf(Buffer.from(publicKey, "base64url")),
		{ name: "ECDSA", namedCurve: "P-256" },
		false,
		["verify"],
	);
	const valid = await crypto.subtle.verify(
		{ name: "ECDSA", hash: "SHA-256" },
		key,
		bytesOf(Buffer.from(signature ?? "", "base64url")),
		bytesOf(encoder.encode(`${encodedHeader}.${encodedPayload}`)),
	);
	expect(valid).toBe(true);
	return JSON.parse(Buffer.from(encodedPayload ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
}

// --- server helpers ---------------------------------------------------------------------------------------------

type Harness = { test: TestSetup; push: FakePushService };

async function setupWithPush(options: Parameters<typeof createSetup>[0] = {}): Promise<Harness> {
	const push = startPush();
	// Every test registers its own subscriptions on this service; the server pushes to nobody else.
	const test = await createSetup({
		allowedOrigins: [APP_ORIGIN],
		...options,
		notifications: { subject: APP_ORIGIN, ...(options.notifications ?? {}) },
	});
	cleanups.push(test.cleanup);
	return { test, push };
}

async function connect(server: TestSetup["server"]): Promise<TestClient> {
	const client = await TestClient.open(server);
	clients.push(client);
	return client;
}

async function addProject(client: TestClient, path: string): Promise<string> {
	const response = await client.request({ type: "projects.add", path });
	if (response.type !== "projects.add") throw new Error(JSON.stringify(response));
	return response.project.id;
}

async function configureCoordinator(client: TestClient, projectId: string): Promise<void> {
	const response = await client.request({
		type: "projects.configure",
		projectId,
		coordinatorModel: FAUX,
		coordinatorThinkingLevel: null,
		workerModels: [FAUX],
	});
	if (response.type !== "projects.configure") throw errorOf(response);
}

/** Register one device with the fake push service's subscription. */
async function registerDevice(
	client: TestClient,
	push: FakePushService,
	options: { deviceId?: string; backendKey?: string; preferences?: NotificationPreferences; status?: number } = {},
): Promise<{ deviceId: string; endpoint: string }> {
	const { subscription } = await push.subscribe(options.status);
	const deviceId = options.deviceId ?? "device-1";
	const response = await client.request({
		type: "notifications.register",
		deviceId,
		label: "Test device",
		backendKey: options.backendKey ?? "harness-pc",
		subscription,
		preferences: options.preferences ?? preferences(),
	});
	if (response.type !== "notifications.register") throw errorOf(response);
	return { deviceId, endpoint: subscription.endpoint };
}

describe("backend-local VAPID persistence", () => {
	it("creates the first pair at <data>/notifications/vapid.json, mode 0600, and keeps it across restarts", async () => {
		const dataDir = await tempDir();
		const file = resolveVapidKeyFile(dataDir, {});
		expect(file).toBe(join(dataDir, "notifications", "vapid.json"));
		const first = await loadOrCreateVapidKeys(file);
		expect(await vapidKeysWork(first)).toBe(true);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		const bytes = await readFile(file, "utf8");
		expect(await loadOrCreateVapidKeys(file)).toEqual(first);
		expect(await readFile(file, "utf8")).toBe(bytes);
		await chmod(file, 0o644);
		expect(await loadOrCreateVapidKeys(file)).toEqual(first);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
	});
	it("fails on malformed JSON, malformed key shape and a mismatched pair without overwriting", async () => {
		const file = join(await tempDir(), "vapid.json");
		const a = await createVapidKeys();
		const b = await createVapidKeys();
		for (const malformed of [
			"{broken",
			"null",
			"{}",
			JSON.stringify({ publicKey: a.publicKey, privateKey: b.privateKey }),
		]) {
			await writeFile(file, malformed);
			await expect(loadOrCreateVapidKeys(file)).rejects.toThrow();
			expect(await readFile(file, "utf8")).toBe(malformed);
		}
	});
	it("retains KEMIRI_VAPID_KEY_FILE and KEMIRI_VAPID_SUBJECT overrides", async () => {
		const root = await tempDir();
		const file = join(root, "private-override.json");
		expect(resolveVapidKeyFile(root, { KEMIRI_VAPID_KEY_FILE: file })).toBe(file);
		expect(resolveVapidSubject([], { KEMIRI_VAPID_SUBJECT: "mailto:push@example.test" })).toBe(
			"mailto:push@example.test",
		);
		expect(resolveVapidSubject([], { KEMIRI_VAPID_SUBJECT: "https://backend.example.test/contact" })).toBe(
			"https://backend.example.test/contact",
		);
		const setup = await createSetup({
			notifications: { vapidKeyFile: file, subject: "mailto:push@example.test", fcmKeyFile: null },
		});
		cleanups.push(setup.cleanup);
		const first = setup.server.notifications.vapid;
		expect(await loadOrCreateVapidKeys(file)).toEqual(first);
		expect(setup.server.notifications.subject).toBe("mailto:push@example.test");
		await setup.restart();
		expect(setup.server.notifications.vapid).toEqual(first);
	});
});

// --- crypto against a fake push endpoint -------------------------------------------------------------------------

describe("a push the fake service can decrypt", () => {
	it("encrypts for the subscription and signs a VAPID JWT with the backend's key", async () => {
		const push = startPush();
		const dir = await tempDir();
		const keys = await loadOrCreateVapidKeys(join(dir, "notifications", "vapid.json"));
		expect(await vapidKeysWork(keys)).toBe(true);
		// The file is private and holds the same pair a second read reports.
		expect((await readFile(join(dir, "notifications", "vapid.json"), "utf8")).length).toBeGreaterThan(0);
		expect(await loadOrCreateVapidKeys(join(dir, "notifications", "vapid.json"))).toEqual(keys);

		const store = new NotificationStore({ dir: join(dir, "notifications") });
		const state = new NotificationStateStore({ dir: join(dir, "notifications") });
		const notifier = new Notifier({ store, state, vapid: keys, subject: APP_ORIGIN });
		const { subscription, publicKey } = await push.subscribe();
		await notifier.register({
			deviceId: "pixel",
			label: "Pixel",
			backendKey: "harness-pc",
			subscription,
			preferences: preferences(),
		});

		const result = await notifier.deliver({
			kind: "reply",
			title: "harness replied",
			body: "The build is green.",
			projectId: "project-1",
			key: "reply:project-1:7",
		});
		expect(result.deliveries).toEqual([{ deviceId: "pixel", ok: true, status: 201, message: null }]);

		const [received] = push.pushes;
		expect(received?.decryptError).toBeUndefined();
		expect(received?.payload).toMatchObject({
			kind: "reply",
			title: "harness replied",
			body: "The build is green.",
			backendKey: "harness-pc",
			projectId: "project-1",
			workerId: null,
			scheduleId: null,
			tag: "reply:project-1",
		});
		expect(typeof received?.payload?.["at"]).toBe("string");
		// aes128gcm, a 12-hour TTL, and the VAPID JWT signed with the key `notifications.config` answers.
		expect(received?.headers["content-encoding"]).toBe("aes128gcm");
		expect(received?.headers["ttl"]).toBe("43200");
		const claims = await verifyVapidJwt(received?.headers["authorization"] ?? "", keys.publicKey);
		expect(claims["sub"]).toBe(APP_ORIGIN);
		expect(claims["aud"]).toBe(push.url);
		// The payload is what the service worker parses, per the protocol.
		expect(publicKey.length).toBe(65);
	});

	it("marks failures urgent and keeps a normal push normal", async () => {
		const push = startPush();
		const dir = await tempDir();
		const keys = await createVapidKeys();
		const store = new NotificationStore({ dir });
		const notifier = new Notifier({ store, state: new NotificationStateStore({ dir }), vapid: keys, subject: APP_ORIGIN });
		const { subscription } = await push.subscribe();
		await notifier.register({
			deviceId: "pixel",
			label: "Pixel",
			backendKey: "harness-pc",
			subscription,
			preferences: preferences(),
		});

		await notifier.deliver({ kind: "worker_failed", title: "Worker failed", body: "it broke", projectId: "p" });
		await notifier.deliver({ kind: "worker_report", title: "Worker reported", body: "done", projectId: "p" });

		expect(push.pushes[0]?.headers["urgency"]).toBe("high");
		expect(push.pushes[1]?.headers["urgency"]).toBe("normal");
		expect(push.pushes[0]?.headers["topic"]).toBeTruthy();
		expect((push.pushes[0]?.headers["topic"] ?? "").length).toBeLessThanOrEqual(32);
	});

	it("drops a device whose subscription the push service forgot, and records other failures", async () => {
		const push = startPush();
		const dir = await tempDir();
		const keys = await createVapidKeys();
		const store = new NotificationStore({ dir });
		const notifier = new Notifier({
			store,
			state: new NotificationStateStore({ dir }),
			vapid: keys,
			subject: APP_ORIGIN,
		});
		const gone = await push.subscribe(410);
		await notifier.register({
			deviceId: "gone",
			label: "Gone",
			backendKey: "harness-pc",
			subscription: gone.subscription,
			preferences: preferences(),
		});
		const broken = await push.subscribe(500);
		await notifier.register({
			deviceId: "broken",
			label: "Broken",
			backendKey: "harness-pc",
			subscription: broken.subscription,
			preferences: preferences(),
		});

		// A failure reaches no caller: the delivery reports it, the event still counts as handled.
		const result = await notifier.deliver({ kind: "reply", title: "Reply", body: "hi", projectId: "p", key: "reply:p:1" });
		expect(result.deliveries.map((delivery) => [delivery.deviceId, delivery.ok, delivery.status])).toEqual([
			["gone", false, 410],
			["broken", false, 500],
		]);
		expect(store.list().map((device) => device.deviceId)).toEqual(["broken"]);
		expect(store.get("broken")?.lastDelivery).toMatchObject({ ok: false, status: 500 });
		expect(store.get("broken")?.lastDelivery?.message).toBeNull();

		// The same key is not delivered twice, and a new one is.
		const duplicate = await notifier.deliver({ kind: "reply", title: "Reply", body: "hi", projectId: "p", key: "reply:p:1" });
		expect(duplicate.skipped).toBe("duplicate");
		expect(push.pushes.length).toBe(2);
	});
});

// --- filtering ----------------------------------------------------------------------------------------------------

describe("filtering", () => {
	const device = (change: Partial<NotificationPreferences> = {}) => ({
		deviceId: "device-1",
		preferences: preferences(change),
	});

	it("reads quiet hours in the device's timezone, across midnight", () => {
		const quiet = { start: "22:00", end: "07:00", timezone: "Europe/Bucharest", allowFailures: false };
		// Bucharest is UTC+2 in November, so 21:30Z is 23:30 local and 05:30Z is 07:30 local.
		expect(inQuietHours(quiet, new Date("2026-11-05T21:30:00Z"))).toBe(true);
		expect(inQuietHours(quiet, new Date("2026-11-05T04:59:00Z"))).toBe(true); // 06:59 local
		expect(inQuietHours(quiet, new Date("2026-11-05T05:00:00Z"))).toBe(false); // 07:00 local
		expect(inQuietHours(quiet, new Date("2026-11-05T10:00:00Z"))).toBe(false); // 12:00 local
		// A window inside one day, and the two ends that mean no quiet hours.
		const daytime = { start: "09:00", end: "17:00", timezone: "UTC", allowFailures: false };
		expect(inQuietHours(daytime, new Date("2026-11-05T08:59:00Z"))).toBe(false);
		expect(inQuietHours(daytime, new Date("2026-11-05T09:00:00Z"))).toBe(true);
		expect(inQuietHours(daytime, new Date("2026-11-05T17:00:00Z"))).toBe(false);
		expect(inQuietHours({ ...daytime, start: "09:00", end: "09:00" }, new Date("2026-11-05T09:00:00Z"))).toBe(false);
		// A zone Intl does not know never silences a device.
		expect(inQuietHours({ ...quiet, timezone: "Mars/Olympus" }, new Date("2026-11-05T21:30:00Z"))).toBe(false);
	});

	it("blocks by kind, mute and quiet hours, letting failures through when asked", () => {
		const at = new Date("2026-11-05T21:30:00Z");
		const event = { kind: "reply" as const, projectId: "project-1" };
		expect(notificationBlocked(device(), event, { at })).toBeUndefined();
		expect(notificationBlocked(device({ kinds: ["worker_failed"] }), event, { at })).toBe("kind");
		expect(notificationBlocked(device({ mutedProjects: ["project-1"] }), event, { at })).toBe("muted");
		expect(notificationBlocked(device({ mutedProjects: ["other"] }), event, { at })).toBeUndefined();
		// A global event has no project to be muted.
		expect(
			notificationBlocked(device({ mutedProjects: ["project-1"] }), { kind: "deploy_problem", projectId: null }, { at }),
		).toBeUndefined();

		const quiet = { start: "22:00", end: "07:00", timezone: "Europe/Bucharest", allowFailures: false };
		expect(notificationBlocked(device({ quietHours: quiet }), event, { at })).toBe("quiet");
		expect(
			notificationBlocked(device({ quietHours: { ...quiet, allowFailures: true } }), event, { at }),
		).toBe("quiet");
		expect(
			notificationBlocked(device({ quietHours: { ...quiet, allowFailures: true } }), { kind: "worker_failed", projectId: "project-1" }, { at }),
		).toBeUndefined();
		// A test push is never filtered: the user asked for it just now.
		expect(
			notificationBlocked(
				device({ kinds: [], mutedProjects: ["project-1"], quietHours: quiet }),
				{ kind: "test", projectId: null },
				{ at },
			),
		).toBeUndefined();
	});

	it("forgets presence when a connection is removed, and counts a hidden page as not open", () => {
		const presence = new NotificationPresence();
		const first = {};
		const second = {};
		expect(presence.anyVisible()).toBe(false);
		presence.set(second, { deviceId: "device-2", visible: false, projectId: "project-1" });
		expect(presence.anyVisible()).toBe(false);
		presence.set(first, { deviceId: "device-1", visible: true, projectId: null });
		expect(presence.anyVisible()).toBe(true);
		presence.remove(first);
		expect(presence.anyVisible()).toBe(false);
		expect(presence.of("device-1")).toEqual([]);
	});

	it("keeps legacy body beside the longer preview and named targets", () => {
		const event = replyNotification({
			projectId: "project-1",
			projectName: "Harness",
			entryId: 4,
			at: "2026-11-05T10:00:00Z",
			text: "First line.\nSecond line.",
		});
		const payload = notificationPayload({ backendKey: "harness-vm" }, event, "2026-11-05T10:00:01Z", "Studio");
		expect(payload).toEqual({
			kind: "reply",
			title: "Harness replied",
			body: "First line.",
			message: "First line.\nSecond line.",
			computerName: "Studio",
			coordinatorName: "Main chat",
			projectName: "Harness",
			level: "important",
			key: "reply:project-1:4",
			backendKey: "harness-vm",
			projectId: "project-1",
			workerId: null,
			scheduleId: null,
			tag: "reply:project-1",
			at: "2026-11-05T10:00:01Z",
		});
		expect(notificationTag({ kind: "worker_report", projectId: "p", workerId: "w", scheduleId: null })).toBe(
			"worker_report:p:w",
		);
	});

	it("keeps the dedupe keys bounded and names the app as the VAPID subject", async () => {
		const dir = await tempDir();
		const state = new NotificationStateStore({ dir });
		for (let index = 0; index < KEPT_NOTIFIED_KEYS + 5; index += 1) expect(state.claim(`key-${index}`)).toBe(true);
		expect(state.claim("key-0")).toBe(true); // fell off the end, so it may be claimed again
		await state.flush();
		expect([...state.keys].length).toBeLessThanOrEqual(KEPT_NOTIFIED_KEYS);
		// The burst of claims shares writes, and the file still ends with the last state.
		const reread = new NotificationStateStore({ dir });
		await reread.read();
		expect([...reread.keys]).toEqual([...state.keys]);

		expect(resolveVapidSubject([APP_ORIGIN])).toBe(APP_ORIGIN);
		expect(resolveVapidSubject(["http://localhost:5173", APP_ORIGIN])).toBe(APP_ORIGIN);
		expect(resolveVapidSubject(["http://localhost:5173"])).toBe("https://localhost");
		expect(resolveVapidSubject([], { KEMIRI_VAPID_SUBJECT: "https://other.test" })).toBe("https://other.test");
	});
});

// --- events from the running server -------------------------------------------------------------------------------

function script(options: { delegate?: { text: string; call: JsonObject }; workerAnswer?: string }) {
	const delegate = options.delegate ?? {
		text: "Delegate the reading.",
		call: { id: "reader", task: "Read the README.", title: "Read the README" },
	};
	const workerAnswer = options.workerAnswer ?? "## Report\nOutcome: done";
	return (request: TranscriptContext) => {
		const last = request.messages.findLast((message) => message.role !== "system");
		const text =
			typeof last?.content === "string"
				? last.content
				: Array.isArray(last?.content)
					? last.content
							.map((part) => (part.type === "text" ? part.text : ""))
							.join("")
					: "";
		if (last?.role === "toolResult") return fauxAssistantMessage("Tool call finished.");
		if (text.includes(delegate.call["task"] as string)) return fauxAssistantMessage(workerAnswer);
		if (text.includes("reported]") || text.includes("failed:")) return fauxAssistantMessage("Report reviewed.");
		if (text.includes(delegate.text)) {
			return fauxAssistantMessage([fauxToolCall("worker_spawn", delegate.call)], { stopReason: "toolUse" });
		}
		return fauxAssistantMessage("Nothing to do.");
	};
}

/** The newest answer the project has published, which is how a test knows a reply landed. */
async function lastReplyId(test: TestSetup): Promise<number | null> {
	const [project] = await test.server.manager.list();
	return project?.activity?.lastReplyEntryId ?? null;
}

async function submit(client: TestClient, projectId: string, content: string, requestId: string): Promise<void> {
	const response = await client.request({ type: "conversation.submit", projectId, content, requestId });
	if (response.type !== "conversation.submit") throw errorOf(response);
}

describe("the requests", () => {
	it("answers the VAPID key, registers, tests, reports and forgets a device", async () => {
		const { test, push } = await setupWithPush();
		const client = await connect(test.server);
		await client.hello();

		const config = await client.request({ type: "notifications.config" });
		if (config.type !== "notifications.config") throw errorOf(config);
		expect(config.publicKey).toBe(test.server.notifications.publicKey);
		expect(await vapidKeysWork(test.server.notifications.vapid)).toBe(true);

		const { deviceId, endpoint } = await registerDevice(client, push);
		const device = await client.request({ type: "notifications.device", deviceId });
		if (device.type !== "notifications.device") throw errorOf(device);
		expect(device.device).toMatchObject({ deviceId, label: "Test device", backendKey: "harness-pc", lastDelivery: null });
		expect(device.device?.preferences.kinds).toEqual(ALL_KINDS);

		const tested = await client.request({ type: "notifications.test", deviceId });
		if (tested.type !== "notifications.test") throw errorOf(tested);
		expect(tested).toMatchObject({ ok: true, status: 201, message: null });
		expect(push.pushes[0]?.payload).toMatchObject({ kind: "test", tag: "test", projectId: null });
		const afterTest = await client.request({ type: "notifications.device", deviceId });
		if (afterTest.type !== "notifications.device") throw errorOf(afterTest);
		expect(afterTest.device?.lastDelivery).toMatchObject({ ok: true, status: 201 });

		// The push service forgot the subscription: the test says so and the device is gone.
		push.setStatus(endpoint, 410);
		const gone = await client.request({ type: "notifications.test", deviceId });
		if (gone.type !== "notifications.test") throw errorOf(gone);
		expect(gone).toMatchObject({ ok: false, status: 410 });
		const missing = await client.request({ type: "notifications.device", deviceId });
		if (missing.type !== "notifications.device") throw errorOf(missing);
		expect(missing.device).toBeNull();
		const unknown = await client.request({ type: "notifications.test", deviceId });
		expect(errorOf(unknown).code).toBe("bad_request");

		const unregistered = await client.request({ type: "notifications.unregister", deviceId });
		expect(unregistered.type).toBe("notifications.unregister");
	}, 30_000);
});

describe("events", () => {
	it("announces a filed answer once instead of the chat reply, including across a restart", async () => {
		const { test, push } = await setupWithPush();
		const client = await connect(test.server);
		await client.hello();
		const projectId = await addProject(client, test.projectDir);
		await configureCoordinator(client, projectId);
		await registerDevice(client, push);
		test.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("board", { action: "answer", title: "Checks", answer: "All green.\nTwo checks passed." })], { stopReason: "toolUse" }),
			fauxAssistantMessage("The verification is complete."),
		]);

		await submit(client, projectId, "How is it?", "req-1");
		await until(() => push.ofKind("reply").length === 1);
		expect(push.ofKind("reply")[0]?.payload).toMatchObject({
			kind: "reply",
			title: "project · General",
			coordinatorId: "main",
			entryId: expect.any(Number),
			answerId: "A1",
			body: "All green.",
			projectId,
			backendKey: "harness-pc",
		});

		const alerts = await test.server.notifications.recent(0);
		expect(alerts?.events.filter(event => event.type === "alert" && event.alert.kind === "reply")).toEqual([
			expect.objectContaining({ alert: expect.objectContaining({ kind: "reply", answerId: "A1", entryId: expect.any(Number) }) }),
		]);

		// The activity's last reply is persisted before the restart, so replaying the transcript notifies nothing.
		await until(async () => (await lastReplyId(test)) !== null);
		await sleep(100);
		const restarted = await test.restart();
		const again = await connect(restarted);
		await again.hello();
		await again.request({ type: "conversation.page", projectId, limit: 10 });
		await sleep(500);
		expect(push.ofKind("reply").length).toBe(1);
	}, 30_000);

	for (const coordinator of ["main", "area"] as const) {
		it(`notifies for owner chat, including a steer, but not harness-only turns in the ${coordinator} coordinator`, async () => {
			const { test, push } = await setupWithPush();
			const client = await connect(test.server);
			await client.hello();
			const projectId = await addProject(client, test.projectDir);
			await configureCoordinator(client, projectId);
			await registerDevice(client, push);
			const { runtime } = await test.server.manager.open(projectId);
			const area = await runtime.threads.create({ title: "Packing", area: "Pack sample orders." }, "packing");
			const threadId = coordinator === "main" ? "main" : area.id;
			const conversation = await runtime.threads.conversation(threadId);
			const submitOwnerChat = async (content: string, whenBusy?: "steer" | "followUp") => {
				const response = await client.request({ type: "conversation.submit", projectId, threadId, content, requestId: content,
					...(whenBusy === undefined ? {} : { whenBusy }) });
				if (response.type !== "conversation.submit") throw errorOf(response);
				return response;
			};
			const harnessInputs = [
				["worker-report", "[worker reader reported] Read the sample."],
				["check-in", "[check-in] Check on the sample."],
				["board-notice", "[board] The sample was updated."],
				["board-answer", "[board] The owner answered Q1: Yes."],
				["report-nudge", "[reports] File the sample results."],
				["landing-turn", "[turn] The landing turn is yours."],
				["usage-pause", "The provider is paused."],
				["schedule-wake", "Check the sample orders."],
			] as const;
			for (const [requestId, content] of harnessInputs) {
				test.faux.setResponses([fauxAssistantMessage(`Handled ${requestId}.`)]);
				const submitted = await conversation.submit({ type: "input", content, requestId }, BACKGROUND_CONTEXT);
				expect((await submitted.wait(BACKGROUND_CONTEXT)).status).toBe("done");
			}

			test.faux.setResponses([fauxAssistantMessage("Handled peer message.")]);
			const peerId = "fixture-peer-request";
			await runtime.threads.deliver({ sender: coordinator === "main" ? area.id : "main", receiver: threadId,
				message: "Count the boxes.", kind: "request", callId: peerId });
			await until(async () => (await conversation.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT))
				.items[0]?.model?.some(message => message.role === "assistant" && message.content.some(block => block.type === "text" && block.text === "Handled peer message.")) === true);

			test.faux.setResponses([fauxAssistantMessage("Direct reply.\nSecond line.")]);
			// The marker, not a familiar harness prefix, decides whether this is owner chat.
			await submitOwnerChat("[board] What does this prefix mean?");
			await until(() => push.ofKind("reply").some(push => push.payload?.body === "Direct reply."));

			for (const whenBusy of ["steer", "followUp"] as const) {
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const ownerText = `Owner ${whenBusy} message.`;
				const ownerReply = `Handled owner ${whenBusy}.`;
				test.faux.setResponses([
					async () => {
						entered.resolve();
						await release.promise;
						return whenBusy === "steer"
							? fauxAssistantMessage([fauxToolCall("board", { action: "list" })], { stopReason: "toolUse" })
							: fauxAssistantMessage("Harness reply before follow-up.");
					},
					(request: TranscriptContext) => {
						expect(request.messages.at(-1)).toMatchObject({ role: "user", content: ownerText });
						return fauxAssistantMessage(ownerReply);
					},
				]);
				await conversation.submit({ type: "input", content: "[check-in] Review the sample.", requestId: `check-${whenBusy}` }, BACKGROUND_CONTEXT);
				try {
					await entered.promise;
					expect((await submitOwnerChat(ownerText, whenBusy)).status).toBe("queued");
				} finally {
					release.resolve();
				}
				await until(() => push.ofKind("reply").some(push => push.payload?.body === ownerReply));
			}

			const expectedBodies = ["Direct reply.", "Handled owner steer.", "Handled owner followUp."];
			const replies = push.ofKind("reply").map(push => push.payload);
			expect(replies.map(reply => reply?.body)).toEqual(expectedBodies);
			for (const reply of replies) expect(reply).toMatchObject({ projectId, coordinatorId: threadId, tag: `reply:${projectId}:${threadId}` });
			const recent = await test.server.notifications.recent(0);
			expect(recent?.events.flatMap(event => event.type === "alert" && event.alert.kind === "reply" ? [event.alert.body] : [])).toEqual(expectedBodies);
		}, 30_000);
	}

	it("says nothing for an archived project, and notifies again once it is unarchived", async () => {
		const { test, push } = await setupWithPush();
		const client = await connect(test.server);
		await client.hello();
		const projectId = await addProject(client, test.projectDir);
		await configureCoordinator(client, projectId);
		await registerDevice(client, push);
		test.faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("Done.")));

		const archive = async (archived: boolean): Promise<void> => {
			const response = await client.request({ type: "projects.configure", projectId, archived });
			if (response.type !== "projects.configure") throw errorOf(response);
			expect(response.project.archived).toBe(archived ? true : undefined);
		};
		await archive(true);
		await submit(client, projectId, "one", "req-1");
		await until(async () => (await lastReplyId(test)) !== null);
		await sleep(300);
		expect(push.pushes.length).toBe(0);
		// A device-wide event (no project) still goes through.
		const deployLike = await test.server.notifications.deliver({ kind: "test", title: "Test", body: "x", projectId: null });
		expect(deployLike.deliveries).toHaveLength(1);

		await archive(false);
		await submit(client, projectId, "two", "req-2");
		await until(() => push.ofKind("reply").length === 1);
		expect(push.ofKind("reply")[0]?.payload).toMatchObject({ projectId });
	}, 30_000);

	it("tells the devices once when the coordinator asks a question on the board", async () => {
		const { test, push } = await setupWithPush();
		const client = await connect(test.server);
		await client.hello();
		const projectId = await addProject(client, test.projectDir);
		await configureCoordinator(client, projectId);
		await registerDevice(client, push);
		test.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("board", { action: "ask", text: "Which database should it use?" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Asked."),
		]);

		await submit(client, projectId, "Plan the storage.", "req-1");
		await until(() => push.ofKind("board_question").length === 1);
		expect(push.ofKind("board_question")[0]?.payload).toMatchObject({
			kind: "board_question",
			title: "project · General",
			coordinatorId: "main",
			body: "Which database should it use?",
			projectId,
		});
		await sleep(300);
		expect(push.ofKind("board_question").length).toBe(1);
	}, 30_000);

	it("clears an answered board question only for upgraded devices whose notice was accepted", async () => {
		const { test, push } = await setupWithPush();
		const client = await connect(test.server);
		await client.hello();
		const projectId = await addProject(client, test.projectDir);
		await configureCoordinator(client, projectId);
		const enabled = preferences({ quietResolutions: true });
		await registerDevice(client, push, { deviceId: "enabled", preferences: enabled });
		await registerDevice(client, push, { deviceId: "legacy" });
		await registerDevice(client, push, { deviceId: "failed", preferences: enabled, status: 503 });
		await registerDevice(client, push, { deviceId: "off", preferences: preferences({ kinds: [], quietResolutions: true }) });
		test.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("board", { action: "ask", text: "Which oven?" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Asked."),
		]);
		await submit(client, projectId, "Plan the benchmark.", "question-request");
		await until(() => push.ofKind("board_question").length === 3);
		const [notice] = push.ofKind("board_question");
		const question = (await (await test.server.manager.open(projectId)).runtime.board.state()).questions[0]!;
		expect(await client.request({ type: "board.question.answer", projectId, questionId: question.id,
			expectedRevision: question.revision, answer: "Stock" })).toMatchObject({ type: "board.question.answer" });
		await until(() => push.ofKind("resolved").length !== 0);
		await test.server.notifications.flush();
		const [clear] = push.ofKind("resolved");
		expect(push.ofKind("resolved")).toHaveLength(1);
		expect(clear).toMatchObject({ id: notice!.id, headers: { ttl: "300", urgency: "low" }, payload: {
			kind: "resolved", title: "", body: "", resolved: [{ tag: notice!.payload!.tag, at: notice!.payload!.at, key: notice!.payload!.key }],
		} });
		expect(clear?.headers.topic).toBeUndefined();
	}, 30_000);

 it("Ask back sends no question push; replies replace the question notification under its existing setting", async () => {
  const { test, push } = await setupWithPush();
  const client = await connect(test.server); await client.hello();
  const projectId = await addProject(client, test.projectDir);
  await configureCoordinator(client, projectId); await registerDevice(client, push);
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  test.faux.setResponses([
   fauxAssistantMessage([fauxToolCall("board", { action: "ask", text: "Which storage?" })], { stopReason: "toolUse" }),
   fauxAssistantMessage("Waiting."),
   async () => { await gate; return fauxAssistantMessage([fauxToolCall("board", { action: "reply_question", id: "Q1", expectedRevision: 2, text: "Shared storage is remote." })], { stopReason: "toolUse" }); },
   fauxAssistantMessage("Explained."),
  ]);
  const view = new ViewClient(client); await view.start(projectId);
  await submit(client, projectId, "Plan storage.", "ask-back-notify");
  await until(() => push.ofKind("board_question").length === 1);
  await view.waitForView(v => v.entries.some(e => JSON.stringify(e.model).includes("Waiting.")));
  try {
   const response = await client.request({ type: "board.question.clarify", projectId, questionId: "Q1", expectedRevision: 1, text: "What does remote mean?" });
   expect(response.type).toBe("board.question.clarify");
   expect(push.ofKind("board_question")).toHaveLength(1);
  } finally { release(); }
  await until(() => push.ofKind("board_question").length === 2);
  const [initial, reply] = push.ofKind("board_question");
  expect(reply!.payload).toMatchObject({ kind: "board_question", title: "project · General", coordinatorId: "main", body: "Shared storage is remote.", projectId, threadId: "main" });
  expect(initial?.payload?.tag).toBe(`board-question:${projectId}:Q1`);
  expect(reply?.payload?.tag).toBe(initial?.payload?.tag);
 }, 30_000);

	it("names the root request for a nested part's question, warning and steps in both transports", async () => {
		const { test, push } = await setupWithPush();
		const client = await connect(test.server); await client.hello();
		const projectId = await addProject(client, test.projectDir);
		await configureCoordinator(client, projectId);
		await registerDevice(client, push, { preferences: preferences({ kinds: [...new Set([...ALL_KINDS, "task_steps" as const])] }) });
		const board = (args: JsonObject) => fauxAssistantMessage([fauxToolCall("board", args)], { stopReason: "toolUse" });
		test.faux.setResponses([
			board({ action: "add_task", title: "Ship the order" }),
			board({ action: "add_task", title: "Pack the boxes", parent: "T1" }),
			board({ action: "add_task", title: "Print labels", parent: "T2" }),
			board({ action: "ask", text: "Which size?", taskId: "T3" }),
			board({ action: "ask", kind: "warning", text: "The proof is old.", taskId: "T3" }),
			board({ action: "write_report", id: "T3", steps: "1. Approve the labels." }),
			fauxAssistantMessage("Asked."),
		]);
		await submit(client, projectId, "Pack a synthetic order.", "part-notices");
		await until(() => push.ofKind("board_question").length === 2 && push.ofKind("task_steps").length === 1);
		const recent = (await test.server.notifications.recent(0))?.events.flatMap(entry => entry.type === "alert" ? [entry.alert] : []);
		for (const [kind, title, body, questionId] of [
			["board_question", "Ship the order · project", "Which size? · asked while building Print labels", "Q1"],
			["board_question", "Ship the order · project", "The proof is old. · asked while building Print labels", "Q2"],
			["task_steps", "Your steps · Ship the order", "asked while building Print labels", null],
		] as const) {
			const expected = { title, body, taskId: "T3", projectId };
			expect(push.ofKind(kind).find(event => event.payload?.body === body)?.payload).toMatchObject(expected);
			expect(recent?.find(alert => alert.kind === kind && alert.body === body)).toMatchObject({ ...expected, ...(questionId ? { questionId } : {}) });
		}
	}, 20_000);

	it("attaches the first eligible Results proof version to a review and sends no picture URL", async () => {
		const { test, push } = await setupWithPush();
		const client = await connect(test.server);
		await client.hello();
		const projectId = await addProject(client, test.projectDir);
		await configureCoordinator(client, projectId);
		await registerDevice(client, push, { preferences: preferences({ kinds: ["task_review"] }) });
		const { runtime } = await test.server.manager.open(projectId);
		const task = await runtime.board.saveTask({ task: { title: "Check the proof", description: "", acceptance: null,
			status: "in_progress", blockedBy: [], blockedReason: null, writeScopes: [] } }, "coordinator");
		const save = async (name: string, continueArtifactId?: string) => {
			const sourcePath = `${test.projectDir}/${name}`;
			await Bun.write(sourcePath, "synthetic artifact contents");
			return await test.server.artifacts.save({ projectId, taskId: task.id, sourcePath, threadId: "main", workerId: null,
				...(continueArtifactId ? { continueArtifactId } : {}) });
		};
		const log = await save("check.txt");
		const first = await save("desktop.png");
		await save("desktop.png", first.id);
		await save("mobile.png");
		runtime.board.noticeReview({ before: task, after: { ...task, status: "review", report: { ...task.report, blocks: {
			results: [{ kind: "proof", artifactRef: { artifactId: log.id }, text: "The trace." },
				{ kind: "proof", artifactRef: { artifactId: first.id, version: 1 }, text: "The first screenshot." }],
		} } } });
		await until(() => push.ofKind("task_review").length === 1);
		const payload = push.ofKind("task_review")[0]?.payload;
		expect(payload).toMatchObject({ proofArtifactId: `${first.id}~1`, taskId: task.id });
		expect(JSON.stringify(payload)).not.toContain("https://");
	});

	it("a part checked by its coordinator sends no review alert or board wake, while owner closes and reopens still wake", async () => {
		const { test, push } = await setupWithPush({ boardEditDebounceMs: 60_000 });
		const client = await connect(test.server); await client.hello();
		const projectId = await addProject(client, test.projectDir);
		await configureCoordinator(client, projectId); await registerDevice(client, push);
		const { runtime } = await test.server.manager.open(projectId);
		const board = (args: JsonObject) => fauxAssistantMessage([fauxToolCall("board", args)], { stopReason: "toolUse" });
		test.faux.setResponses([
			board({ action: "add_task", title: "Ship the order" }),
			board({ action: "add_task", title: "Print labels", parent: "T1" }),
			board({ action: "write_report", id: "T2", results: "The labels fit the boxes." }),
			board({ action: "update_task", id: "T2", expectedRevision: 1, status: "review" }),
			board({ action: "update_task", id: "T1", expectedRevision: 1, status: "review" }),
			fauxAssistantMessage("Checked."),
		]);
		const result = await runtime.conversation.submit({ type: "input", content: "Check a synthetic order.", requestId: "part-close" }, BACKGROUND_CONTEXT);
		await result.wait(BACKGROUND_CONTEXT);
		await runtime.board.flushEdits();
		await until(() => push.ofKind("task_review").length === 1);
		expect(push.ofKind("task_review")[0]?.payload?.taskId).toBe("T1");
		const entries = async () => (await runtime.conversation.entries({}, 200, undefined, BACKGROUND_CONTEXT)).items
			.flatMap(entry => entry.model ?? []).flatMap(message => message.role === "user" && typeof message.content === "string" ? [message.content] : []).join("\n");
		expect(await entries()).not.toContain("[board] T2");
		for (const status of ["todo", "done"] as const) {
			const part = (await runtime.board.state()).tasks.find(task => task.id === "T2")!;
			test.faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("Noted.")));
			await runtime.board.saveTask({ taskId: part.id, expectedRevision: part.revision, task: { ...part, status } }, "user");
			await runtime.board.flushEdits();
			await runtime.conversation.waitForIdle(BACKGROUND_CONTEXT);
			expect(await entries()).toContain(`T2 "Print labels" (r${part.revision + 1})`);
		}
		const recent = (await test.server.notifications.recent(0))?.events.flatMap(entry => entry.type === "alert" && entry.alert.kind === "task_review" ? [entry.alert.taskId] : []);
		expect(recent).toEqual(["T1"]);
	}, 20_000);

	it.each(["user", "coordinator"] as const)("a %s's dated wait on a part does not send review push or alert", async author => {
		let now = Date.parse("2026-11-10T12:00:00Z");
		const { test, push } = await setupWithPush({ now: () => now, boardEditDebounceMs: 60_000 });
		const client = await connect(test.server); await client.hello();
		const projectId = await addProject(client, test.projectDir);
		await configureCoordinator(client, projectId); await registerDevice(client, push);
		test.faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("Noted.")));
		const { runtime } = await test.server.manager.open(projectId);
		const task = { title: "Ship the order", description: "", acceptance: null, status: "in_progress" as const, blockedBy: [], blockedReason: null, writeScopes: [] };
		const root = await runtime.board.saveTask({ task }, "user");
		const part = await runtime.board.saveTask({ task: { ...task, title: "Print labels", parent: root.id, status: "waiting", waitingFor: "Printer approval", waitUntil: new Date(now + 1000).toISOString() } }, author);
		const request = await runtime.board.saveTask({ task: { ...task, title: "Ship a sample", status: "waiting", waitingFor: "Sample approval", waitUntil: new Date(now + 1000).toISOString() } }, "user");
		now += 1000;
		await runtime.board.checkWaiting();
		await until(() => push.ofKind("task_review").length === 1);
		expect(push.ofKind("task_review")[0]?.payload?.taskId).toBe(request.id);
		expect((await runtime.board.state()).tasks.find(task => task.id === part.id)?.status).not.toBe("waiting");
		const recent = (await test.server.notifications.recent(0))?.events.flatMap(entry => entry.type === "alert" && entry.alert.kind === "task_review" ? [entry.alert.taskId] : []);
		expect(recent).toEqual([request.id]);
	}, 20_000);

	it("tells the devices about a warning and a move to review, each naming its task", async () => {
		const { test, push } = await setupWithPush();
		const client = await connect(test.server);
		await client.hello();
		const projectId = await addProject(client, test.projectDir);
		await configureCoordinator(client, projectId);
		await registerDevice(client, push);
		const board = (args: Record<string, unknown>) =>
			fauxAssistantMessage([fauxToolCall("board", args as never)], { stopReason: "toolUse" });
		test.faux.setResponses([
			board({ action: "add_task", title: "Migrate the database" }),
			board({ action: "ask", kind: "warning", text: "The backup is a week old.", taskId: "T1" }),
			board({ action: "update_task", id: "T1", expectedRevision: 1, status: "review" }),
			fauxAssistantMessage("T1 is ready for review."),
		]);

		await submit(client, projectId, "Migrate the database.", "req-1");
		await until(() => push.ofKind("board_question").length === 1 && push.ofKind("task_review").length === 1);
		expect(push.ofKind("board_question")[0]?.payload).toMatchObject({ title: "project · General", coordinatorId: "main", taskId: "T1" });
		expect(push.ofKind("task_review")[0]?.payload).toMatchObject({
			kind: "task_review",
			title: "project · General",
			coordinatorId: "main",
			body: "T1 Migrate the database",
			taskId: "T1",
		});
	}, 30_000);

	it("returns a dated waiting task on time and sends one review notification through Notifier", async () => {
		let now = Date.parse("2026-11-10T12:00:00Z");
		const { test, push } = await setupWithPush({ now: () => now, boardEditDebounceMs: 5 });
		test.faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("Noted.")));
		const client = await connect(test.server);
		await client.hello();
		const projectId = await addProject(client, test.projectDir);
		await configureCoordinator(client, projectId);
		await registerDevice(client, push);
		const saved = await client.request({ type: "board.task.save", projectId, task: {
			title: "Ship auth", description: "", acceptance: null, status: "waiting", waitingFor: "PR #312 approval from Ana",
			waitUntil: new Date(now + 100).toISOString(), blockedBy: [], blockedReason: null, writeScopes: [],
		} });
		expect(saved.type).toBe("board.task.save");
		now += 100;
		await until(() => push.ofKind("task_review").length === 1);
		expect(push.ofKind("task_review")[0]?.payload).toMatchObject({ taskId: "T1", body: "T1 is back for review: waiting for PR #312 approval from Ana" });
		const board = await client.request({ type: "board.get", projectId });
		if (board.type !== "board.get") throw new Error(JSON.stringify(board));
		expect(board.board.tasks[0]?.status).toBe("review");
		await sleep(150);
		expect(push.ofKind("task_review")).toHaveLength(1);
	}, 20_000);

	it("reports a worker's answer, and a scheduled run's completion and failure", async () => {
		const { test, push } = await setupWithPush();
		const client = await connect(test.server);
		await client.hello();
		const projectId = await addProject(client, test.projectDir);
		await configureCoordinator(client, projectId);
		await registerDevice(client, push);
		test.faux.setResponses(Array.from({ length: 20 }, () => script({})));

		await submit(client, projectId, "Delegate the reading.", "req-1");
		await until(() => push.ofKind("worker_report").length === 1);
		expect(push.ofKind("worker_report")[0]?.payload).toMatchObject({
			kind: "worker_report",
			title: "Worker reported · project",
			body: "## Report",
			projectId,
			workerId: "reader",
		});

		// A schedule whose model does not exist fails before a worker starts: that is a schedule problem.
		const saved = await client.request({
			type: "schedules.save",
			projectId,
			schedule: {
				title: "Nightly",
				brief: "Say goodnight.",
				spec: { kind: "daily", time: "23:00" },
				model: { provider: "faux", modelId: "missing-model" },
				thinkingLevel: null,
				isolation: "shared",
				onReport: "record",
				enabled: false,
			},
		});
		if (saved.type !== "schedules.save") throw errorOf(saved);
		const ran = await client.request({ type: "schedules.run", projectId, scheduleId: saved.schedule.id });
		if (ran.type !== "schedules.run") throw errorOf(ran);
		expect(ran.run.outcome).toBe("failed");
		await until(() => push.ofKind("schedule_problem").length === 1);
		expect(push.ofKind("schedule_problem")[0]?.payload).toMatchObject({
			kind: "schedule_problem",
			title: "Scheduled task failed · Nightly",
			scheduleId: saved.schedule.id,
		});

		// A run that starts and reports is a schedule that finished.
		const healthy = await client.request({
			type: "schedules.save",
			projectId,
			schedule: {
				title: "Morning",
				brief: "Say good morning.",
				spec: { kind: "daily", time: "08:00" },
				model: FAUX,
				thinkingLevel: null,
				isolation: "shared",
				onReport: "record",
				enabled: false,
			},
		});
		if (healthy.type !== "schedules.save") throw errorOf(healthy);
		const started = await client.request({ type: "schedules.run", projectId, scheduleId: healthy.schedule.id });
		if (started.type !== "schedules.run") throw errorOf(started);
		expect(started.run.outcome).toBe("started");
		await until(() => push.ofKind("schedule_done").length === 1);
		expect(push.ofKind("schedule_done")[0]?.payload).toMatchObject({
			kind: "schedule_done",
			title: "Scheduled task done · Morning",
			scheduleId: healthy.schedule.id,
		});
	}, 40_000);

	it("holds back replies while a worker runs, then says once that the work finished", async () => {
		const { test, push } = await setupWithPush({ workFinished: { minWorkMs: 0, quietMs: 300 } });
		const client = await connect(test.server);
		await client.hello();
		const projectId = await addProject(client, test.projectDir);
		await configureCoordinator(client, projectId);
		await registerDevice(client, push);
		let release: () => void = () => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const answer = script({});
		test.faux.setResponses(
			Array.from({ length: 20 }, () => async (request: TranscriptContext, options?: { signal?: AbortSignal }) => {
				const reply = answer(request);
				const text = JSON.stringify(request.messages.at(-1) ?? null);
				if (text.includes("Read the README.") && !text.includes("reported]")) {
					await new Promise<void>((resolve) => {
						options?.signal?.addEventListener("abort", () => resolve(), { once: true });
						void gate.then(() => resolve());
					});
				}
				return text.includes("reported]") ? fauxAssistantMessage("All read.\nNothing else to do.") : reply;
			}),
		);

		await submit(client, projectId, "Delegate the reading.", "req-1");
		// The coordinator answers while its worker still runs: no reply push, and the work is not finished.
		await until(async () => (await lastReplyId(test)) !== null);
		await sleep(600);
		expect(push.ofKind("reply")).toHaveLength(0);
		expect(push.ofKind("work_finished")).toHaveLength(0);

		release();
		await until(() => push.ofKind("work_finished").length === 1);
		expect(push.ofKind("work_finished")[0]?.payload).toMatchObject({
			kind: "work_finished",
			title: "project finished",
			body: "All read.",
			projectId,
		});
		// The final answer handled only the worker report: work_finished still uses it, but there is no reply notice.
		expect(push.ofKind("reply")).toHaveLength(0);

		const restarted = await test.restart();
		const again = await connect(restarted);
		await again.hello();
		await again.request({ type: "conversation.page", projectId, limit: 10 });
		await sleep(600);
		expect(push.ofKind("work_finished")).toHaveLength(1);
	}, 30_000);

	it("holds a reply while a page is visible, pushes it when nobody interacts, and drops it when someone does", async () => {
		const { test, push } = await setupWithPush({ notifications: { holdMs: 1_500 } });
		const watcher = await connect(test.server);
		const sender = await connect(test.server);
		await watcher.hello();
		await sender.hello();
		const projectId = await addProject(sender, test.projectDir);
		await configureCoordinator(sender, projectId);
		const device = await registerDevice(sender, push);
		test.faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("First.")));

		// An open page on this very project no longer silences it: the push comes once the hold has run out.
		const view = new ViewClient(watcher);
		await view.start(projectId);
		const presence = await watcher.request({
			type: "notifications.presence",
			deviceId: device.deviceId,
			visible: true,
			projectId,
		});
		expect(presence.type).toBe("notifications.presence");
		await submit(sender, projectId, "one", "req-1");
		await until(() => test.server.notifications.heldCount === 1);
		expect(push.ofKind("reply").length).toBe(0);
		await until(() => push.ofKind("reply").length === 1);
		expect(test.server.notifications.heldCount).toBe(0);

		// The sender cannot borrow the watcher's presence even though both connections use the same device ID.
		await submit(sender, projectId, "two", "req-2");
		await until(() => test.server.notifications.heldCount === 1);
		const interaction = { type: "notifications.interaction", deviceId: device.deviceId } as const;
		expect(await sender.request(interaction)).toMatchObject({ type: interaction.type, dropped: 0 });
		expect(await watcher.request(interaction)).toMatchObject({ type: interaction.type, dropped: 1 });
		await sleep(2_000);
		expect(push.ofKind("reply").length).toBe(1);

		// The socket closes, so nothing is open: the next answer is pushed at once.
		watcher.close();
		await watcher.closed();
		await submit(sender, projectId, "three", "req-3");
		await until(() => push.ofKind("reply").length === 2, 10_000);
	}, 60_000);

	it("mutes a project and honours quiet hours, letting a failure through only when asked", async () => {
		// 23:30 in Bucharest, inside the device's 22:00–07:00 quiet hours.
		const now = () => Date.parse("2026-11-05T21:30:00Z");
		const deployDir = await tempDir();
		const deployFile = join(deployDir, "deploy-status.json");
		const { test, push } = await setupWithPush({
			now,
			notifications: { now },
			status: { deployStatusFile: deployFile },
		});
		const client = await connect(test.server);
		await client.hello();
		const projectId = await addProject(client, test.projectDir);
		await configureCoordinator(client, projectId);
		test.faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("Quiet.")));

		// Muted: nothing for this project.
		await registerDevice(client, push, { preferences: preferences({ mutedProjects: [projectId] }) });
		await submit(client, projectId, "one", "req-1");
		await until(async () => (await lastReplyId(test)) !== null);
		await sleep(300);
		expect(push.pushes.length).toBe(0);

		// Unmuted, but in quiet hours.
		await registerDevice(client, push, {
			preferences: preferences({
				quietHours: { start: "22:00", end: "07:00", timezone: "Europe/Bucharest", allowFailures: false },
			}),
		});
		await submit(client, projectId, "two", "req-2");
		await until(async () => ((await lastReplyId(test)) ?? 0) > 1);
		await sleep(300);
		expect(push.pushes.length).toBe(0);

		// A failure at the same hour: blocked here, let through on a device that allows failures.
		await registerDevice(client, push, {
			deviceId: "forgiving",
			preferences: preferences({
				quietHours: { start: "22:00", end: "07:00", timezone: "Europe/Bucharest", allowFailures: true },
			}),
		});
		await writeFile(
			deployFile,
			JSON.stringify({
				state: "failed",
				commit: "0f1e2d3c4b5a69788796a5b4c3d2e1f009182736",
				description: "feat: a deploy",
				message: "the tests failed",
				at: "2026-11-05T21:20:00Z",
			}),
		);
		await test.server.serverStatus.refresh();
		await until(() => push.ofKind("deploy_problem").length === 1);
		expect(push.ofKind("deploy_problem")[0]?.id).toBeTruthy();
		expect(push.ofKind("deploy_problem")[0]?.payload).toMatchObject({
			kind: "deploy_problem",
			title: "Deploy failed",
			body: "0f1e2d3 feat: a deploy: the tests failed",
			projectId: null,
		});
		expect(push.ofKind("deploy_problem").length).toBe(1);
	}, 40_000);

	it("reports a failed deploy once per attempt, including after the rolled-back restart", async () => {
		const deployDir = await tempDir();
		const deployFile = join(deployDir, "deploy-status.json");
		const writeAttempt = (state: "failed" | "rolled_back", at: string): Promise<void> =>
			writeFile(
				deployFile,
				JSON.stringify({
					state,
					commit: "1231234890abcdef1231234890abcdef12312348",
					description: "fix: ship it",
					message: "the health check failed",
					at,
				}),
			);
		const push = startPush();
		const test = await createSetup({
			allowedOrigins: [APP_ORIGIN],
			status: { deployStatusFile: deployFile },
			notifications: { subject: APP_ORIGIN },
		});
		cleanups.push(test.cleanup);
		const client = await connect(test.server);
		await client.hello();
		await registerDevice(client, push);
		// The deploy writes its status while the server runs; the watcher (or this refresh) makes it news.
		await writeAttempt("failed", "2026-11-05T09:00:00Z");
		await test.server.serverStatus.refresh();
		await until(() => push.ofKind("deploy_problem").length === 1);
		expect(push.ofKind("deploy_problem")[0]?.payload?.["body"]).toBe(
			"1231234 fix: ship it: the health check failed",
		);

		// The same attempt after a restart is old news, even though the file is read again on the way in.
		await test.restart();
		const again = await connect(test.server);
		await again.hello();
		await sleep(300);
		expect(push.ofKind("deploy_problem").length).toBe(1);

		// A new attempt is a new problem.
		await writeAttempt("rolled_back", "2026-11-05T10:00:00Z");
		await test.server.serverStatus.refresh();
		await until(() => push.ofKind("deploy_problem").length === 2);
		expect(push.ofKind("deploy_problem")[1]?.payload).toMatchObject({
			title: "Deploy rolled back",
			body: "1231234 fix: ship it: the health check failed",
		});
	}, 40_000);

	it("says when a sign-in waits for an answer", async () => {
		const provider = fakeOAuthProvider();
		const { test, push } = await setupWithPush({
			configureModels: (models) => models.setProvider(provider.provider),
		});
		const client = await connect(test.server);
		await client.hello();
		await registerDevice(client, push);
		const started = await client.request({ type: "credentials.loginStart", providerId: "fake-subscription" });
		if (started.type !== "credentials.loginStart") throw errorOf(started);
		await until(() => push.ofKind("login_prompt").length === 1);
		const payload = push.ofKind("login_prompt")[0]?.payload;
		expect(payload).toMatchObject({ kind: "login_prompt", title: "Sign in · fake-subscription" });
		expect(String(payload?.["body"])).toContain("Select a fake login method");
	}, 30_000);

	it("says when memory maintenance fails", async () => {
		const { test, push } = await setupWithPush({ timezone: "UTC" });
		const client = await connect(test.server);
		await client.hello();
		const projectId = await addProject(client, test.projectDir);
		await registerDevice(client, push);
		await client.request({
			type: "memory.settings.set",
			maintenance: { model: FAUX, thinkingLevel: null, time: "03:00", afterWrites: 100 },
		});
		await test.server.manager.memory.write({
			target: { scope: "project", projectId },
			fileId: "testing",
			text: "Use `bun test`.",
		});
		test.faux.setResponses(
			Array.from({ length: 10 }, () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider is down" })),
		);
		const maintain = await client.request({ type: "memory.maintain", scope: "project", projectId });
		expect(maintain.type).toBe("memory.maintain");

		await until(() => push.ofKind("maintenance_failed").length === 1, 30_000);
		const payload = push.ofKind("maintenance_failed")[0]?.payload;
		expect(payload).toMatchObject({
			kind: "maintenance_failed",
			title: "Memory maintenance failed",
			projectId,
		});
		expect(String(payload?.["body"])).toContain("provider is down");
	}, 40_000);
});

describe("the activity watch", () => {
	it("reports a compaction failure once per failed task", async () => {
		const initial = { entries: [], docs: {} } as unknown as ConversationView;
		let push: ((value: ConversationView) => void) | undefined;
		const stub = {
			watch: async () => ({
				value: initial,
				start: (fn: (call: { kind: "value"; value: ConversationView; ops: []; retired: false }) => Promise<void>) => {
					push = value => { void fn({ kind: "value", value, ops: [], retired: false }); };
				},
				stop: async () => undefined,
				closed: new Promise(() => undefined),
			}),
			entries: async () => ({ items: [] }),
		} as unknown as Conversation;
		const failures: CompactionFailureNotice[] = [];
		const replies: ReplyNotice[] = [];
		const service = new ProjectActivityService({
			conversation: stub,
			initial: DEFAULT_ACTIVITY,
			onChange: () => undefined,
			onReply: (reply) => replies.push(reply),
			onCompactionFailure: (failure) => failures.push(failure),
		});
		await service.start();

		const failed = (taskId: number) =>
			({ entries: [], docs: { "pi.live": { compactionFailure: { taskId, trigger: "threshold", error: "the model failed" } } } }) as unknown as ConversationView;
		push?.(failed(3));
		push?.(failed(3));
		push?.(failed(4));
		expect(failures).toEqual([
			{ taskId: 3, reason: "threshold", error: "the model failed" },
			{ taskId: 4, reason: "threshold", error: "the model failed" },
		]);
		expect(replies).toEqual([]);
		await service.stop();
	});
});
