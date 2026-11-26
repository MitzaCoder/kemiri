/**
 * Notifications: Web Push to the user's devices.
 *
 * Every backend signs with the same VAPID key pair, because a browser holds one push subscription. A device (one browser
 * profile, identified by a client-chosen `deviceId`) subscribes once and registers that subscription with each backend it
 * is connected to, with its preferences. Each backend then pushes its own events to the device directly. Payloads are
 * encrypted end to end (RFC 8291), so the push service cannot read them.
 *
 * An Android app registers a Firebase Cloud Messaging token instead (`notifications.registerFcm`, feature `fcm-push`): the
 * backend sends the same payload as FCM data through the HTTP v1 API, with a service-account key of the app's Firebase
 * project. Kinds, quiet hours, mutes, presence and dedupe are the same for both transports.
 *
 * An open app holds its notifications: each connection reports whether its page is visible (`notifications.presence`),
 * and while any connection on a backend is visible, that backend holds an event for 15 s before pushing it. Interaction
 * (`notifications.interaction`, feature `notification-hold`) drops held events for the project visible on that
 * connection. Events for other projects or without a project still go out after the hold. No visible connection, no
 * hold: the push goes out at once.
 */
import { type Static, Type } from "typebox";
import { AnswerIdSchema } from "./answers.ts";
import { ProjectIdSchema, RequestIdSchema } from "./common.ts";

export const NotificationKindSchema = Type.Union(
	[
		Type.Literal("reply"),
		Type.Literal("worker_report"),
		Type.Literal("worker_failed"),
		Type.Literal("schedule_done"),
		Type.Literal("schedule_problem"),
		Type.Literal("deploy_problem"),
		Type.Literal("login_prompt"),
		Type.Literal("usage_limit_reached"),
		Type.Literal("usage_drain_warning"),
		Type.Literal("usage_drain_paused"),
		Type.Literal("compaction_failed"),
		Type.Literal("maintenance_failed"),
		Type.Literal("board_question"),
		Type.Literal("thread_finished"),
		Type.Literal("thread_failed"),
		Type.Literal("coordinator_failed"),
		Type.Literal("work_finished"),
		Type.Literal("disk_low"),
		Type.Literal("task_review"),
		Type.Literal("task_steps"),
		Type.Literal("later_back"),
	],
	{
		description:
			"reply: the coordinator finished an answer. worker_report / worker_failed: a worker reported or failed. schedule_done: a scheduled run finished; schedule_problem: one failed or was skipped. deploy_problem: a backend or project deploy failed or rolled back. login_prompt: a provider login waits for an answer. usage_limit_reached: a subscription reached its limit and work is waiting. compaction_failed, maintenance_failed: background work failed. board_question: a thread asked the user a question on the board. thread_finished / thread_failed: a background thread finished or failed. coordinator_failed: a coordinator turn failed. work_finished: a project went quiet (nothing running) after a stretch of work; replaces per-reply and per-report noise during long runs. disk_low: a backend\'s disk is running low. task_review: a task is ready for review. task_steps: a task has new manual steps for the owner. later_back: postponed attention returned, grouped by project.",
	},
);
export type NotificationKind = Static<typeof NotificationKindSchema>;
/** Kinds exposed by the shared device presets. Later is opt-in on the wire until its clients ship. */
export const NOTIFICATION_KINDS: readonly NotificationKind[] = NotificationKindSchema.anyOf.map(kind => kind.const).filter(kind => kind !== "later_back");

/** The kinds that count as failures, which quiet hours may still let through. */
export const NOTIFICATION_FAILURE_KINDS: readonly NotificationKind[] = [
	"worker_failed",
	"schedule_problem",
	"deploy_problem",
	"compaction_failed",
	"maintenance_failed",
	"thread_failed",
	"coordinator_failed",
	"disk_low",
];

