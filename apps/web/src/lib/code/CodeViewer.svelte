<script lang="ts">
	import { Compartment, EditorState } from '@codemirror/state';
	import { EditorView } from '@codemirror/view';
	import { openSearchPanel } from '@codemirror/search';
	import { untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { commentOnVisibleCode, drawLineReview, lineReviewExtensions, reviewLineNumbers, type LineReviewTarget } from './line-review-editor.js';
	import CopyButton from '#lib/components/CopyButton.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import { codeLanguageForPath } from './languages.js';
	import { loadCodeLanguage } from './language-extensions.js';
	import { readonlyCodeExtensions } from './readonly-editor.js';
	import { sourceOffsets, sourceSelection, type SourceReview } from './source-review.js';

	let { text, path, languageHint, compact = false, roomy = false, review = $bindable(), oncomment, ongeometry, lineReview }: {
		text: string; path: string; languageHint?: string; compact?: boolean; roomy?: boolean; review?: SourceReview;
		oncomment?: () => void; ongeometry?: () => void; lineReview?: LineReviewTarget;
	} = $props();
	const phone = new MediaQuery('(max-width: 640px)');
	let host = $state<HTMLDivElement>();
	let editor = $state.raw<EditorView>();
	let wrap = $state(true);
	let hasSelection = $state(false);
	const wrapExtension = new Compartment();
	const languageExtension = new Compartment();
	const language = $derived(languageHint ?? codeLanguageForPath(path));

	$effect(() => {
		const parent = host;
		const source = text;
		const label = `${path} source`;
		const target = lineReview;
		if (!parent) return;
		const offsets = sourceOffsets(source);
		let lastSelection: { from: number; to: number } | undefined;
		const view = new EditorView({ parent, state: EditorState.create({ doc: source, extensions: readonlyCodeExtensions(label, languageExtension.of([]), [
			...(target ? [lineReviewExtensions(target, 'file')] : []),
			wrapExtension.of(untrack(() => wrap) ? EditorView.lineWrapping : []),
			EditorView.updateListener.of(update => {
				if (update.selectionSet) hasSelection = !update.state.selection.main.empty;
				if (update.geometryChanged || update.viewportChanged) ongeometry?.();
			}),
		], target ? reviewLineNumbers(target, 'file') : undefined) }) });
		const position = (anchor: string) => {
			if (!/^s:\d{1,9}$/.test(anchor)) return;
			const offset = Number(anchor.slice(2));
			if (offset < source.length) return offsets.normalizedOffset(offset);
		};
		editor = view;
		if (target) untrack(() => target.session.reconcile(target.source, target.path, 'file', view.state.doc));
		hasSelection = false;
		review = {
			selection() {
				const { from, to } = view.state.selection.main;
				lastSelection = { from, to };
				return sourceSelection(view.state.doc, from, to, offsets.originalOffset);
			},
			rect(anchor) {
				const at = anchor ? position(anchor) : lastSelection?.from;
				if (at === undefined || !view.visibleRanges.some(range => at >= range.from && at <= range.to)) return;
				const coords = view.coordsAtPos(at);
				if (!coords) return;
				const bounds = parent.getBoundingClientRect();
				return { x: bounds.left, y: coords.top, width: bounds.width, height: coords.bottom - coords.top };
			},
			reveal(anchor) {
				const at = position(anchor);
				if (at !== undefined) view.dispatch({ effects: EditorView.scrollIntoView(at, { y: 'center' }) });
			},
			clearSelection() {
				lastSelection = undefined;
				view.dispatch({ selection: { anchor: view.state.selection.main.head } });
			},
		};
		return () => { view.destroy(); editor = undefined; review = undefined; };
	});
	$effect(() => {
		const view = editor;
		const requested = language;
		if (!view) return;
		let disposed = false;
		void loadCodeLanguage(requested).then(extension => {
			if (!disposed) view.dispatch({ effects: languageExtension.reconfigure(extension) });
		});
		return () => { disposed = true; };
	});
		$effect(() => {
		const target = lineReview, view = editor, isPhone = phone.current;
		if (!target || !view) return;
		target.session.comments; target.session.editor?.id; target.session.editor?.anchor; target.session.editor?.outdated;
		untrack(() => drawLineReview(view, target, 'file', isPhone));
	});
	$effect(() => { editor?.dispatch({ effects: wrapExtension.reconfigure(wrap ? EditorView.lineWrapping : []) }); });
</script>

<div class="code-viewer" class:compact class:roomy>
	<div class="code-toolbar" role="group" aria-label="Source controls">
		<span class="mr-auto text-xs text-(--chat-fg-muted)">{language} · Read-only</span>
		<Button size="sm" variant="ghost" onclick={() => editor && openSearchPanel(editor)}>Find</Button>
		<Button size="sm" variant="ghost" aria-pressed={wrap} onclick={() => wrap = !wrap}>Wrap</Button>
		{#if lineReview}<Button size="sm" variant="ghost" aria-keyshortcuts="Alt+C" onclick={() => editor && lineReview && commentOnVisibleCode(editor, lineReview, 'file')}>Comment</Button>{:else if oncomment}<Button size="sm" variant="ghost" disabled={!hasSelection} onclick={oncomment} title="Select text to comment">Comment<span class="sr-only"> on selection</span></Button>{/if}
		<CopyButton {text} label="Copy source" />
	</div>
	<div class="code-document" bind:this={host}></div>
</div>

<style>
	.code-viewer { display: flex; flex-direction: column; height: min(60dvh, 36rem); min-width: 0; }
	.code-viewer.compact { height: 16rem; }
	.code-viewer.roomy { height: 100%; min-height: 0; }
	.code-toolbar { display: flex; flex-wrap: wrap; align-items: center; padding: 2px 8px; gap: 2px; border-bottom: 1px solid var(--chat-border); background: var(--chat-surface); }
	.code-document { flex: 1; min-width: 0; min-height: 0; }
	@media (pointer: coarse) { .code-toolbar :global(button) { min-height: 44px; } }
</style>
