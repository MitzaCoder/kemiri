/**
 * Artifacts: files a conversation keeps for the user, such as demo videos, screenshots, logs and reports.
 *
 * Any coordinator thread or worker saves one with its `artifact_save` tool, from a file in its working directory; the
 * backend copies it into the project's artifact store in its data directory, so it stays on that backend. Clients list
 * them per project, thread, worker or board task and fetch the bytes over HTTP: `artifacts.url` answers a URL with a
 * signed token valid for a few hours, which a `<video>` or `<img>` element can load directly, with byte ranges for
 * seeking. Publishing them anywhere else is up to the user's instructions.
 */
import { type Static, Type } from "typebox";
import { BoardFeedbackStateSchema, BoardTaskStatusSchema } from "./board.ts";
import { ProjectIdSchema, RequestIdSchema } from "./common.ts";

export const ArtifactKindSchema = Type.Union(
	[Type.Literal("video"), Type.Literal("image"), Type.Literal("audio"), Type.Literal("text"), Type.Literal("file")],
	{ description: "How the app shows it, from the MIME type: play, view, read, or download." },
);
export type ArtifactKind = Static<typeof ArtifactKindSchema>;

export const ArtifactVersionSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	projectId: ProjectIdSchema,
	name: Type.String({ minLength: 1, description: "File name, e.g. \"checkout-flow.webm\"." }),
	title: Type.Union([Type.String(), Type.Null()], { description: "What it shows, in a few words." }),
	note: Type.Union([Type.String(), Type.Null()], { description: "Longer description, Markdown." }),
	kind: ArtifactKindSchema,
	mimeType: Type.String(),
	size: Type.Integer({ minimum: 0, description: "Bytes." }),
	durationSeconds: Type.Union([Type.Number({ minimum: 0 }), Type.Null()], { description: "Video or audio, when known." }),
	threadId: Type.String({ minLength: 1, description: 'The thread it belongs to; "main" for main and its workers.' }),
	workerId: Type.Union([Type.String(), Type.Null()], { description: "The worker that saved it, if one did." }),
	taskId: Type.Union([Type.String(), Type.Null()], {
		description:
			"Its home task: the board task it was first saved for. Part of its identity, so it never changes across versions; null for an artifact a conversation saved without a task.",
	}),
	/**
	 * The task that made this version when that is not the home task (feature `artifact-library`): a follow-up task, or a
	 * later task that continued the artifact with `artifact_save { artifactId }`. Absent when the home task made it, or
	 * when the save named no task.
	 */
	madeForTaskId: Type.Optional(Type.String({ minLength: 1 })),
	sourcePath: Type.String({ description: "Where the file was when it was saved." }),
	/**
	 * Free-form short lowercase words (`web`, `phone`, `dark`, `before`): what platform and state the media shows. Absent
	 * on servers older than the `artifact-tags` feature, which reads as none. Normalised by the server (`normalizeTags`).
	 */
	tags: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Normalised: lowercase, unique, in order." })),
	createdAt: Type.String(),
	version: Type.Optional(Type.Integer({ minimum: 1 })),
	versionCount: Type.Optional(Type.Integer({ minimum: 1, description: "Total saves, including pruned versions." })),
});
export type ArtifactVersion = Static<typeof ArtifactVersionSchema>;

/** Set when the owner keeps an artifact alive after its task (feature `artifact-library`); absent when it is not living. */
export const ArtifactLivingSchema = Type.Object({
	since: Type.String({ description: "When the owner switched it on." }),
});
export type ArtifactLiving = Static<typeof ArtifactLivingSchema>;

export const ArtifactSchema = Type.Object({
	...ArtifactVersionSchema.properties,
	versions: Type.Optional(Type.Array(ArtifactVersionSchema, { description: "Retained snapshots, oldest first; IDs address immutable versions." })),
	laterTaskIds: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			description: "Every task other than the home task that ever made a version, first one first; kept when old versions are pruned.",
		}),
	),
	living: Type.Optional(ArtifactLivingSchema),
});
export type Artifact = Static<typeof ArtifactSchema>;

// --- requests ----------------------------------------------------------------------------------------------------

