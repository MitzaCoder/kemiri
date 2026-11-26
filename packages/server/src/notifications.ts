import { markdownText, newRelayId, type NotificationsConfirmRelayRequest } from "@kemiri/protocol";
import type { PushRelayTransport } from "./push-relay/transport.ts";
/**
 * Web Push notifications: one VAPID key pair for every backend, devices registered per backend, and one `Notifier` the
 * rest of the server calls. Android devices register an FCM token instead of a subscription and are sent the same
 * payload through `fcm.ts`; everything else (kinds, quiet hours, mutes, presence, dedupe) is shared.
 *
 * Encryption and signing are `web-push`'s (`generateRequestDetails`, RFC 8291 aes128gcm and the RFC 8292 VAPID JWT),
 * which runs unchanged on Bun; only the HTTP POST is ours, through `fetch`, so the push service sees exactly the request
 * the library built. A push never reaches the caller's failure path: every attempt is recorded on the device
 * (`lastDelivery`), a device the push service no longer knows (404/410) is dropped, and everything else is logged.
 *
 * Holding: while some connection is visible (`NotificationPresence.anyVisible`), an event is held for `NOTIFICATION_HOLD_MS`
 * and pushed when the hold ends, unless a connection reports interaction while showing the event's project. Held
 * events are persisted in the state file and carried on after a restart (`Notifier.restore`).
 *
 * No duplicates: events carry a dedupe key (`reply:<project>:<entry>`, `deploy:<commit>:<attempt>`, …) and the keys are
 * persisted, so a restart that replays a watch or re-reads a deploy status notifies nothing twice.
 */
import {
	DEFAULT_NOTIFICATION_KINDS,
	NOTIFICATION_FAILURE_KINDS,
	NOTIFICATION_HOLD_MS,
	NOTIFICATION_KINDS,
	RESOLVED_PUSH_TTL_MS,
	type NotificationResolvedTarget,
	normalizeNotificationMutes,
	notificationMuteActive,
	pruneExpiredNotificationMutes,
	type AuthLogin,
	type DeployStatus,
	type NotificationAlert,
	type NotificationsResolvedEvent,
	type NotificationDevice,
	type NotificationKind,
	type NotificationPayload,
	type NotificationPreferences,
	type NotificationTransport,
	type PushSubscription,
	type ScheduleRun,
} from "@kemiri/protocol";
import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import * as webpush from "web-push";
import type { Environment } from "./data-dir.ts";
import { ServerError, errorMessage } from "./errors.ts";
import type { FcmSender } from "./fcm.ts";
import { readJsonFile, writeJsonFile } from "./fs-json.ts";
import { NotificationClearQueue, type MatchesPushCard, type PushCard } from "./notification-clears.ts";
import { notificationAlertLevel, type NotificationRecentStore } from "./notification-alerts.ts";
import { serverSettings } from "./server-settings.ts";

/** Where the keys, the devices and the dedupe state live, under the data directory. */
export const NOTIFICATIONS_DIR_NAME = "notifications";
export const VAPID_KEY_FILE_NAME = "vapid.json";
export const DEVICES_FILE_NAME = "devices.json";
export const NOTIFICATION_STATE_FILE_NAME = "state.json";
/** Names the VAPID key pair file outright, for a backend whose data directory is not the default. */
export const VAPID_KEY_FILE_ENV = "KEMIRI_VAPID_KEY_FILE";
/** The VAPID `sub`, which RFC 8292 wants to be the app's URL; overrides what the allowed origins give. */
export const VAPID_SUBJECT_ENV = "KEMIRI_VAPID_SUBJECT";
/** A push nobody picked up is dropped by the push service after this long. */
export const NOTIFICATION_TTL_SECONDS = 12 * 60 * 60;
/** How many dedupe keys are kept; old ones fall off, and an event that far back is never replayed. */
export const KEPT_NOTIFIED_KEYS = 500;
/** The most text one notification carries before an ellipsis. */
export const NOTIFICATION_BODY_LIMIT = 200;

/** When no allowed origin is HTTPS there is still a subject to sign with; a push service is the one that cares. */
export const DEFAULT_VAPID_SUBJECT = "https://localhost";

export type VapidKeys = { publicKey: string; privateKey: string };

type VapidFile = VapidKeys & { version: 1 };
type DevicesFile = { version: 1; devices: StoredDevice[] };
type StateFile = { version: 1; deployAttempt: string | null; notified: string[]; held?: HeldEvent[]; cards?: ReturnType<NotificationClearQueue["snapshot"]> };

/** An event waiting out its hold: what it was, when it happened (the payload's `at`) and when the hold ends. */
export type HeldEvent = { id: string; eventId?: string; event: NotificationEvent; at: string; dueAt: number };

function parseHeldEvent(raw: unknown): HeldEvent | undefined {
	if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.at !== "string" || typeof raw.dueAt !== "number") {
		return undefined;
	}
	const event = raw.event;
	if (!isRecord(event) || typeof event.kind !== "string" || typeof event.title !== "string") return undefined;
	if (typeof event.body !== "string") return undefined;
	if (event.kind !== "test" && !STORED_KINDS.has(event.kind)) return undefined;
	return { id: raw.id, ...(typeof raw.eventId === "string" ? { eventId: raw.eventId } : {}),
		event: event as NotificationEvent, at: raw.at, dueAt: raw.dueAt };
}

/** `~` is the service user's home, which is what a deploy script would write too. */
function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

/** `${KEMIRI_VAPID_KEY_FILE}` when set, else `<data>/notifications/vapid.json`. */
export function resolveVapidKeyFile(dataDir: string, env: Environment = serverSettings): string {
	const override = env[VAPID_KEY_FILE_ENV];
	if (override !== undefined && override.trim().length > 0) return resolve(expandHome(override.trim()));
	return join(dataDir, NOTIFICATIONS_DIR_NAME, VAPID_KEY_FILE_NAME);
}

/**
 * The VAPID `sub`: RFC 8292 wants a `mailto:` or an `https:` URL, and the app's own URL is the one that names this
 * harness. It comes from the allowed-origins configuration rather than a constant, so the deploy and the app agree.
 */
export function resolveVapidSubject(allowedOrigins: readonly string[], env: Environment = serverSettings): string {
	const override = env[VAPID_SUBJECT_ENV];
	if (override !== undefined && override.trim().length > 0) {
		const trimmed = override.trim();
		try {
			const url = new URL(trimmed);
			if (url.protocol === "https:" || url.protocol === "mailto:") return trimmed;
		} catch {
			// Not a URL at all: fall through rather than sign with something a push service will reject.
		}
	}
	return allowedOrigins.find((origin) => origin.startsWith("https://")) ?? DEFAULT_VAPID_SUBJECT;
}

function base64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}

/** Bytes as the WebCrypto types want them: an `ArrayBuffer`-backed copy, not a view onto a pool. */
function bytesOf(source: Uint8Array | null): Uint8Array<ArrayBuffer> {
	const copy = new Uint8Array(source?.length ?? 0);
	if (source !== null) copy.set(source);
	return copy;
}

function fromBase64url(value: string): Uint8Array<ArrayBuffer> | undefined {
	try {
		return bytesOf(Buffer.from(value, "base64url"));
	} catch {
		return undefined;
	}
}

/** An uncompressed P-256 point: `0x04` then the 32-byte x and y, which is what a VAPID public key is. */
function rawPublicKey(jwk: JsonWebKey): string {
	const x = jwk.x === undefined ? undefined : fromBase64url(jwk.x);
	const y = jwk.y === undefined ? undefined : fromBase64url(jwk.y);
	if (x === undefined || y === undefined || x.length !== 32 || y.length !== 32) {
		throw new Error("the generated P-256 key has no usable coordinates");
	}
	const point = new Uint8Array(65);
	point[0] = 0x04;
	point.set(x, 1);
	point.set(y, 33);
	return base64url(point);
}

/** A fresh VAPID key pair, in the two base64url strings `web-push` takes. */
export async function createVapidKeys(): Promise<VapidKeys> {
	const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
	const jwk = await crypto.subtle.exportKey("jwk", keys.privateKey);
	if (jwk.d === undefined) throw new Error("the generated P-256 key has no private part");
	return { publicKey: rawPublicKey(jwk), privateKey: jwk.d };
}

/** Whether `keys` is a usable pair: a 65-byte point and a 32-byte scalar that sign and verify together. */
export async function vapidKeysWork(keys: VapidKeys): Promise<boolean> {
	const publicBytes = fromBase64url(keys.publicKey);
	const privateBytes = fromBase64url(keys.privateKey);
	if (publicBytes === undefined || privateBytes === undefined) return false;
	if (publicBytes.length !== 65 || publicBytes[0] !== 0x04) return false;
	if (privateBytes.length !== 32) return false;
	try {
		const privateKey = await crypto.subtle.importKey(
			"jwk",
			{
				kty: "EC",
				crv: "P-256",
				d: keys.privateKey,
				x: base64url(publicBytes.subarray(1, 33)),
				y: base64url(publicBytes.subarray(33)),
			},
			{ name: "ECDSA", namedCurve: "P-256" },
			false,
			["sign"],
		);
		const publicKey = await crypto.subtle.importKey("raw", publicBytes, { name: "ECDSA", namedCurve: "P-256" }, false, [
			"verify",
		]);
		const probe = new TextEncoder().encode("aiki vapid key check");
		const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, probe);
		return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, signature, probe);
	} catch {
		return false;
	}
}

function parseVapidFile(raw: unknown): VapidKeys | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const record = raw as Partial<VapidFile>;
	if (typeof record.publicKey !== "string" || typeof record.privateKey !== "string") return undefined;
	if (record.publicKey.length === 0 || record.privateKey.length === 0) return undefined;
	return { publicKey: record.publicKey, privateKey: record.privateKey };
}

/**
 * This backend's signing key pair, read from `file` or generated and written there (mode 0600) on first start. A
 * file that does not hold a working pair is a configuration error, not something to overwrite: replacing it would
 * silently invalidate every subscription the user already has.
 */
export async function loadOrCreateVapidKeys(file: string): Promise<VapidKeys> {
	const raw = await readJsonFile(file);
	if (raw !== undefined) {
		const keys = parseVapidFile(raw);
		if (keys === undefined || !(await vapidKeysWork(keys))) {
			throw new Error(
				`${file} does not hold a working VAPID key pair; fix or remove it (removing it invalidates existing push subscriptions)`,
			);
		}
		// A file another process or an older copy left readable is narrowed here, like every other file this server owns.
		await chmod(file, 0o600).catch(() => undefined);
		return keys;
	}
	const keys = await createVapidKeys();
	await writeJsonFile(file, { version: 1, ...keys } satisfies VapidFile, 0o600);
	return keys;
}

// --- devices and their persistent state ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A device as this backend keeps it: what the protocol shows (`NotificationDevice`) plus where it is pushed to, a browser's
 * Web Push subscription or an Android app's FCM token. Either stays on the server: the app that registered it holds it.
 */
