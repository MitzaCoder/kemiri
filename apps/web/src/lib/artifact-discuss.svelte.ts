import { goto } from '$app/navigation';
import { page } from '$app/state';
import type { HarnessClient } from '@kemiri/client';
import type { Artifact } from '@kemiri/protocol';
import { discussHeader } from './artifact-discuss.js';
import { moveReviewToDraft } from './artifact-review-draft.js';
import { projectHref } from './backends.js';
import { draftKey } from './drafts.js';
import { harness } from './harness.svelte.js';

export const discussionNavigation = $state<{ path: string; projectName?: string; sequence: number }>({ path: '', sequence: 0 });
let shownNavigation = 0;
export function claimDiscussionNavigation(sequence: number) {
	if (sequence <= shownNavigation) return false;
	shownNavigation = sequence;
	return true;
}
const DISCUSSION_DRAG = 'application/x-kemiri-artifact';
let draggedArtifact: { client: HarnessClient; artifact: Artifact } | undefined;

export function startArtifactDrag(event: DragEvent, client: HarnessClient, artifact: Artifact) {
	if (!event.dataTransfer) return;
	draggedArtifact = { client, artifact };
	event.dataTransfer.setData(DISCUSSION_DRAG, artifact.id);
	event.dataTransfer.effectAllowed = 'copy';
}

export function endArtifactDrag() { draggedArtifact = undefined; }
export function hasArtifactDrag(event: DragEvent) { return draggedArtifact !== undefined && event.dataTransfer?.types.includes(DISCUSSION_DRAG) === true; }
export function takeArtifactDrag(event: DragEvent) {
	if (!hasArtifactDrag(event)) return undefined;
	const drag = draggedArtifact;
	endArtifactDrag();
	return drag;
}

export async function discussArtifact(client: HarnessClient, artifact: Artifact, close?: () => void) {
	const backend = harness.backends.find(backend => backend.client === client);
	if (!backend) throw new Error('The artifact’s backend is unavailable.');
	const path = projectHref(backend.id, artifact.projectId);
	const projectName = page.url.pathname !== path ? backend.projects.find(project => project.id === artifact.projectId)?.name ?? 'the artifact’s project' : undefined;
	moveReviewToDraft(localStorage, window, draftKey(backend.id, artifact.projectId), discussHeader(artifact), artifact.taskId ?? undefined, true);
	close?.();
	if (page.url.pathname !== path || page.url.search || page.url.hash) await goto(path);
	Object.assign(discussionNavigation, { path, projectName, sequence: discussionNavigation.sequence + 1 });
}