/** What a new device starts with. */
export const DEFAULT_NOTIFICATION_KINDS: readonly NotificationKind[] = [
	"reply",
	"worker_failed",
	"schedule_problem",
	"deploy_problem",
	"login_prompt",
	"usage_limit_reached",
	"usage_drain_warning",
	"usage_drain_paused",
	"board_question",
	"thread_finished",
	"thread_failed",
	"coordinator_failed",
	"work_finished",
	"disk_low",
	"task_review",
	"task_steps",
];

/** Device presets are exact sets, shared across clients. */
export const NOTIFICATION_PRESETS = {
	important: DEFAULT_NOTIFICATION_KINDS,
	needed: ["login_prompt", "board_question", "task_review", "task_steps", ...NOTIFICATION_FAILURE_KINDS],
	everything: NOTIFICATION_KINDS,
} satisfies Record<string, readonly NotificationKind[]>;

const TimeOfDay = Type.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9]$", description: '"HH:MM", 24-hour.' });

// Stay within the range Date can display. The same absolute time works across client and server timezones.
const MAX_MUTE_TIME_MS = 8_640_000_000_000_000;
const MuteEndTime = Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_MUTE_TIME_MS,
	description: "Expiry as Unix milliseconds; omitted means muted until turned back on.",
}));

export const NotificationMuteSchema = Type.Object({ until: MuteEndTime });
export type NotificationMute = Static<typeof NotificationMuteSchema>;

export const NotificationProjectMuteSchema = Type.Object({ projectId: ProjectIdSchema, until: MuteEndTime });
export type NotificationProjectMute = Static<typeof NotificationProjectMuteSchema>;

export const NotificationPreferencesSchema = Type.Object({
	kinds: Type.Array(NotificationKindSchema, { description: "The kinds this device wants." }),
	mutedProjects: Type.Array(ProjectIdSchema, { description: "Projects muted until turned back on (legacy entry format)." }),
	quietHours: Type.Union(
		[
			Type.Object({
				start: TimeOfDay,
				end: TimeOfDay,
				timezone: Type.String({ minLength: 1, description: "The device's IANA timezone." }),
				allowFailures: Type.Boolean({ description: "Failure kinds still come through during quiet hours." }),
			}),
			Type.Null(),
		],
		{ description: "From start to end (crossing midnight when end < start), nothing is pushed." },
	),
	projectMutes: Type.Optional(Type.Array(NotificationProjectMuteSchema)),
	backendMute: Type.Optional(NotificationMuteSchema),
	quietResolutions: Type.Optional(Type.Boolean({ description: "The device can handle a clear without showing a notification." })),
});
export type NotificationPreferences = Static<typeof NotificationPreferencesSchema>;

export type NotificationMutes = Pick<NotificationPreferences, "mutedProjects" | "projectMutes" | "backendMute">;

function muteRecord(raw: unknown): Record<string, unknown> | undefined {
	return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
}

function validMuteEnd(until: unknown): until is number {
	return typeof until === "number" && Number.isSafeInteger(until) && until > 0 && until <= MAX_MUTE_TIME_MS;
}

/** Tolerate old and malformed stored fields. Never turn an invalid or expired deadline into a permanent mute. */
export function normalizeNotificationMutes(raw: Partial<Record<keyof NotificationMutes, unknown>>, now: number): NotificationMutes {
	const mutedProjects = new Set<string>();
	const timed = new Map<string, number>();
	if (Array.isArray(raw.mutedProjects)) {
		for (const id of raw.mutedProjects) if (typeof id === "string" && id.length) mutedProjects.add(id);
	}
	if (Array.isArray(raw.projectMutes)) {
		for (const entry of raw.projectMutes) {
			const mute = muteRecord(entry);
			if (typeof mute?.projectId !== "string" || !mute.projectId.length) continue;
			if (mute.until === undefined) mutedProjects.add(mute.projectId);
			else if (validMuteEnd(mute.until) && mute.until > now && mute.until > (timed.get(mute.projectId) ?? 0)) timed.set(mute.projectId, mute.until);
		}
	}
	const projectMutes = [...timed].flatMap(([projectId, until]) => mutedProjects.has(projectId) ? [] : [{ projectId, until }]);
	const backend = muteRecord(raw.backendMute);
	const until = backend?.until;
	const backendMute = !backend ? undefined : until === undefined ? {} : validMuteEnd(until) && until > now ? { until } : undefined;
	return {
		mutedProjects: [...mutedProjects],
		...(projectMutes.length ? { projectMutes } : {}),
		...(backendMute ? { backendMute } : {}),
	};
}

