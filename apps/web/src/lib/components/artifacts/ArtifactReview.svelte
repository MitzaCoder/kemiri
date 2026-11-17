<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '#lib/components/ui/button/index.js';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import type { Artifact } from '@kemiri/protocol';
	import type { HarnessClient } from '@kemiri/client';
	import { harness } from '#lib/harness.svelte.js';
	import { artifactTitle } from '#lib/artifacts.js';
	import { draftKey } from '#lib/drafts.js';
	import { projectHref, threadHref } from '#lib/backends.js';
	import { moveReviewToDraft } from '#lib/artifact-review-draft.js';
	import { quoteFromSelection, selectionInWholeWords } from '#lib/chat/quotes.js';
	import { ArtifactReviewSubmission, reviewThreadId, artifactReviewKey, loadArtifactReview, saveArtifactReview, formatArtifactReview, precedingArtifactHeading, reviewText, reviewLocation, validateArtifactSelection, REVIEW_INTENTS, type ArtifactSelection, type ReviewComment, type ReviewIntent } from '#lib/artifact-review.js';

	let { artifact, client, scope, frame, pageView, onclose }: { artifact: Artifact; client: HarnessClient; scope: HTMLElement | undefined; frame?: HTMLIFrameElement; pageView: boolean; onclose?: () => void } = $props();
	const backend = $derived(harness.backends.find(backend => backend.client === client));
	const key = untrack(() => artifactReviewKey(backend?.id ?? page.params.backend ?? '', artifact.projectId, artifact.id, artifact.version ?? 1));
	const restored = untrack(() => loadArtifactReview(localStorage, key));
	let comments = $state(restored.comments);
	let overall = $state(restored.overall);
	let selection = $state<ArtifactSelection>();
	let composing = $state(false);
	let editing = $state<number>();
	let intent = $state<ReviewIntent>();
	let note = $state('');
	let commentSelection = $state<ArtifactSelection>();
	let trayOpen = $state(restored.comments.length > 0 || restored.overall.length > 0);
	let picking = $state(false);
	let sending = $state(false);
	let problem = $state('');
	let status = $state('');
	let stored = $state(true);
	let noteInput = $state<HTMLTextAreaElement>();
	const submission = new ArtifactReviewSubmission();
	$effect(() => { stored = saveArtifactReview(localStorage, key, { comments, overall }); });
	$effect(() => { if (!pageView) picking = false; });

	export function cancelTransient(): boolean {
		if (composing) { composing = false; return true; }
		if (picking) { frame?.contentWindow?.postMessage('kemiri:cancel-artifact-pick', '*'); picking = false; return true; }
		return false;
	}
	onMount(() => {
		const message = (event: MessageEvent) => {
			if (!pageView) return;
			const selected = validateArtifactSelection(event.source, frame?.contentWindow, event.data);
			if (!selected) return;
			picking = false;
			if (!composing) selection = selected.text ? selected : undefined;
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === 'Escape' && cancelTransient()) { event.preventDefault(); event.stopImmediatePropagation(); }
		};
		window.addEventListener('message', message);
		window.addEventListener('keydown', escape, true);
		return () => { window.removeEventListener('message', message); window.removeEventListener('keydown', escape, true); };
	});

	function readSelection(): void {
		if (pageView || composing) return;
		const selected = document.getSelection();
		if (!scope || !selected?.rangeCount || selected.isCollapsed) { selection = undefined; return; }
		const range = selected.getRangeAt(0);
		if (!scope.contains(range.startContainer) || !scope.contains(range.endContainer)) return;
		const element = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
		if (element?.closest('input,textarea,[data-artifact-review]')) return;
		const edge = (node: Node, offset: number) => node instanceof Text ? { text: node.data, offset } : undefined;
		const text = reviewText(quoteFromSelection(selectionInWholeWords(selected.toString(), edge(range.startContainer, range.startOffset), edge(range.endContainer, range.endOffset))), 4000);
		selection = text ? { text, section: precedingArtifactHeading(scope, range.startContainer) } : undefined;
	}
	async function compose(comment?: ReviewComment, index?: number): Promise<void> {
		commentSelection = comment ?? selection;
		if (!commentSelection) return;
		editing = index;
		intent = comment?.intent;
		note = comment?.note ?? '';
		composing = true;
		trayOpen = true;
		await tick(); noteInput?.focus();
	}
	function add(): void {
		if (!commentSelection || (!intent && !note.trim()) || sending) return;
		const comment = { ...commentSelection, intent, note: reviewText(note, 4000) };
		comments = editing === undefined ? [...comments, comment] : comments.map((saved, index) => index === editing ? comment : saved);
		composing = false; selection = undefined; status = ''; problem = '';
		document.getSelection()?.removeAllRanges();
	}
	function formatted(): string { return formatArtifactReview({ title: artifactTitle(artifact), id: artifact.id, version: artifact.version ?? 1, name: artifact.name }, { comments, overall }); }
	function clear(): void { submission.accepted(); comments = []; overall = ''; selection = undefined; composing = false; }
	const recipient = $derived(reviewThreadId(artifact.taskId, page.params.threadId));
	async function send(): Promise<void> {
		if (sending) return;
		sending = true; problem = ''; status = '';
		const text = formatted();
		try {
			await client.submit(artifact.projectId, text, { whenBusy: 'steer', taskId: artifact.taskId ?? undefined, threadId: recipient, keepDraft: true, requestId: submission.requestIdFor(text) });
			clear(); status = 'Sent. The review appears in chat.';
		} catch (error) { problem = `${error instanceof Error ? error.message : String(error)} Your comments are kept. Try Send again.`; }
		finally { sending = false; }
	}
	async function draft(): Promise<void> {
		problem = '';
		try {
			if (!backend) throw new Error('The backend is unavailable.');
			moveReviewToDraft(localStorage, window, draftKey(backend.id, artifact.projectId, recipient), formatted(), artifact.taskId ?? undefined);
			clear(); onclose?.();
			await goto(recipient ? threadHref(backend.id, artifact.projectId, recipient) : projectHref(backend.id, artifact.projectId));
			await tick();
			requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus());
		} catch (error) { problem = error instanceof Error ? error.message : String(error); }
	}