export type StoredDevice = NotificationDevice & { sessionId?: string } & (
		{ subscription: PushSubscription; fcmToken?: undefined } | { fcmToken: string; subscription?: undefined }
	);

/** Where a device is reached, as `register` and `registerFcm` take it. */
export type DeviceAddress = { subscription: PushSubscription } | { fcmToken: string };

function transportOf(device: Pick<StoredDevice, "fcmToken">): NotificationTransport {
	return device.fcmToken === undefined ? "web-push" : "fcm";
}

/** The kinds a stored preference may name; anything else in the file is dropped. */
const STORED_KINDS: ReadonlySet<string> = new Set(NOTIFICATION_KINDS);

function parseSubscription(raw: unknown): PushSubscription | undefined {
	if (!isRecord(raw) || typeof raw.endpoint !== "string" || raw.endpoint.length === 0) return undefined;
	const keys = raw.keys;
	if (!isRecord(keys) || typeof keys.p256dh !== "string" || keys.p256dh.length === 0) return undefined;
	if (typeof keys.auth !== "string" || keys.auth.length === 0) return undefined;
	const expirationTime = raw.expirationTime;
	return {
		endpoint: raw.endpoint,
		...(typeof expirationTime === "number" || expirationTime === null ? { expirationTime } : {}),
		keys: { p256dh: keys.p256dh, auth: keys.auth },
	};
}

function parsePreferences(raw: unknown, now: number): NotificationPreferences | undefined {
	if (!isRecord(raw)) return undefined;
	const kinds = Array.isArray(raw.kinds)
		? raw.kinds.filter((kind): kind is NotificationKind => typeof kind === "string" && STORED_KINDS.has(kind))
		: undefined;
	if (kinds === undefined || !Array.isArray(raw.mutedProjects)) return undefined;
	const quiet = raw.quietHours;
	let quietHours: NotificationPreferences["quietHours"] = null;
	if (isRecord(quiet)) {
		const { start, end, timezone, allowFailures } = quiet;
		if (
			typeof start !== "string" ||
			typeof end !== "string" ||
			typeof timezone !== "string" ||
			typeof allowFailures !== "boolean"
		) {
			return undefined;
		}
		quietHours = { start, end, timezone, allowFailures };
	} else if (quiet !== null && quiet !== undefined) {
		return undefined;
	}
	return { kinds, quietHours, ...normalizeNotificationMutes(raw, now), ...(raw.quietResolutions === true ? { quietResolutions: true } : {}) };
}

/** A device read back from `devices.json`; anything that does not validate is dropped, like a stored schedule. */
function parseDevice(raw: unknown, now: number): StoredDevice | undefined {
	if (!isRecord(raw)) return undefined;
	if (typeof raw.deviceId !== "string" || raw.deviceId.length === 0) return undefined;
	if (typeof raw.backendKey !== "string" || raw.backendKey.length === 0) return undefined;
	const fcmToken = typeof raw.fcmToken === "string" && raw.fcmToken.length > 0 ? raw.fcmToken : undefined;
	const subscription = fcmToken === undefined ? parseSubscription(raw.subscription) : undefined;
	const preferences = parsePreferences(raw.preferences, now);
	if ((subscription === undefined && fcmToken === undefined) || preferences === undefined) return undefined;
	const address: DeviceAddress = fcmToken === undefined ? { subscription: subscription! } : { fcmToken };
	const last = raw.lastDelivery;
	const lastDelivery: NotificationDevice["lastDelivery"] = isRecord(last)
		? {
				at: typeof last.at === "string" ? last.at : new Date().toISOString(),
				ok: last.ok === true,
				status: typeof last.status === "number" ? last.status : null,
				message: typeof last.message === "string" ? last.message : null,
			}
		: null;
	return {
		deviceId: raw.deviceId,
		...(typeof raw.sessionId === "string" ? { sessionId: raw.sessionId } : {}),
		label: typeof raw.label === "string" ? raw.label : "",
		backendKey: raw.backendKey,
		...address,
		preferences,
		createdAt: typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
		lastDelivery,
	};
}

/** The device as the protocol shows it: its address is between the device and its push service, not the app. */
export function publicDevice(device: StoredDevice): NotificationDevice {
	const {
		subscription: _subscription,
		fcmToken: _fcmToken,
		transport: _transport,
		sessionId: _sessionId,
		...rest
	} = device;
	return { ...rest, transport: transportOf(device) };
}

/** The devices registered with this backend, in `<data>/notifications/devices.json` (mode 0600). */
export class NotificationStore {
	readonly #file: string;
	readonly #log: (message: string) => void;
	readonly #devices = new Map<string, StoredDevice>();
	#writes: Promise<void> = Promise.resolve();
	#loaded = false;

	constructor(options: { dir: string; log?: (message: string) => void }) {
		this.#file = join(options.dir, DEVICES_FILE_NAME);
		this.#log = options.log ?? (() => undefined);
	}

	get file(): string {
		return this.#file;
	}

	/** Read the file once; a corrupt one starts empty rather than stopping the server (devices re-register). */
	async read(now = Date.now()): Promise<void> {
		if (this.#loaded) return;
		this.#loaded = true;
		const raw = await readJsonFile(this.#file).catch((error: unknown) => {
			this.#log(`notifications: ${this.#file} is unreadable: ${errorMessage(error)}`);
			return undefined;
		});
		if (raw === undefined) return;
		const devices = isRecord(raw) && Array.isArray(raw.devices) ? raw.devices : undefined;
		if (devices === undefined) {
			this.#log(`notifications: ${this.#file} does not describe devices; starting empty`);
			return;
		}
		for (const entry of devices) {
			const device = parseDevice(entry, now);
			if (device === undefined) {
				this.#log(`notifications: dropping a device that does not match the protocol from ${this.#file}`);
				continue;
			}
			this.#devices.set(device.deviceId, device);
		}
	}

	list(): StoredDevice[] {
		return [...this.#devices.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	}

	get(deviceId: string): StoredDevice | undefined {
		return this.#devices.get(deviceId);
	}

	/** Expiry is lazy: remove entries during normal device access, without scheduling timers. */
	pruneMutes(now: number): void {
		let changed = false;
		for (const [id, device] of this.#devices) {
			const preferences = pruneExpiredNotificationMutes(device.preferences, now);
			if (preferences === device.preferences) continue;
			this.#devices.set(id, { ...device, preferences });
			changed = true;
		}
		if (changed) void this.#persist().catch(() => undefined);
	}

	/** Register or update one device: its subscription or FCM token, what it calls this backend, and its preferences. */
	async register(
		input: {
			deviceId: string;
			sessionId?: string;
			allowLegacyRegistration?: boolean;
			label: string;
			backendKey: string;
			preferences: NotificationPreferences;
			now?: () => number;
		} & DeviceAddress,
	): Promise<StoredDevice> {
		const existing = this.#devices.get(input.deviceId);
		if (existing?.sessionId && !input.sessionId && !input.allowLegacyRegistration)
			throw new ServerError("auth_required", "auth_required");
		if (input.sessionId)
			for (const device of this.#devices.values())
				if (
					device.deviceId !== input.deviceId &&
					(("fcmToken" in input && device.fcmToken === input.fcmToken) ||
						("subscription" in input && device.subscription?.endpoint === input.subscription.endpoint))
				)
					this.#devices.delete(device.deviceId);
		const address: DeviceAddress =
			"fcmToken" in input
				? { fcmToken: input.fcmToken }
				: {
						subscription: {
							endpoint: input.subscription.endpoint,
							...(input.subscription.expirationTime === undefined
								? {}
								: { expirationTime: input.subscription.expirationTime }),
							keys: { p256dh: input.subscription.keys.p256dh, auth: input.subscription.keys.auth },
						},
					};
		const now = (input.now ?? Date.now)();
		const device: StoredDevice = {
			deviceId: input.deviceId,
			...((input.sessionId ?? existing?.sessionId) ? { sessionId: input.sessionId ?? existing!.sessionId } : {}),
			label: input.label,
			backendKey: input.backendKey,
			...address,
			preferences: {
				kinds: [...input.preferences.kinds],
				...(input.preferences.quietResolutions === true ? { quietResolutions: true } : {}),
				...normalizeNotificationMutes(input.preferences, now),
				quietHours:
					input.preferences.quietHours === null
						? null
						: {
								start: input.preferences.quietHours.start,
								end: input.preferences.quietHours.end,
								timezone: input.preferences.quietHours.timezone,
								allowFailures: input.preferences.quietHours.allowFailures,
							},
			},
			createdAt: existing?.createdAt ?? new Date(now).toISOString(),
			lastDelivery: existing?.lastDelivery ?? null,
		};
		this.#devices.set(device.deviceId, device);
		await this.#persist();
		return device;
	}

	/** Forget a device; false when it was not registered. */
	async unregister(deviceId: string): Promise<boolean> {
		if (!this.#devices.delete(deviceId)) return false;
		await this.#persist();
		return true;
	}

	/** Record the last push attempt to a device, for `notifications.device`. */
	async setLastDelivery(deviceId: string, delivery: StoredDevice["lastDelivery"]): Promise<void> {
		const device = this.#devices.get(deviceId);
		if (device === undefined) return;
		this.#devices.set(deviceId, { ...device, lastDelivery: delivery });
		await this.#persist();
	}

	/** Wait for every write this store queued, so a test (or a shutdown) sees the file settled. */
	async flush(): Promise<void> {
		await this.#writes;
	}

	#persist(): Promise<void> {
		const run = this.#writes.then(async () => {
			const file: DevicesFile = { version: 1, devices: this.list() };
			await writeJsonFile(this.#file, file, 0o600);
		});
		this.#writes = run.catch((error: unknown) => {
			this.#log(`notifications: could not save ${this.#file}: ${errorMessage(error)}`);
		});
		return run;
	}
}

/**
 * What this backend already notified and which deploy attempt it reported: keys are kept, the deploy attempt is one
 * value, so a restart that replays a watch or re-reads the deploy status notifies nothing twice.
 */
