import { type Static, Type } from "typebox";
import { ProjectIdSchema, RequestIdSchema } from "./common.ts";
import { CodeRootSchema } from "./project-files.ts";

export const MAX_CHANGE_FILES = 500;
export const MAX_CHANGE_SIDE_BYTES = 1024 * 1024;
export const MAX_CHANGE_PATCH_BYTES = 256 * 1024;
export const MAX_CHANGE_PATH_BYTES = 4096;

const GitHashSchema = Type.String({ pattern: "^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$" });
const ChangePathSchema = Type.String({ minLength: 1, maxLength: MAX_CHANGE_PATH_BYTES });

export const ChangeSourceSchema = Type.Union([
	Type.Object({ kind: Type.Literal("task"), taskId: Type.String({ minLength: 1 }) }),
	Type.Object({ kind: Type.Literal("commit"), hash: GitHashSchema }),
]);
/** A committed source, used by Delivery and commit deep links. */
export type ChangeSource = Static<typeof ChangeSourceSchema>;

export const WorkingChangeSourceSchema = Type.Object({ kind: Type.Literal("working"), root: CodeRootSchema });
export type WorkingChangeSource = Static<typeof WorkingChangeSourceSchema>;
export const ChangeRequestSourceSchema = Type.Union([...ChangeSourceSchema.anyOf, WorkingChangeSourceSchema]);
export type ChangeRequestSource = Static<typeof ChangeRequestSourceSchema>;

export const ChangeCommitSchema = Type.Object({
	hash: GitHashSchema,
	subject: Type.String(),
	author: Type.String(),
	time: Type.String({ description: "ISO 8601 author time." }),
	landed: Type.Boolean(),
	partIds: Type.Optional(Type.Array(Type.String(), { description: "request-digest: the contributing parts of the requested task." })),
});
export type ChangeCommit = Static<typeof ChangeCommitSchema>;

export const ChangedFileSchema = Type.Object({
	path: ChangePathSchema,
	previousPath: Type.Optional(ChangePathSchema),
	status: Type.Union([Type.Literal("added"), Type.Literal("modified"), Type.Literal("deleted"), Type.Literal("renamed")]),
	additions: Type.Integer({ minimum: 0 }),
	deletions: Type.Integer({ minimum: 0 }),
	binary: Type.Boolean(),
});
export type ChangedFile = Static<typeof ChangedFileSchema>;

export const ChangeFileSideSchema = Type.Object({ text: Type.String(), hash: GitHashSchema });
export type ChangeFileSide = Static<typeof ChangeFileSideSchema>;

const changeRequestFields = { id: RequestIdSchema, projectId: ProjectIdSchema, source: ChangeRequestSourceSchema };
export const ChangesListRequestSchema = Type.Object({ type: Type.Literal("changes.list"), ...changeRequestFields });
export type ChangesListRequest = Static<typeof ChangesListRequestSchema>;
export const ChangesFileRequestSchema = Type.Object({ type: Type.Literal("changes.file"), ...changeRequestFields, path: ChangePathSchema, reveal: Type.Optional(Type.Boolean()) });
export type ChangesFileRequest = Static<typeof ChangesFileRequestSchema>;

export const ChangesListResponseSchema = Type.Object({
	type: Type.Literal("changes.list"), id: RequestIdSchema,
	commits: Type.Array(ChangeCommitSchema),
	files: Type.Array(ChangedFileSchema, { maxItems: MAX_CHANGE_FILES }),
	truncated: Type.Boolean(),
	baseCommit: Type.Optional(Type.Union([GitHashSchema, Type.Null()], { description: "Working sources only; null in an unborn checkout." })),
	readAt: Type.Optional(Type.String({ description: "Working sources only; ISO 8601 time the live scan began." })),
	contiguous: Type.Optional(Type.Boolean({ description: "Task sources only; false means no combined diff." })),
	nonContiguousReason: Type.Optional(Type.Union([Type.Literal("no-commits"), Type.Literal("not-first-parent-chain")])),
});
export type ChangesListResponse = Static<typeof ChangesListResponseSchema>;

export const ChangesFileResponseSchema = Type.Object({
	type: Type.Literal("changes.file"), id: RequestIdSchema,
	before: Type.Optional(ChangeFileSideSchema), after: Type.Optional(ChangeFileSideSchema),
	binary: Type.Optional(Type.Literal(true)), tooLarge: Type.Optional(Type.Literal(true)),
	sensitive: Type.Optional(Type.Literal(true)),
	patch: Type.Optional(Type.String()), patchTruncated: Type.Optional(Type.Literal(true)),
});
export type ChangesFileResponse = Static<typeof ChangesFileResponseSchema>;
