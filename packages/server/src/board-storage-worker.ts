import { configureServerSettings } from "./server-settings.ts";
import { parentPort, workerData } from "node:worker_threads";
import type { Artifact, ArtifactTaskFacts, ArtifactsTrailResponse, ProjectAttention } from "@kemiri/protocol";
import { maintainBoardStorage, type BoardMaintenance } from "./board-checkpoint.ts";
import { readArtifactBoardFacts, readArtifactTrail, readRequestPartIds } from "./artifact-board-facts.ts";
import { readStoredAttention } from "./sidebar-attention-migration.ts";

export type BoardStorageRequest = { path: string } & (
	| { type: "maintenance" }
	| { type: "attention"; now: number }
	| { type: "request-parts"; taskId: string }
	| { type: "artifact-tasks"; projectId: string; taskIds: readonly string[]; now: number }
	| { type: "artifact-trail"; projectId: string; artifact: Artifact; now: number }
);

export type BoardStorageResults = {
	maintenance: BoardMaintenance;
	attention: ProjectAttention;
	"request-parts": string[];
	"artifact-tasks": ArtifactTaskFacts[];
	"artifact-trail": Omit<ArtifactsTrailResponse, "id" | "type" | "artifact">;
};

async function dispatch(request: BoardStorageRequest): Promise<BoardStorageResults[BoardStorageRequest["type"]]> {
	switch (request.type) {
		case "maintenance": return maintainBoardStorage(request.path);
		case "attention": return readStoredAttention(request.path, request.now);
		case "request-parts": return readRequestPartIds(request.path, request.taskId);
		case "artifact-tasks": return readArtifactBoardFacts(request.path, request.projectId, request.taskIds, request.now);
		case "artifact-trail": return readArtifactTrail(request.path, request.projectId, request.artifact, request.now);
	}
}

if (parentPort) {
	try {
		const { request, stateNamespace, sqliteTmpDir } = workerData as { request: BoardStorageRequest; stateNamespace?: string; sqliteTmpDir?: string };
		// Transfer only the on-disk namespace and the temporary volume to check before compaction.
		configureServerSettings({ KEMIRI_STATE_NAMESPACE: stateNamespace, SQLITE_TMPDIR: sqliteTmpDir });
		parentPort.postMessage({ result: await dispatch(request) });
	} catch (error) {
		parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
	}
}
