/**
 * Artifact tools for every conversation — coordinators, workers and their code-mode scripts. Save copies a file
 * into the project's artifact store (`artifacts.ts`); read returns metadata and an editable copy of a stored version.
 *
 * What save may read: a regular file under the calling conversation's cwd, the project directory or the system temp
 * directory (where browsers and screen recorders usually leave their output), after symlinks are resolved. Nothing in
 * the data directory except the project's own worker workspaces, so credentials and secrets cannot become artifacts.
 *
 * Replay: the artifact ID is memoized before the copy, so a rerun after a restart finds the row the first run saved
 * instead of saving the file twice.
 */
import type { Context } from "@earendil-works/chord/context";
import { type Extension, type ToolRegistration, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { type Artifact, MAIN_THREAD_ID } from "@kemiri/protocol";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rename, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { artifactTagsFromFileName } from "./artifact-file-tags.ts";
import { Type } from "typebox";
import { type ArtifactStore, newArtifactId } from "./artifacts.ts";
import { errorMessage } from "./errors.ts";
import type { Project } from "./projects.ts";

export const ARTIFACT_SAVE_TOOL = "artifact_save";
export const ARTIFACT_READ_TOOL = "artifact_read";
export const ARTIFACT_EXTENSION = "artifact-tools";

/**
 * Fixed text (it sits in the tool description, so prompts stay byte-stable) that tells the model how to tag media. The
 * app groups a task's photos and videos by tag and pairs `before` with `after` for its compare slide.
 */
export const ARTIFACT_TAG_GUIDANCE =
	"Tag media by platform and state with `tags` or names like `task-board--web-phone-dark-after.png` " +
	"(last `--`, hyphen-separated letters/digits, lowercase, 1–24 characters each). " +
	"For `path` or `paths`, explicit tags come first, then file-name tags. " +
	"Give before/after pairs the same tags except `before` and `after`; the app filters and compares by tag.";

export const ARTIFACT_CONTINUATION_GUIDANCE = "Pass artifactId with one file to continue an existing artifact.";

export const artifactSaveFields = {
	artifactId: Type.Optional(Type.String({ minLength: 1, description: "Stable ID of the artifact to continue." })),
	path: Type.Optional(Type.String({ minLength: 1, description: "One file to keep; omit when giving paths." })),
	paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
		minItems: 1,
		maxItems: 50,
		description: "Files to keep; omit path. List only the files meant to be kept.",
	})),
	title: Type.Optional(Type.String({ minLength: 1, description: "What a single file shows; ignored for several files." })),
	note: Type.Optional(Type.String({ minLength: 1, description: "Longer description, Markdown." })),
	tags: Type.Optional(
		Type.Array(Type.String({ minLength: 1 }), {
			maxItems: 100,
			description: "Short lowercase words: platform, form factor, theme, before/after. E.g. [\"web\", \"phone\", \"dark\"].",
		}),
	),
};

export type ArtifactToolsOptions = {
	store: ArtifactStore;
	project: () => Project;
	/**
	 * The parts of the data directory a save may read from: main's worker workspaces and the background threads'
	 * directories (their checkouts and their workers' workspaces).
	 */
	workspaceDirs: string[];
	/** The worker a conversation is, or null for a coordinator (and any other conversation). */
	workerIdOf: (conversationId: number) => Promise<string | null>;
	/** The thread a conversation belongs to, a worker's being its coordinator's; main when not given. */
	threadIdOf?: (conversationId: number) => Promise<string>;
	/** Best-effort durable proof receipt, including saves replayed after a restart. Must not fail the save. */
	liveRunOf?: (conversationId: number) => Promise<{ conversationId: number; runId: string } | undefined>;
	onSavedSource?: (conversationId: number, path: string) => Promise<void>;
};

