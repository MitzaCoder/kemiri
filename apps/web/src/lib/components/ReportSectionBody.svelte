<!--
	Render one report section's body from { section, markdown, class? }.
	The host supplies the heading and placement. No task or sheet state is required.
-->
<script lang="ts">
	import { shapeLegacyReport, type LegacyReportSection } from '#lib/report-legacy-shape.js';
	import Markdown from './markdown/Markdown.svelte';

	let { section, markdown, class: className = '' }: {
		section: LegacyReportSection;
		markdown: string;
		class?: string;
	} = $props();
	const segments = $derived(shapeLegacyReport(section, markdown));
</script>

<div class="report-section-body {className}">
	{#each segments as segment}
		{#if segment.kind === 'markdown'}
			<Markdown source={segment.source} class="report-section-markdown" />
		{:else if segment.kind === 'rows'}
			<ul class="report-rows" role="list">
				{#each segment.items as item}
					<li><Markdown source={item} inline class="report-section-markdown" /></li>
				{/each}
			</ul>
		{:else}
			<dl class="report-labeled-rows">
				{#each segment.rows as row}
					<div class="report-labeled-row">
						<dt>{row.label}:</dt>
						<dd><Markdown source={row.value} inline class="report-section-markdown" /></dd>
					</div>
				{/each}
			</dl>
		{/if}
	{/each}
</div>

<style>
	.report-section-body {
		container: report-section / inline-size;
		display: flex;
		flex-direction: column;
		gap: 1em;
		/* About 70 characters of prose in the app font, whose digits are wider than prose. */
		max-inline-size: 34em;
		min-inline-size: 0;
		line-height: var(--task-summary-line-height, 1.6);
		overflow-wrap: anywhere;
	}
	.report-section-body :global(.report-section-markdown) {
		font-size: inherit;
		line-height: inherit;
	}
	.report-rows, .report-labeled-rows {
		display: grid;
		gap: 0.65em;
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.report-labeled-row {
		display: grid;
		grid-template-columns: minmax(0, 10em) minmax(0, 1fr);
		gap: 0.15em 1em;
	}
	.report-labeled-row dt {
		font-weight: 650;
		color: var(--chat-fg-muted);
	}
	.report-labeled-row dd { margin: 0; }
	@container report-section (max-width: 32rem) {
		.report-labeled-row { grid-template-columns: minmax(0, 1fr); }
	}
</style>
