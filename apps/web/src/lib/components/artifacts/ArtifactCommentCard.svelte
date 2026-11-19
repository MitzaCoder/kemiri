<script lang="ts">
	import { onMount } from 'svelte';
	import { REVIEW_INTENTS, reviewLocation, type ArtifactSelection, type ReviewIntent } from '#lib/artifact-review.js';

	let { selection, editing, coarse, disabled, autofocus, intent = $bindable(), note = $bindable(), onsave, oncancel }: {
		selection: ArtifactSelection; editing: boolean; coarse: boolean; disabled: boolean; autofocus: boolean;
		intent?: ReviewIntent; note: string; onsave: () => void; oncancel: () => void;
	} = $props();
	let input: HTMLTextAreaElement;
	const canSave = $derived(!disabled && (intent !== undefined || note.trim() !== ''));
	onMount(() => { if (autofocus) input.focus({ preventScroll: true }); });

	function submit(event: SubmitEvent): void {
		event.preventDefault();
		if (canSave) onsave();
	}
	function noteKeys(event: KeyboardEvent): void {
		if (event.key !== 'Enter' || event.shiftKey || event.isComposing || (coarse && !event.metaKey && !event.ctrlKey)) return;
		event.preventDefault();
		if (canSave) onsave();
	}
</script>

<form aria-label={editing ? 'Edit comment' : 'New comment'} onsubmit={submit}>
	<div class="location"><span>{reviewLocation(selection) || 'Selected passage'}</span><strong>{editing ? 'Edit comment' : 'New comment'}</strong></div>
	<blockquote title={selection.text}>{selection.text}</blockquote>
	<div class="intents" role="group" aria-label="Comment intent">
		{#each REVIEW_INTENTS as label}<button type="button" aria-pressed={intent === label} onclick={() => intent = intent === label ? undefined : label}>{label}</button>{/each}
	</div>
	<textarea bind:this={input} bind:value={note} aria-label="Comment note" onkeydown={noteKeys} maxlength="4000" rows="2" placeholder="What would help? An intent alone is enough."></textarea>
	<div class="actions">
		{#if !coarse}<span class="keys"><kbd>Enter</kbd> save · <kbd>Esc</kbd> cancel</span>{/if}
		<button type="button" onclick={oncancel}>Cancel</button>
		<button type="submit" class="save" disabled={!canSave}>Save</button>
	</div>
</form>

<style>
	form { padding:12px; font-size:13px; }
	.location { display:flex; justify-content:space-between; align-items:baseline; gap:8px; color:var(--chat-fg-muted); font-size:11px; }
	.location span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	.location strong { flex:none; color:var(--chat-fg); }
	blockquote { margin:8px 0 10px; padding-left:9px; border-left:2px solid var(--accent-2); color:var(--chat-fg-muted); display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; line-clamp:2; overflow:hidden; overflow-wrap:anywhere; }
	.intents, .actions { display:flex; flex-wrap:wrap; gap:5px; align-items:center; }
	.intents { margin-bottom:8px; }
	button { cursor:pointer; min-height:32px; padding:4px 10px; border:1px solid var(--tone-border-strong); border-radius:8px; background:var(--chat-surface); color:var(--chat-fg); font-size:12px; }
	button:hover { background:var(--chat-surface-2); }
	button:disabled { opacity:.5; cursor:default; }
	.intents button { border-radius:999px; }
	button[aria-pressed=true] { background:color-mix(in srgb,var(--tone-primary) 14%,var(--chat-bg)); color:var(--accent-2); border-color:var(--accent-2); font-weight:600; }
	button.save { color:var(--tone-primary-fg); background:var(--tone-primary); border-color:var(--tone-primary); font-weight:600; }
	textarea { display:block; width:100%; min-height:62px; max-height:160px; field-sizing:content; resize:none; padding:8px 10px; background:var(--chat-surface); color:var(--chat-fg); border:1px solid var(--tone-border-strong); border-radius:8px; font-size:14px; line-height:1.45; }
	textarea:focus-visible, button:focus-visible { outline:2px solid var(--tone-ring); outline-offset:2px; }
	.actions { justify-content:flex-end; margin-top:10px; gap:8px; }
	.keys { margin-right:auto; font-size:10px; color:var(--chat-fg-muted); }
	kbd { padding:1px 3px; background:var(--chat-surface); border:1px solid var(--chat-border); border-radius:4px; }
	@media (pointer:coarse) { textarea { font-size:16px; } button { min-height:36px; } }
</style>
