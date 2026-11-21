<script lang="ts">
	import { EditorState, Text } from '@codemirror/state';
	import { untrack } from 'svelte';
	import { commentOnVisibleCode, drawLineReview, lineReviewExtensions, reviewLineNumbers, type LineReviewTarget } from './line-review-editor.js';
	import type { CodeSide } from './code-review.js';
	import { EditorView, ViewPlugin, keymap } from '@codemirror/view';
	import { getChunks, goToNextChunk, goToPreviousChunk, MergeView, unifiedMergeView } from '@codemirror/merge';
	import { MediaQuery } from 'svelte/reactivity';
	import { Button } from '#lib/components/ui/button/index.js';
	import { codeLanguageForPath } from './languages.js';
	import { loadCodeLanguage } from './language-extensions.js';
	import { readonlyCodeExtensions } from './readonly-editor.js';
	import { comparisonState, type ComparisonText } from './artifact-comparison.js';

	let { before, after, path, beforeLabel, afterLabel, layout, lineReview }: {
		before: ComparisonText; after: ComparisonText; path: string; beforeLabel: string; afterLabel: string; layout?: 'unified' | 'split'; lineReview?: LineReviewTarget;
	} = $props();
	const wide = new MediaQuery('(min-width: 768px)');
	let preferSplit = $state(false);
	const split = $derived(layout !== undefined ? layout === 'split' : wide.current && preferSplit);
	const comparison = $derived(comparisonState(before, after));
	let host = $state<HTMLDivElement>();
	let editor = $state.raw<EditorView>();
	let beforeEditor = $state.raw<EditorView>();
	const phone = new MediaQuery('(max-width: 640px)');
	let precise = $state(true);
	let count = $state(0);
	let navigation = $state('');
	let ready = $state(false);
	let failed = $state(false);
	const diffConfig = { scanLimit: 500, timeout: 100 };
	const collapseUnchanged = { margin: 3, minSize: 4 };
	// Merge's built-in collapse widget is clickable but is not keyboard-focusable.
	const accessibleCollapse = ViewPlugin.fromClass(class {
		readonly observer: MutationObserver;
		constructor(view: EditorView) {
			const labelWidgets = () => {
				for (const widget of view.dom.querySelectorAll<HTMLElement>('.cm-collapsedLines:not([role])')) {
					widget.tabIndex = 0;
					widget.setAttribute('role', 'button');
					widget.setAttribute('aria-label', `Show ${widget.textContent}`);
					const show = document.createElement('span');
					show.className = 'cm-showUnchanged';
					show.textContent = ' · Show';
					show.style.pointerEvents = 'none';
					widget.append(show);
					widget.addEventListener('keydown', event => {
						if (event.key !== 'Enter' && event.key !== ' ') return;
						event.preventDefault();
						event.stopPropagation();
						view.focus();
						widget.click();
					});
				}
			};
			this.observer = new MutationObserver(labelWidgets);
			this.observer.observe(view.dom, { childList: true, subtree: true });
			labelWidgets();
		}
		destroy() { this.observer.disconnect(); }
	});

	$effect(() => {
		const parent = host, oldText = before.content, newText = after.content, showSplit = split;
		const oldLabel = beforeLabel, newLabel = afterLabel, language = codeLanguageForPath(path), target = lineReview;
		if (!parent) return;
		let disposed = false;
		let destroy: (() => void) | undefined;
		navigation = '';
		ready = false;
		failed = false;
		void loadCodeLanguage(language).then(extension => {
			if (disposed) return;
			const extensions = (label: string, side: CodeSide) => readonlyCodeExtensions(label, extension, [EditorView.lineWrapping, accessibleCollapse,
				keymap.of([{ key: 'Alt-ArrowDown', run: goToNextChunk }, { key: 'Alt-ArrowUp', run: goToPreviousChunk }]),
				...(target ? [lineReviewExtensions(target, side, !showSplit)] : [])], target ? reviewLineNumbers(target, side) : undefined);
			if (showSplit) {
				const merge = new MergeView({ parent,
					a: { doc: oldText, extensions: extensions(oldLabel, 'before') }, b: { doc: newText, extensions: extensions(newLabel, 'after') },
					diffConfig, collapseUnchanged, gutter: true });
				editor = merge.b;
				beforeEditor = merge.a;
				destroy = () => merge.destroy();
			} else {
				const view = new EditorView({ parent, state: EditorState.create({ doc: newText, extensions: [
					extensions(`${oldLabel} to ${newLabel}, unified changes`, 'after'),
					unifiedMergeView({ original: oldText, diffConfig, collapseUnchanged, mergeControls: false, gutter: true }),
				] }) });
				editor = view;
				destroy = () => view.destroy();
			}
			const chunks = getChunks(editor.state)?.chunks ?? [];
			if (target) {
				target.session.reconcile(target.source, path, 'before', target.disabledSides?.includes('before') ? undefined : Text.of(oldText.split(/\r\n?|\n/)), target.previousPath);
				target.session.reconcile(target.source, path, 'after', target.disabledSides?.includes('after') ? undefined : editor.state.doc, target.previousPath);
			}
			count = chunks.length;
			precise = chunks.every(chunk => chunk.precise);
			ready = true;
		}).catch(() => { if (!disposed) failed = true; });
		return () => { disposed = true; destroy?.(); editor = undefined; beforeEditor = undefined; };
	});

	$effect(() => {
		const target = lineReview, view = editor, oldView = beforeEditor, isPhone = phone.current, unified = !split;
		if (!target || !view) return;
		target.session.comments; target.session.editor?.id; target.session.editor?.anchor; target.session.editor?.outdated;
		untrack(() => {
			drawLineReview(view, target, 'after', isPhone, unified);
			if (oldView) drawLineReview(oldView, target, 'before', isPhone);
		});
	});

	function goToChange(direction: 'previous' | 'next') {
		const view = editor;
		if (!view) return;
		const go = direction === 'previous' ? goToPreviousChunk : goToNextChunk;
		if (go(view)) {
			navigation = `Change at ${afterLabel}, line ${view.state.doc.lineAt(view.state.selection.main.head).number}.`;
			return;
		}
		navigation = direction === 'previous' ? 'No previous change.' : 'No next change.';
	}
