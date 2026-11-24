/**
 * Helpers on top of the protocol's notification types: where a payload's notification opens, what this browser calls
 * itself, the preferences a device keeps, and quiet hours read in the device's timezone. Everything here is pure (or
 * takes the storage it writes to), so the app, its tests and the service worker share one decision instead of three.
 */
import {
	DEFAULT_NOTIFICATION_KINDS,
	MAIN_THREAD_ID,
	NOTIFICATION_FAILURE_KINDS,
	NOTIFICATION_KINDS,
	normalizeNotificationMutes,
	notificationMuteActive,
	type NotificationMute,
	type NotificationMutes,
	type NotificationProjectMute,
	type NotificationKind,
	type NotificationPayload,
	type NotificationPreferences,
} from "@kemiri/protocol";

export { NOTIFICATION_KINDS };

/**
 * What a new device started with, by defaults version (the index). A device that still has exactly one version's kinds
 * kept the defaults and follows the next version's; one that changed them keeps its own choice.
 */
const DEFAULT_KINDS_BY_VERSION: readonly (readonly NotificationKind[])[] = [
	["reply", "worker_report", "worker_failed", "schedule_problem", "deploy_problem", "login_prompt"],
	["reply", "worker_report", "worker_failed", "schedule_problem", "deploy_problem", "login_prompt", "board_question"],
	[
		"reply",
		"worker_report",
		"worker_failed",
		"schedule_problem",
		"deploy_problem",
		"login_prompt",
		"board_question",
		"thread_finished",
		"thread_failed",
	],
	[
		"reply",
		"worker_failed",
		"schedule_problem",
		"deploy_problem",
		"login_prompt",
		"board_question",
		"thread_finished",
		"thread_failed",
		"work_finished",
		"disk_low",
	],
	["reply", "worker_failed", "schedule_problem", "deploy_problem", "login_prompt", "board_question",
		"thread_finished", "thread_failed", "work_finished", "disk_low", "task_review"],
	["reply", "worker_failed", "schedule_problem", "deploy_problem", "login_prompt", "board_question",
		"thread_finished", "thread_failed", "coordinator_failed", "work_finished", "disk_low", "task_review"],
	["reply", "worker_failed", "schedule_problem", "deploy_problem", "login_prompt", "board_question",
		"thread_finished", "thread_failed", "coordinator_failed", "work_finished", "disk_low", "task_review", "task_steps"],
	["reply", "worker_failed", "schedule_problem", "deploy_problem", "login_prompt", "usage_limit_reached", "board_question",
		"thread_finished", "thread_failed", "coordinator_failed", "work_finished", "disk_low", "task_review", "task_steps"],
	DEFAULT_NOTIFICATION_KINDS,
];

/** The defaults version this build writes; settings stored without one are version 0. */
export const NOTIFICATION_DEFAULTS_VERSION = DEFAULT_KINDS_BY_VERSION.length - 1;

/**
 * The kinds a device has after the defaults moved on: each version it missed replaces its kinds when they were exactly
 * that version's defaults. A device that customised its kinds is left alone.
 */
export function migrateDefaultKinds(kinds: readonly NotificationKind[], fromVersion: number): NotificationKind[] {
	let current = [...kinds];
	for (let version = Math.max(0, fromVersion); version < NOTIFICATION_DEFAULTS_VERSION; version += 1) {
		const before = DEFAULT_KINDS_BY_VERSION[version] ?? [];
		const after = DEFAULT_KINDS_BY_VERSION[version + 1] ?? [];
		const keptDefaults = current.length === before.length && before.every((kind) => current.includes(kind));
		if (keptDefaults) current = NOTIFICATION_KINDS.filter((kind) => after.includes(kind));
	}
	return current;
}

/** A kind that reports something going wrong. Quiet hours may still let these through. */
export function isNotificationFailure(kind: NotificationKind | "test"): boolean {
	return (NOTIFICATION_FAILURE_KINDS as readonly string[]).includes(kind);
}

/**
 * Where the app's routes keep a payload: `/b/<backend>/projects/<project>`, then the task's sheet over main's chat
 * (`?task=`), the worker, the background thread's card in main, or the schedule.
 */
