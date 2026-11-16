<script lang="ts">
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { backgroundJobPresentation } from '#lib/threads.js';
	import type { ThreadSummary } from '@kemiri/protocol';

	/** A background job's status as a badge: a spinner while it works, red only when it failed. */
	let {
		thread,
		class: className = ''
	}: {
		thread: ThreadSummary;
		class?: string;
	} = $props();
	const presentation = $derived(backgroundJobPresentation(thread));
</script>

<Badge variant="outline" class="{presentation.tone} {className}">
	{#if presentation.label === 'Working'}
		<LoaderCircleIcon class="animate-spin" aria-hidden="true" />
	{/if}
	{presentation.label}
</Badge>
