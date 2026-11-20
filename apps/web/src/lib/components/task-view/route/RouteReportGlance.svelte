<script lang="ts">
	import type { BoardTask } from '@kemiri/protocol';
	import { reportGlance } from '#lib/report-glance.js';

	let { task, door, taskFieldsEnabled, showNext = false }: {
		task: BoardTask;
		door: 'arrived' | 'ahead';
		taskFieldsEnabled: boolean;
		showNext?: boolean;
	} = $props();
	const glance = $derived(reportGlance(task, taskFieldsEnabled));
	const lines = $derived(door === 'arrived' ? glance.findingTitles : [...glance.riskTitles, ...(glance.legacyNotDone ? [glance.legacyNotDone] : [])]);
</script>

{#if door === 'arrived' && glance.firstOutcome}<p class="route-report-lead">{glance.firstOutcome}</p>{/if}
{#if lines.length}<ul class="route-report-glance" role="list">{#each lines.slice(0, 3) as line}<li>{line}</li>{/each}</ul>{/if}
{#if door === 'ahead' && showNext && glance.firstNextAction}
	<p class="route-report-next"><strong>Next</strong> {glance.firstNextAction}</p>
{/if}
