import { applyArtifactChange } from "@kemiri/client";
import { isHtmlArtifact, type Artifact, type ArtifactsChangedEvent } from "@kemiri/protocol";

/** Keep only catalogue metadata when a push also carries the retained snapshots. */
export function applyProjectArtifactChange(rows: readonly Artifact[], event: ArtifactsChangedEvent, projectId: string): readonly Artifact[] {
	const { versions: _versions, ...artifact } = event.artifact;
	return applyArtifactChange(rows, { ...event, artifact }, projectId);
}

export function projectArtifactSections(rows: readonly Artifact[], query: string, taskTitles: ReadonlyMap<string, string>) {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	const pinned: Artifact[] = [], html: Artifact[] = [], other: Artifact[] = [];
	for (const artifact of rows) {
		const search = [artifact.title, artifact.name, artifact.note, artifact.taskId,
			artifact.taskId && taskTitles.get(artifact.taskId), ...(artifact.tags ?? [])].join(' ').toLowerCase();
		if (!terms.every(term => search.includes(term))) continue;
		if (artifact.kind !== "text" || !isHtmlArtifact(artifact)) other.push(artifact);
		else if (artifact.pinned) pinned.push(artifact);
		else html.push(artifact);
	}
	return { pinned, html, other };
}