</script>

{#snippet plainVersions()}
	<div class="plain-versions">
		{#each [{ ...before, label: beforeLabel }, { ...after, label: afterLabel }] as preview (preview.label)}
			<section class="min-w-0">
				<h3 class="mb-1 text-sm font-medium">{preview.label}{preview.truncated ? ' · preview truncated' : ''}</h3>
				<!-- svelte-ignore a11y_no_noninteractive_tabindex (the scrollable preview needs keyboard focus) -->
				<pre class="max-h-[50dvh] overflow-auto whitespace-pre-wrap break-all rounded border border-(--chat-border) p-3 text-xs" tabindex="0">{preview.content}</pre>
			</section>
		{/each}
	</div>
{/snippet}

{#if comparison === 'too-large' || failed}
	<p class="px-4 py-2 text-sm" role="status">{failed ? 'The comparison could not be drawn.' : 'These versions exceed the comparison limits.'} Showing plain text previews instead.</p>
	{@render plainVersions()}
{:else if comparison === 'same' && !lineReview}
	<p class="px-4 py-8 text-sm" role="status">{layout ? 'There are no text changes in this file.' : 'There are no text changes between these versions.'}</p>
{:else}
	<div class="comparison-controls" role="group" aria-label="Compare controls">
		<span class="mr-auto px-1 text-xs text-(--chat-fg-muted)" role="status">{ready ? `${count} ${count === 1 ? 'change' : 'changes'}${precise ? '' : ' · approximate'}` : 'Calculating changes…'}</span>
		{#if layout === undefined && wide.current}
			<Button size="sm" variant="ghost" aria-pressed={!split} onclick={() => preferSplit = false}>Unified</Button>
			<Button size="sm" variant="ghost" aria-pressed={split} onclick={() => preferSplit = true}>Split</Button>
		{/if}
		{#if lineReview}<Button size="sm" variant="ghost" disabled={!ready} title="Comment on selected or first visible lines (Alt+C)" aria-keyshortcuts="Alt+C" onclick={() => {
			const old = beforeEditor?.hasFocus || lineReview?.disabledSides?.includes('after');
			const view = old ? beforeEditor ?? editor : editor;
			if (view && lineReview) commentOnVisibleCode(view, lineReview, old && beforeEditor ? 'before' : 'after');
		}}>Comment</Button>{/if}
		<Button size="sm" variant="ghost" disabled={!ready} onclick={() => goToChange('previous')} aria-label="Previous change" title="Previous change (Alt+↑)">↑ Previous</Button>
		<Button size="sm" variant="ghost" disabled={!ready} onclick={() => goToChange('next')} aria-label="Next change" title="Next change (Alt+↓)">↓ Next</Button>
	</div>
	<p class="sr-only" role="status">{navigation}</p>
	{#if split}<div class="version-headings" aria-hidden="true"><span>{beforeLabel}</span><span>{afterLabel}</span></div>{/if}
	<div class="comparison-content" class:split bind:this={host}></div>
{/if}

<style>
	.comparison-controls, .version-headings { display: flex; flex-wrap: wrap; align-items: center; gap: 3px; padding: 4px 10px; background: var(--chat-surface); border-bottom: 1px solid var(--chat-border); }
	.version-headings span { flex: 1; padding: 0 8px; color: var(--chat-fg-muted); font-size: 12px; }
	.comparison-content { min-height: 0; flex: 1; }
	.comparison-content.split { overflow: auto; background: var(--code-view-bg, white); }
	:global(.dark) .comparison-content.split { --code-view-bg: var(--chat-bg); }
	.comparison-content.split :global(.cm-mergeView) { overflow: visible; }
	.comparison-content :global(.cm-merge-a .cm-changedLineGutter::after), .comparison-content :global(.cm-deletedLineGutter::after) { content: '−'; color: var(--chat-danger); }
	.comparison-content :global(.cm-merge-b .cm-changedLineGutter::after) { content: '+'; color: var(--chat-success); }
	.comparison-controls :global(button[aria-pressed='true']) { background: var(--chat-surface-2); color: var(--chat-fg); }
	.comparison-content :global(.cm-changeGutter) { width: 1.4ch !important; }
	.comparison-content :global(.cm-changedLineGutter), .comparison-content :global(.cm-deletedLineGutter) { width: 1.4ch; background: none !important; }
	/* The deleted widget uses the same text inset as a normal CodeMirror line. */
	.comparison-content :global(.cm-deletedChunk) { padding-inline: 8px 10px; }
	.comparison-content :global(.cm-showUnchanged) { font-weight: 700; }
	.comparison-content :global(.cm-mergeSpacer) { background: repeating-linear-gradient(135deg, transparent 0 5px, var(--chat-border) 5px 6px); }
	.plain-versions { overflow: auto; display: grid; gap: 8px; padding: 8px 16px 16px; }
	@media (min-width: 768px) { .plain-versions { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
	@media (max-width: 640px), (pointer: coarse) { .comparison-controls :global(button) { min-height: 44px; } }
</style>