/** Test expiry at send/display time. Normalization is only needed when reading or replacing preferences. */
export function notificationMuteActive(mute: NotificationMute | undefined, now: number): boolean {
	return mute !== undefined && (mute.until === undefined || (validMuteEnd(mute.until) && mute.until > now));
}

/** Remove expired optional entries from already normalized preferences, preserving identity if nothing expired. */
export function pruneExpiredNotificationMutes(preferences: NotificationPreferences, now: number): NotificationPreferences {
	const projectExpired = preferences.projectMutes?.some(mute => !notificationMuteActive(mute, now));
	const backendExpired = preferences.backendMute !== undefined && !notificationMuteActive(preferences.backendMute, now);
	if (!projectExpired && !backendExpired) return preferences;
	const pruned = { ...preferences };
	if (projectExpired) {
		const active = preferences.projectMutes!.filter(mute => notificationMuteActive(mute, now));
		if (active.length) pruned.projectMutes = active;
		else delete pruned.projectMutes;
	}
	if (backendExpired) delete pruned.backendMute;
	return pruned;
}

/** A browser `PushSubscription` as `toJSON()` gives it. */
export const PushSubscriptionSchema = Type.Object({
	endpoint: Type.String({ minLength: 1 }),
	expirationTime: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
	keys: Type.Object({ p256dh: Type.String({ minLength: 1 }), auth: Type.String({ minLength: 1 }) }),
});
export type PushSubscription = Static<typeof PushSubscriptionSchema>;

/** How a device is reached: a browser's Web Push subscription or an Android app's FCM token. */
export const NotificationTransportSchema = Type.Union([
	Type.Literal("web-push"), Type.Literal("fcm"), Type.Literal("fcm-relay"),
]);
export type NotificationTransport = Static<typeof NotificationTransportSchema>;

/** Safe relay status only; never capabilities, transcript material or keys. */
export const NotificationRelayStatusSchema = Type.Object({
	available: Type.Boolean(),
	state: Type.Union([
		Type.Literal("unregistered"), Type.Literal("pending"), Type.Literal("active"),
		Type.Literal("needs_new_keys"), Type.Literal("paused"), Type.Literal("revoked"),
	]),
	leaseExpiresAt: Type.Union([Type.Integer(), Type.Null()]),
	absoluteExpiresAt: Type.Union([Type.Integer(), Type.Null()]),
	cleanup: Type.Union([Type.Literal("pending"), Type.Literal("done")]),
	lastDelivery: Type.Union([Type.String(), Type.Null()]),
});
export type NotificationRelayStatus = Static<typeof NotificationRelayStatusSchema>;

export const NotificationDeviceSchema = Type.Object({
	deviceId: Type.String({ minLength: 1 }),
	label: Type.String({ description: 'For humans, e.g. "Pixel 8 · Chrome".' }),
	backendKey: Type.String({
		minLength: 1,
		description: "What the device calls this backend; echoed in payloads so the device can build links.",
	}),
	preferences: NotificationPreferencesSchema,
	createdAt: Type.String(),
	lastDelivery: Type.Union(
		[
			Type.Object({
				at: Type.String(),
				ok: Type.Boolean(),
				status: Type.Union([Type.Integer(), Type.Null()], { description: "The push service's HTTP status." }),
				message: Type.Union([Type.String(), Type.Null()]),
			}),
			Type.Null(),
		],
		{ description: "The last push attempt to this device." },
	),
	transport: Type.Optional(NotificationTransportSchema),
	relay: Type.Optional(NotificationRelayStatusSchema),
});
export type NotificationDevice = Static<typeof NotificationDeviceSchema>;

const NotificationQuestionSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	revision: Type.Integer({ minimum: 1 }),
	quickAnswerAllowed: Type.Boolean(),
	choices: Type.Optional(Type.Array(Type.Object({ label: Type.String(), recommended: Type.Boolean() }), { minItems: 1, maxItems: 3 })),
	warning: Type.Optional(Type.Boolean()),
	approval: Type.Optional(Type.Boolean()),
});

export const RESOLVED_PUSH_TTL_MS = 5 * 60 * 1000;
export const RESOLVED_PUSH_TARGET_LIMIT = 16;
const NotificationResolvedTargetSchema = Type.Object({
	tag: Type.String({ minLength: 1 }),
	at: Type.String({ minLength: 1 }),
	key: Type.Optional(Type.String()),
	sharedLimitKey: Type.Optional(Type.String()),
});
export type NotificationResolvedTarget = Static<typeof NotificationResolvedTargetSchema>;

/** What the service worker receives, as JSON, in the push message. */
export const NotificationPayloadSchema = Type.Object({
	kind: Type.Union([NotificationKindSchema, Type.Literal("test"), Type.Literal("resolved")]),
	title: Type.String(),
	body: Type.String(),
	backendKey: Type.String(),
	projectId: Type.Union([ProjectIdSchema, Type.Null()]),
	workerId: Type.Union([Type.String(), Type.Null()]),
	scheduleId: Type.Union([Type.String(), Type.Null()]),
	coordinatorId: Type.Optional(Type.String({ description: "Open this coordinator's chat; main opens the project chat." })),
	entryId: Type.Optional(Type.Integer({ minimum: 1, description: "Reply entry in the destination chat." })),
	threadId: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "The background thread it is about; the app opens main and highlights its card." })),
	artifactId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	taskId: Type.Optional(
		Type.Union([Type.String(), Type.Null()], { description: "The board task it is about; the app opens that task." }),
	),
	tag: Type.String({ description: "Notifications with the same tag replace each other." }),
	at: Type.String(),
	answerId: Type.Optional(AnswerIdSchema),
	projectName: Type.Optional(Type.String()),
	computerName: Type.Optional(Type.String()),
	coordinatorName: Type.Optional(Type.String()),
	message: Type.Optional(Type.String({ description: "Long plain-text preview. Older clients use body." })),
	taskTitle: Type.Optional(Type.String()),
	proofArtifactId: Type.Optional(Type.String({ maxLength: 128, description: "Versioned proof image ID for a review, not a URL." })),
	taskRevision: Type.Optional(Type.Integer({ minimum: 1 })),
	key: Type.Optional(Type.String({ description: "This event, rather than the tag it replaces." })),
	level: Type.Optional(Type.Union([Type.Literal("urgent"), Type.Literal("important"), Type.Literal("info"), Type.Literal("inbox")])),
	question: Type.Optional(NotificationQuestionSchema),
	expiresAt: Type.Optional(Type.String({ description: "ISO 8601 deadline when the event has a known expiry." })),
	sharedLimitKey: Type.Optional(Type.String({ description: "Opaque identity for one kind of notice about the same verified subscription window." })),
	resolved: Type.Optional(Type.Array(NotificationResolvedTargetSchema, { minItems: 1, maxItems: RESOLVED_PUSH_TARGET_LIMIT })),
});
export type NotificationPayload = Static<typeof NotificationPayloadSchema>;

// --- requests ----------------------------------------------------------------------------------------------------

