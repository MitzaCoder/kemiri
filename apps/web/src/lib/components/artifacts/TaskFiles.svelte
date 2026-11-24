<script lang="ts">
	import type { HarnessClient } from '@kemiri/client';
	import type { Artifact } from '@kemiri/protocol';
	import { isHtmlArtifact } from '#lib/artifact-preview.js';
	import { splitMedia } from '#lib/media-gallery.js';
	import ArtifactDialog from './ArtifactDialog.svelte';
	import ArtifactList from './ArtifactList.svelte';
	import MediaGallery from './MediaGallery.svelte';

	/**
	 * The task's Files section: page cards first, then the image/video carousel and ordinary file rows. `onupdatetags` is given only when the backend can change tags.
	 */
	let {
		artifacts,
		client,
		projectId,
		partLabel,
		onupdatetags
	}: {
		artifacts: readonly Artifact[];
		client: HarnessClient;
		projectId: string;
		partLabel?: (artifact: Artifact) => string | undefined;
		onupdatetags?: (artifact: Artifact, tags: string[]) => Promise<void>;
	} = $props();

	const split = $derived(splitMedia(artifacts));
	let detailsId = $state<string | undefined>(undefined);
	let detailsOpen = $state(false);
	const details = $derived(artifacts.find((artifact) => artifact.id === detailsId));
</script>

<div class="flex min-w-0 flex-col gap-3" data-task-files>
	{#if split.files.some(isHtmlArtifact)}
		<ArtifactList {client} {projectId} items={split.files.filter(isHtmlArtifact)} layout="rows" collapsedCount={4} emptyText="" />
	{/if}
	{#if split.media.length > 0}
		<MediaGallery
			media={split.media}
			{partLabel}
			{client}
			{projectId}
			canEditTags={onupdatetags !== undefined}
			{onupdatetags}
			ondetails={(artifact) => {
				detailsId = artifact.id;
				detailsOpen = true;
			}}
		/>
	{/if}
	{#if split.files.length > 0}
		<ArtifactList {client} {projectId} items={split.files.filter((artifact) => !isHtmlArtifact(artifact))} layout="rows" collapsedCount={4} emptyText="" />
	{/if}
</div>

<ArtifactDialog artifact={details} {client} bind:open={detailsOpen} />