export type NotificationTarget = Pick<NotificationPayload, "backendKey" | "projectId" | "workerId" | "scheduleId"> &
	Partial<Pick<NotificationPayload, "threadId" | "taskId" | "coordinatorId" | "entryId" | "answerId" | "kind">>;

/** The link a notification opens. A payload without a project (a deploy problem) opens the app's home page. */
export function notificationUrl(target: NotificationTarget): string {
	const projectId = target.projectId;
	if (projectId === null) return "/";
	const project = `/b/${encodeURIComponent(target.backendKey)}/projects/${encodeURIComponent(projectId)}`;
	if (target.kind === "reply" && target.answerId !== undefined && /^A[1-9]\d*$/.test(target.answerId)) {
		return `${project}?answer=${encodeURIComponent(target.answerId)}`;
	}
	if (target.coordinatorId != null) {
		const chat = target.coordinatorId === MAIN_THREAD_ID ? project : `${project}/threads/${encodeURIComponent(target.coordinatorId)}`;
		const task = target.taskId == null ? "" : `?task=${encodeURIComponent(target.taskId)}`;
		const reply = target.entryId == null ? "" : `#entry-${target.entryId}`;
		return `${chat}${task}${reply}`;
	}
	const taskId = target.taskId ?? null;
	if (taskId !== null) return `${project}?task=${encodeURIComponent(taskId)}`;
	const threadId = target.threadId ?? null;
	const background = threadId !== null && threadId !== MAIN_THREAD_ID;
	if (target.workerId !== null) {
		const worker = `workers/${encodeURIComponent(target.workerId)}`;
		return background ? `${project}/threads/${encodeURIComponent(threadId)}/${worker}` : `${project}/${worker}`;
	}
	// A thread's news opens main, where its card is: the user talks to main, not to the thread.
	if (background) return `${project}#${threadAnchor(threadId)}`;
	if (target.scheduleId !== null) return `${project}/settings#${scheduleAnchor(target.scheduleId)}`;
	return project;
}

/** The hash that makes main's transcript scroll to a background thread's newest card and highlight it. */
export function threadAnchor(threadId: string): string {
	return `thread-${threadId}`;
}

/** The thread a hash names, or undefined when the hash is something else. */
export function threadFromAnchor(hash: string): string | undefined {
	const anchor = hash.startsWith("#") ? hash.slice(1) : hash;
	if (!anchor.startsWith("thread-")) return undefined;
	let threadId: string;
	try {
		threadId = decodeURIComponent(anchor.slice("thread-".length));
	} catch {
		return undefined;
	}
	return threadId.length === 0 ? undefined : threadId;
}

/** The id a schedule's card carries in project settings, so a notification can land on it. */
export function scheduleAnchor(scheduleId: string): string {
	return `schedule-${scheduleId}`;
}

/**
 * A push message as the payload the service worker draws, or null when the push carries something else. Push data is
 * remote input, so every field the notification uses is checked; a payload without a title is not shown.
 */
export function parseNotificationPayload(raw: string | null | undefined): NotificationPayload | null {
	if (raw === null || raw === undefined) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	if (typeof parsed !== "object" || parsed === null) return null;
	const record = parsed as Record<string, unknown>;
	const kind = record.kind;
	const knownKind =
		kind === "test" || (typeof kind === "string" && (NOTIFICATION_KINDS as readonly string[]).includes(kind));
	if (!knownKind) return null;
	if (typeof record.title !== "string" || record.title.length === 0) return null;
	if (typeof record.body !== "string") return null;
	if (typeof record.backendKey !== "string" || record.backendKey.length === 0) return null;
	if (typeof record.tag !== "string" || record.tag.length === 0) return null;
	const projectId = record.projectId;
	const workerId = record.workerId;
	const scheduleId = record.scheduleId;
	if (!nullableString(projectId) || !nullableString(workerId) || !nullableString(scheduleId)) return null;
	const coordinatorId = record.coordinatorId;
	if (coordinatorId !== undefined && (typeof coordinatorId !== "string" || coordinatorId.length === 0)) return null;
	const entryId = record.entryId;
	if (entryId !== undefined && (typeof entryId !== "number" || !Number.isSafeInteger(entryId) || entryId <= 0)) return null;
	const threadId = record.threadId;
	if (threadId !== undefined && !nullableString(threadId)) return null;
	const taskId = record.taskId;
	if (taskId !== undefined && !nullableString(taskId)) return null;
	return {
		kind: kind as NotificationPayload["kind"],
		title: record.title,
		body: record.body,
		backendKey: record.backendKey,
		projectId,
		workerId,
		scheduleId,
		...(coordinatorId === undefined ? {} : { coordinatorId }),
		...(entryId === undefined ? {} : { entryId }),
		...(threadId === undefined ? {} : { threadId }),
		...(taskId === undefined ? {} : { taskId }),
		tag: record.tag,
		at: typeof record.at === "string" ? record.at : new Date().toISOString(),
	};
}

function nullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

/** Whether a notification should replace the last one with the same tag and buzz again. */
export function notificationRenotify(kind: NotificationKind | "test"): boolean {
	return isNotificationFailure(kind);
}

/**
 * A base64url VAPID public key as the bytes `pushManager.subscribe` wants. Throws on a key that is not base64url, so a
 * backend that answers nonsense is reported instead of subscribed with garbage.
 */
export function applicationServerKey(publicKey: string): Uint8Array<ArrayBuffer> {
	const trimmed = publicKey.trim();
	if (!/^[A-Za-z0-9_-]+={0,2}$/.test(trimmed)) throw new Error("The backend's notification key is not base64url.");
	const base64 = trimmed.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	let binary: string;
	try {
		binary = atob(padded);
	} catch {
		throw new Error("The backend's notification key is not valid base64.");
	}
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	if (bytes.length !== 65 || bytes[0] !== 4) {
		throw new Error("The backend's notification key is not a P-256 public key.");
	}
	return bytes;
}

/** Two base64url keys for the same point, without padding differences. */
export function samePublicKey(left: string, right: string): boolean {
	return left.trim().replace(/=+$/, "") === right.trim().replace(/=+$/, "");
}

/**
 * The subscription's own key (`getKey("p256dh")` is the endpoint's key, not VAPID's), so the comparison above uses the
 * key the subscription was made with: `PushSubscription.options.applicationServerKey`.
 */
export function subscriptionServerKey(subscription: Pick<PushSubscription, "options">): string | undefined {
	const key = subscription.options?.applicationServerKey;
	if (key === null || key === undefined) return undefined;
	const bytes =
		key instanceof ArrayBuffer
			? new Uint8Array(key)
			: new Uint8Array((key as ArrayBufferView).buffer, (key as ArrayBufferView).byteOffset, (key as ArrayBufferView).byteLength);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A name for this browser in a notification's device list: "Pixel 8 · Chrome", "Mac · Safari". */
export function deviceLabelFromUserAgent(userAgent: string): string {
	return `${deviceNameFromUserAgent(userAgent)} · ${browserNameFromUserAgent(userAgent)}`;
}

export function deviceNameFromUserAgent(userAgent: string): string {
	if (/iPhone/.test(userAgent)) return "iPhone";
	if (/iPad/.test(userAgent)) return "iPad";
	if (/iPod/.test(userAgent)) return "iPod";
	const android = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build[/;]|\))/i.exec(userAgent);
	if (android !== null) {
		const model = (android[1] ?? "").replace(/\s*wv$/, "").trim();
		// Chrome's reduced user agent sends "K" instead of the model.
		if (model.length > 0 && model !== "K" && !/^Android$/.test(model)) return model;
		return "Android";
	}
	if (/Windows/.test(userAgent)) return "Windows";
	if (/Macintosh|Mac OS X/.test(userAgent)) return "Mac";
	if (/CrOS/.test(userAgent)) return "Chromebook";
	if (/Linux/.test(userAgent)) return "Linux";
	return "Device";
}