/** Newest first. Every filter is optional; together they narrow the list. */
export const ArtifactsListRequestSchema = Type.Object({
	type: Type.Literal("artifacts.list"),
	id: RequestIdSchema,
	projectId: ProjectIdSchema,
	artifactId: Type.Optional(Type.String({ minLength: 1, description: "Exact stable artifact ID, including retained version metadata." })),
	threadId: Type.Optional(Type.String({ minLength: 1 })),
	workerId: Type.Optional(Type.String({ minLength: 1 })),
	taskId: Type.Optional(Type.String({ minLength: 1, description: "Its home task, or (with `artifact-library`) any task in its `laterTaskIds`." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Default 100, or all matches when scoped to a task." })),
});
export type ArtifactsListRequest = Static<typeof ArtifactsListRequestSchema>;

/** A URL the client can load the artifact's bytes from, with `download` asking for an attachment. */
export const ArtifactsUrlRequestSchema = Type.Object({
	type: Type.Literal("artifacts.url"),
	id: RequestIdSchema,
	projectId: ProjectIdSchema,
	artifactId: Type.String({ minLength: 1 }),
	download: Type.Optional(Type.Boolean()),
});
export type ArtifactsUrlRequest = Static<typeof ArtifactsUrlRequestSchema>;

export const ArtifactsDeleteRequestSchema = Type.Object({
	type: Type.Literal("artifacts.delete"),
	id: RequestIdSchema,
	projectId: ProjectIdSchema,
	artifactId: Type.String({ minLength: 1 }),
});
export type ArtifactsDeleteRequest = Static<typeof ArtifactsDeleteRequestSchema>;

/**
 * Replaces an artifact's tags (feature `artifact-tags`) and/or switches its living mark (feature `artifact-library`). The
 * server normalises tags (trim, lowercase, dedupe, length and count caps) and answers with the row as stored; an empty
 * array clears them. A request without `tags` and `living` is refused with `bad_request`. Pushed as `artifacts.changed`.
 */
export const ArtifactsUpdateRequestSchema = Type.Object({
	type: Type.Literal("artifacts.update"),
	id: RequestIdSchema,
	projectId: ProjectIdSchema,
	artifactId: Type.String({ minLength: 1 }),
	tags: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	living: Type.Optional(Type.Boolean({ description: "True keeps it alive (sets `living.since` once); false clears it." })),
});
export type ArtifactsUpdateRequest = Static<typeof ArtifactsUpdateRequestSchema>;

/**
 * The artifact library (feature `artifact-library`): the latest version of every artifact across this backend's
 * projects, newest save first, with light facts about their tasks, including done and archived ones.
 */
export const ArtifactsLibraryRequestSchema = Type.Object({
	type: Type.Literal("artifacts.library"),
	id: RequestIdSchema,
	projectIds: Type.Optional(Type.Array(ProjectIdSchema, { description: "Only these projects. Default: every project, archived ones included." })),
	before: Type.Optional(Type.String({ description: "Paging: only artifacts whose latest save is older than this ISO time (the previous page's `nextBefore`)." })),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "Default 300." })),
});
export type ArtifactsLibraryRequest = Static<typeof ArtifactsLibraryRequestSchema>;

/**
 * Everything around one artifact for its Studio (feature `artifact-library`): its home and later tasks with their
 * summary and decisions, and the owner's comments on it, from the feedback of any task in its project.
 */
export const ArtifactsTrailRequestSchema = Type.Object({
	type: Type.Literal("artifacts.trail"),
	id: RequestIdSchema,
	projectId: ProjectIdSchema,
	artifactId: Type.String({ minLength: 1, description: "The stable ID; a `~version` suffix is ignored." }),
});
export type ArtifactsTrailRequest = Static<typeof ArtifactsTrailRequestSchema>;

/** What the library shows about a task beside its artifacts, even when the task is done and archived. */
export const ArtifactTaskFactsSchema = Type.Object({
	projectId: ProjectIdSchema,
	id: Type.String({ minLength: 1, description: 'e.g. "T12".' }),
	title: Type.String(),
	status: BoardTaskStatusSchema,
	archived: Type.Boolean(),
	settledAt: Type.Union([Type.String(), Type.Null()], { description: "When it became done or dropped." }),
	summary: Type.Optional(Type.String({ description: "The report's summary, when written." })),
});
export type ArtifactTaskFacts = Static<typeof ArtifactTaskFactsSchema>;

/** A task folder: the facts plus what the task decided, for "Comes from" and Discuss. */
export const ArtifactTaskFolderSchema = Type.Object({
	...ArtifactTaskFactsSchema.properties,
	decisions: Type.Array(
		Type.Object({ id: Type.String(), text: Type.String(), why: Type.Union([Type.String(), Type.Null()]), at: Type.String() }),
		{ description: "The task's board decisions, newest first." },
	),
});
export type ArtifactTaskFolder = Static<typeof ArtifactTaskFolderSchema>;

/** One owner message about the artifact: a task feedback entry whose text names it with `(artifact <id>` or `(artifact <id>~<n>`. */
export const ArtifactCommentSchema = Type.Object({
	taskId: Type.String({ minLength: 1 }),
	feedbackId: Type.String({ minLength: 1 }),
	version: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()], { description: "The version the message named, if it named one." }),
	text: Type.String(),
	at: Type.String(),
	state: BoardFeedbackStateSchema,
	note: Type.Union([Type.String(), Type.Null()], { description: "What the coordinator said addressed it." }),
});
export type ArtifactComment = Static<typeof ArtifactCommentSchema>;

export const ArtifactLibraryProjectSchema = Type.Object({
	id: ProjectIdSchema,
	name: Type.String(),
	archived: Type.Boolean(),
});
export type ArtifactLibraryProject = Static<typeof ArtifactLibraryProjectSchema>;

// --- responses ---------------------------------------------------------------------------------------------------

