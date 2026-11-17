<script lang="ts">
	import type { Artifact } from '@kemiri/protocol';
	import type { HarnessClient } from '@kemiri/client';
	import { onMount } from 'svelte';
	import { PAGE_PREVIEW_BYTES, pagePreviewPool } from '#lib/page-preview.js';
	import { ARTIFACT_FRAME_SANDBOX } from '#lib/artifact-preview.js';
	import { artifactPageDocument, readArtifactTheme, type ArtifactPageTheme } from '#lib/artifact-page.js';
	import { artifactTitle } from '#lib/artifacts.js';
	import { readArtifactText } from '#lib/artifact-text.js';
	import { useArtifactSource } from '#lib/artifacts.svelte.js';
	import { harness } from '#lib/harness.svelte.js';
	let { artifact, client }: { artifact: Artifact; client: HarnessClient } = $props();
	let root = $state<HTMLElement>();
	let visible = $state(false);
	let permitted = $state(false);
	let content = $state<string>();
	let problem = $state(false);
	let width = $state(320);
	let theme = $state<ArtifactPageTheme>({ mode: 'light', tokens: {} });
	const project = $derived(harness.backends.find((backend) => backend.client === client)?.projects.find((project) => project.id === artifact.projectId));
	const blockRequests = $derived(project === undefined || project.blockArtifactRequests === true);
	const document = $derived(content === undefined ? '' : artifactPageDocument(content, theme, blockRequests, true, false));
	const source = useArtifactSource(() => permitted ? { client, projectId: artifact.projectId, artifactId: artifact.id } : undefined);
	onMount(() => {
		const update = () => { theme = readArtifactTheme(); };
		update();
		const tones = new MutationObserver(update);
		tones.observe(window.document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
		const intersection = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting === true; });
		const resize = new ResizeObserver(([entry]) => { if (entry) width = entry.contentRect.width; });
		if (root) { intersection.observe(root); resize.observe(root); }
		return () => { tones.disconnect(); intersection.disconnect(); resize.disconnect(); };
	});
	$effect(() => {
		if (!visible) { content = undefined; return; }
		const release = pagePreviewPool.reserve(() => { permitted = true; });
		return () => { permitted = false; release(); };
	});
	$effect(() => {
		const url = source.current?.url;
		if (!permitted || !url) return;
		const controller = new AbortController();
		content = undefined; problem = false;
		void readArtifactText(url, artifact.size, controller.signal, fetch, PAGE_PREVIEW_BYTES).then((preview) => {
			if (!controller.signal.aborted) { content = preview.truncated ? undefined : preview.content; problem = preview.truncated; }
		}).catch(() => { if (!controller.signal.aborted) problem = true; });
		return () => controller.abort();
	});
</script>

<span bind:this={root} class="page-thumb" aria-hidden="true" data-page-thumb>
	<span class="placeholder">{problem ? 'Preview unavailable · open page' : 'Page'}</span>
	{#if permitted && content !== undefined}
		<iframe title="Preview of {artifactTitle(artifact)}" srcdoc={document} sandbox={ARTIFACT_FRAME_SANDBOX} referrerpolicy="no-referrer" scrolling="no" tabindex="-1" inert style:transform="scale({width / 800})"></iframe>
	{/if}
</span>

<style>
	.page-thumb { display: block; position: relative; width: 100%; max-width: 32rem; aspect-ratio: 16 / 9; overflow: hidden; background: var(--chat-surface-2); }
	.placeholder { position: absolute; inset: 0; display: grid; place-items: center; font-size: .75rem; color: var(--chat-fg-subtle); }
	iframe { position: absolute; inset: 0 auto auto 0; width: 800px; height: 450px; border: 0; transform-origin: top left; pointer-events: none; }
</style>
