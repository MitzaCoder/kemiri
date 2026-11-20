<script module lang="ts">
	import type { BoardTask } from '@kemiri/protocol';
	import { reportExcerptLines } from '#lib/task-view/route/report.js';
	import { taskDetailFields } from '#lib/task-details.js';

	type ReportSection = 'summary' | 'results' | 'notDone' | 'next' | 'steps';
	type ReportExcerpt = 'full' | 'glance';

	// The Markdown bridge is local to this file. Replace both render modes when the typed report lands.
	function sectionText(task: BoardTask, section: ReportSection, taskFieldsEnabled: boolean): string {
		switch (section) {
			case 'summary': return taskFieldsEnabled ? task.report.summary?.trim() ?? '' : '';
			case 'notDone': return taskDetailFields(task, taskFieldsEnabled).notDoneMarkdown ?? '';
			default: return task.report[section]?.trim() ?? '';
		}
	}

</script>

<script lang="ts">
	import Markdown from '#lib/components/markdown/Markdown.svelte';
	import { emptyFinishedResults } from '#lib/report-freshness.js';

	let { task, section, taskFieldsEnabled, mode = 'full', showEmpty = false }: {
		task: BoardTask;
		section: ReportSection;
		taskFieldsEnabled: boolean;
		mode?: ReportExcerpt;
		showEmpty?: boolean;
	} = $props();
	const source = $derived(sectionText(task, section, taskFieldsEnabled));
	const items = $derived(reportExcerptLines(source, section === 'next' ? 1 : 3));
</script>

{#if source}
	{#if section === 'summary'}
		<p class="route-report-lead">{source}</p>
	{:else if mode === 'glance'}
		{#if section === 'next' && items.length}
			<p class="route-report-next"><strong>Next</strong> {items[0]}</p>
		{:else if items.length}
			<ul class="route-report-glance">{#each items as item}<li>{item}</li>{/each}</ul>
		{/if}
	{:else}
		{#if section === 'next'}<h3>Next</h3>{/if}
		<Markdown {source} class="task-detail-markdown route-report-markdown" />
	{/if}
{:else if showEmpty}
	<p class="route-quiet">{section === 'next' ? 'No next action written.' : emptyFinishedResults(task) ? 'No results yet · work finished' : 'Nothing written yet.'}</p>
{/if}
