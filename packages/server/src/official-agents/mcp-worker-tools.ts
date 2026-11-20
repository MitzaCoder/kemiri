import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId, Harness, Tx } from "@earendil-works/pi-durable";
import type { Tool } from "@earendil-works/pi-mcp";
import { realpath } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { ARTIFACT_CONTINUATION_GUIDANCE, ARTIFACT_SAVE_TOOL, ARTIFACT_TAG_GUIDANCE, artifactSaveFields, artifactSaveTags } from "../artifact-tools.ts";
import type { ArtifactStore } from "../artifacts.ts";
import { errorMessage } from "../errors.ts";
import { workerTaskProgress, workerTaskProgressTool } from "../worker-task-progress.ts";
import { captureBridgeArtifactRoot, isInsideBridgeRoot, openBridgeArtifactSource } from "./bridge-artifact-source.ts";
import type { OfficialAgentMcpScope } from "./mcp-bridge.ts";
import { bridgeToolError } from "./mcp-bridge-command.ts";

const artifactParameters = Type.Object(artifactSaveFields, { additionalProperties: false });
const artifactSave: Tool = {
	name: ARTIFACT_SAVE_TOOL,
	description: "Keep selected files as artifacts. Give exactly one of path or paths (1–50 files). Paths must resolve inside your workspace or proof folder. " +
		"The backend assigns your task automatically, or keeps the artifact in your conversation if you have no task. " +
		"Same filename and scope saves a new version. Failures are per file. " + ARTIFACT_CONTINUATION_GUIDANCE + " " + ARTIFACT_TAG_GUIDANCE,
	inputSchema: { ...artifactParameters },
};
/** No public request IDs enter the scope; they all come from the durable worker record at launch. */
export async function officialAgentWorkerTools(options: {
	projectId: string;
	workerId: string;
	threadId: string;
	taskId: string | null;
	taskLive: boolean;
	cwd: string;
	managedWorkspace: boolean;
	proofDirectory?: string | undefined;
	harness: Harness;
	mainId: ConversationId;
	artifacts: ArtifactStore;
	isCurrent(tx?: Tx): Promise<boolean>;
	onSavedProof?(path: string): Promise<void>;
}): Promise<OfficialAgentMcpScope> {
	const { cwd, proofDirectory, harness, mainId, taskId, taskLive, projectId, workerId, threadId, artifacts, isCurrent } = options;
	const { name: progressName, description, parameters: progressParameters } = workerTaskProgressTool(taskLive);
	const taskProgress: Tool = { name: progressName, description, inputSchema: { ...progressParameters } };
	const workspace = await captureBridgeArtifactRoot(cwd);
	const roots = [workspace];
	const dataDir = await realpath(artifacts.dataDir);
	const excludedRoot = options.managedWorkspace && workspace.path !== dataDir && isInsideBridgeRoot(dataDir, workspace.path) ? undefined : dataDir;
	if (proofDirectory) {
		const proof = await captureBridgeArtifactRoot(proofDirectory, true).catch(() => undefined);
		if (proof) roots.push(proof);
	}
	return {
		isCurrent,
		tools: taskId === null ? [artifactSave] : [taskProgress, artifactSave],
		async call(name, args, key, signal) {
			if (name === taskProgress.name && taskId !== null) {
				if (!Check(progressParameters, args) || Object.keys(args).some(key => !Object.hasOwn(progressParameters.properties, key))) return bridgeToolError("Invalid task_progress arguments.");
				const result = await workerTaskProgress(args as Static<typeof progressParameters>, {
					harness, mainId, context: BACKGROUND_CONTEXT, scope: { taskId, workerId, threadId }, taskLive, key, assignedTaskOnly: true, artifactScope: { store: artifacts, projectId },
					commit: change => harness.commit(async tx => {
						if (!await isCurrent(tx) || signal.aborted) throw new Error("This worker's bridge is no longer active.");
						return change(tx);
					}, BACKGROUND_CONTEXT),
				});
				return { content: result.output, ...("isError" in result ? { isError: true } : {}) };
			}
			if (name !== artifactSave.name) return bridgeToolError("This tool is not available to this worker.");
			if (!Check(artifactParameters, args)) return bridgeToolError("Invalid artifact_save arguments. The backend assigns the task automatically.");
			const input = args as Static<typeof artifactParameters>;
			if ((input.path === undefined) === (input.paths === undefined)) return bridgeToolError("Give exactly one of path or paths (1–50 files).");
			const paths = input.paths ?? [input.path!];
			if (input.artifactId !== undefined && paths.length !== 1) return bridgeToolError("artifactId requires exactly one file.");
			const messages: string[] = [];
			let failed = false;
			for (const path of paths) {
				if (signal.aborted || !await isCurrent()) return bridgeToolError("This worker's bridge is no longer active.");
				let source: Awaited<ReturnType<typeof openBridgeArtifactSource>> | undefined;
				try {
					source = await openBridgeArtifactSource(cwd, roots, path, excludedRoot);
					const artifact = await artifacts.save({ projectId, threadId, workerId, taskId, signal,
						sourcePath: source.path, sourceFd: source.fd,
						...(paths.length === 1 && input.title !== undefined ? { title: input.title } : {}),
						...(input.note === undefined ? {} : { note: input.note }),
						...artifactSaveTags(input, source.path),
						...(input.artifactId === undefined ? {} : { continueArtifactId: input.artifactId }),
					});
					await options.onSavedProof?.(source.path).catch(() => undefined);
					messages.push(`${JSON.stringify(path)}: Saved artifact ${artifact.id}~${artifact.version ?? 1}: ${artifact.name}.`);
				} catch (error) {
					failed = true;
					messages.push(`${JSON.stringify(path)}: Saving the artifact failed: ${errorMessage(error)}`);
				} finally { source?.close(); }
			}
			return { content: [{ type: "text", text: messages.join("\n") }], ...(failed ? { isError: true } : {}) };
		},
	};
}