/** Whether `path` is `root` or inside it. Both must already be real paths. */
function isWithin(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function realOrUndefined(path: string): Promise<string | undefined> {
	return realpath(path).catch(() => undefined);
}

/**
 * The real path of a file `artifact_save` may copy, or the reason it may not. `path` is absolute or relative to `cwd`;
 * `~/` is the server user's home.
 */
export async function resolveArtifactSource(options: {
	path: string;
	cwd: string;
	projectPath: string;
	dataDir: string;
	workspaceDirs: string[];
}): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
	const expanded = options.path === "~" || options.path.startsWith("~/") ? homedir() + options.path.slice(1) : options.path;
	const requested = isAbsolute(expanded) ? resolve(expanded) : resolve(options.cwd, expanded);
	const real = await realOrUndefined(requested);
	if (real === undefined) return { ok: false, message: `${requested} does not exist.` };
	const info = await stat(real);
	if (info.isDirectory()) return { ok: false, message: `${requested} is a directory; list only the files you mean to keep with paths, or save an archive of it.` };
	if (!info.isFile()) return { ok: false, message: `${requested} is not a regular file.` };

	const roots = (await Promise.all([options.cwd, options.projectPath, tmpdir()].map(realOrUndefined))).filter(
		(root): root is string => root !== undefined,
	);
	const dataDir = await realOrUndefined(options.dataDir);
	const workspaces = (await Promise.all(options.workspaceDirs.map(realOrUndefined))).filter(
		(root): root is string => root !== undefined,
	);
	const inDataDir = dataDir !== undefined && isWithin(real, dataDir);
	const inWorkspaces = workspaces.some((root) => isWithin(real, root));
	if (!roots.some((root) => isWithin(real, root)) || (inDataDir && !inWorkspaces)) {
		return {
			ok: false,
			message: `${requested} is outside the paths an artifact may come from: this conversation's working directory, the project directory and ${tmpdir()}.`,
		};
	}
	try {
		await access(real, constants.R_OK);
	} catch {
		return { ok: false, message: `${requested} is not readable.` };
	}
	return { ok: true, path: real };
}

