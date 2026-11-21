import { defaultKeymap, selectAll } from '@codemirror/commands';
import { foldGutter, foldKeymap } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, keymap, lineNumbers } from '@codemirror/view';
import { search, searchKeymap } from '@codemirror/search';
import { codeHighlight, codeTheme } from './editor-theme.js';

export function readonlyCodeExtensions(label: string, language: Extension, extensions: Extension = [], numberOptions?: Parameters<typeof lineNumbers>[0]): Extension {
	return [EditorState.readOnly.of(true), EditorState.tabSize.of(4), EditorView.editable.of(false),
		EditorView.contentAttributes.of({ tabindex: '0', 'aria-label': label, 'aria-readonly': 'true' }),
		lineNumbers(numberOptions), foldGutter(), drawSelection(), search(),
		keymap.of([{ key: 'Mod-a', run: selectAll }, ...searchKeymap, ...foldKeymap, ...defaultKeymap]),
		codeTheme, codeHighlight, language, extensions];
}
