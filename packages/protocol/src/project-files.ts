import { type Static, Type } from "typebox";
import { ProjectIdSchema, RequestIdSchema } from "./common.ts";

export const MAX_FILE_PATH_BYTES = 4096;
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_FILE_LIST_ENTRIES = 1000;
export const MAX_FILE_SEARCH_RESULTS = 50;

export const CodeRootSchema = Type.Union([
	Type.Object({ kind: Type.Literal("project") }),
	Type.Object({ kind: Type.Literal("worker"), workerId: Type.String({ minLength: 1 }) }),
	Type.Object({ kind: Type.Literal("thread"), threadId: Type.String({ minLength: 1 }) }),
]);
export type CodeRoot = Static<typeof CodeRootSchema>;

const pathSchema = Type.String({ maxLength: MAX_FILE_PATH_BYTES });
const fileMetadata = { size: Type.Integer({ minimum: 0 }), modifiedAt: Type.String({ description: "ISO 8601 modification time." }) };
export const FileListEntrySchema = Type.Object({
	name: Type.String({ minLength: 1 }),
	kind: Type.Union([Type.Literal("file"), Type.Literal("dir"), Type.Literal("link")]),
	...fileMetadata,
});
export type FileListEntry = Static<typeof FileListEntrySchema>;

const requestFields = { id: RequestIdSchema, projectId: ProjectIdSchema, root: CodeRootSchema };
export const FilesListRequestSchema = Type.Object({
	type: Type.Literal("files.list"), ...requestFields, path: pathSchema, showHidden: Type.Optional(Type.Boolean()),
});
export const FilesSearchRequestSchema = Type.Object({
	type: Type.Literal("files.search"), ...requestFields, query: Type.String({ maxLength: 256 }),
});
export const FilesReadRequestSchema = Type.Object({
	type: Type.Literal("files.read"), ...requestFields, path: pathSchema, reveal: Type.Optional(Type.Boolean()),
});
export type FilesListRequest = Static<typeof FilesListRequestSchema>;
export type FilesSearchRequest = Static<typeof FilesSearchRequestSchema>;
export type FilesReadRequest = Static<typeof FilesReadRequestSchema>;

export const FilesListResponseSchema = Type.Object({
	type: Type.Literal("files.list"), id: RequestIdSchema, entries: Type.Array(FileListEntrySchema, { maxItems: MAX_FILE_LIST_ENTRIES }),
	truncated: Type.Boolean(),
});
export const FilesSearchResponseSchema = Type.Object({
	type: Type.Literal("files.search"), id: RequestIdSchema, paths: Type.Array(pathSchema, { maxItems: MAX_FILE_SEARCH_RESULTS }),
});
export const FilesReadResponseSchema = Type.Object({
	type: Type.Literal("files.read"), id: RequestIdSchema, ...fileMetadata,
	text: Type.Optional(Type.String()), hash: Type.Optional(Type.String({ pattern: "^[a-f0-9]{64}$" })),
	binary: Type.Optional(Type.Literal(true)), mimeType: Type.Optional(Type.String()),
	tooLarge: Type.Optional(Type.Literal(true)), sensitive: Type.Optional(Type.Literal(true)),
});
export type FilesListResponse = Static<typeof FilesListResponseSchema>;
export type FilesSearchResponse = Static<typeof FilesSearchResponseSchema>;
export type FilesReadResponse = Static<typeof FilesReadResponseSchema>;