export class NotificationStateStore {
	readonly #file: string;
	readonly #log: (message: string) => void;
	readonly keys: Set<string>;
	readonly cards = new NotificationClearQueue(() => { void this.#persist(); });
	/** Events in their hold, by ID, in the order they happened. */
	readonly held = new Map<string, HeldEvent>();
	#deployAttempt: string | null = null;
	#writes: Promise<void> = Promise.resolve();
	/** The write that has not started yet, which later claims join. */
	#queued: Promise<void> | undefined;
	#loaded = false;

	constructor(options: { dir: string; log?: (message: string) => void; keys?: Iterable<string> }) {
		this.#file = join(options.dir, NOTIFICATION_STATE_FILE_NAME);
		this.#log = options.log ?? (() => undefined);
		this.keys = new Set(options.keys ?? []);
	}

	get file(): string {
		return this.#file;
	}

	get deployAttempt(): string | null {
		return this.#deployAttempt;
	}

	async read(): Promise<void> {
		if (this.#loaded) return;
		this.#loaded = true;
		const raw = await readJsonFile(this.#file).catch((error: unknown) => {
			this.#log(`notifications: ${this.#file} is unreadable: ${errorMessage(error)}`);
			return undefined;
		});
		if (raw === undefined || !isRecord(raw)) return;
		this.cards.load(raw.cards);
		if (typeof raw.deployAttempt === "string") this.#deployAttempt = raw.deployAttempt;
		if (Array.isArray(raw.notified)) {
			for (const key of raw.notified) if (typeof key === "string") this.keys.add(key);
		}
		if (Array.isArray(raw.held)) {
			for (const entry of raw.held) {
				const held = parseHeldEvent(entry);
				if (held !== undefined) this.held.set(held.id, held);
			}
		}
	}

	/** Remember an event in its hold, so a restart does not lose it. */
	hold(held: HeldEvent): void {
		this.held.set(held.id, held);
		void this.#persist();
	}

	/** Forget held events (pushed or dropped); returns how many were held. */
	release(ids: Iterable<string>): number {
		let released = 0;
		for (const id of ids) if (this.held.delete(id)) released += 1;
		if (released > 0) void this.#persist();
		return released;
	}

	/** Whether this event key was already notified; records it when it was not. */
	claim(key: string): boolean {
		if (this.keys.has(key)) return false;
		this.keys.add(key);
		while (this.keys.size > KEPT_NOTIFIED_KEYS) {
			const oldest = this.keys.values().next().value;
			if (oldest === undefined) break;
			this.keys.delete(oldest);
		}
		void this.#persist();
		return true;
	}

	/** Whether this deploy attempt was already reported; records it when it was not. */
	claimDeployAttempt(attempt: string): boolean {
		if (this.#deployAttempt === attempt) return false;
		this.#deployAttempt = attempt;
		void this.#persist();
		return true;
	}

	async flush(): Promise<void> {
		await this.#writes;
	}

	/**
	 * Save the state after the write in flight. Claims made while a write waits to start join it, since it reads the state
	 * when it starts: a burst of claims costs one or two writes, not one each.
	 */
	#persist(): Promise<void> {
		if (this.#queued !== undefined) return this.#queued;
		const run = this.#writes.then(async () => {
			this.#queued = undefined;
			const cards = this.cards.snapshot();
			const file: StateFile = {
				version: 1,
				deployAttempt: this.#deployAttempt,
				notified: [...this.keys],
				...(cards.posted.length || cards.waiting.length ? { cards } : {}),
				...(this.held.size === 0 ? {} : { held: [...this.held.values()] }),
			};
			await writeJsonFile(this.#file, file, 0o600);
		});
		this.#queued = run;
		this.#writes = run.catch((error: unknown) => {
			this.#log(`notifications: could not save ${this.#file}: ${errorMessage(error)}`);
		});
		return run;
	}
}

// --- presence -----------------------------------------------------------------------------------------------------

export type ConnectionPresence = {
	deviceId: string;
	/** Whether the page is visible (or the app in the foreground); a hidden tab is not open. */
	visible: boolean;
	/** The project this connection shows on this backend, if any. */
	projectId: string | null;
};

const SOUND_INTERACTION_WINDOW_MS = 30 * 60 * 1000;

/** Which connections are visible and were recently used. Both records are forgotten when the socket closes. */
export class NotificationPresence {
	readonly #byConnection = new Map<object, ConnectionPresence>();
	readonly #lastInteraction = new Map<object, { at: number; order: number }>();
	#interactionOrder = 0;

	interacted(connection: object, now: number): void {
		this.#lastInteraction.set(connection, { at: now, order: ++this.#interactionOrder });
	}

	/** Latest qualifying report, including deterministic tie-breaking within one clock tick. */
	soundTarget<T extends object>(connections: Iterable<T>, now: number): T | undefined {
		let target: T | undefined;
		let latest: { at: number; order: number } | undefined;
		for (const connection of connections) {
			const interaction = this.#lastInteraction.get(connection);
			if (!this.get(connection)?.visible || interaction === undefined || now - interaction.at > SOUND_INTERACTION_WINDOW_MS) continue;
			if (latest && (interaction.at < latest.at || (interaction.at === latest.at && interaction.order < latest.order))) continue;
			latest = interaction;
			target = connection;
		}
		return target;
	}

	set(connection: object, presence: ConnectionPresence): void {
		this.#byConnection.set(connection, presence);
	}

	get(connection: object): ConnectionPresence | undefined {
		return this.#byConnection.get(connection);
	}

	remove(connection: object): void {
		this.#byConnection.delete(connection);
		this.#lastInteraction.delete(connection);
	}

