<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { REVIEW_INTENTS } from '#lib/review.js';
	import { codeLocation, MAX_CODE_QUOTE, suggestedPatch, type CodeComment } from '#lib/code/code-review.js';
	import type { CodeReviewSession } from '#lib/code/code-review-session.svelte.js';
	import ReviewIntentIcon from '../artifacts/ReviewIntentIcon.svelte';
	let { session, commentId }: { session: CodeReviewSession; commentId: string } = $props();
	const comment = $derived(session.editor?.id === commentId ? session.editor : undefined);
	const existing = $derived(session.comments.some(row => row.id === commentId));
	let note = $state<HTMLTextAreaElement>();
	let replacement = $state<HTMLTextAreaElement>();
	const patch = $derived(comment && suggestedPatch(comment.anchor, comment.replacement));

	onMount(() => { if (innerWidth > 640) note?.focus(); });
	async function suggest(row: CodeComment): Promise<void> {
		row.replacement = row.anchor.quotedText;
		await tick();
		replacement?.focus();
	}
</script>

{#if comment}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape cancels the comment editor) -->
	<form class="line-card" aria-label={existing ? 'Edit line comment' : 'New line comment'} onsubmit={event => { event.preventDefault(); session.add(); }}
		onkeydown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); session.cancel(); } }}>
		<header><strong>{existing ? 'Edit comment' : 'New comment'}</strong><span>{codeLocation(comment.anchor)}</span></header>
		{#if comment.outdated}<p class="text-xs text-(--chat-warning)">Outdated · the quoted lines no longer match.</p>{/if}
		<pre class="line-quote">{comment.anchor.quotedText || 'Blank line'}</pre>
		<div class="intents" role="group" aria-label="Comment intent">
			{#each REVIEW_INTENTS as intent}<button type="button" aria-pressed={comment.intent === intent} onclick={() => comment.intent = comment.intent === intent ? undefined : intent}><ReviewIntentIcon {intent} />{intent}</button>{/each}
		</div>
		<textarea bind:this={note} bind:value={comment.note} aria-label="Comment note" rows="2" maxlength="4000" placeholder="What should the agent know?"></textarea>
		{#if comment.replacement === undefined}
			<button class="suggest" type="button" onclick={() => void suggest(comment!)}>Suggest an edit</button>
		{:else}
			<label class="replacement">Suggested replacement
				<textarea bind:this={replacement} bind:value={comment.replacement} class="font-mono" rows="3" maxlength={MAX_CODE_QUOTE} spellcheck="false"></textarea>
			</label>
			{#if patch}
				<div class="preview" aria-label="Suggested edit preview">
					{#each patch.split('\n').slice(3) as line}<pre class:added={line.startsWith('+')} class:removed={line.startsWith('-')}>{line}</pre>{/each}
				</div>
			{/if}
			<button class="suggest" type="button" onclick={() => comment && (comment.replacement = undefined)}>Remove suggestion</button>
		{/if}
		{#if session.problem}<p role="alert" class="text-xs text-(--chat-danger)">{session.problem}</p>{/if}
		<div class="actions"><button type="button" onclick={() => session.cancel()}>Cancel</button><button class="primary" disabled={session.busy || !(comment.intent || comment.note.trim() || patch)} type="submit">{existing ? 'Save comment' : 'Add comment'}</button></div>
	</form>
{/if}

<style>
	.line-card { display: grid; gap: 7px; padding: 12px; background: var(--chat-surface); color: var(--chat-fg); border: 1px solid var(--chat-border); border-radius: 12px; font: 13px/1.45 var(--font-sans); }
	header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
	header span { color: var(--chat-fg-muted); text-align: right; font-size: 11px; overflow-wrap: anywhere; }
	.line-quote, .preview pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font: 11.5px/1.4 var(--font-mono); }
	.line-quote { padding-left: 8px; border-left: 2px solid var(--accent-2); max-height: 4.5rem; overflow: auto; }
	.preview { border: 1px solid var(--chat-border); border-radius: 6px; overflow: auto; max-height: 9rem; }
	.preview pre { padding: 2px 6px; }
	.added { background: color-mix(in oklab, var(--chat-success) 14%, transparent); }
	.removed { background: color-mix(in oklab, var(--chat-danger) 14%, transparent); }
	.intents, .actions { display: flex; flex-wrap: wrap; gap: 5px; }
	.actions { justify-content: flex-end; }
	button { min-height: 32px; padding: 4px 9px; border: 1px solid var(--chat-border); border-radius: 7px; font-size: 12px; cursor: pointer; }
	button:disabled { opacity: .45; cursor: default; }
	button:hover:not(:disabled), button[aria-pressed='true'] { background: var(--chat-surface-2); }
	button[aria-pressed='true'] { border-color: var(--accent-2); font-weight: 700; }
	.intents button { display: flex; align-items: center; gap: 4px; border-radius: 999px; }
	.primary { background: var(--tone-primary); color: var(--tone-primary-fg); font-weight: 700; }
	.primary:hover:not(:disabled) { background: var(--tone-primary); filter: brightness(1.1); }
	.suggest { justify-self: start; }
	textarea { display: block; width: 100%; resize: vertical; min-height: 54px; max-height: 10rem; padding: 6px 8px; border: 1px solid var(--chat-border); border-radius: 6px; background: var(--chat-bg); }
	.replacement { font-size: 12px; }
	.replacement textarea { margin-top: 4px; }
	@media (max-width: 640px), (pointer: coarse) { button { min-height: 44px; } textarea { font-size: 16px; } }
</style>