/** The VAPID public key (base64url) this backend signs with; every backend should answer the same key. */
export const NotificationsConfigRequestSchema = Type.Object({
	type: Type.Literal("notifications.config"),
	id: RequestIdSchema,
});
export type NotificationsConfigRequest = Static<typeof NotificationsConfigRequestSchema>;

/** Register or update this device: its subscription, what it calls this backend, and its preferences. */
export const NotificationsRegisterRequestSchema = Type.Object({
	type: Type.Literal("notifications.register"),
	id: RequestIdSchema,
	deviceId: Type.String({ minLength: 1 }),
	label: Type.String(),
	backendKey: Type.String({ minLength: 1 }),
	subscription: PushSubscriptionSchema,
	preferences: NotificationPreferencesSchema,
});
export type NotificationsRegisterRequest = Static<typeof NotificationsRegisterRequestSchema>;

/**
 * Register or update this device as an Android app reached through Firebase Cloud Messaging (feature `fcm-push`). Same
 * as `notifications.register`, with the app's FCM registration token in place of a Web Push subscription; the app sends
 * it again whenever Firebase rotates the token.
 */
export const NotificationsRegisterFcmRequestSchema = Type.Object({
	type: Type.Literal("notifications.registerFcm"),
	id: RequestIdSchema,
	deviceId: Type.String({ minLength: 1 }),
	label: Type.String(),
	backendKey: Type.String({ minLength: 1 }),
	token: Type.String({ minLength: 1, maxLength: 4096, description: "The FCM registration token." }),
	preferences: NotificationPreferencesSchema,
});
export type NotificationsRegisterFcmRequest = Static<typeof NotificationsRegisterFcmRequestSchema>;

export const NotificationsUnregisterRequestSchema = Type.Object({
	type: Type.Literal("notifications.unregister"),
	id: RequestIdSchema,
	deviceId: Type.String({ minLength: 1 }),
});
export type NotificationsUnregisterRequest = Static<typeof NotificationsUnregisterRequestSchema>;

/** This device's registration on this backend, or null. */
export const NotificationsDeviceRequestSchema = Type.Object({
	type: Type.Literal("notifications.device"),
	id: RequestIdSchema,
	deviceId: Type.String({ minLength: 1 }),
});
export type NotificationsDeviceRequest = Static<typeof NotificationsDeviceRequestSchema>;

/** Push a test notification to this device now and say how the push service answered. */
export const NotificationsTestRequestSchema = Type.Object({
	type: Type.Literal("notifications.test"),
	id: RequestIdSchema,
	deviceId: Type.String({ minLength: 1 }),
});
export type NotificationsTestRequest = Static<typeof NotificationsTestRequestSchema>;

/**
 * Whether this connection's page is visible, and which project it shows on this backend (null on other backends or
 * outside a project). Sent on connect and on visibility or route changes; forgotten when the connection closes. Any
 * visible connection makes the backend hold notifications for 15 s. Its project scopes its own interactions when an
 * interaction report does not include a screen snapshot.
 */
export const NotificationsPresenceRequestSchema = Type.Object({
	type: Type.Literal("notifications.presence"),
	id: RequestIdSchema,
	deviceId: Type.String({ minLength: 1 }),
	visible: Type.Boolean(),
	projectId: Type.Union([ProjectIdSchema, Type.Null()]),
});
export type NotificationsPresenceRequest = Static<typeof NotificationsPresenceRequestSchema>;

/** How long a backend holds a notification while some connection is visible, unless interaction drops it. */
export const NOTIFICATION_HOLD_MS = 15_000;
/** The most often a client reports interaction to one backend while the user keeps interacting. */
export const INTERACTION_REPORT_INTERVAL_MS = 5_000;

/**
 * The user touched the app on this device (a pointer press, a key, a touch, the wheel, typing; not a mere mouse move).
 * Needs `notification-hold`. Drops held pushes for the visible project or for alerts already acknowledged as shown
 * (`notifications.shown`), for every device. The optional screen snapshot avoids acting on a stale presence update.
 * Clients send it at most once per `INTERACTION_REPORT_INTERVAL_MS` per backend (the first interaction at once, later
 * ones as one trailing message), and to every backend they are connected to: backends do not talk to each other.
 */
