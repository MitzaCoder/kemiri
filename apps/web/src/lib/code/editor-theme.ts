import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { codeTokenVariables } from './palette.js';

export const codeTheme = EditorView.theme({
	'&': { ...codeTokenVariables(false), height: '100%', color: 'var(--code-text)', background: '#fff' },
	'.dark &': { ...codeTokenVariables(true), background: 'var(--chat-bg)' },
	'&.cm-focused': { outline: '2px solid var(--accent-2)', outlineOffset: '-2px' },
	'.cm-scroller': { fontFamily: 'var(--font-mono)', fontSize: '12.5px', lineHeight: '21px', overscrollBehavior: 'contain' },
	'@media (max-width: 767px)': { '.cm-scroller': { fontSize: '11.5px' } },
	'.cm-content': { padding: '10px 0', minWidth: '0' },
	'.cm-line': { padding: '0 10px 0 8px' },
	'.cm-gutters': { color: 'var(--chat-fg-muted)', background: 'var(--chat-surface)', borderColor: 'var(--chat-border)' },
	'.cm-foldGutter .cm-gutterElement': { padding: '0 4px' },
	'.cm-cursor': { borderLeftColor: 'var(--code-text)' },
	'.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { background: 'color-mix(in oklab, var(--accent-2) 24%, transparent)' },
	'.cm-searchMatch': { background: 'color-mix(in oklab, var(--chat-warning) 24%, transparent)', outline: '1px solid var(--chat-warning)' },
	'.cm-panel': { background: 'var(--chat-surface)', color: 'var(--chat-fg)' },
	'.cm-panel input, .cm-panel button': { background: 'var(--chat-bg)', color: 'var(--chat-fg)', minHeight: '32px' },
	'.cm-panels': { borderColor: 'var(--chat-border)' },
	'.cm-mergeView &': { height: 'auto' },
	'&.cm-merge-a .cm-changedLine, .cm-deletedChunk': { background: 'color-mix(in oklab, var(--chat-danger) 12%, transparent)' },
	'&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine': { background: 'color-mix(in oklab, var(--chat-success) 12%, transparent)' },
	'&.cm-merge-a .cm-changedText, .cm-deletedText': { background: 'color-mix(in oklab, var(--chat-danger) 22%, transparent)', textDecoration: 'none' },
	'&.cm-merge-b .cm-changedText, .cm-insertedText': { background: 'color-mix(in oklab, var(--chat-success) 22%, transparent)' },
	'.cm-collapsedLines': { background: 'var(--chat-surface-2)', color: 'var(--chat-fg-muted)', padding: '4px 10px' },
});

export const codeHighlight = syntaxHighlighting(HighlightStyle.define([
	{ tag: [t.comment, t.meta], color: 'var(--code-comment)' },
	{ tag: [t.keyword, t.controlKeyword, t.definitionKeyword], color: 'var(--code-keyword)' },
	{ tag: [t.string, t.regexp, t.special(t.string)], color: 'var(--code-string)' },
	{ tag: [t.number, t.integer, t.float], color: 'var(--code-number)' },
	{ tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--code-function)' },
	{ tag: [t.typeName, t.className, t.namespace], color: 'var(--code-type)' },
	{ tag: [t.propertyName, t.definition(t.propertyName)], color: 'var(--code-property)' },
	{ tag: [t.operator, t.operatorKeyword], color: 'var(--code-operator)' },
	{ tag: [t.atom, t.bool, t.null, t.constant(t.name)], color: 'var(--code-constant)' },
	{ tag: t.tagName, color: 'var(--code-tag)' },
	{ tag: t.attributeName, color: 'var(--code-attribute)' },
	{ tag: [t.punctuation, t.bracket], color: 'var(--code-punctuation)' },
	{ tag: t.inserted, color: 'var(--code-string)' },
	{ tag: t.deleted, color: 'var(--code-constant)' },
	{ tag: t.changed, color: 'var(--code-type)' },
	{ tag: t.heading, color: 'var(--code-heading)', fontWeight: 'bold' },
	{ tag: t.strong, fontWeight: 'bold' }, { tag: t.emphasis, fontStyle: 'italic' },
]));
