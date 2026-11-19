<script lang="ts">
	import ReviewIntentIcon from './ReviewIntentIcon.svelte';
	import type { ReviewComment } from '#lib/artifact-review.js';
	let { comments, indexes, onedit, ondelete }: { comments: ReviewComment[]; indexes: number[]; onedit: (index: number) => void; ondelete: (index: number) => void } = $props();
</script>

<div class="preview" role="region" aria-label="Comments on this part">
	{#each indexes as index (index)}
		{@const comment = comments[index]}
		{#if comment}
			<div class="comment">
				<div class="comment-actions">
					<strong><ReviewIntentIcon intent={comment.intent} />{comment.intent ?? 'Note'}</strong>
					<button type="button" onclick={() => onedit(index)}>Edit<span class="sr-only"> comment {index + 1}</span></button>
					<button type="button" onclick={() => ondelete(index)}>Delete<span class="sr-only"> comment {index + 1}</span></button>
				</div>
				{#if comment.note}<p>{comment.note}</p>{/if}
			</div>
		{/if}
	{/each}
</div>

<style>
	.preview { padding:3px 12px; font-size:13px; }
	.comment { padding:7px 0; }
	.comment + .comment { border-top:1px solid var(--chat-border); }
	.comment-actions { display:flex; align-items:center; gap:3px; }
	strong { display:inline-flex; align-items:center; gap:4px; margin-right:auto; border:1px solid color-mix(in srgb,var(--accent-2) 45%,transparent); border-radius:999px; padding:2px 8px; background:color-mix(in srgb,var(--tone-primary) 11%,var(--chat-bg)); color:var(--accent-2); font-size:11px; }
	button { min-height:32px; padding:4px 7px; cursor:pointer; border-radius:6px; color:var(--chat-fg-muted); font-size:12px; }
	button:hover { background:var(--chat-surface-2); color:var(--chat-fg); }
	button:focus-visible { outline:2px solid var(--tone-ring); outline-offset:1px; }
	p { margin:2px 0 4px; white-space:pre-wrap; overflow-wrap:anywhere; }
	@media (pointer:coarse) { button { min-height:44px; } }
</style>
