<script lang="ts">
	import XIcon from '@lucide/svelte/icons/x';
	import { selectedArtifactVersion } from '#lib/artifact-versions.js';
	import { useArtifactFeed } from '#lib/artifacts.svelte.js';
	import { isHtmlArtifact } from '#lib/artifact-preview.js';
	import type { DiscussionReference } from '#lib/artifact-discuss.js';
	import type { BackendConnection } from '#lib/harness.svelte.js';
	import ArtifactThumb from './ArtifactThumb.svelte';
	import ArtifactPageThumb from './ArtifactPageThumb.svelte';
	let { discussion, backend, projectId, onremove }: { discussion: DiscussionReference; backend: BackendConnection; projectId: string; onremove?: () => void } = $props();
	const feed = useArtifactFeed(() => ({ client: backend.client, projectId, filter: { artifactId: discussion.artifactId } }));
	const latest = $derived(feed.current?.artifacts.find(row => row.id === discussion.artifactId));
	const pinned = $derived(latest && selectedArtifactVersion(latest, discussion.version));
</script>
<div class="flex min-w-0 items-center gap-2 rounded-xl border border-(--chat-border) bg-(--chat-surface-2)/65 px-2 py-1.5 text-sm" data-discussion-chip>
	{#if pinned && (pinned.version ?? 1) === discussion.version}
		{#if isHtmlArtifact(pinned)}<span class="w-10 shrink-0 overflow-hidden rounded-md"><ArtifactPageThumb artifact={pinned} client={backend.client} /></span>
		{:else}<ArtifactThumb artifact={pinned} client={backend.client} class="h-8 w-10 rounded-md" duration={false} play={false} />{/if}
	{/if}
	<span class="min-w-0 flex-1"><strong class="block truncate font-semibold">{discussion.title}</strong><span class="block text-xs text-(--chat-fg-muted)">Version {discussion.version}</span></span>
	{#if onremove}<button type="button" onclick={onremove} aria-label="Remove artifact" class="grid size-8 shrink-0 place-items-center rounded-lg hover:bg-(--chat-surface)"><XIcon size={16}/></button>{/if}
</div>
