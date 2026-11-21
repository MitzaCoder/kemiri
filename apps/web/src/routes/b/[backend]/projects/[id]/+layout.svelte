<script lang="ts">
	import { page } from '$app/state';
	import ProjectChats from '#lib/components/ProjectChats.svelte';
	import { harness } from '#lib/harness.svelte.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
	const backendId = $derived(page.params.backend ?? '');
	const projectId = $derived(page.params.id ?? '');
	const backend = $derived(harness.backend(backendId));
	const chatRoute = $derived(page.route.id === '/b/[backend]/projects/[id]' || page.route.id === '/b/[backend]/projects/[id]/threads/[threadId]');
</script>

{#if chatRoute && backend}
	{#key `${backendId}:${projectId}`}
		<ProjectChats {backend} {projectId} threadId={page.params.threadId} />
	{/key}
{/if}
{@render children()}