export const NotificationsInteractionRequestSchema = Type.Object({
	type: Type.Literal("notifications.interaction"),
	id: RequestIdSchema,
	deviceId: Type.String({ minLength: 1 }),
	readChat: Type.Optional(Type.Object({ projectId: ProjectIdSchema, coordinatorId: Type.String({ minLength: 1 }),
		through: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }) })),
	onScreenProjectId: Type.Optional(Type.Union([ProjectIdSchema, Type.Null()], {
		description: "Project visible on this backend when the report was sent. Null means none; omitted uses this connection's last presence.",
	})),
});
export type NotificationsInteractionRequest = Static<typeof NotificationsInteractionRequestSchema>;

// --- responses ---------------------------------------------------------------------------------------------------

export const NotificationsConfigResponseSchema = Type.Object({
	type: Type.Literal("notifications.config"),
	id: RequestIdSchema,
	publicKey: Type.String({ minLength: 1 }),
	relay: Type.Optional(NotificationRelayStatusSchema),
	fcm: Type.Optional(
		Type.Union([Type.Object({ projectId: Type.String({ minLength: 1 }) }), Type.Null()], {
			description:
				"The Firebase project this backend sends FCM through; null when it has no service-account key (FCM off). Absent on backends without fcm-push.",
		}),
	),
});
export type NotificationsConfigResponse = Static<typeof NotificationsConfigResponseSchema>;

export const NotificationsRegisterResponseSchema = Type.Object({
	type: Type.Literal("notifications.register"),
	id: RequestIdSchema,
	device: NotificationDeviceSchema,
});
export type NotificationsRegisterResponse = Static<typeof NotificationsRegisterResponseSchema>;

export const NotificationsRegisterFcmResponseSchema = Type.Object({
	type: Type.Literal("notifications.registerFcm"),
	id: RequestIdSchema,
	device: NotificationDeviceSchema,
});
export type NotificationsRegisterFcmResponse = Static<typeof NotificationsRegisterFcmResponseSchema>;

export const NotificationsUnregisterResponseSchema = Type.Object({
	type: Type.Literal("notifications.unregister"),
	id: RequestIdSchema,
	relay: Type.Optional(NotificationRelayStatusSchema),
});
export type NotificationsUnregisterResponse = Static<typeof NotificationsUnregisterResponseSchema>;

export const NotificationsDeviceResponseSchema = Type.Object({
	type: Type.Literal("notifications.device"),
	id: RequestIdSchema,
	device: Type.Union([NotificationDeviceSchema, Type.Null()]),
	relay: Type.Optional(NotificationRelayStatusSchema),
});
export type NotificationsDeviceResponse = Static<typeof NotificationsDeviceResponseSchema>;

export const NotificationsTestResponseSchema = Type.Object({
	type: Type.Literal("notifications.test"),
	id: RequestIdSchema,
	ok: Type.Boolean(),
	status: Type.Union([Type.Integer(), Type.Null()]),
	message: Type.Union([Type.String(), Type.Null()]),
});
export type NotificationsTestResponse = Static<typeof NotificationsTestResponseSchema>;

export const NotificationsPresenceResponseSchema = Type.Object({
	type: Type.Literal("notifications.presence"),
	id: RequestIdSchema,
});
export type NotificationsPresenceResponse = Static<typeof NotificationsPresenceResponseSchema>;

export const NotificationsInteractionResponseSchema = Type.Object({
	type: Type.Literal("notifications.interaction"),
	id: RequestIdSchema,
	dropped: Type.Integer({ minimum: 0, description: "How many held notifications were dropped because the project is visible here or an app already showed them." }),
});
export type NotificationsInteractionResponse = Static<typeof NotificationsInteractionResponseSchema>;