export const ArtifactsListResponseSchema = Type.Object({
	type: Type.Literal("artifacts.list"),
	id: RequestIdSchema,
	artifacts: Type.Array(ArtifactSchema),
});
export type ArtifactsListResponse = Static<typeof ArtifactsListResponseSchema>;

export const ArtifactsUrlResponseSchema = Type.Object({
	type: Type.Literal("artifacts.url"),
	id: RequestIdSchema,
	url: Type.String({ description: "Absolute URL on this backend's origin, token included." }),
	expiresAt: Type.String(),
});
export type ArtifactsUrlResponse = Static<typeof ArtifactsUrlResponseSchema>;

export const ArtifactsDeleteResponseSchema = Type.Object({
	type: Type.Literal("artifacts.delete"),
	id: RequestIdSchema,
});
export type ArtifactsDeleteResponse = Static<typeof ArtifactsDeleteResponseSchema>;

export const ArtifactsUpdateResponseSchema = Type.Object({
	type: Type.Literal("artifacts.update"),
	id: RequestIdSchema,
	artifact: ArtifactSchema,
});
export type ArtifactsUpdateResponse = Static<typeof ArtifactsUpdateResponseSchema>;

export const ArtifactsLibraryResponseSchema = Type.Object({
	type: Type.Literal("artifacts.library"),
	id: RequestIdSchema,
	artifacts: Type.Array(ArtifactSchema, { description: "Latest versions with retained version metadata, newest save first." }),
	tasks: Type.Array(ArtifactTaskFactsSchema, { description: "Every home and later task the listed artifacts name." }),
	projects: Type.Array(ArtifactLibraryProjectSchema, { description: "Every project the listed artifacts belong to." }),
	nextBefore: Type.Union([Type.String(), Type.Null()], { description: "Pass as `before` for the next page; null when this was the last." }),
});
export type ArtifactsLibraryResponse = Static<typeof ArtifactsLibraryResponseSchema>;

export const ArtifactsTrailResponseSchema = Type.Object({
	type: Type.Literal("artifacts.trail"),
	id: RequestIdSchema,
	artifact: ArtifactSchema,
	tasks: Type.Array(ArtifactTaskFolderSchema, { description: "The home task first, then later tasks in `laterTaskIds` order; tasks no longer on the board are left out." }),
	comments: Type.Array(ArtifactCommentSchema, { description: "Oldest first." }),
});
export type ArtifactsTrailResponse = Static<typeof ArtifactsTrailResponseSchema>;

// --- server events -----------------------------------------------------------------------------------------------

/** One artifact was saved, deleted or had its tags or living mark changed (`deleted` false); clients showing a list that could hold it read again. */
export const ArtifactsChangedEventSchema = Type.Object({
	type: Type.Literal("artifacts.changed"),
	projectId: ProjectIdSchema,
	artifact: ArtifactSchema,
	deleted: Type.Boolean(),
});
export type ArtifactsChangedEvent = Static<typeof ArtifactsChangedEventSchema>;

// --- tags ----------------------------------------------------------------------------------------------------------

/** The most tags one artifact keeps; more are dropped from the end. */
export const ARTIFACT_MAX_TAGS = 12;
/** The longest a tag is, in characters; a longer one is cut. */
export const ARTIFACT_MAX_TAG_LENGTH = 24;
/** Snapshots a living artifact keeps (a year of weekly saves and some), instead of `ARTIFACT_VERSION_LIMIT`'s 20. */
export const ARTIFACT_LIVING_VERSION_LIMIT = 60;
/** Suggested in tool descriptions and the app: platform, form factor, theme, and before/after state. */
export const SUGGESTED_ARTIFACT_TAGS = ["web", "android", "phone", "desktop", "tablet", "dark", "light", "before", "after"] as const;

/**
 * One tag in its stored form: trimmed, lowercase, runs of whitespace and separators as one `-`, no characters but
 * letters, digits, `-`, `_`, `.`, `+` and `:`, cut to `ARTIFACT_MAX_TAG_LENGTH`; `undefined` when nothing is left.
 */
export function normalizeTag(tag: string): string | undefined {
	const cleaned = tag
		.normalize("NFKC")
		.trim()
		.toLowerCase()
		.replace(/[\s,;/\\]+/g, "-")
		.replace(/[^\p{L}\p{N}\-_.+:]/gu, "")
		.replace(/^[-_.:+]+|[-_.:+]+$/g, "")
		.slice(0, ARTIFACT_MAX_TAG_LENGTH)
		.replace(/[-_.:+]+$/g, "");
	return cleaned.length === 0 ? undefined : cleaned;
}

/** A list of tags as stored: each normalised, duplicates dropped (first wins), at most `ARTIFACT_MAX_TAGS`. */
export function normalizeTags(tags: readonly string[] | undefined | null): string[] {
	const seen = new Set<string>();
	for (const tag of tags ?? []) {
		const normal = normalizeTag(tag);
		if (normal !== undefined) seen.add(normal);
		if (seen.size >= ARTIFACT_MAX_TAGS) break;
	}
	return [...seen];
}
