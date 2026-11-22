import type { Artifact, ArtifactTaskFacts, ArtifactsLibraryRequest, ArtifactsLibraryResponse, ArtifactsTrailResponse } from "@kemiri/protocol";
import { type ArtifactStore, withVersions } from "./artifacts.ts";
import type { ProjectStore } from "./projects.ts";
import { artifactTaskIds } from "./artifact-board-facts.ts";

export async function artifactLibrary(
	projects: ProjectStore, store: ArtifactStore, request: ArtifactsLibraryRequest,
	readTaskFacts: (projectId: string, taskIds: ReadonlySet<string>) => Promise<ArtifactTaskFacts[]>,
): Promise<Omit<ArtifactsLibraryResponse, "id" | "type">> {
	const selected = request.projectIds === undefined ? undefined : new Set(request.projectIds);
	const matchingProjects = (await projects.list()).filter((project) => selected === undefined || selected.has(project.id));
	const rows = (await Promise.all(matchingProjects.map((project) => store.libraryRows(project.id)))).flat();
	const before = request.before;
	const matching = rows.filter((row) => before === undefined || Date.parse(row.createdAt) < Date.parse(before))
		.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.projectId.localeCompare(right.projectId) || right.id.localeCompare(left.id));
	let end = Math.min(request.limit ?? 300, matching.length);
	// Timestamp-only cursors cannot split same-millisecond saves without dropping rows.
	while (end < matching.length && matching[end - 1]!.createdAt === matching[end]!.createdAt) end++;
	const artifacts = matching.slice(0, end).map(withVersions);
	const pageTaskIds = new Map<string, Set<string>>();
	for (const artifact of artifacts) {
		const ids = pageTaskIds.get(artifact.projectId) ?? new Set<string>();
		for (const id of artifactTaskIds(artifact)) ids.add(id);
		pageTaskIds.set(artifact.projectId, ids);
	}
	const pageProjects = matchingProjects.filter((project) => pageTaskIds.has(project.id));
	const tasks = (await Promise.all(pageProjects.map(async (project) => {
		const ids = pageTaskIds.get(project.id)!;
		return ids.size === 0 ? [] : readTaskFacts(project.id, ids);
	}))).flat();
	return {
		artifacts, tasks,
		projects: pageProjects.map(({ id, name, archived }) => ({ id, name, archived: archived === true })),
		nextBefore: end < matching.length ? artifacts.at(-1)!.createdAt : null,
	};
}

export async function artifactTrail(
	projects: ProjectStore, store: ArtifactStore, projectId: string, artifactId: string,
	readTrail: (artifact: Artifact) => Promise<Omit<ArtifactsTrailResponse, "id" | "type" | "artifact">>,
): Promise<Omit<ArtifactsTrailResponse, "id" | "type">> {
	await projects.require(projectId);
	const artifact = await store.require(projectId, artifactId.replace(/~[1-9]\d*$/, ""));
	return { artifact, ...await readTrail(artifact) };
}
