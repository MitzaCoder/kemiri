<!--
	{ task, section, class? }: render one report body from the task's ID and report.
	The host owns the section heading, its anchor and its placement. Proof uses the standard
	project artifact context if provided; the report and captions do not require it.
-->
<script lang="ts">
	import type { Artifact, ReportBlock, ReportBlockSection } from '@kemiri/protocol';
	import { artifactScope, useArtifactFeed } from '#lib/artifacts.svelte.js';
	import { artifactTitle } from '#lib/artifacts.js';
	import { isMedia } from '#lib/media-gallery.js';
	import { readReportSection, reportBlockGroups, reportProofArtifact, type TaskReportSections } from '#lib/report-sections.js';
	import ReportSectionBody from './ReportSectionBody.svelte';
	import ArtifactDialog from './artifacts/ArtifactDialog.svelte';
	import ArtifactThumb from './artifacts/ArtifactThumb.svelte';
	import Markdown from './markdown/Markdown.svelte';
	import ReportStepCopy from './ReportStepCopy.svelte';

	let { task, section, class: className = '' }: {
		task: { id: string; report: TaskReportSections };
		section: ReportBlockSection;
		class?: string;
	} = $props();
	const content = $derived(readReportSection(task.report, section));
	const scope = artifactScope();
	const artifactConnection = $derived(scope?.());
	const proofFeed = useArtifactFeed(() => artifactConnection?.available && content.kind === 'blocks' &&
		content.blocks.some(block => block.kind === 'proof')
		? { client: artifactConnection.client, projectId: artifactConnection.projectId, filter: { taskId: task.id } }
		: undefined);
	let preview = $state<Artifact>();
	let previewOpen = $state(false);
</script>