</script>

<svelte:document onselectionchange={readSelection} />
<div class="review-controls" data-artifact-review>
	{#if pageView}<button type="button" aria-pressed={picking} disabled={sending} onclick={() => { picking = !picking; frame?.contentWindow?.postMessage('kemiri:pick-artifact-block', '*'); if (picking) frame?.focus(); }}>{picking ? 'Cancel picking' : 'Pick a block'}</button>{/if}
	{#if picking}<span class="pick-hint" role="status">Pick a block, or use ↓ ↑ then Enter. Escape cancels.</span>{/if}
	<button type="button" aria-expanded={trayOpen} onclick={() => trayOpen = !trayOpen}>Comments · {comments.length}</button>
	{#if selection && !composing}<button type="button" class="selection-comment" disabled={sending} onpointerdown={event => event.preventDefault()} onclick={() => void compose()} title={selection.text}>Comment on “{selection.text.slice(0, 80)}{selection.text.length > 80 ? '…' : ''}”</button>{/if}
</div>
{#if trayOpen}
	<aside class="review-panel" aria-label="Artifact review" data-artifact-review>
		<header><div><strong>Your comments · {comments.length}</strong><p>Version {artifact.version ?? 1} · only on this device</p></div><Button variant="ghost" size="icon-sm" class="self-start" aria-label="Close comments" title="Close comments" onclick={() => { trayOpen = false; composing = false; }}><XIcon /></Button></header>
		<div class="review-scroll">
			{#if composing && commentSelection}
				<form onsubmit={event => { event.preventDefault(); add(); }} class="review-compose" aria-label="Comment on selection">
					<strong>{editing === undefined ? 'Comment on' : 'Edit comment'} {reviewLocation(commentSelection)}</strong>
					<blockquote>{commentSelection.text}</blockquote>
					<div class="intents" role="group" aria-label="Comment intent">{#each REVIEW_INTENTS as label}<button type="button" aria-pressed={intent === label} onclick={() => intent = intent === label ? undefined : label}>{label}</button>{/each}</div>
					<label>Note (optional)<textarea bind:this={noteInput} bind:value={note} maxlength="4000" rows="3" placeholder="What would help? An intent alone is enough."></textarea></label>
					<div class="buttons"><button type="submit" class="primary" disabled={sending || (!intent && !note.trim()) || (editing === undefined && comments.length >= 100)}>{editing === undefined ? 'Add comment' : 'Save comment'}</button><button type="button" onclick={() => composing = false}>Cancel</button></div>
				</form>
			{/if}
			{#if !comments.length && !composing}<p class="hint">Select a sentence, or pick any visible block. Your comments gather here before you send.</p>{/if}
			<ol>{#each comments as comment, index}<li><strong>{index + 1}. {comment.intent ?? 'Note'}</strong><p class="location">{reviewLocation(comment)}</p><blockquote>{comment.text}</blockquote>{#if comment.note}<p class="comment-note">{comment.note}</p>{/if}<div class="buttons"><button type="button" disabled={sending} onclick={() => void compose(comment, index)}>Edit<span class="sr-only"> comment {index + 1}</span></button><button type="button" disabled={sending} onclick={() => comments = comments.filter((_, at) => at !== index)}>Remove<span class="sr-only"> comment {index + 1}</span></button></div></li>{/each}</ol>
			<label>About the whole page (optional)<textarea bind:value={overall} disabled={sending} maxlength="4000" rows="2" placeholder="The bigger picture…"></textarea></label>
		</div>
		<footer>
			{#if !stored}<p role="alert">Storage unavailable. Keep this viewer open until you send.</p>{/if}
			{#if problem}<p role="alert">{problem}</p>{/if}
			<p role="status">{status}</p>
			<button type="button" class="primary" disabled={sending || composing || (!comments.length && !overall.trim())} onclick={() => void send()}>{sending ? 'Sending…' : `Send ${comments.length} comments`}</button>
			<button type="button" disabled={sending || composing || (!comments.length && !overall.trim())} onclick={() => void draft()}>Add to chat draft</button>
		</footer>
	</aside>
{/if}

<style>
	button { cursor:pointer; border:1px solid var(--chat-border); background:var(--chat-surface); color:var(--chat-fg); border-radius:8px; padding:8px 11px; font-size:12px; line-height:1.35; min-height:36px; }
	button:hover { background:var(--chat-surface-2); }
	button:focus-visible, textarea:focus-visible { outline:2px solid var(--accent-2); outline-offset:2px; }
	button:disabled { opacity:.5; cursor:default; }
	.primary, button[aria-pressed=true] { background:var(--chat-surface-2); color:var(--accent-2); border-color:var(--accent-2); font-weight:600; }
	.review-controls { position:absolute; z-index:5; bottom:12px; left:12px; display:flex; flex-wrap:wrap; gap:6px; max-width:calc(100% - 24px); padding:5px; background:var(--chat-bg); border:1px solid var(--chat-border); border-radius:12px; box-shadow:0 3px 16px #0002; }
	.pick-hint { font-size:12px; align-self:center; max-width:240px; color:var(--chat-fg-muted); }
	.selection-comment { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; text-align:left; }
	.review-panel { flex:0 0 320px; width:320px; max-width:100%; min-height:0; display:flex; flex-direction:column; background:var(--chat-bg); border-left:1px solid var(--chat-border); color:var(--chat-fg); font-size:13px; z-index:6; }
	header { display:flex; justify-content:space-between; gap:8px; padding:16px 14px 12px; border-bottom:1px solid var(--chat-border); }
	header p, .location { font-size:11px; color:var(--chat-fg-muted); margin:4px 0; }
	.review-scroll { min-height:0; flex:1; overflow:auto; padding:14px; overscroll-behavior:contain; }
	ol { list-style:none; margin:0; padding:0; }
	li, .review-compose { padding:0 0 16px; margin-bottom:16px; border-bottom:1px solid var(--chat-border); }
	blockquote { max-height:112px; overflow:auto; border-left:2px solid var(--accent-2); margin:8px 0; padding-left:10px; color:var(--chat-fg-muted); white-space:pre-wrap; overflow-wrap:anywhere; }
	.intents, .buttons { display:flex; flex-wrap:wrap; gap:6px; margin:10px 0; }
	label { display:block; font-size:12px; color:var(--chat-fg-muted); }
	textarea { display:block; width:100%; border:1px solid var(--chat-border); border-radius:8px; padding:10px; margin-top:6px; background:var(--chat-surface); color:var(--chat-fg); resize:vertical; font-size:14px; }
	.comment-note { white-space:pre-wrap; overflow-wrap:anywhere; }
	.hint { color:var(--chat-fg-muted); line-height:1.6; }
	footer { padding:12px 14px; border-top:1px solid var(--chat-border); display:grid; gap:8px; }
	footer p { font-size:12px; margin:0; }
	footer p:empty { display:none; }
	@container artifact-review (max-width:639px) { .review-panel { position:absolute; bottom:0; left:0; width:100%; height: min(74dvh, 650px); border:1px solid var(--chat-border); border-radius:16px 16px 0 0; box-shadow:0 -6px 32px #0003; padding-bottom:env(safe-area-inset-bottom); } }
</style>
