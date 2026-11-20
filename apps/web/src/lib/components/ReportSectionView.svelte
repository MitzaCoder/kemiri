<script lang="ts">
	import type { HarnessClient } from '@kemiri/client';
	import type { ReportSectionView } from '@kemiri/protocol';
	import { onMount } from 'svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { readArtifactTheme, type ArtifactPageTheme } from '#lib/artifact-page.js';
	import { SECTION_VIEW_FRAME_POLICY, fetchReportSectionView, sectionViewDocument, type SanitizedSectionView } from '#lib/report-section-view.js';

	let { client, projectId, view }: { client: HarnessClient; projectId: string; view: ReportSectionView } = $props();
	const previewId = $props.id();
	let expanded = $state(false);
	let large = $state(false);
	let unavailable = $state(false);
	let sanitized = $state<SanitizedSectionView>();
	let theme = $state<ArtifactPageTheme>({ mode: 'light', tokens: {} });
	let largerButton = $state<HTMLButtonElement | null>(null);
	const srcdoc = $derived(sanitized && sectionViewDocument(sanitized, theme));

	onMount(() => {
		const update = () => { theme = readArtifactTheme(); };
		update();
		const observer = new MutationObserver(update);
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
		return () => observer.disconnect();
	});

	$effect(() => {
		if (!expanded || sanitized) return;
		const controller = new AbortController();
		const { signal } = controller;
		const read = fetchReportSectionView(client, projectId, view, location.origin, signal);
		void Promise.all([read, import('#lib/report-section-sanitizer.js')]).then(([source, { sanitizeReportSectionView }]) => {
			if (!signal.aborted) sanitized = sanitizeReportSectionView(source);
		}).catch(() => { if (!signal.aborted) unavailable = true; });
		return () => controller.abort();
	});
</script>

{#snippet frame(frameDocument: string, roomy: boolean)}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex (the bounded preview supports keyboard scrolling) -->
	<iframe {...SECTION_VIEW_FRAME_POLICY} srcdoc={frameDocument} title={`${view.label} (HTML view)`}
		class:roomy tabindex="0"></iframe>
{/snippet}

<div class="section-view">
	<Button variant="outline" aria-expanded={expanded} aria-controls={previewId} onclick={() => {
		unavailable = false;
		expanded = !expanded;
	}}>{expanded ? 'Close preview' : view.label}</Button>
	<div id={previewId} hidden={!expanded}>
		{#if unavailable}
			<p class="text-muted-foreground" role="status">View unavailable</p>
		{:else if srcdoc && expanded}
			<Dialog.Root bind:open={large}>
				<div class="preview-actions">
					<Button bind:ref={largerButton} variant="ghost" size="sm" onclick={() => { large = true; }}>Open larger view</Button>
				</div>
				{#if !large}{@render frame(srcdoc, false)}{/if}
				<Dialog.Content class="sm:max-w-5xl overflow-hidden" onCloseAutoFocus={(event) => {
					event.preventDefault();
					largerButton?.focus();
				}}>
					<Dialog.Title class="pr-10">{view.label}</Dialog.Title>
					<Dialog.Description class="sr-only">Supplemental HTML view. Tab out of the preview to close this dialog.</Dialog.Description>
					{@render frame(srcdoc, true)}
				</Dialog.Content>
			</Dialog.Root>
		{:else if expanded}
			<p class="text-muted-foreground" role="status">Loading view…</p>
		{/if}
	</div>
</div>

<style>
	.section-view { min-inline-size: 0; max-inline-size: 100%; margin-block-start: 1rem; }
	.section-view :global(button) { max-inline-size: 100%; height: auto; min-height: 2.75rem; white-space: normal; overflow-wrap: anywhere; }
	.section-view p { margin-block: .5rem; }
	.preview-actions { display: flex; justify-content: end; }
	iframe { display: block; inline-size: 100%; min-inline-size: 0; block-size: clamp(12rem, 38dvh, 22rem); border: 1px solid var(--tone-border); border-radius: .5rem; }
	iframe.roomy { block-size: min(68dvh, 44rem); }
	iframe:focus-visible { outline: 2px solid var(--tone-ring); outline-offset: 2px; }
</style>