	/** Whether any connection is visible: the app is open somewhere, so events are held before they are pushed. */
	anyVisible(): boolean {
		for (const presence of this.#byConnection.values()) if (presence.visible) return true;
		return false;
	}

	/** Every presence a device has, for tests and for `notifications.device`. */
	of(deviceId: string): ConnectionPresence[] {
		return [...this.#byConnection.values()].filter((presence) => presence.deviceId === deviceId);
	}

	clear(): void {
		this.#byConnection.clear();
		this.#lastInteraction.clear();
	}
}

/** Backend-wide events have no project view in which interaction can acknowledge them. */
function isOnScreen(held: HeldEvent, onScreenProjectId: string | null): boolean {
	return onScreenProjectId !== null && held.event.projectId === onScreenProjectId;
}

// --- filtering ----------------------------------------------------------------------------------------------------

export type BlockedReason = "kind" | "muted" | "quiet";

function parseTimeOfDay(value: string): number | undefined {
	const match = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value);
	if (match === null) return undefined;
	return Number(match[1]) * 60 + Number(match[2]);
}

/** The wall-clock minute of `at` in `timezone`, or undefined for a zone `Intl` does not know. */
export function minutesInTimezone(at: Date, timezone: string): number | undefined {
	try {
		const parts = new Intl.DateTimeFormat("en-GB", {
			timeZone: timezone,
			hourCycle: "h23",
			hour: "2-digit",
			minute: "2-digit",
		}).formatToParts(at);
		const hour = Number(parts.find((part) => part.type === "hour")?.value);
		const minute = Number(parts.find((part) => part.type === "minute")?.value);
		if (!Number.isInteger(hour) || !Number.isInteger(minute)) return undefined;
		return hour * 60 + minute;
	} catch {
		return undefined;
	}
}

/**
 * Whether `at` falls in the device's quiet hours, in its own timezone. A window whose end is earlier than its start
 * crosses midnight (`22:00`–`07:00` is quiet at 23:30 and at 06:59). Identical ends mean no quiet hours, and a zone
 * `Intl` does not know is no quiet hours either: a device must not go silent over a bad setting.
 */
export function inQuietHours(quiet: NonNullable<NotificationPreferences["quietHours"]>, at: Date): boolean {
	const start = parseTimeOfDay(quiet.start);
	const end = parseTimeOfDay(quiet.end);
	if (start === undefined || end === undefined || start === end) return false;
	const now = minutesInTimezone(at, quiet.timezone);
	if (now === undefined) return false;
	return start < end ? now >= start && now < end : now >= start || now < end;
}

export type NotificationEvent = {
	kind: NotificationKind | "test";
	title: string;
	body: string;
	projectId?: string | null;
	workerId?: string | null;
	scheduleId?: string | null;
	/** The background thread it is about ("main" for main's own); the app opens main and highlights its card. */
	threadId?: string | null;
	coordinatorId?: string;
	entryId?: number;
	answerId?: string;
	/** The board task it is about; the app opens that task. */
	taskId?: string | null;
	projectName?: string;
	coordinatorName?: string;
	/** Full source for the plain-text preview, before enforcing the push budget. */
	message?: string;
	taskTitle?: string;
	expiresAt?: string;
	sharedLimitKey?: string;
	/** Task attachments not used for tap routing in the legacy payload. */
	alertTaskId?: string | null;
	taskRevision?: number;
	question?: Pick<NotificationAlert, "questionId" | "questionRevision" | "choices" | "warning" | "approval">;
	/** Notifications that share a tag replace each other on the device. Default: one per event kind and target. */
	tag?: string;
	/** Persisted dedupe key: an event with a key this backend already sent is not sent again, even after a restart. */
	key?: string;
};

export function notificationTag(
	event: Pick<NotificationEvent, "kind" | "projectId" | "workerId" | "scheduleId">,
): string {
	const parts: string[] = [event.kind];
	if (event.projectId !== null && event.projectId !== undefined) parts.push(event.projectId);
	if (event.workerId !== null && event.workerId !== undefined) parts.push(event.workerId);
	if (event.scheduleId !== null && event.scheduleId !== undefined) parts.push(event.scheduleId);
	return parts.join(":");
}

/**
 * Why this device does not get this event, or undefined when it does. `muteAt` is only for hold admission: a mute
 * can still be active now but expire before the held push is due.
 */
export function notificationBlocked(
	device: Pick<StoredDevice, "deviceId" | "preferences">,
	event: Pick<NotificationEvent, "kind" | "projectId">,
	options: { at: Date; muteAt?: number },
): BlockedReason | undefined {
	// A test push is the user asking for one right now: no preference can silence it.
	if (event.kind === "test") return undefined;
	const preferences = device.preferences;
	const muteAt = options.muteAt ?? options.at.getTime();
	if (notificationMuteActive(preferences.backendMute, muteAt)) return "muted";
	if (!preferences.kinds.includes(event.kind)) return "kind";
	if (event.projectId != null && (preferences.mutedProjects.includes(event.projectId) ||
		preferences.projectMutes?.some(mute => mute.projectId === event.projectId && notificationMuteActive(mute, muteAt)))) return "muted";
	const quiet = preferences.quietHours;
	if (quiet !== null && inQuietHours(quiet, options.at)) {
		const failure = NOTIFICATION_FAILURE_KINDS.includes(event.kind);
		if (!(quiet.allowFailures && failure)) return "quiet";
	}
	return undefined;
}

// --- payloads from events -----------------------------------------------------------------------------------------

/** One line of text, trimmed and cut to what a notification can show. */
export function notificationLine(text: string | null | undefined, limit = NOTIFICATION_BODY_LIMIT): string {
	const first = (text ?? "").trim().split("\n")[0]?.trim() ?? "";
	if (Array.from(first).length <= limit) return first;
	return `${Array.from(first).slice(0, Math.max(0, limit - 1)).join("").trimEnd()}…`;
}

/** Clip complete Unicode code points and measure the JSON form so quotes and escapes count toward the budget. */
function notificationTextWithin(text: string | undefined, maxPoints: number, maxBytes: number): string | undefined {
	if (!text) return undefined;
	const points = Array.from(text.trim());
	let count = Math.min(maxPoints, points.length);
	const preview = () => `${points.slice(0, count).join("").trimEnd()}${count < points.length ? "…" : ""}`;
	while (count > 0 && Buffer.byteLength(JSON.stringify(preview())) > maxBytes) count--;
	return count > 0 ? preview() : undefined;
}

/** The server decides which exact choices are safe to offer. Never shorten or pick an answer for the owner. */
function pushQuestion(event: NotificationEvent): NotificationPayload["question"] {
	const question = event.question;
	if (!question?.questionId || question.questionRevision === undefined) return undefined;
	const choices = question.choices ?? [];
	const quickAnswerAllowed = event.projectId != null && !question.warning && !question.approval &&
		choices.length >= 1 && choices.length <= 3 && new Set(choices.map(choice => choice.label)).size === choices.length &&
		choices.every(({ label }) => label.trim() && !/[\u0000-\u001f\u007f]/u.test(label) && Array.from(label).length <= 24);
	return { id: question.questionId, revision: question.questionRevision, quickAnswerAllowed,
		...(quickAnswerAllowed ? { choices: [...choices].sort((left, right) => Number(right.recommended) - Number(left.recommended)) } : {}),
		...(question.warning ? { warning: true } : {}), ...(question.approval ? { approval: true } : {}) };
}

/** The payload one device gets: its own backend key, plus optional richer display and routing fields. */
export function notificationPayload(
	device: Pick<NotificationDevice, "backendKey">,
	event: NotificationEvent,
	at: string,
	computerName?: string,
): NotificationPayload {
	const projectName = notificationTextWithin(event.projectName, 80, 112);
	const coordinatorName = notificationTextWithin(event.coordinatorName, 80, 112);
	const computer = notificationTextWithin(computerName, 80, 112);
	const taskTitle = notificationTextWithin(event.taskTitle, 120, 144);
	const message = notificationTextWithin(event.message === undefined ? undefined : markdownText(event.message, true), 600, 1600);
	const question = pushQuestion(event);
	return {
		kind: event.kind,
		title: notificationTextWithin(notificationLine(event.title, 80), 80, 254) ?? "Open the app",
		body: notificationTextWithin(event.body, 600, 520) ?? "",
		backendKey: device.backendKey,
		projectId: event.projectId ?? null,
		workerId: event.workerId ?? null,
		scheduleId: event.scheduleId ?? null,
		...(event.threadId === undefined ? {} : { threadId: event.threadId }),
		...(event.coordinatorId === undefined ? {} : { coordinatorId: event.coordinatorId }),
		...(event.entryId === undefined || (event.kind === "reply" && !event.coordinatorId) ? {} : { entryId: event.entryId }),
		...(event.answerId === undefined ? {} : { answerId: event.answerId }),
		...(event.taskId === undefined ? {} : { taskId: event.taskId }),
		tag: event.tag ?? notificationTag(event),
		at,
		...(projectName ? { projectName } : {}), ...(computer ? { computerName: computer } : {}),
		...(coordinatorName ? { coordinatorName } : {}), ...(message && message !== event.body ? { message } : {}),
		...(taskTitle ? { taskTitle } : {}), ...(event.taskRevision === undefined ? {} : { taskRevision: event.taskRevision }),
		...(event.key && Buffer.byteLength(JSON.stringify(event.key)) <= 160 ? { key: event.key } : {}),
		...(event.kind === "test" ? {} : { level: notificationAlertLevel(event.kind, event.question?.warning) }),
		...(question ? { question } : {}), ...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
		...(event.sharedLimitKey ? { sharedLimitKey: event.sharedLimitKey } : {}),
	};
}

/** A shared VAPID key scopes the correlation to this installation; raw account labels stay on the server. */
export function sharedSubscriptionLimitKey(ownerKey: string, kind: "usage_limit_reached" | "usage_drain_warning",
	reading: { providerId: string; account: string | null; plan: string | null } | undefined, reset: string | undefined, windowId?: string): string | undefined {
	const account = reading?.account?.trim().toLowerCase();
	const at = reset ? Date.parse(reset) : NaN;
	if (!reading || !account || !Number.isFinite(at)) return undefined;
	return createHmac("sha256", ownerKey).update(JSON.stringify(["subscription-notice-v1", kind, reading.providerId, account, reading.plan, at, windowId ?? null]))
		.digest("base64url");
}

function pushedCard(event: NotificationEvent, at: string): PushCard | undefined {
	if (event.kind === "test") return undefined;
	const question = event.question;
	return {
		kind: event.kind, tag: event.tag ?? notificationTag(event), at,
		projectId: event.projectId ?? null, workerId: event.workerId ?? null,
		...(event.key && Buffer.byteLength(JSON.stringify(event.key)) <= 160 ? { key: event.key } : {}),
		...(event.threadId === undefined ? {} : { threadId: event.threadId }),
		...(event.coordinatorId === undefined ? {} : { coordinatorId: event.coordinatorId }),
		...(event.entryId === undefined ? {} : { entryId: event.entryId }),
		...(event.answerId === undefined ? {} : { answerId: event.answerId }),
		...(event.taskId === undefined && event.alertTaskId === undefined ? {} : { taskId: event.alertTaskId ?? event.taskId ?? null }),
		...(event.taskRevision === undefined ? {} : { taskRevision: event.taskRevision }),
		...(question?.questionId ? { questionId: question.questionId } : {}),
		...(question?.questionRevision === undefined ? {} : { questionRevision: question.questionRevision }),
		...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
		...(event.sharedLimitKey ? { sharedLimitKey: event.sharedLimitKey } : {}),
	};
}

function resolvedPayload(device: Pick<NotificationDevice, "backendKey">, targets: NotificationResolvedTarget[], at: string): NotificationPayload {
	return { kind: "resolved", backendKey: device.backendKey, at, resolved: targets, title: "", body: "", tag: "resolved",
		projectId: null, scheduleId: null, workerId: null };
}

/** The coordinator finished an answer: the body is the first line of it. */
export function replyNotification(input: {
	projectId: string;
	projectName: string;
	entryId: number;
	at: string;
	text: string;
	coordinatorId?: string;
	coordinatorTitle?: string;
	answerId?: string;
}): NotificationEvent {
	return {
		kind: "reply",
		projectName: input.projectName,
		coordinatorName: input.coordinatorTitle ?? "Main chat",
		message: input.text,
		title: input.coordinatorTitle ? `${input.projectName} · ${input.coordinatorTitle}` : `${input.projectName} replied`,
		entryId: input.entryId,
		...(input.coordinatorId ? { coordinatorId: input.coordinatorId, threadId: input.coordinatorId } : {}),
		...(input.answerId === undefined ? {} : { answerId: input.answerId }),
		body: notificationLine(input.text) || "The coordinator finished an answer.",
		projectId: input.projectId,
		tag: `reply:${input.projectId}${input.coordinatorId ? `:${input.coordinatorId}` : ""}`,
		key: `reply:${input.projectId}${input.coordinatorId ? `:${input.coordinatorId}` : ""}:${input.entryId}`,
	};
}

/** A worker's answer came back to the coordinator, or it could not finish. */
export function workerNotification(input: {
	projectId: string;
	projectName: string;
	workerId: string;
	callId: string;
	kind: "worker_report" | "worker_failed";
	text: string | null;
	failure: string | null;
	taskId?: string | null;
	/** The background thread that started the worker; absent for main's. */
	threadId?: string;
	coordinatorId?: string;
	coordinatorTitle?: string;
}): NotificationEvent {
	const failed = input.kind === "worker_failed";
	const message = failed ? input.failure : input.text;
	const thread = input.threadId === undefined || input.threadId === "main" ? undefined : input.threadId;
	return {
		kind: input.kind,
		...(message ? { message } : {}),
		title: input.coordinatorTitle ? `${input.projectName} · ${input.coordinatorTitle}` : failed ? `Worker failed · ${input.projectName}` : `Worker reported · ${input.projectName}`,
		...(input.coordinatorId ? { coordinatorId: input.coordinatorId } : {}),
		body: failed
			? notificationLine(input.failure) || "A worker could not finish."
			: notificationLine(input.text) || "A worker reported.",
		projectId: input.projectId,
		workerId: input.workerId,
		alertTaskId: input.taskId ?? null,
		...(thread === undefined ? {} : { threadId: thread }),
		tag: failed ? `worker-failed:${input.projectId}:${thread ?? "main"}:${input.workerId}`
			: thread === undefined ? `worker:${input.workerId}` : `worker:${thread}:${input.workerId}`,
		key:
			thread === undefined
				? `worker:${input.projectId}:${input.workerId}:${input.callId}`
				: `worker:${input.projectId}:${thread}:${input.workerId}:${input.callId}`,
	};
}

/** A background thread finished with a summary: the body is its first line. */
export function threadFinishedNotification(input: {
	projectId: string;
	projectName: string;
	coordinatorId?: string | undefined;
	threadId: string;
	title: string;
	summary: string;
	/** The finish's tool call, so a rerun after a restart notifies nobody twice. */
	callId: string;
	scheduleId?: string | null;
}): NotificationEvent {
	return {
		kind: "thread_finished",
		message: input.summary,
		title: `Finished · ${input.title}`,
		body: notificationLine(input.summary) || `${input.projectName}: a background thread finished.`,
		projectId: input.projectId,
		...(input.coordinatorId === undefined || input.coordinatorId === "main" ? {} : { coordinatorId: input.coordinatorId }),
		threadId: input.threadId,
		...(input.scheduleId === undefined || input.scheduleId === null ? {} : { scheduleId: input.scheduleId }),
		tag: `thread:${input.projectId}:${input.threadId}`,
		key: `thread-finished:${input.projectId}:${input.threadId}:${input.callId}`,
	};
}

/** A background thread's turn failed; `key` names the failure (its error entry), so it is sent once. */
export function threadFailedNotification(input: {
	projectId: string;
	projectName: string;
	coordinatorId?: string | undefined;
	threadId: string;
	title: string;
	failure: string;
	key: string;
	scheduleId?: string | null;
	coordinator?: boolean;
	taskId?: string | null;
}): NotificationEvent {
	if (input.coordinator) return coordinatorFailedNotification({ ...input, key: `thread-failed:${input.projectId}:${input.key}` });
	return {
		kind: "thread_failed",
		message: input.failure,
		title: `Thread failed · ${input.title}`,
		body: notificationLine(input.failure) || `${input.projectName}: a background thread failed.`,
		projectId: input.projectId,
		...(input.coordinatorId === undefined || input.coordinatorId === "main" ? {} : { coordinatorId: input.coordinatorId }),
		threadId: input.threadId,
		...(input.scheduleId === undefined || input.scheduleId === null ? {} : { scheduleId: input.scheduleId }),
		alertTaskId: input.taskId ?? null,
		tag: `thread-failed:${input.projectId}:${input.threadId}`,
		key: `thread-failed:${input.projectId}:${input.key}`,
	};
}

/** A coordinator's transcript ended in an error, the same state shown in Needs you. */
export function coordinatorFailedNotification(input: {
	projectId: string;
	projectName: string;
	threadId: string;
	title: string;
	failure: string;
	key: string;
	entryId?: number;
}): NotificationEvent {
	return {
		kind: "coordinator_failed",
		message: input.failure,
		title: `Coordinator failed · ${input.projectName} · ${input.title}`,
		body: notificationLine(input.failure) || "The coordinator turn failed.",
		projectId: input.projectId,
		threadId: input.threadId,
		coordinatorId: input.threadId,
		...(input.entryId === undefined ? {} : { entryId: input.entryId }),
		tag: `coordinator-failed:${input.projectId}:${input.threadId}`,
		key: input.key,
	};
}

/** A scheduled run that started and has now reported back, so the schedule did its job. */
export function scheduleDoneNotification(input: {
	projectId: string;
	projectName: string;
	coordinatorId?: string | undefined;
	scheduleId: string;
	scheduleTitle: string;
	workerId: string;
	callId: string;
	text: string | null;
}): NotificationEvent {
	return {
		kind: "schedule_done",
		...(input.text ? { message: input.text } : {}),
		title: `Scheduled task done · ${input.scheduleTitle}`,
		body: notificationLine(input.text) || `${input.projectName}: the scheduled run finished.`,
		projectId: input.projectId,
		...(input.coordinatorId === undefined || input.coordinatorId === "main" ? {} : { coordinatorId: input.coordinatorId }),
		workerId: input.workerId,
		scheduleId: input.scheduleId,
		tag: `schedule:${input.scheduleId}`,
		key: `schedule-done:${input.projectId}:${input.scheduleId}:${input.callId}`,
	};
}

/** A scheduled run that started and then could not finish: its worker failed instead of reporting. */
export function scheduleFailureNotification(input: {
	projectId: string;
	projectName: string;
	coordinatorId?: string | undefined;
	scheduleId: string;
	scheduleTitle: string;
	workerId: string;
	callId: string;
	failure: string;
}): NotificationEvent {
	return {
		kind: "schedule_problem",
		message: input.failure,
		title: `Scheduled task failed · ${input.scheduleTitle}`,
		body: notificationLine(input.failure) || "The scheduled run could not finish.",
		projectId: input.projectId,
		...(input.coordinatorId === undefined || input.coordinatorId === "main" ? {} : { coordinatorId: input.coordinatorId }),
		workerId: input.workerId,
		scheduleId: input.scheduleId,
		tag: `schedule:${input.scheduleId}`,
		key: `schedule-failed:${input.projectId}:${input.scheduleId}:${input.callId}`,
	};
}

/** A schedule that failed or was skipped; a run that started is not a problem. */
export function scheduleProblemNotification(input: {
	projectId: string;
	projectName: string;
	coordinatorId?: string | undefined;
	scheduleId: string;
	scheduleTitle: string;
	run: ScheduleRun;
}): NotificationEvent | undefined {
	if (input.run.outcome === "started") return undefined;
	const skipped = input.run.outcome === "skipped";
	return {
		kind: "schedule_problem",
		title: skipped
			? `Scheduled task skipped · ${input.scheduleTitle}`
			: `Scheduled task failed · ${input.scheduleTitle}`,
		body: notificationLine(input.run.message) || (skipped ? "It was skipped." : "It could not start."),
		projectId: input.projectId,
		...(input.coordinatorId === undefined || input.coordinatorId === "main" ? {} : { coordinatorId: input.coordinatorId }),
		scheduleId: input.scheduleId,
		tag: `schedule:${input.scheduleId}`,
		key: `schedule:${input.projectId}:${input.scheduleId}:${input.run.at}${input.run.ref == null ? "" : `:${input.run.ref}`}:${input.run.outcome}`,
	};
}

/** The deploy attempt a `server.status.deploy` describes, as the dedupe key of one attempt. */
export function deployAttemptKey(deploy: DeployStatus): string {
	return `${deploy.commit}:${deploy.at}:${deploy.state}`;
}

/** A deploy that failed before publishing or rolled back after the restart; reported once per attempt. */
export function deployProblemNotification(deploy: DeployStatus | null): NotificationEvent | undefined {
	if (deploy === null || deploy.state === "ok") return undefined;
	const rolledBack = deploy.state === "rolled_back";
	const short = deploy.commit.slice(0, 7);
	return {
		kind: "deploy_problem",
		title: rolledBack ? "Deploy rolled back" : "Deploy failed",
		body: notificationLine(
			`${short}${deploy.description.length === 0 ? "" : ` ${deploy.description}`}${deploy.message === null ? "" : `: ${deploy.message}`}`,
		),
		projectId: null,
		tag: "deploy",
		key: `deploy:${deployAttemptKey(deploy)}`,
	};
}

/** A project's observer reported a failed attempt, independent of this backend's own deploy. */
export function projectDeployProblemNotification(input: {
	projectId: string;
	projectName: string;
	attemptKey: string;
	taskId?: string;
	threadId?: string;
	rolledBack: boolean;
	summary: string;
}): NotificationEvent {
	return {
		kind: "deploy_problem",
		title: `${input.rolledBack ? "Deploy rolled back" : "Deploy failed"} · ${input.projectName}`,
		body: notificationLine(input.summary),
		projectId: input.projectId,
		...(input.taskId === undefined ? {} : { taskId: input.taskId }),
		...(input.threadId === undefined ? {} : { threadId: input.threadId }),
		tag: `project-deploy:${input.projectId}`,
		key: `project-deploy:${input.projectId}:${input.attemptKey}`,
	};
}

/** A provider login waits for an answer that only the user can give. */
export function loginPromptNotification(login: AuthLogin, expiresAt?: string): NotificationEvent | undefined {
	const prompt = login.prompt;
	if (prompt === undefined || prompt.id.length === 0) return undefined;
	const message = prompt.message.trim().length === 0 ? "Sign in needs an answer." : prompt.message;
	return {
		kind: "login_prompt",
		message: message,
		...(expiresAt ? { expiresAt } : {}),
		title: `Sign in · ${login.providerId}`,
		body: notificationLine(message),
		projectId: null,
		tag: `login:${login.id}`,
		key: `login:${login.id}:${prompt.id}`,
	};
}

export function usageLimitReachedNotification(input: { providerLogin: string; label: string; reason: string; since: string; until?: string; sharedLimitKey?: string }): NotificationEvent {
	const when = input.until ? `${input.until.slice(0, 10)} at ${input.until.slice(11, 16)} UTC` : undefined;
	return {
		kind: "usage_limit_reached",
		...(input.until ? { expiresAt: input.until } : {}),
		...(input.sharedLimitKey ? { sharedLimitKey: input.sharedLimitKey } : {}),
		title: notificationLine(input.reason, 80),
		body: when ? `${input.label} work on this computer waits until ${when} and then continues by itself.`
			: `${input.label} work on this computer waits. The provider did not give a reset time. Resume from Usage.`,
		projectId: null,
		tag: `usage-limit:${input.providerLogin}`,
		key: `usage-limit:${input.providerLogin}:${input.since}`,
	};
}

function usageDuration(minutes: number): string {
	if (minutes >= 90) {
		const hours = Math.round(minutes / 60);
		return `${hours} ${hours === 1 ? "hour" : "hours"}`;
	}
	const rounded = Math.max(1, Math.round(minutes));
	return `${rounded} ${rounded === 1 ? "minute" : "minutes"}`;
}

export function usageDrainWarningNotification(input: {
	providerLogin: string; label: string; limit: string; minutesLeft: number; minutesToReset: number; limitId: string; resetsAt: string; sharedLimitKey?: string;
}): NotificationEvent {
	const timeLeft = usageDuration(input.minutesLeft);
	const timeToReset = usageDuration(input.minutesToReset);
	const windowKey = JSON.stringify([input.providerLogin, input.limitId]);
	return {
		kind: "usage_drain_warning",
		expiresAt: input.resetsAt,
		...(input.sharedLimitKey ? { sharedLimitKey: input.sharedLimitKey } : {}),
		title: `${input.label} ${input.limit} limit`,
		body: `About ${timeLeft} left at this pace. The limit resets in about ${timeToReset}.`,
		projectId: null,
		tag: `usage-drain-warning:${windowKey}`,
		key: `usage-drain-warning:${windowKey}:${input.resetsAt}`,
	};
}

export function usageDrainFixedNotification(input: {
	providerLogin: string; label: string; projectId: string | null; incidentId: string; note: string;
}): NotificationEvent {
	return {
		kind: "usage_drain_paused",
		title: `Paused and fixed: ${input.label} was draining fast`,
		body: notificationLine(input.note),
		projectId: input.projectId,
		tag: `usage-drain:${input.providerLogin}`,
		key: `usage-drain:${input.incidentId}`,
	};
}

/** A compaction of the coordinator failed; `pi.live.n` reports it once per failed task. */
export function compactionFailureNotification(input: {
	projectId: string;
	projectName: string;
	taskId: number | string;
	reason?: string | undefined;
	error: string;
}): NotificationEvent {
	return {
		kind: "compaction_failed",
		message: input.error,
		title: `Compaction failed · ${input.projectName}`,
		body: notificationLine(input.error) || "Compacting the coordinator's conversation failed.",
		projectId: input.projectId,
		tag: `compaction:${input.projectId}`,
		key: `compaction:${input.projectId}:${input.taskId}`,
	};
}

/** Leave space for the part context even when the question is long. */
function partNoticeBody(partTitle: string, text?: string): string {
	const context = `asked while building ${notificationLine(partTitle, 80)}`;
	const message = notificationLine(text, NOTIFICATION_BODY_LIMIT - context.length - 3);
	return message ? `${message} · ${context}` : context;
}

/** The coordinator asked the user a question on the board; one notification per question. */
export function boardQuestionNotification(input: {
	projectId: string;
	projectName: string;
	questionId: string;
 revision?: number;
 reply?: boolean;
 noReplyYet?: boolean;
	text: string;
	/** The thread that asked; "main" for main. */
	threadId?: string;
	coordinatorId?: string;
	coordinatorTitle?: string;
	/** The task it is about, if it names one. */
	taskId?: string | null;
	requestTitle?: string;
	partTitle?: string;
	taskTitle?: string;
	taskRevision?: number;
	/** A warning, not a question: the user must acknowledge it. */
	warning?: boolean;
	approval?: boolean;
	questionRevision?: number;
	choices?: readonly { label: string; recommended?: boolean }[];
}): NotificationEvent {
	const taskTitle = input.taskTitle ?? input.partTitle;
	return {
		kind: "board_question",
		projectName: input.projectName,
		coordinatorName: input.coordinatorTitle ?? "Main chat",
		message: input.text,
		...(taskTitle ? { taskTitle } : {}),
		...(input.taskRevision === undefined ? {} : { taskRevision: input.taskRevision }),
		title: input.requestTitle !== undefined ? `${input.requestTitle} · ${input.projectName}` : input.coordinatorTitle ? `${input.projectName} · ${input.coordinatorTitle}` : `${input.noReplyYet ? `No reply yet on ${input.questionId}` : input.reply ? `Reply on ${input.questionId}` : input.warning === true ? "Warning" : "Question"} · ${input.projectName}`,
		...(input.coordinatorId ? { coordinatorId: input.coordinatorId } : {}),
		body: input.partTitle === undefined ? notificationLine(markdownText(input.text)) : partNoticeBody(input.partTitle, markdownText(input.text)),
		projectId: input.projectId,
		...(input.threadId === undefined ? {} : { threadId: input.threadId }),
		...(input.taskId === undefined || input.taskId === null ? {} : { taskId: input.taskId }),
		question: {
			questionId: input.questionId,
			questionRevision: input.questionRevision ?? input.revision ?? 1,
			choices: (input.choices ?? []).map(({ label, recommended }) => ({ label, recommended: recommended === true })),
			warning: input.warning === true,
			approval: input.approval === true,
		},
		tag: `board-question:${input.projectId}:${input.questionId}`,
		key: `board-question:${input.projectId}:${input.questionId}${input.revision === undefined ? "" : `@${input.revision}`}`,
	};
}

/** The coordinator (or a thread) moved a task to review: it is ready for the user. One per move. */
export function taskReviewNotification(input: {
	projectId: string;
	projectName: string;
	taskId: string;
	title: string;
	/** The task's revision after the move, so each move to review is told once. */
	revision: number;
	/** The thread that holds the task, if it is a background thread. */
	threadId?: string;
	coordinatorId?: string;
	coordinatorTitle?: string;
}): NotificationEvent {
	return {
		kind: "task_review",
		projectName: input.projectName,
		taskTitle: input.title,
		title: input.coordinatorTitle ? `${input.projectName} · ${input.coordinatorTitle}` : `Ready for review · ${input.projectName}`,
		...(input.coordinatorId ? { coordinatorId: input.coordinatorId } : {}),
		body: notificationLine(`${input.taskId} ${input.title}`),
		projectId: input.projectId,
		...(input.threadId === undefined || input.threadId === "main" ? {} : { threadId: input.threadId }),
		taskId: input.taskId,
		taskRevision: input.revision,
		tag: `task-review:${input.projectId}:${input.taskId}`,
		key: `task-review:${input.projectId}:${input.taskId}@${input.revision}`,
	};
}

/** A task has new steps for the owner. Keep commands and step text on the task itself. */
export function taskStepsNotification(input: {
	projectId: string;
	projectName: string;
	taskId: string;
	title: string;
	revision: number;
	stepsVersion: number;
	requestTitle?: string | undefined;
	threadId: string;
}): NotificationEvent {
	return {
		kind: "task_steps",
		projectName: input.projectName,
		taskTitle: input.title,
		title: `Your steps · ${input.requestTitle ?? input.projectName}`,
		body: input.requestTitle === undefined ? notificationLine(`${input.taskId} ${input.title}`) : partNoticeBody(input.title),
		projectId: input.projectId,
		taskId: input.taskId,
		threadId: input.threadId,
		taskRevision: input.revision,
		tag: `task-steps:${input.projectId}:${input.taskId}`,
		key: `task-steps:${input.projectId}:${input.taskId}@${input.stepsVersion}`,
	};
}

/** Memory maintenance failed; the run is recorded, and the devices hear about it once. */
export function maintenanceFailureNotification(input: {
	scope: "global" | "project";
	projectId: string | null;
	projectName?: string | null;
	at: string;
	message: string | null;
}): NotificationEvent {
	const where =
		input.scope === "global" ? "global memory" : `${input.projectName ?? input.projectId ?? "project"} memory`;
	return {
		kind: "maintenance_failed",
		title: "Memory maintenance failed",
		body: notificationLine(`${where}: ${input.message ?? "the run failed"}`),
		projectId: input.projectId,
		tag: `maintenance:${input.scope}:${input.projectId ?? ""}`,
		key: `maintenance:${input.scope}:${input.projectId ?? ""}:${input.at}`,
	};
}

/** What `notifications.test` pushes: it says nothing about the backend's work, only that this device hears it. */
export function testNotification(): NotificationEvent {
	return {
		kind: "test",
		title: "Test notification",
		body: "Notifications reach this device.",
		projectId: null,
		tag: "test",
	};
}

// --- sending ------------------------------------------------------------------------------------------------------

/** The POST a push service gets: what `web-push` built, handed to `fetch` (or to a test's fake endpoint). */
export type PushRequest = { endpoint: string; headers: Record<string, string>; body: Uint8Array<ArrayBuffer> };
export type PushResponse = { status: number | null; message: string | null };
export type PushTransport = (request: PushRequest) => Promise<PushResponse>;

/** The default transport: the request `web-push` built, sent as it is. */
export const fetchPush: PushTransport = async (request) => {
	try {
		const response = await fetch(request.endpoint, {
			method: "POST",
			headers: request.headers,
			body: request.body,
		});
		const text = (await response.text().catch(() => "")).trim();
		return { status: response.status, message: text.length === 0 ? null : text.slice(0, 300) };
	} catch (error) {
		return { status: null, message: errorMessage(error) };
	}
};

export type DeliveryOutcome = {
	deviceId: string;
	ok: boolean;
	status: number | null;
	message: string | null;
};

export type NotifyResult = {
	/** Undefined when the event was delivered to at least one device, or deliberately not sent. */
	skipped?: "duplicate" | "no-devices" | "filtered" | "held";
	deliveries: DeliveryOutcome[];
};

type InAppAlerts = {
	store: NotificationRecentStore;
	backendKey: string;
	alert(alert: NotificationAlert, now: number): void;
	resolved(event: NotificationsResolvedEvent): void;
};

export type NotifierOptions = {
	computerName?: string;
	projectName?: (projectId: string) => Promise<string | undefined>;
	inAppAlerts?: InAppAlerts;
	relay?: PushRelayTransport;
	sessionActive?: (sessionId: string) => boolean;
	store: NotificationStore;
	state: NotificationStateStore;
	vapid: VapidKeys;
	/** The VAPID `sub`: the app's URL. */
	subject: string;
	presence?: NotificationPresence;
	now?: () => number;
	log?: (message: string) => void;
	send?: PushTransport;
	ttlSeconds?: number;
	/** FCM for Android devices; undefined when this backend has no service-account key (FCM off). */
	fcm?: FcmSender;
	/** Whether a project is archived: its events are dropped. Default: none is. */
	isArchived?: (projectId: string) => Promise<boolean>;
	/** How long an event is held while the app is open. Default: `NOTIFICATION_HOLD_MS` (15 s). */
	holdMs?: number;
	/** Runs `run` after `delayMs` and returns what cancels it. Default: `setTimeout` (a test passes a fake clock). */
	schedule?: HoldScheduler;
};

export type HoldScheduler = (run: () => void, delayMs: number) => () => void;

const timeoutScheduler: HoldScheduler = (run, delayMs) => {
	const timer = setTimeout(run, delayMs);
	return () => clearTimeout(timer);
};

/** What an FCM device's delivery says while this backend cannot send through FCM. */
export const FCM_OFF_MESSAGE = "FCM is off on this backend (no service-account key)";

/**
 * The one thing the rest of the server calls to notify: it decides which devices hear about an event, encrypts and
 * signs one payload per device, posts it to the push service, and records what happened. Nothing here throws at a
 * caller; `notify` is fire and forget, and `deliver` is the awaitable form tests and `notifications.test` use.
 */
export class Notifier {
	readonly relay: PushRelayTransport | undefined;
	readonly presence: NotificationPresence;
	readonly #store: NotificationStore;
	readonly #computerName: string | undefined;
	readonly #projectName: NotifierOptions["projectName"];
	readonly #sessionActive: ((sessionId: string) => boolean) | undefined;
	readonly #state: NotificationStateStore;
	readonly #inAppAlerts: InAppAlerts | undefined;
	readonly #shownInApp = new WeakSet<HeldEvent>();
	readonly #vapid: VapidKeys;
	readonly #subject: string;
	readonly #now: () => number;
	readonly #log: (message: string) => void;
	readonly #send: PushTransport;
	readonly #ttlSeconds: number;
	readonly #fcm: FcmSender | undefined;
	readonly #isArchived: ((projectId: string) => Promise<boolean>) | undefined;
	readonly #pending = new Set<Promise<unknown>>();
	readonly #holdMs: number;
	readonly #schedule: HoldScheduler;
	/** The timer of every held event, by the held event's ID. */
	readonly #holdTimers = new Map<string, () => void>();
	readonly #deliveringCards = new Set<{ card: PushCard; handled: boolean }>();
	#clearTimer: { at: number; cancel: () => void } | undefined;
	#sendingClears = false;
	#stopped = false;
	#registrations: Promise<unknown> = Promise.resolve();
	#alertBroadcasts = Promise.resolve();

