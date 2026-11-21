<script lang="ts">
	import { MediaQuery } from 'svelte/reactivity';
	import { tick } from 'svelte';
	import XIcon from '@lucide/svelte/icons/x';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import { Button } from '#lib/components/ui/button/index.js';
	import { reviewCommentCount } from '#lib/review.js';
	import type { CodeReviewSession } from '#lib/code/code-review-session.svelte.js';
	import LineReviewCard from './LineReviewCard.svelte';
	import SavedLineComment from './SavedLineComment.svelte';

	let { session, ondraft, onrecheck, inlineEditor = true }: { session: CodeReviewSession; ondraft: () => void; onrecheck?: () => Promise<void>; inlineEditor?: boolean } = $props();
	const phone = new MediaQuery('(max-width: 640px)');
	let toggle = $state<HTMLButtonElement | null>(null);
	let panelClose = $state<HTMLButtonElement | null>(null);
	let sheet = $state<HTMLElement>();
	const maySend = $derived(!session.editor && !session.busy && session.comments.length > 0);
	const recipient = $derived(session.taskId ? `Goes to the coordinator as feedback on ${session.taskId}.` : session.recipient ? 'Goes to the chat this review was opened from.' : 'Goes to the main chat.');

	async function openTray(): Promise<void> { session.openTray(); void onrecheck?.(); await tick(); panelClose?.focus(); }
	async function closeTray(): Promise<void> { session.trayOpen = false; await tick(); toggle?.focus(); }
	$effect(() => {
		if (phone.current && session.editor && sheet) sheet.focus({ preventScroll: true });
	});
</script>

<div class="review-host" class:tray={session.trayOpen}>
	{#if session.trayOpen}
		<aside class="review-panel" aria-label="Code review tray">
			<header><div><strong>Review</strong><p>{reviewCommentCount(session.comments.length)} · Only on this device</p></div><Button bind:ref={panelClose} variant="ghost" size="icon" aria-label="Close review tray" onclick={() => void closeTray()}><XIcon /></Button></header>
			<div class="review-list">
				{#if !session.comments.length}<p class="text-sm text-(--chat-fg-muted)">No comments yet. Use a line's + or press Alt+C in the editor.</p>{/if}
				{#if session.editor && !phone.current}
					{#if !inlineEditor || session.editor.outdated}<LineReviewCard {session} commentId={session.editor.id} />
					{:else}<button class="resume" onclick={() => { document.querySelector<HTMLElement>('[data-code-review-inline] textarea')?.focus(); }}>Continue comment in code</button>{/if}
				{/if}
				{#each session.comments as comment (comment.id)}<SavedLineComment {comment} {session} compact />{/each}
			</div>
			<footer>
				<label>Overall note<textarea bind:value={session.overall} disabled={session.busy} maxlength="4000" rows="2" placeholder="Anything about the whole review?"></textarea></label>
				{#if !session.stored}<p class="text-xs text-(--chat-warning)">This review could not be saved on this device.</p>{/if}
				{#if session.problem}<p role="alert" class="text-xs text-(--chat-danger)">{session.problem}</p>{/if}
				<Button class="send" disabled={!maySend} onclick={() => void session.send(onrecheck)}>{session.busy ? 'Sending…' : `Send ${reviewCommentCount(session.comments.length)}`}</Button>
				<Button variant="outline" disabled={!maySend} onclick={() => { if (session.toDraft()) ondraft(); }}>Add to chat draft</Button>
				<p class="destination">{recipient}</p>
			</footer>
		</aside>
	{/if}
	<div class="review-bar">
		<Button bind:ref={toggle} variant="outline" aria-expanded={session.trayOpen} onclick={() => void (session.trayOpen ? closeTray() : openTray())}><MessageSquareIcon size={15} />Review · {session.comments.length}</Button>
		{#if phone.current && !session.trayOpen && session.comments.length}<Button disabled={!maySend} onclick={() => void session.send(onrecheck)}>Send {session.comments.length}</Button>{/if}
		{#if session.status}<span class="status" role="status">{session.status}</span>{/if}
		{#if session.problem && !session.trayOpen && !session.editor}<span class="status text-(--chat-danger)" role="alert">{session.problem}</span>{/if}
	</div>
	{#if phone.current && session.editor}
		<div class="comment-scrim"></div>
		<!-- svelte-ignore a11y_no_noninteractive_tabindex (focus the sheet without opening the virtual keyboard) -->
		<section class="phone-editor" aria-label="Comment on a code line" tabindex="0" bind:this={sheet}><LineReviewCard {session} commentId={session.editor.id} /></section>
	{/if}
</div>

<style>
	.review-host { z-index: 4; }
	.review-host.tray { width: clamp(15rem, 23vw, 22rem); min-height: 0; }
	.review-panel { height: 100%; display: flex; flex-direction: column; min-height: 0; background: var(--chat-surface); border-inline-start: 1px solid var(--chat-border); }
	header { display: flex; justify-content: space-between; gap: 4px; align-items: center; padding: 8px 10px; border-bottom: 1px solid var(--chat-border); }
	header p, .destination { color: var(--chat-fg-muted); font-size: 11px; }
	.review-list { flex: 1; min-height: 0; overflow: auto; display: flex; flex-direction: column; gap: 8px; padding: 9px; }
	footer { flex: none; display: grid; gap: 6px; padding: 8px 9px 12px; border-top: 1px solid var(--chat-border); }
	footer textarea { display: block; width: 100%; margin-top: 4px; padding: 6px 8px; border: 1px solid var(--chat-border); border-radius: 7px; background: var(--chat-bg); color: var(--chat-fg); resize: vertical; min-height: 44px; max-height: 7rem; }
	footer :global(.send) { color: var(--tone-primary-fg); background: var(--tone-primary); }
	.review-bar { position: absolute; inset: auto 12px 10px auto; z-index: 6; display: flex; align-items: end; flex-wrap: wrap; justify-content: end; gap: 6px; max-width: calc(100% - 24px); }
	.tray .review-bar { inset-inline-end: calc(clamp(15rem, 23vw, 22rem) + 10px); }
	.status { order: -1; max-width: 15rem; padding: 6px; border-radius: 6px; background: var(--chat-surface); font-size: 12px; }
	.resume { text-align: left; color: var(--accent-2); text-decoration: underline; font-size: 12px; }
	@media (max-width: 640px) {
		.review-host.tray { width: 0; }
		.review-panel { position: absolute; z-index: 7; inset: auto 0 0; height: min(75dvh, 36rem); border-radius: 14px 14px 0 0; border: 1px solid var(--chat-border); }
		.review-bar, .tray .review-bar { inset: auto 8px max(8px, env(safe-area-inset-bottom)); }
		.review-bar :global(button), .review-panel :global(button) { min-height: 44px; }
		.comment-scrim { position: absolute; z-index: 8; inset: 0; background: #0006; }
		.phone-editor { position: absolute; z-index: 9; inset: auto 0 0; max-height: 84%; overflow: auto; padding: 4px 6px max(6px, env(safe-area-inset-bottom)); background: var(--chat-surface); border-radius: 12px 12px 0 0; }
	}
</style>
