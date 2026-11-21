<script lang="ts">
	import { codeLocation, suggestedPatch, type CodeComment } from '#lib/code/code-review.js';
	import type { CodeReviewSession } from '#lib/code/code-review-session.svelte.js';
	import ReviewIntentIcon from '../artifacts/ReviewIntentIcon.svelte';
	let { comment, session, compact = false }: { comment: CodeComment; session: CodeReviewSession; compact?: boolean } = $props();
	const patch = $derived(suggestedPatch(comment.anchor, comment.replacement));
</script>

<article class="saved-comment" class:compact>
	<header><strong>{#if comment.intent}<ReviewIntentIcon intent={comment.intent} />{/if}{comment.intent ?? 'Note'}</strong><span>{codeLocation(comment.anchor)}</span></header>
	{#if comment.outdated}<p class="outdated">Outdated · original quote</p>{/if}
	{#if compact || comment.outdated}<blockquote>{comment.anchor.quotedText || 'Blank line'}</blockquote>{/if}
	{#if comment.note}<p>{comment.note}</p>{/if}
	{#if patch}
		<div class="suggestion" aria-label="Suggested edit">
			<b>Suggested edit</b>
			{#each patch.split('\n').slice(3) as line}<pre class:added={line.startsWith('+')} class:removed={line.startsWith('-')}>{line}</pre>{/each}
		</div>
	{/if}
	<footer><button disabled={session.busy || !!session.editor} onclick={() => session.edit(comment)}>Edit</button><button disabled={session.busy || !!session.editor} onclick={() => session.remove(comment.id)}>Remove</button></footer>
</article>

<style>
	.saved-comment { padding: 9px 11px; background: var(--chat-surface); border: 1px solid var(--chat-border); border-inline-start: 2px solid var(--accent-2); border-radius: 9px; color: var(--chat-fg); font: 13px/1.4 var(--font-sans); overflow-wrap: anywhere; }
	.saved-comment.compact { background: var(--chat-surface-2); }
	header { display: flex; align-items: baseline; flex-wrap: wrap; gap: 5px 8px; }
	header strong { display: inline-flex; gap: 5px; border-radius: 999px; padding: 2px 7px; background: var(--chat-surface-2); color: var(--accent-2); font-size: 12px; }
	header span, .outdated { color: var(--chat-fg-muted); font-size: 11px; }
	.outdated { color: var(--chat-warning); }
	p, blockquote { margin-top: 5px; white-space: pre-wrap; }
	blockquote { font: 11px/1.4 var(--font-mono); border-inline-start: 1px solid var(--chat-border); padding-inline-start: 6px; max-height: 4rem; overflow: auto; }
	.suggestion { margin-top: 6px; border: 1px solid var(--chat-border); border-radius: 6px; overflow: auto; max-height: 10rem; }
	.suggestion b { display: block; font-size: 11px; padding: 3px 6px; color: var(--chat-fg-muted); }
	.suggestion pre { white-space: pre-wrap; margin: 0; padding: 2px 6px; font: 11px/1.35 var(--font-mono); }
	.added { background: color-mix(in oklab, var(--chat-success) 14%, transparent); }
	.removed { background: color-mix(in oklab, var(--chat-danger) 14%, transparent); }
	footer { display: flex; justify-content: flex-end; gap: 4px; margin-top: 4px; }
	button { min-height: 26px; padding: 0 6px; border-radius: 5px; font-size: 11px; }
	button:hover { background: var(--chat-surface-2); }
	@media (max-width: 640px), (pointer: coarse) { button { min-height: 44px; } }
</style>