{#snippet prose(text: string)}<Markdown source={text} inline class="report-block-prose" />{/snippet}

{#snippet reportBlock(block: ReportBlock)}
	{#if block.kind === 'outcome'}
		<div class:summary-lead={section === 'summary'}>{@render prose(block.text)}</div>
	{:else if block.kind === 'finding' || block.kind === 'risk'}
		{#if block.kind === 'risk' && section === 'results'}<div class="report-label">Caveat</div>{/if}
		<h3 class="block-title">{block.title}</h3>
		{@render prose(block.text)}
	{:else if block.kind === 'setup'}
		<div class="report-setup">
			<h3 class="block-title">{block.title}</h3>
			<dl>
				{#each block.facts as fact}
					<div><dt>{fact.label}</dt><dd>{fact.value}</dd></div>
				{/each}
			</dl>
		</div>
	{:else if block.kind === 'proof'}
		{@const artifact = reportProofArtifact(block, proofFeed.current?.artifacts ?? [])}
		<figure class="report-proof">
			{#if artifact && artifactConnection}
				<button type="button" class="proof-button" class:proof-media={isMedia(artifact)}
					aria-label="Open proof: {artifactTitle(artifact)}" onclick={() => { preview = artifact; previewOpen = true; }}>
					{#if isMedia(artifact)}
						<ArtifactThumb {artifact} client={artifactConnection.client} class="aspect-[8/5] w-full rounded-t-lg" />
					{/if}
					<span>{artifactTitle(artifact)}</span>
				</button>
			{:else}
				<p class="report-label">{proofFeed.current && !proofFeed.current.loaded ? 'Loading proof…' : 'Proof file unavailable'}</p>
			{/if}
			<figcaption>{@render prose(block.text)}</figcaption>
		</figure>
	{:else if block.kind === 'cleanup'}
		<div class="report-cleanup"><span class="report-label">Cleaned up:</span> {@render prose(block.text)}</div>
	{:else if block.kind === 'metric'}
		<div class="report-metric">
			<div class="metric-value">{block.value}{#if block.unit}<span>{` ${block.unit}`}</span>{/if}</div>
			<p class="block-title">{block.label}</p>
			{#if block.context}{@render prose(block.context)}{/if}
		</div>
	{:else if block.kind === 'step'}
		{@render prose(block.text)}
		{#if block.copyText !== undefined}<ReportStepCopy text={block.copyText} language={block.language} />{/if}
	{:else if block.kind === 'nextAction'}
		<div>{@render prose(block.text)}</div>
	{:else if block.kind === 'markdown'}
		<Markdown source={block.text} class="report-block-prose" />
	{/if}
{/snippet}

{#if content.kind === 'blocks'}
	<div class="report-blocks {className}">
		{#each reportBlockGroups(content.blocks) as group}
			{#if group.kind === 'finding' || group.kind === 'risk'}
				<ul class="report-titled-rows" role="list">{#each group.blocks as block}<li>{@render reportBlock(block)}</li>{/each}</ul>
			{:else if group.kind === 'step'}
				<ol class="report-steps">{#each group.blocks as block}<li>{@render reportBlock(block)}</li>{/each}</ol>
			{:else if group.kind === 'metric' || group.kind === 'nextAction'}
				<div class:report-metrics={group.kind === 'metric'} class:report-actions={group.kind === 'nextAction'}>
					{#each group.blocks as block}{@render reportBlock(block)}{/each}
				</div>
			{:else}
				{#each group.blocks as block}{@render reportBlock(block)}{/each}
			{/if}
		{/each}
	</div>
	{#if artifactConnection && preview?.taskId === task.id && preview.projectId === artifactConnection.projectId}
		<ArtifactDialog artifact={preview} client={artifactConnection.client} bind:open={previewOpen} />
	{/if}
{:else}
	<ReportSectionBody {section} markdown={content.markdown} class={className} />
{/if}

<style>
	.report-blocks {
		container: report-blocks / inline-size;
		display: grid;
		gap: 1em;
		min-inline-size: 0;
		max-inline-size: 34em;
		line-height: 1.6;
		overflow-wrap: anywhere;
	}
	.report-blocks :global(.report-block-prose) { font-size: inherit; line-height: inherit; }
	.summary-lead { font-size: 1.125em; font-weight: 600; }
	.block-title { font-weight: 700; margin: 0; }
	.report-label { color: var(--chat-fg-muted); font-size: .875em; font-weight: 600; }
	.report-titled-rows, .report-steps, .report-actions { display: grid; gap: .65em; margin: 0; }
	.report-titled-rows { list-style: none; padding: 0; }
	.report-steps { list-style: decimal; padding-inline-start: 1.6em; }
	.report-steps li { min-inline-size: 0; padding-inline-start: .2em; }
	.report-steps li::marker { color: var(--chat-fg-muted); font-weight: 650; }
	.report-setup {
		padding: .65em .85em;
		border: 1px solid var(--chat-border);
		border-radius: var(--radius-lg);
		background: var(--chat-surface-2);
	}
	.report-setup dl { margin: .35em 0 0; display: grid; gap: .3em; }
	.report-setup dl > div { display: grid; grid-template-columns: minmax(0, 9em) minmax(0, 1fr); column-gap: .8em; }
	.report-setup dt { color: var(--chat-fg-muted); }
	.report-setup dd { margin: 0; }
	@container report-blocks (max-width: 23rem) {
		.report-setup dl { gap: .45em; }
		.report-setup dl > div { grid-template-columns: minmax(0, 1fr); }
		.report-setup dt { line-height: 1.3; }
	}
	.report-proof { display: grid; justify-items: start; gap: .35em; margin: 0; }
	.proof-button {
		display: grid;
		min-block-size: 2.75rem;
		max-inline-size: 100%;
		align-items: center;
		border: 1px solid var(--chat-border-strong);
		border-radius: var(--radius-lg);
		text-align: start;
		font-weight: 600;
	}
	.proof-button span { padding: .35em .75em; }
	.proof-media { inline-size: 15em; }
	.proof-button:hover { border-color: var(--accent-2); }
	.proof-button:focus-visible { outline: 2px solid var(--chat-ring); outline-offset: 2px; }
	.report-cleanup :global(.report-block-prose) { display: inline; }
	.report-cleanup .report-label { margin-inline-end: .4em; }
	.report-metrics { display: flex; flex-wrap: wrap; gap: .75em 1em; }
	.report-metric { flex: 1 1 10em; min-inline-size: 0; border-inline-start: 1px solid var(--chat-border-strong); padding-inline-start: .75em; }
	.metric-value { font-size: 1.5em; line-height: 1.25; font-weight: 700; font-variant-numeric: tabular-nums; }
	.metric-value span { font-size: .65em; font-weight: 500; }
</style>
