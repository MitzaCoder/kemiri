<script lang="ts">
	import FileCodeIcon from '@lucide/svelte/icons/file-code';
	import type { Artifact } from '@kemiri/protocol';
	import type { HarnessClient } from '@kemiri/client';
	import { artifactTitle } from '#lib/artifacts.js';
	import { useArtifactSource } from '#lib/artifacts.svelte.js';
	import { inView } from '#lib/in-view.js';

	let { artifact, client, class: className = 'aspect-video w-full', fit = 'cover' }: { artifact: Artifact; client: HarnessClient; class?: string; fit?: 'cover' | 'contain' } = $props();
	let visible = $state(false);
	let loadedUrl = $state<string>();
	let failedUrl = $state<string>();
	const address = $derived(artifact.version && !artifact.id.includes('~') ? `${artifact.id}~${artifact.version}` : artifact.id);
	const source = useArtifactSource(() => visible && client.state.features?.includes('artifact-thumbnails') ? { client, projectId: artifact.projectId, artifactId: address } : undefined);
	const preview = $derived.by(() => {
		if (!source.current?.url) return undefined;
		const url = new URL(source.current.url, window.location.origin);
		url.searchParams.set('preview', '1');
		return url.href;
	});
</script>

<span class="page-thumb relative grid shrink-0 place-items-center overflow-hidden bg-(--chat-surface-2) {className}" use:inView={() => visible = true} aria-hidden="true" data-page-thumb>
	<span class="flex min-w-0 max-w-full items-center justify-center gap-1.5 px-1.5 text-[0.625rem] font-medium text-(--chat-fg-muted)">
		<FileCodeIcon class="size-3 shrink-0" /><span class="truncate">{artifactTitle(artifact)}</span>
	</span>
	{#if preview && preview !== failedUrl}
		{#key preview}
			<img src={preview} alt="" decoding="async" loading="lazy" draggable="false" referrerpolicy="no-referrer"
				class="absolute inset-0 size-full bg-white {fit === 'contain' ? 'object-contain' : 'object-cover object-top'}" class:opacity-0={loadedUrl !== preview}
				onload={() => loadedUrl = preview} onerror={() => failedUrl = preview} />
		{/key}
	{/if}
</span>