/** Server-assigned priority. The client decides whether a particular inbox item may also pop up or play sound. */
export const NotificationAlertLevelSchema = Type.Union([
	Type.Literal("urgent"), Type.Literal("important"), Type.Literal("info"), Type.Literal("inbox"),
]);
export type NotificationAlertLevel = Static<typeof NotificationAlertLevelSchema>;

const AlertSequence = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const RecentCursor = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const AlertEpoch = Type.String({ minLength: 1 });
const AlertTagList = Type.Array(Type.String({ minLength: 1 }), { maxItems: 200 });

export const NotificationAlertSchema = Type.Object({
	...NotificationPayloadSchema.properties,
	kind: NotificationKindSchema,
	backendKey: Type.String({ description: "The server's backend identity. For app links use the receiving client's configured backend key." }),
	seq: AlertSequence,
	key: Type.String({ minLength: 1 }),
	level: NotificationAlertLevelSchema,
	backendEpoch: AlertEpoch,
	taskRevision: Type.Optional(Type.Integer({ minimum: 1 })),
	questionId: Type.Optional(Type.String()),
	questionRevision: Type.Optional(Type.Integer({ minimum: 1 })),
	choices: Type.Optional(Type.Array(Type.Object({ label: Type.String(), recommended: Type.Boolean() }))),
	warning: Type.Optional(Type.Boolean()),
	approval: Type.Optional(Type.Boolean()),
});
export type NotificationAlert = Static<typeof NotificationAlertSchema>;

export const NotificationsAlertEventSchema = Type.Object({
	type: Type.Literal("notifications.alert"),
	alert: NotificationAlertSchema,
	sound: Type.Boolean({ description: "Whether the server picked this connection. The client still applies its level and sound settings." }),
});
export type NotificationsAlertEvent = Static<typeof NotificationsAlertEventSchema>;

const AlertResolution = {
	tags: AlertTagList,
	seq: AlertSequence,
	backendEpoch: AlertEpoch,
	at: Type.String(),
};
export const NotificationsResolvedEventSchema = Type.Object({
	type: Type.Literal("notifications.resolved"),
	...AlertResolution,
});
export type NotificationsResolvedEvent = Static<typeof NotificationsResolvedEventSchema>;

export const NotificationRecentEntrySchema = Type.Union([
	Type.Object({ type: Type.Literal("alert"), alert: NotificationAlertSchema, resolved: Type.Boolean() }),
	Type.Object({ type: Type.Literal("resolved"), ...AlertResolution }),
]);
export type NotificationRecentEntry = Static<typeof NotificationRecentEntrySchema>;

export const NotificationsRecentRequestSchema = Type.Object({
	type: Type.Literal("notifications.recent"),
	id: RequestIdSchema,
	after: RecentCursor,
});
export type NotificationsRecentRequest = Static<typeof NotificationsRecentRequestSchema>;

export const NotificationsRecentResponseSchema = Type.Object({
	type: Type.Literal("notifications.recent"),
	id: RequestIdSchema,
	backendEpoch: AlertEpoch,
	latestSeq: RecentCursor,
	events: Type.Array(NotificationRecentEntrySchema),
});
export type NotificationsRecentResponse = Static<typeof NotificationsRecentResponseSchema>;

/** Mark pop-ups that were actually displayed, not alerts read from the stream or inbox. This alone never drops a push. */
export const NotificationsShownRequestSchema = Type.Object({
	type: Type.Literal("notifications.shown"),
	id: RequestIdSchema,
	keys: AlertTagList,
});
export type NotificationsShownRequest = Static<typeof NotificationsShownRequestSchema>;

export const NotificationsShownResponseSchema = Type.Object({
	type: Type.Literal("notifications.shown"),
	id: RequestIdSchema,
});
export type NotificationsShownResponse = Static<typeof NotificationsShownResponseSchema>;