	constructor(options: NotifierOptions) {
		this.#sessionActive = options.sessionActive;
		this.#store = options.store;
		this.#computerName = options.computerName;
		this.#projectName = options.projectName;
		this.#state = options.state;
		this.#inAppAlerts = options.inAppAlerts;
		this.#vapid = options.vapid;
		this.#subject = options.subject;
		this.#now = options.now ?? Date.now;
		this.#log = options.log ?? (() => undefined);
		this.#send = options.send ?? fetchPush;
		this.#ttlSeconds = options.ttlSeconds ?? NOTIFICATION_TTL_SECONDS;
		this.#fcm = options.fcm;
		this.#isArchived = options.isArchived;
		this.#holdMs = options.holdMs ?? NOTIFICATION_HOLD_MS;
		this.#schedule = options.schedule ?? timeoutScheduler;
		this.presence = options.presence ?? new NotificationPresence();
		this.relay = options.relay;
		this.relay?.setCardAccepted((deviceId, card, handled) => {
			const active = [...this.#deliveringCards].find(candidate => candidate.card === card ||
				(candidate.card.tag === card.tag && candidate.card.at === card.at && candidate.card.key === card.key));
			this.#rememberPush(deviceId, card, handled || active?.handled === true);
		});
		this.relay?.setPolicy(async (device, event) =>
			(!event.projectId || await this.#isArchived?.(event.projectId) !== true) &&
			notificationBlocked(device, event, { at: new Date(this.#now()) }) === undefined);
	}

	/** The device's registration on this backend, or null. */
	device(deviceId: string): NotificationDevice | null {
		const now = this.#now();
		const relayDevice = this.relay?.store.device(deviceId, now);
		if (relayDevice) return relayDevice;
		this.#store.pruneMutes(now);
		const device = this.#store.get(deviceId);
		return device === undefined ? null : publicDevice(device);
	}

	/** Serialize explicit transport selection so concurrent direct and relay confirmations cannot create dual sends. */
	async #registration<T>(change: () => Promise<T>): Promise<T> {
		const run = this.#registrations.then(change);
		this.#registrations = run.catch(() => undefined);
		return await run;
	}

	/** Register/update a direct transport; serialize against relay activation. */
	async register(input: Parameters<Notifier["registerDirect"]>[0]): Promise<NotificationDevice> {
		return await this.#registration(() => this.registerDirect(input));
	}

	/** Internal direct registration under the shared transport-selection transaction queue. */
	private async registerDirect(
		input: {
			deviceId: string;
			sessionId?: string;
			allowLegacyRegistration?: boolean;
			label: string;
			backendKey: string;
			preferences: NotificationPreferences;
		} & DeviceAddress,
	): Promise<NotificationDevice> {
		if (input.sessionId && !this.#sessionActive?.(input.sessionId))
			throw new ServerError("auth_revoked", "auth_revoked");
		if (input.sessionId && this.relay?.store.selected(input.sessionId)) {
			await this.relay.revoke(input.sessionId);
			for (const old of this.#store.list())
				if (old.sessionId === input.sessionId) await this.#store.unregister(old.deviceId);
		}
		const device = await this.#store.register({ ...input, now: this.#now });
		if (input.sessionId && this.relay?.store.selected(input.sessionId)) await this.relay.selectDirect(input.sessionId);
		if (input.sessionId && !this.#sessionActive?.(input.sessionId)) {
			await this.#store.unregister(input.deviceId);
			throw new ServerError("auth_revoked", "auth_revoked");
		}
		await this.#store.flush();
		return publicDevice(device);
	}

	checkSessionDevice(deviceId: string, sessionId: string | undefined) {
		this.relay?.checkDevice(deviceId, sessionId);
		const device = this.#store.get(deviceId);
		if (device && device.sessionId !== sessionId)
			throw new ServerError("permission_denied", "Notification registration belongs to another session");
	}
	/** Confirm and durably select a relay before removing stale direct rows; the selection suppresses crash leftovers. */
	async confirmRelay(sessionId: string, request: NotificationsConfirmRelayRequest): Promise<NotificationDevice> {
		if (!this.relay) throw new ServerError("bad_request", "Relay is unavailable");
		return await this.#registration(async () => {
			const device = await this.relay!.confirm(sessionId, request.operationId, request.confirmation);
			for (const old of this.#store.list())
				if (old.sessionId === sessionId) await this.#store.unregister(old.deviceId);
			return device;
		});
	}

	/** Local revoke never waits for remote cleanup, and removes every direct row after delete-only work is durable. */
	async revokeSession(sessionId: string) {
		await this.relay?.revoke(sessionId);
		for (const device of this.#store.list())
			if (device.sessionId === sessionId) await this.#store.unregister(device.deviceId);
		if (!this.#store.list().length && !this.relay?.devices().length) this.#dropHeld([...this.#state.held.keys()]);
		await this.#store.flush();
		await this.#state.flush();
	}

	/** Forget a device; false when it was not registered. */
	async unregister(deviceId: string): Promise<boolean> {
		const relay = this.relay?.devices().find((d) => d.deviceId === deviceId);
		const pending = this.relay?.store.snapshot().routes.find((r) => r.device.deviceId === deviceId);
		if (relay || pending) {
			await this.revokeSession(relay?.sessionId ?? pending!.context.sessionId);
			return true;
		}
		const removed = await this.#store.unregister(deviceId);
		await this.#store.flush();
		return removed;
	}

	/** The key pair every backend shares; `notifications.config` answers it. */
	get vapid(): VapidKeys {
		return this.#vapid;
	}

	get subject(): string {
		return this.#subject;
	}

	get publicKey(): string {
		return this.#vapid.publicKey;
	}

	/** The Firebase project FCM pushes go through, or null when FCM is off here. */
	get fcmProjectId(): string | null {
		return this.#fcm?.projectId ?? null;
	}

	/** Fire and forget: the caller's work must never wait for, or fail with, a push. */
	notify(event: NotificationEvent): void {
		this.#trackDelivery(this.deliver(event), event.kind);
	}

	/** Await admission into the stream or hold, but never wait for an OS push service. */
	async queue(event: NotificationEvent): Promise<void> {
		const admitted = await this.#admit(event);
		if ("event" in admitted) this.#trackDelivery(this.#deliverNow(admitted.event, admitted.at), event.kind);
	}

	#trackDelivery(delivery: Promise<unknown>, kind: NotificationEvent["kind"]): void {
		const run = delivery.catch((error: unknown) => {
			this.#log(`notifications: ${kind} could not be sent: ${errorMessage(error)}`);
		});
		this.#pending.add(run);
		void run.finally(() => this.#pending.delete(run));
	}

	/**
	 * Send one event and say what each device's push service answered. While some connection is visible the event is
	 * held instead (`skipped: "held"`): interaction can drop it if it is on screen, otherwise the end of the hold pushes
	 * it. The key is claimed first either way, so a dropped event never comes back.
	 */
	async deliver(event: NotificationEvent): Promise<NotifyResult> {
		const admitted = await this.#admit(event);
		return "event" in admitted ? this.#deliverNow(admitted.event, admitted.at) : admitted;
	}

	async #admit(event: NotificationEvent): Promise<NotifyResult | { event: NotificationEvent; at: string }> {
		if (event.key !== undefined && !this.#state.claim(event.key)) return { skipped: "duplicate", deliveries: [] };
		// An archived project is silent. The key was claimed above, so nothing replays when it comes back.
		if (
			event.projectId !== null &&
			event.projectId !== undefined &&
			(await this.#isArchived?.(event.projectId)) === true
		) {
			return { skipped: "filtered", deliveries: [] };
		}
		const at = new Date(this.#now());
		if (event.projectId && event.projectName === undefined) {
			const name = await this.#projectName?.(event.projectId);
			if (name) event = { ...event, projectName: name };
		}
		const inApp = this.#inAppAlerts;
		if (inApp && event.kind !== "test") {
			const kind = event.kind;
			const key = event.key ?? crypto.randomUUID();
			event = { ...event, key };
			const payload = notificationPayload(inApp, event, at.toISOString(), this.#computerName);
			if (kind === "board_question" || kind === "task_review" || kind === "task_steps") this.#resolveInApp(alert => alert.tag === payload.tag);
			const alert = inApp.store.append({
				...payload, ...event.question, kind, key,
				...(event.alertTaskId == null ? {} : { taskId: event.alertTaskId }),
				...(event.taskRevision === undefined ? {} : { taskRevision: event.taskRevision }),
				level: notificationAlertLevel(kind, event.question?.warning),
			}, at.getTime());
			await this.#publishAlertEvent(inApp, () => inApp.alert(alert, this.#now()));
			if (inApp.store.wasHandled(alert.key)) return { skipped: "filtered", deliveries: [] };
		}
		if (this.presence.anyVisible() && this.#wanted(event, at)) {
			this.#hold({ id: crypto.randomUUID(), ...(this.relay ? { eventId: newRelayId() } : {}),
				event, at: at.toISOString(), dueAt: at.getTime() + this.#holdMs });
			return { skipped: "held", deliveries: [] };
		}
		return { event, at: at.toISOString() };
	}

	/** Some device could get this push; a mute that ends within the hold must not prevent admission. */
	#wanted(event: NotificationEvent, at: Date): boolean {
		this.#store.pruneMutes(at.getTime());
		const muteAt = at.getTime() + this.#holdMs;
		return [...this.#store.list().filter((d) => !d.sessionId || !this.relay?.store.selected(d.sessionId)),
			...(this.relay?.devices() ?? [])].some((device) => notificationBlocked(device, event, { at, muteAt }) === undefined);
	}

	/** Filter at the moment of sending (a mute or quiet hours changed during the hold count) and push to each device. */
	async #deliverNow(event: NotificationEvent, atIso: string, eventId = newRelayId()): Promise<NotifyResult> {
		const at = new Date(this.#now());
		if (event.expiresAt && Date.parse(event.expiresAt) <= at.getTime()) return { skipped: "filtered", deliveries: [] };
		this.#store.pruneMutes(at.getTime());
		const deliveries: DeliveryOutcome[] = [];
		// Snapshot the routing choice before the first network await. A newly selected relay must not duplicate an in-flight direct notice.
		const relayDevices = this.relay?.devices() ?? [];
		const card = pushedCard(event, atIso);
		const active = card ? { card, handled: false } : undefined;
		if (active) this.#deliveringCards.add(active);
		try {
			for (const device of this.#store.list()) {
				if (active?.handled) break;
				if (device.sessionId && this.relay?.store.selected(device.sessionId)) continue;
				if (notificationBlocked(device, event, { at }) !== undefined) continue;
				const result = await this.#push(device, event, atIso);
				deliveries.push(result);
				if (result.ok && card && device.preferences.quietResolutions) this.#rememberPush(device.deviceId, card, active?.handled === true);
			}
			for (const device of relayDevices) {
				if (active?.handled) break;
				if (notificationBlocked(device, event, { at }) !== undefined) continue;
				deliveries.push(await this.relay!.send(device.deviceId, notificationPayload(device, event, atIso, this.#computerName),
					event, atIso, eventId, device.preferences.quietResolutions ? card : undefined));
			}
		} finally { if (active) this.#deliveringCards.delete(active); }
		return { ...(deliveries.length === 0 ? { skipped: "filtered" as const } : {}), deliveries };
	}

	#hold(held: HeldEvent): void {
		this.#state.hold(held);
		this.#armHold(held);
	}

	#armHold(held: HeldEvent): void {
		const cancel = this.#schedule(
			() => {
				this.#holdTimers.delete(held.id);
				if (this.#state.release([held.id]) === 0) return;
				const run = this.#deliverNow(held.event, held.at, held.eventId).catch((error: unknown) => {
					this.#log(`notifications: ${held.event.kind} could not be sent: ${errorMessage(error)}`);
				});
				this.#pending.add(run);
				void run.finally(() => this.#pending.delete(run));
			},
			Math.max(0, held.dueAt - this.#now()),
		);
		this.#holdTimers.set(held.id, cancel);
	}

	/** Drop held events on the interacting connection's screen, for every device. Their dedupe keys stay claimed. */
	interaction(connection: object, onScreenProjectId?: string | null): number {
		this.presence.interacted(connection, this.#now());
		const presence = this.presence.get(connection);
		const visibleProjectId =
			onScreenProjectId === undefined ? (presence?.visible ? presence.projectId : null) : onScreenProjectId;
		const ids: string[] = [];
		for (const held of this.#state.held.values()) if (isOnScreen(held, visibleProjectId) || this.#shownInApp.has(held)) ids.push(held.id);
		return this.#dropHeld(ids);
	}

	shown(keys: readonly string[]): void {
		const shown = new Set(keys);
		for (const held of this.#state.held.values()) {
			if (held.event.key !== undefined && shown.has(held.event.key)) this.#shownInApp.add(held);
		}
	}

	async recent(after: number) {
		const store = this.#inAppAlerts?.store;
		if (!store) return undefined;
		const page = store.recent(after, this.#now());
		await store.flush();
		return page;
	}

	resolveAlerts(matches: MatchesPushCard): Promise<void> | undefined {
		const published = this.#resolveInApp(matches);
		for (const active of this.#deliveringCards) if (matches(active.card)) active.handled = true;
		const held = [...this.#state.held.values()].filter(({ event, at }) => {
			const card = pushedCard(event, at);
			return card && matches(card);
		});
		this.#dropHeld(held.map(({ id }) => id));
		this.#state.cards.settle(matches, this.#now());
		this.#armClears();
		void this.relay?.settleCards(matches).catch(() => this.#log("notifications: could not save a settled relay card"));
		return published;
	}

	#resolveInApp(matches: MatchesPushCard): Promise<void> | undefined {
		const inApp = this.#inAppAlerts;
		const resolution = inApp?.store.resolve(matches, this.#now());
		if (inApp && resolution) return this.#publishAlertEvent(inApp, () => inApp.resolved(resolution));
	}

	readChat(projectId: string, coordinatorId: string, through: number): void {
		void this.resolveAlerts(card => card.kind === "reply" && card.projectId === projectId &&
			(card.coordinatorId ?? "main") === coordinatorId && card.entryId !== undefined && card.entryId <= through);
	}

	#rememberPush(deviceId: string, card: PushCard, handled: boolean): void {
		this.#state.cards.accepted(deviceId, card, this.#now(), handled ||
			(card.key !== undefined && this.#inAppAlerts?.store.wasHandled(card.key) === true));
		this.#armClears();
	}

	#armClears(): void {
		if (this.#sendingClears || this.#stopped) return;
		const now = this.#now();
		const delay = this.#state.cards.nextDelay(now);
		if (!Number.isFinite(delay)) { this.#clearTimer?.cancel(); this.#clearTimer = undefined; return; }
		if (this.#clearTimer && this.#clearTimer.at <= now + delay) return;
		this.#clearTimer?.cancel();
		const cancel = this.#schedule(() => {
			this.#clearTimer = undefined;
			this.#sendingClears = true;
			const run = this.#sendClears().catch(() => this.#log("notifications: could not send quiet clears")).finally(() => {
				this.#pending.delete(run);
				this.#sendingClears = false;
				this.#armClears();
			});
			this.#pending.add(run);
		}, Math.min(delay, 2_147_483_647));
		this.#clearTimer = { at: now + delay, cancel };
	}

	async #sendClears(): Promise<void> {
		const now = this.#now();
		const at = new Date(now).toISOString();
		for (const [deviceId, batch] of this.#state.cards.batches(now)) {
			if (this.#stopped) break;
			try {
				const relay = this.relay?.devices().find(device => device.deviceId === deviceId);
				const direct = this.#store.get(deviceId);
				if (relay?.preferences.quietResolutions) await this.relay!.send(deviceId, resolvedPayload(relay, batch, at), { kind: "test" }, at);
				else if (direct?.preferences.quietResolutions) await this.#sendDirect(direct, resolvedPayload(direct, batch, at));
			} finally { this.#state.cards.delivered(deviceId, batch); }
		}
	}

	/** Send in sequence order after the recent file write; a restart must not reuse a published sequence. */
	#publishAlertEvent(inApp: InAppAlerts, publish: () => void): Promise<void> {
		const written = inApp.store.flush();
		this.#alertBroadcasts = this.#alertBroadcasts.then(() => written).then(publish)
			.catch((error: unknown) => this.#log(`notifications: could not broadcast alert: ${errorMessage(error)}`));
		return this.#alertBroadcasts;
	}

	#dropHeld(ids: string[]): number {
		for (const id of ids) {
			this.#holdTimers.get(id)?.();
			this.#holdTimers.delete(id);
		}
		return this.#state.release(ids);
	}

	/** How many events wait in their hold. */
	get heldCount(): number {
		return this.#state.held.size;
	}

	/**
	 * After a restart: carry on with the events that were in their hold. A hold that ran out while the server was down
	 * pushes at once; the others wait the rest of their time, so a client that reconnects can still drop them.
	 */
	restore(): void {
		this.#stopped = false;
		this.relay?.start();
		this.#armClears();
		for (const held of this.#state.held.values()) if (!this.#holdTimers.has(held.id)) this.#armHold(held);
	}

	/** Cancel the hold timers (a shutdown); held events stay in the state file for `restore`. */
	stop(): void {
		this.#stopped = true;
		this.#clearTimer?.cancel();
		this.#clearTimer = undefined;
		this.relay?.stop();
		for (const cancel of this.#holdTimers.values()) cancel();
		this.#holdTimers.clear();
	}

	/** Push a test notification to one device and report what the push service answered. */
	async test(deviceId: string): Promise<DeliveryOutcome> {
		const relayDevice = this.relay?.store.device(deviceId);
		if (relayDevice) {
			const event = testNotification();
			const at = new Date(this.#now()).toISOString();
			return await this.relay!.send(deviceId, notificationPayload(relayDevice, event, at, this.#computerName), event, at);
		}
		const device = this.#store.get(deviceId);
		if (device === undefined) {
			throw new ServerError("bad_request", `No device "${deviceId}" is registered with this backend`);
		}
		const outcome = await this.#push(device, testNotification(), new Date(this.#now()).toISOString());
		await this.#store.flush();
		return outcome;
	}

	/** Report the last deploy attempt when it failed or rolled back, once per attempt, across restarts too. */
	async deployProblem(deploy: DeployStatus | null): Promise<void> {
		if (deploy?.state === "ok") {
			await this.resolveAlerts(alert => alert.kind === "deploy_problem" && alert.projectId === null);
			return;
		}
		const event = deployProblemNotification(deploy);
		if (deploy === null || event === undefined) return;
		if (!this.#state.claimDeployAttempt(deployAttemptKey(deploy))) return;
		// Keep the original deploy marker for rollback; the alert and any held push share the event's key.
		await this.deliver(event);
		await this.#state.flush();
	}

	/** Wait for everything `notify` started: a shutdown or a test can then read the devices' last deliveries. */
	async flush(): Promise<void> {
		while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
		await this.relay?.flush();
		await this.#store.flush();
		await this.#state.flush();
		await this.#inAppAlerts?.store.flush();
		await this.#alertBroadcasts;
	}

	async #push(device: StoredDevice, event: NotificationEvent, at: string): Promise<DeliveryOutcome> {
		return await this.#sendDirect(device, notificationPayload(device, event, at, this.#computerName));
	}

	async #sendDirect(device: StoredDevice, payload: NotificationPayload): Promise<DeliveryOutcome> {
		const at = payload.at;
		const quiet = payload.kind === "resolved";
		if (
			this.#store.get(device.deviceId)?.sessionId !== device.sessionId ||
			(device.sessionId && !this.#sessionActive?.(device.sessionId))
		)
			return { deviceId: device.deviceId, ok: false, status: null, message: "auth_revoked" };
		if (device.sessionId && this.relay?.store.selected(device.sessionId))
			return { deviceId: device.deviceId, ok: false, status: null, message: "relay_selected" };
		if (device.fcmToken !== undefined) return await this.#pushFcm(device, device.fcmToken, payload);
		const subscription = device.subscription!;
		let details: webpush.RequestDetails;
		try {
			details = webpush.generateRequestDetails(
				{
					endpoint: subscription.endpoint,
					keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
				},
				JSON.stringify(payload),
				{
					vapidDetails: {
						subject: this.#subject,
						publicKey: this.#vapid.publicKey,
						privateKey: this.#vapid.privateKey,
					},
					TTL: quiet ? RESOLVED_PUSH_TTL_MS / 1000 : this.#ttlSeconds,
					...(quiet ? { urgency: "low" as const } : payload.kind !== "test" && payload.kind !== "resolved" && NOTIFICATION_FAILURE_KINDS.includes(payload.kind)
						? { urgency: "high" as const } : {}),
					...(quiet ? {} : { topic: pushTopic(payload.tag) }),
				},
			);
		} catch (error) {
			// A subscription the library cannot encrypt for is this device's problem, not the caller's.
			const message = "Invalid push subscription";
			this.#log(`notifications: ${device.deviceId} has an unusable subscription: ${message}`);
			await this.#store.setLastDelivery(device.deviceId, { at, ok: false, status: null, message });
			return { deviceId: device.deviceId, ok: false, status: null, message };
		}
		const response = await this.#send({
			endpoint: subscription.endpoint,
			headers: details.headers,
			body: bytesOf(details.body),
		});
		// The push service forgot the subscription (uninstalled, permission revoked, profile gone): stop trying.
		return await this.#record(device, payload, at, response, response.status === 404 || response.status === 410);
	}

	/** The same payload as FCM data (`payload`: its JSON), which the Android app draws itself. */
	async #pushFcm(
		device: StoredDevice,
		token: string,
		payload: NotificationPayload,
	): Promise<DeliveryOutcome> {
		const at = payload.at;
		const quiet = payload.kind === "resolved";
		if (this.#fcm === undefined) {
			// Kept registered: the key may be added later, and the device then hears from this backend again.
			await this.#store.setLastDelivery(device.deviceId, { at, ok: false, status: null, message: FCM_OFF_MESSAGE });
			return { deviceId: device.deviceId, ok: false, status: null, message: FCM_OFF_MESSAGE };
		}
		const result = await this.#fcm.send({
			token,
			authorized: () =>
				this.#store.get(device.deviceId)?.sessionId === device.sessionId &&
				(!device.sessionId || !this.relay?.store.selected(device.sessionId)) &&
				(!device.sessionId || this.#sessionActive?.(device.sessionId) === true),
			data: { payload: JSON.stringify(payload) },
			ttlSeconds: quiet ? RESOLVED_PUSH_TTL_MS / 1000 : this.#ttlSeconds,
			...(quiet ? { priority: "normal" as const } : {}),
		});
		return await this.#record(device, payload, at, result, result.unregistered);
	}

	/** Record what the push service answered; a device it no longer knows is dropped. */
	async #record(
		device: StoredDevice,
		event: Pick<NotificationPayload, "kind">,
		at: string,
		response: PushResponse,
		gone: boolean,
	): Promise<DeliveryOutcome> {
		if (response.message) response = { ...response, message: "Push delivery failed" };
		const ok = response.status !== null && response.status >= 200 && response.status < 300;
		if (gone) {
			await this.#store.unregister(device.deviceId);
			const address = device.fcmToken === undefined ? "subscription" : "FCM token";
			this.#log(`notifications: dropping ${device.deviceId}; its ${address} is gone (${response.status})`);
		} else {
			await this.#store.setLastDelivery(device.deviceId, {
				at,
				ok,
				status: response.status,
				message: ok ? null : response.message,
			});
			if (!ok) {
				this.#log(
					`notifications: ${event.kind} to ${device.deviceId} failed (${response.status ?? "no answer"}): push service rejected delivery`,
				);
			}
		}
		return { deviceId: device.deviceId, ok, status: response.status, message: response.message };
	}
}

/** A push `Topic` header: base64url of the tag, cut to the 32 characters RFC 8030 allows. */
export function pushTopic(tag: string): string {
	return Buffer.from(tag, "utf8").toString("base64url").slice(0, 32);
}

/** What a device that registers without preferences starts with. */
export function defaultNotificationPreferences(): NotificationPreferences {
	return { kinds: [...DEFAULT_NOTIFICATION_KINDS], mutedProjects: [], quietHours: null };
}
