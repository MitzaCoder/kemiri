<script lang="ts">
	import type { BoardTask, ReportBlockSection } from '@kemiri/protocol';
	import ReportSection from '#lib/components/ReportSection.svelte';

	let { task, section }: { task: BoardTask; section: ReportBlockSection } = $props();
</script>

{#if section === 'summary'}
	<div class="route-report-lead"><ReportSection {task} {section} /></div>
{:else}
	<ReportSection {task} {section} class="route-report-markdown" />
{/if}
