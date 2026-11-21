<script lang="ts">
	import { indentWithTab, defaultKeymap, history, historyKeymap, undo, redo, undoDepth, redoDepth } from '@codemirror/commands';
	import { indentOnInput } from '@codemirror/language';
	import { openSearchPanel, search, searchKeymap } from '@codemirror/search';
	import { Compartment, EditorState, Prec, StateEffect, Text } from '@codemirror/state';
	import { drawSelection, EditorView, keymap, lineNumbers } from '@codemirror/view';
	import { Button } from '#lib/components/ui/button/index.js';
	import { codeTheme, codeHighlight } from './editor-theme.js';
	import { codeLanguageForPath } from './languages.js';
	import { loadCodeLanguage } from './language-extensions.js';
	import { untrack } from 'svelte';
	import { fileLineEndings } from './file-line-endings.js';

	let { path, text, locked, onedit, onsave }: {
		path: string; text: string; locked: boolean; onedit: (text: string) => void; onsave: () => void;
	} = $props();
	let host = $state<HTMLDivElement>();
	let editor = $state.raw<EditorView>();
	let canUndo = $state(false), canRedo = $state(false);
	const lock = new Compartment();
	function lockExtensions(disabled: boolean) { return [EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]; }
	$effect(() => {
		if (!host) return;
		const endings = fileLineEndings(untrack(() => text));
		const view = new EditorView({ parent: host, state: EditorState.create({ doc: Text.of(endings.lines), extensions: [
			lock.of(lockExtensions(untrack(() => locked))), EditorState.tabSize.of(4), EditorView.lineWrapping,
			EditorView.contentAttributes.of({ 'aria-label': `Edit ${path}`, spellcheck: 'false', autocapitalize: 'off' }),
			lineNumbers(), drawSelection(), history(), indentOnInput(), search({ top: true }), codeTheme, codeHighlight,
			Prec.highest(keymap.of([{ key: 'Mod-s', run: () => { onsave(); return true; } }])),
			keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab]),
			EditorView.updateListener.of(update => {
				if (!update.docChanged) return;
				canUndo = undoDepth(update.state) > 0;
				canRedo = redoDepth(update.state) > 0;
				onedit(endings.update(update.changes, update.startState.doc, update.state.doc));
			}),
		] }) });
		editor = view;
		let disposed = false;
		void loadCodeLanguage(codeLanguageForPath(path)).then(extension => {
			if (!disposed) view.dispatch({ effects: StateEffect.appendConfig.of(extension) });
		});
		view.focus();
		return () => { disposed = true; view.destroy(); editor = undefined; };
	});
	let restoreEditorFocus = false;
	$effect(() => {
		const view = editor;
		const disabled = locked;
		if (!view) return;
		if (disabled) restoreEditorFocus = view.hasFocus;
		view.dispatch({ effects: lock.reconfigure(lockExtensions(disabled)) });
		if (!disabled && restoreEditorFocus) {
			restoreEditorFocus = false;
			if (document.activeElement === document.body) view.focus();
		}
	});
	function run(command: (view: EditorView) => boolean) { if (editor) { command(editor); editor.focus(); } }
</script>

<div class="edit-tools" role="group" aria-label="Editing tools">
	<Button size="sm" variant="ghost" disabled={locked || !canUndo} onclick={() => run(undo)}>Undo</Button>
	<Button size="sm" variant="ghost" disabled={locked || !canRedo} onclick={() => run(redo)}>Redo</Button>
	<Button size="sm" variant="ghost" disabled={locked} onclick={() => run(openSearchPanel)}>Find / replace</Button>
</div>
<div class="edit-editor" bind:this={host}></div>

<style>
	.edit-tools { display:flex; flex-wrap:wrap; gap:4px; padding:2px 8px; border-bottom:1px solid var(--chat-border); background:var(--chat-surface); }
	.edit-editor { flex:1; min-width:0; min-height:0; }
	@media (max-width:640px) { .edit-tools :global(button) { min-height:44px; } }
</style>