function formatBytes(size: number): string {
	if (size < 1024) return `${size} B`;
	const units = ["KiB", "MiB", "GiB"];
	let value = size / 1024;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

function toolText(text: string, isError = false, details?: { artifactId: string } | { artifactId?: string; files: ArtifactSaveFileResult[] }) {
	return {
		output: [{ type: "text" as const, text }],
		...(isError ? { isError: true } : {}),
		...(details === undefined ? {} : { details }),
	};
}

/** Publish an editable copy, never a link to the immutable store. Replace rather than follow an old copy's links. */
async function copyArtifactForReading(store: ArtifactStore, artifact: Artifact): Promise<string> {
	const key = createHash("sha256").update(JSON.stringify([
		resolve(store.dataDir), artifact.projectId, artifact.id.split("~")[0], artifact.version ?? 1,
	])).digest("hex");
	const directory = join(tmpdir(), `kemiri-artifact-read-${process.getuid?.() ?? "user"}-${key}`);
	try {
		await mkdir(directory, { mode: 0o700 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
	}
	const info = await lstat(directory);
	if (!info.isDirectory() || (process.getuid !== undefined && info.uid !== process.getuid())) {
		throw new Error("The artifact copy directory is not a private directory owned by this user.");
	}
	await chmod(directory, 0o700);
	const staging = await mkdtemp(join(directory, ".copy-"));
	try {
		const copy = join(staging, artifact.name);
		await copyFile(store.filePath(artifact), copy);
		await chmod(copy, 0o600);
		const path = join(directory, artifact.name);
		await rename(copy, path);
		return path;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

/** A continuation with no explicit tags inherits its tags, even when the next filename changes. */
export function artifactSaveTags(args: { artifactId?: string | undefined; tags?: string[] | undefined }, path: string): { tags?: string[] } {
	return args.artifactId !== undefined && args.tags === undefined ? {} : { tags: [...(args.tags ?? []), ...artifactTagsFromFileName(path)] };
}

type ArtifactSaveFileResult = { path: string } & (
	{ artifactId: string; version: number } | { error: string }
);

export function createArtifactExtension(options: ArtifactToolsOptions): Extension {
	const threadIdOf = options.threadIdOf ?? (async () => MAIN_THREAD_ID);
	const saveTool = defineTool({
		name: ARTIFACT_SAVE_TOOL,
		description:
			"Keep files as artifacts: videos, screenshots, logs or reports shown in the app. " +
			"Give exactly one of `path` or `paths` (1–50 files); list only the files you mean to keep, never whole frame folders. " +
			"Sources stay in place; copies go into the project's artifact store on this backend. " +
			"Paths are absolute or relative to the working directory, under it, the project or temp directory. " +
			"`taskId`, `note` and `tags` apply to every file; `title` only to a single file (otherwise untitled). " +
			"Give `taskId` for board evidence. Same filename and taskId (else conversation) saves a new version. " +
			"Failures are reported per file; other files still save. " +
			ARTIFACT_CONTINUATION_GUIDANCE + " " + ARTIFACT_TAG_GUIDANCE,
		parameters: Type.Object({
			...artifactSaveFields,
			// Board assignment is optional in native tools only. The official-agent bridge binds it at launch.
			taskId: Type.Optional(Type.String({ minLength: 1, description: "The board task it is evidence for, e.g. T3." })),
		}),
		// Keep the legacy single-path key for in-flight calls; each batch entry gets its own receipt.
		replay: "safe",
		execute: async (args, api, context: Context) => {
			if ((args.path === undefined) === (args.paths === undefined)) {
				return toolText("Give exactly one of path or paths (1–50 files).", true);
			}
			const paths = args.paths ?? [args.path!];
			if (paths.length < 1 || paths.length > 50) return toolText("paths must contain 1–50 files.", true);
			if (args.artifactId !== undefined && paths.length !== 1) return toolText("artifactId requires exactly one file.", true);
			const project = options.project();
			const liveRun = args.taskId ? await options.liveRunOf?.(api.conversationId) : undefined;
			const files: ArtifactSaveFileResult[] = [];
			const messages: string[] = [];
			for (const [index, path] of paths.entries()) {
				try {
					const agent = await api.agent(context);
					const source = await resolveArtifactSource({
						path,
						cwd: agent.cwd ?? project.path,
						projectPath: project.path,
						dataDir: options.store.dataDir,
						workspaceDirs: options.workspaceDirs,
					});
					if (!source.ok) throw new Error(source.message);
					const artifactId = await api.memo<string>(args.paths === undefined ? "artifactId" : `artifactId:${index}`, newArtifactId(api.now()), context);
					const artifact = await options.store.save({
						projectId: project.id,
						sourcePath: source.path,
						...(paths.length === 1 && args.title !== undefined ? { title: args.title } : {}),
						...(args.note === undefined ? {} : { note: args.note }),
						threadId: await threadIdOf(api.conversationId),
						workerId: await options.workerIdOf(api.conversationId),
						taskId: args.taskId ?? null,
						...artifactSaveTags(args, source.path),
						...(args.artifactId === undefined ? {} : { continueArtifactId: args.artifactId }),
						artifactId,
						...(liveRun ? { liveRun } : {}),
					});
					await options.onSavedSource?.(api.conversationId, source.path).catch(() => {});
					files.push({ path, artifactId: artifact.id, version: artifact.version ?? 1 });
					const duration = artifact.durationSeconds === null ? "" : `, ${artifact.durationSeconds.toFixed(1)} s`;
					const tags = artifact.tags === undefined || artifact.tags.length === 0 ? "" : `, tags ${artifact.tags.join(", ")}`;
					messages.push(paths.length > 1
						? `${JSON.stringify(path)}: Saved artifact ${artifact.id}~${artifact.version ?? 1}: ${artifact.name} (${artifact.kind}, ${formatBytes(artifact.size)}${duration}${tags}).`
						: `${(artifact.version ?? 1) > 1 ? `Saved version ${artifact.version} of ${artifact.name}` : `Saved artifact ${artifact.id}: ${artifact.name}`} (${artifact.kind}, ${formatBytes(artifact.size)}${duration}${tags}).`);
				} catch (error) {
					const message = errorMessage(error);
					files.push({ path, error: message });
					messages.push(`${JSON.stringify(path)}: Saving the artifact failed: ${message}`);
				}
			}
			const failed = files.some((file) => "error" in file);
			const single = files.length === 1 ? files[0] : undefined;
			const firstSaved = files.find((file) => "artifactId" in file);
			return toolText(messages.join("\n"), failed,
				single !== undefined && "artifactId" in single ? { artifactId: single.artifactId }
					: args.path !== undefined ? undefined
						: { ...(firstSaved !== undefined && "artifactId" in firstSaved ? { artifactId: firstSaved.artifactId } : {}), files });
		},
	});
	const readTool = defineTool({
		name: ARTIFACT_READ_TOOL,
		description: "Open a retained artifact version from this project: metadata and a private, editable copy of its stored bytes. Bare ID reads latest; id~N or version selects a snapshot. Includes instructions for publishing a revision.",
		parameters: Type.Object({
			artifactId: Type.String({ minLength: 1, description: "Artifact ID, or id~N for a retained version." }),
			version: Type.Optional(Type.Integer({ minimum: 1, description: "Version number; must agree with id~N if both are given." })),
		}),
		replay: "safe",
		execute: async (args) => {
			try {
				const match = /^([a-z0-9][a-z0-9-]{0,63})(?:~([1-9]\d*))?$/.exec(args.artifactId);
				if (match === null) return toolText("Invalid artifact ID; use a bare ID or id~N with a positive whole version number.", true);
				const rootId = match[1]!;
				const pinned = match[2] === undefined ? undefined : Number(match[2]);
				if ((pinned !== undefined && !Number.isSafeInteger(pinned)) || (args.version !== undefined && (!Number.isSafeInteger(args.version) || args.version < 1))) {
					return toolText("Version must be a positive safe whole number.", true);
				}
				if (pinned !== undefined && args.version !== undefined && pinned !== args.version) {
					return toolText(`Conflicting versions: artifactId selects ${pinned}, but version is ${args.version}.`, true);
				}
				const project = options.project();
				const latest = await options.store.get(project.id, rootId);
				if (latest === undefined) return toolText(`No artifact "${rootId}" in this project. Unknown IDs and artifacts from other projects cannot be read.`, true);
				const version = args.version ?? pinned ?? latest.version ?? 1;
				const artifact = latest.versions?.find((snapshot) => snapshot.version === version);
				const retained = latest.versions?.map((snapshot) => snapshot.version).join(", ") ?? "1";
				if (artifact === undefined) return toolText(`Version ${version} of artifact "${rootId}" is not retained (pruned or never saved). Retained versions: ${retained}; latest: ${latest.version ?? 1}.`, true);
				const path = await copyArtifactForReading(options.store, artifact);
				const scope = artifact.taskId === null ? `conversation (thread ${artifact.threadId}, worker ${artifact.workerId ?? "coordinator"})` : `task ${artifact.taskId}`;
				const revision = `From any task or chat, save the next version with artifact_save using artifactId: ${rootId}, the edited file, and your own taskId if any.`;
				return toolText([
					`Artifact ${rootId}~${version}: ${artifact.title ?? "(untitled)"}`,
					`File: ${artifact.name}`,
					`Version ${version}; latest: ${latest.version ?? 1}; retained versions (${latest.versions?.length ?? 1}): ${retained}.`,
					`Kind/MIME: ${artifact.kind} / ${artifact.mimeType}; size: ${artifact.size} bytes (${formatBytes(artifact.size)}).`,
					`Scope: ${scope}. Saved by thread ${artifact.threadId}, worker ${artifact.workerId ?? "coordinator"}, at ${artifact.createdAt}.`,
					`Note: ${artifact.note ?? "(none)"}`,
					`Readable copy: ${path}`,
					revision,
				].join("\n"));
			} catch (error) {
				return toolText(`Reading the artifact failed: ${errorMessage(error)}`, true);
			}
		},
	});
	return defineExtension({ name: ARTIFACT_EXTENSION, tools: [saveTool, readTool] as ToolRegistration[] });
}