export function browserNameFromUserAgent(userAgent: string): string {
	if (/Edg[A-Z]?\//.test(userAgent)) return "Edge";
	if (/OPR\/|Opera/.test(userAgent)) return "Opera";
	if (/SamsungBrowser\//.test(userAgent)) return "Samsung Internet";
	if (/Firefox\/|FxiOS\//.test(userAgent)) return "Firefox";
	if (/CriOS\/|Chrome\//.test(userAgent)) return "Chrome";
	if (/Safari\//.test(userAgent)) return "Safari";
	return "Browser";
}

/** This device's own name, from the browser's user agent. */
export function deviceLabel(): string {
	return deviceLabelFromUserAgent(typeof navigator === "undefined" ? "" : navigator.userAgent);
}

/** Where a browser keeps the device identity it made up; it must survive reloads, not reinstalls. */
export const NOTIFICATION_DEVICE_STORAGE_KEY = "aiki.notification-device.v1";

/** Where this browser keeps what it wants to be told about, per device. */
export const NOTIFICATION_SETTINGS_STORAGE_KEY = "aiki.notifications.v1"; // gitleaks:allow -- localStorage namespace, not a credential

/** A time of day a device may be quiet at, in its own timezone. Same shape as the protocol's non-null quiet hours. */
export type QuietHours = {
	start: string;
	end: string;
	timezone: string;
	allowFailures: boolean;
};

/** What this browser (one device) wants, kept in localStorage and pushed to every backend it registers with. */
export type DeviceNotificationSettings = {
	deviceId: string;
	/** The kinds this device wants, from any backend. */
	kinds: NotificationKind[];
	/** Which defaults the kinds were last brought up to; see `migrateDefaultKinds`. */
	defaultsVersion: number;
	quietHours: QuietHours | null;
	/** Muted project IDs, by backend key: a project ID only means something to the backend that made it. */
	mutedProjects: Record<string, string[]>;
	/** Timed project mutes, by the backend that owns the project. */
	projectMutes?: Record<string, NotificationProjectMute[]>;
	/** Mutes scoped to one backend on this browser, even if it has no push subscription. */
	backendMutes?: Record<string, NotificationMute>;
};

type DeviceMutes = Pick<DeviceNotificationSettings, "mutedProjects" | "projectMutes" | "backendMutes">;

function objectRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readOwn<T>(record: Record<string, T> | undefined, key: string): T | undefined {
	return record && Object.hasOwn(record, key) ? record[key] : undefined;
}

function normalizedDeviceMutes(raw: Partial<Record<keyof DeviceMutes, unknown>>, now: number): DeviceMutes {
	const projects = objectRecord(raw.mutedProjects);
	const timed = objectRecord(raw.projectMutes);
	const backends = objectRecord(raw.backendMutes);
	const entries = [...new Set([...Object.keys(projects), ...Object.keys(timed), ...Object.keys(backends)])]
		.filter(Boolean).map(key => [key, normalizeNotificationMutes({
			mutedProjects: readOwn(projects, key), projectMutes: readOwn(timed, key), backendMute: readOwn(backends, key),
		}, now)] as const);
	const mutedProjects = Object.fromEntries(entries.flatMap(([key, mutes]) => mutes.mutedProjects.length ? [[key, mutes.mutedProjects]] : []));
	const projectMutes = Object.fromEntries(entries.flatMap(([key, mutes]) => mutes.projectMutes ? [[key, mutes.projectMutes]] : []));
	const backendMutes = Object.fromEntries(entries.flatMap(([key, mutes]) => mutes.backendMute ? [[key, mutes.backendMute]] : []));
	return {
		mutedProjects,
		...(Object.keys(projectMutes).length ? { projectMutes } : {}),
		...(Object.keys(backendMutes).length ? { backendMutes } : {}),
	};
}

/** A device ID nobody else uses. `crypto.randomUUID` is available in browsers and Bun; the fallback covers old ones. */
export function newDeviceId(random: () => number = Math.random): string {
	const uuid = globalThis.crypto?.randomUUID?.();
	if (uuid !== undefined) return uuid;
	let tail = "";
	for (let index = 0; index < 24; index += 1) tail += Math.floor(random() * 16).toString(16);
	return `dev-${tail}`;
}

/** The browser's timezone, e.g. "Europe/Bucharest", or "UTC" where `Intl` gives none. */
export function deviceTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

export function defaultDeviceSettings(deviceId: string, timezone = deviceTimezone()): DeviceNotificationSettings {
	return {
		deviceId,
		kinds: [...DEFAULT_NOTIFICATION_KINDS],
		defaultsVersion: NOTIFICATION_DEFAULTS_VERSION,
		quietHours: null,
		mutedProjects: {},
	};
}

function isTimeOfDay(value: unknown): value is string {
	return typeof value === "string" && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value);
}

function stringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const items = value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
	return items;
}

/** Read stored settings, filling in what is missing. Never throws on a damaged store; only the valid parts survive. */
export function parseDeviceSettings(raw: string | null, deviceId: string, timezone = deviceTimezone(), now = Date.now()): DeviceNotificationSettings {
	const fallback = defaultDeviceSettings(deviceId, timezone);
	if (raw === null) return fallback;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return fallback;
	}
	if (typeof parsed !== "object" || parsed === null) return fallback;
	const record = parsed as Record<string, unknown>;
	const storedKinds = stringArray(record.kinds);
	const kinds =
		storedKinds === undefined ? undefined : NOTIFICATION_KINDS.filter((kind) => storedKinds.includes(kind));
	const quiet = record.quietHours;
	let quietHours: QuietHours | null = null;
	if (typeof quiet === "object" && quiet !== null) {
		const value = quiet as Record<string, unknown>;
		if (isTimeOfDay(value.start) && isTimeOfDay(value.end) && typeof value.timezone === "string" && value.timezone.length > 0) {
			quietHours = {
				start: value.start,
				end: value.end,
				timezone: value.timezone,
				allowFailures: value.allowFailures === true,
			};
		}
	}

	const storedDeviceId = typeof record.deviceId === "string" && record.deviceId.length > 0 ? record.deviceId : deviceId;
	const storedVersion =
		typeof record.defaultsVersion === "number" && Number.isInteger(record.defaultsVersion) && record.defaultsVersion >= 0
			? record.defaultsVersion
			: 0;
	return {
		deviceId: storedDeviceId,
		kinds:
			kinds === undefined
				? fallback.kinds
				: storedVersion >= NOTIFICATION_DEFAULTS_VERSION
					? kinds
					: migrateDefaultKinds(kinds, storedVersion),
		defaultsVersion: NOTIFICATION_DEFAULTS_VERSION,
		quietHours,
		...normalizedDeviceMutes(record, now),
	};
}

type ReadStorage = Pick<Storage, "getItem"> | undefined;
type WriteStorage = Pick<Storage, "setItem"> | undefined;
/** localStorage, or whatever a test passes: read and written together, so the two keys stay in one place. */
type DeviceStorage = Pick<Storage, "getItem" | "setItem"> | undefined;

/** This browser's notification settings, making up a device ID the first time. */
export function loadDeviceSettings(storage: DeviceStorage = browserStorage(), timezone = deviceTimezone()): DeviceNotificationSettings {
	const storedDeviceId = deviceIdFromStorage(storage);
	const settings = parseDeviceSettings(
		readStorage(storage, NOTIFICATION_SETTINGS_STORAGE_KEY),
		storedDeviceId.length > 0 ? storedDeviceId : newDeviceId(),
		timezone,
	);
	if (storedDeviceId !== settings.deviceId) {
		// The first visit writes the device ID down, so the next one is the same device.
		writeStorage(storage, NOTIFICATION_DEVICE_STORAGE_KEY, settings.deviceId);
	}
	const stored = readStorage(storage, NOTIFICATION_SETTINGS_STORAGE_KEY);
	if (stored !== null && storedDefaultsVersion(stored) < NOTIFICATION_DEFAULTS_VERSION) {
		// Written once, so the next load is already current; the app registers the new kinds on its next connect.
		writeStorage(storage, NOTIFICATION_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
	}
	return settings;
}

function storedDefaultsVersion(raw: string): number {
	try {
		const version = (JSON.parse(raw) as { defaultsVersion?: unknown } | null)?.defaultsVersion;
		return typeof version === "number" && Number.isInteger(version) && version >= 0 ? version : 0;
	} catch {
		return 0;
	}
}

export function saveDeviceSettings(
	settings: DeviceNotificationSettings,
	storage: DeviceStorage = browserStorage(),
): void {
	const { mutedProjects, projectMutes, backendMutes, ...rest } = settings;
	const mutes = normalizedDeviceMutes({ mutedProjects, projectMutes, backendMutes }, Date.now());
	writeStorage(storage, NOTIFICATION_SETTINGS_STORAGE_KEY, JSON.stringify({ ...rest, ...mutes }));
	writeStorage(storage, NOTIFICATION_DEVICE_STORAGE_KEY, settings.deviceId);
}

/** The device ID this browser already made up, or an empty string. */
export function deviceIdFromStorage(storage: ReadStorage = browserStorage()): string {
	return readStorage(storage, NOTIFICATION_DEVICE_STORAGE_KEY)?.trim() ?? "";
}

/** The preferences this device registers with one backend: the shared kinds and quiet hours, that backend's mutes. */
export function preferencesForBackend(
	settings: DeviceNotificationSettings,
	backendKey: string,
	supportsInAppAlerts = true,
	supportsTaskStepAlerts = true,
	options: { supportsTimedMutes?: boolean; now?: number } = {},
): NotificationPreferences {
	const { mutedProjects, projectMutes, backendMute } = mutesForBackend(settings, backendKey, options.now ?? Date.now());
	return {
		kinds: settings.kinds.filter(kind =>
			(supportsInAppAlerts || kind !== "coordinator_failed") && (supportsTaskStepAlerts || kind !== "task_steps")),
		mutedProjects,
		...(options.supportsTimedMutes === false ? {} : {
			...(projectMutes ? { projectMutes } : {}),
			...(backendMute ? { backendMute } : {}),
		}),
		quietHours: settings.quietHours === null ? null : { ...settings.quietHours },
	};
}

/** Turn one kind on or off, keeping the protocol's order. */
export function withKind(kinds: readonly NotificationKind[], kind: NotificationKind, on: boolean): NotificationKind[] {
	const next = new Set(kinds);
	if (on) next.add(kind);
	else next.delete(kind);
	return NOTIFICATION_KINDS.filter((entry) => next.has(entry));
}

/** Whether this device currently wants a kind, failures included unless the user turned them off. */
export function wantsKind(kinds: readonly NotificationKind[], kind: NotificationKind): boolean {
	return kinds.includes(kind);
}

function mutesForBackend(settings: DeviceMutes, backendKey: string, now: number): NotificationMutes {
	return normalizeNotificationMutes({
		mutedProjects: readOwn(settings.mutedProjects, backendKey),
		projectMutes: readOwn(settings.projectMutes, backendKey),
		backendMute: readOwn(settings.backendMutes, backendKey),
	}, now);
}

function replaceMuteEntry<T>(record: Record<string, T> | undefined, key: string, value: T | undefined): Record<string, T> {
	if (value !== undefined) return { ...record, [key]: value };
	const next = { ...record };
	delete next[key];
	return next;
}

function replaceMutesForBackend(settings: DeviceNotificationSettings, backendKey: string, mutes: NotificationMutes): DeviceNotificationSettings {
	const { mutedProjects, projectMutes, backendMutes, ...rest } = settings;
	const nextProjectMutes = replaceMuteEntry(projectMutes, backendKey, mutes.projectMutes);
	const nextBackendMutes = replaceMuteEntry(backendMutes, backendKey, mutes.backendMute);
	return {
		...rest,
		mutedProjects: replaceMuteEntry(mutedProjects, backendKey, mutes.mutedProjects.length ? mutes.mutedProjects : undefined),
		...(Object.keys(nextProjectMutes).length ? { projectMutes: nextProjectMutes } : {}),
		...(Object.keys(nextBackendMutes).length ? { backendMutes: nextBackendMutes } : {}),
	};
}

/** Set one project's mute. A missing deadline is untimed and null clears either kind. */
export function withProjectMute(
	settings: DeviceNotificationSettings, backendKey: string, projectId: string, mute: NotificationMute | null, now = Date.now(),
): DeviceNotificationSettings {
	const current = mutesForBackend(settings, backendKey, now);
	const projectMutes = (current.projectMutes ?? []).filter(entry => entry.projectId !== projectId);
	if (mute !== null) projectMutes.push({ projectId, ...mute });
	return replaceMutesForBackend(settings, backendKey, normalizeNotificationMutes({
		...current, mutedProjects: current.mutedProjects.filter(id => id !== projectId), projectMutes,
	}, now));
}

/** Preserve the existing indefinite project toggle, including clearing a timed mute. */
export function withMutedProject(
	settings: DeviceNotificationSettings, backendKey: string, projectId: string, muted: boolean,
): DeviceNotificationSettings {
	return withProjectMute(settings, backendKey, projectId, muted ? {} : null);
}

/** Set or clear this device's mute for all alerts from one backend. */
export function withBackendMute(
	settings: DeviceNotificationSettings, backendKey: string, mute: NotificationMute | null, now = Date.now(),
): DeviceNotificationSettings {
	return replaceMutesForBackend(settings, backendKey, normalizeNotificationMutes({
		...mutesForBackend(settings, backendKey, now), backendMute: mute,
	}, now));
}

export function isProjectMuted(settings: DeviceMutes, backendKey: string, projectId: string, now = Date.now()): boolean {
	return (readOwn(settings.mutedProjects, backendKey) ?? []).includes(projectId) ||
		(readOwn(settings.projectMutes, backendKey) ?? []).some(mute => mute.projectId === projectId && notificationMuteActive(mute, now));
}

export function isBackendMuted(settings: DeviceMutes, backendKey: string, now = Date.now()): boolean {
	return notificationMuteActive(readOwn(settings.backendMutes, backendKey), now);
}

/** Local active project mutes, including the deadline if timed. */
export function mutedProjectEntries(settings: DeviceMutes, now = Date.now()): (NotificationProjectMute & { backendKey: string })[] {
	return [...new Set([...Object.keys(settings.mutedProjects), ...Object.keys(settings.projectMutes ?? {})])].flatMap(backendKey => {
		const { mutedProjects, projectMutes } = mutesForBackend(settings, backendKey, now);
		return [...mutedProjects.map(projectId => ({ backendKey, projectId })), ...(projectMutes ?? []).map(mute => ({ backendKey, ...mute }))];
	});
}

/** Local active backend mutes for the settings list. */
export function mutedBackendEntries(settings: DeviceMutes, now = Date.now()): (NotificationMute & { backendKey: string })[] {
	return Object.entries(settings.backendMutes ?? {}).flatMap(([backendKey, mute]) =>
		notificationMuteActive(mute, now) ? [{ backendKey, ...mute }] : []);
}

const timeFormatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
	const cached = timeFormatters.get(timezone);
	if (cached !== undefined) return cached;
	const formatter = new Intl.DateTimeFormat("en-GB", {
		timeZone: timezone,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	timeFormatters.set(timezone, formatter);
	return formatter;
}

/** "HH:MM" as an `Intl` clock in `timezone` reads `at`; the device's own clock when the zone is unknown. */
export function timeOfDayIn(timezone: string, at: Date): string {
	let formatter: Intl.DateTimeFormat;
	try {
		formatter = formatterFor(timezone);
	} catch {
		formatter = formatterFor(deviceTimezone());
	}
	const parts = formatter.formatToParts(at);
	const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
	const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
	// Some engines still answer "24" at midnight.
	return `${hour === "24" ? "00" : hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

/**
 * Whether quiet hours cover `at` right now. A window whose end is before its start crosses midnight; equal ends mean no
 * quiet hours at all (rather than every hour of the day). Failures pass through when `allowFailures` is on.
 */
export function quietHoursActive(
	quietHours: QuietHours | null,
	at: Date,
	kind?: NotificationKind | "test",
): boolean {
	if (quietHours === null || quietHours.start === quietHours.end) return false;
	if (kind !== undefined && quietHours.allowFailures && isNotificationFailure(kind)) return false;
	const now = timeOfDayIn(quietHours.timezone, at);
	if (quietHours.start < quietHours.end) return now >= quietHours.start && now < quietHours.end;
	return now >= quietHours.start || now < quietHours.end;
}

/** "22:00–07:00 (Europe/Bucharest)", for a status line. */
export function quietHoursSummary(quietHours: QuietHours): string {
	return `${quietHours.start}–${quietHours.end} (${quietHours.timezone})`;
}

function readStorage(storage: ReadStorage, key: string): string | null {
	if (storage === undefined) return null;
	try {
		return storage.getItem(key);
	} catch {
		return null;
	}
}

function writeStorage(storage: WriteStorage, key: string, value: string): void {
	if (storage === undefined) return;
	try {
		storage.setItem(key, value);
	} catch {
		// Storage can be full or disabled; the app keeps working for this session.
	}
}

function browserStorage(): Storage | undefined {
	// Not `window`: the app's service worker imports this module and has no `window` (but no storage of its own either).
	try {
		return (globalThis as { localStorage?: Storage }).localStorage;
	} catch {
		return undefined;
	}
}
