<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import type { HarnessClient } from '@kemiri/client';
	import type { FileLocation } from '#lib/code/file-location.js';
	import { codeRootKey } from '#lib/code/file-location.js';
	import { CodeReviewSession } from '#lib/code/code-review-session.svelte.js';
	import { projectHref, threadHref } from '#lib/backends.js';
	import { loadCodeViewer } from '#lib/code/load-viewer.js';
	import { fitsCodeView } from '#lib/code/limits.js';
	import Markdown from '../markdown/Markdown.svelte';
	import CodeReviewTray from '../review/CodeReviewTray.svelte';
	import type { CodeReviewSource } from '#lib/code/code-review.js';
	let { file, hash, text, backendId, projectId, taskId, threadId, client, markdown, onquote, oncopylink, onclose }: {
		file: FileLocation; hash: string; text: string; backendId: string; projectId: string; taskId?: string; threadId?: string;
		client: HarnessClient; markdown: boolean; onquote?: (quote: string) => void; oncopylink: (line: number) => void; onclose: () => void;
	} = $props();
	let sourceShown = $state(untrack(() => !markdown || !!file.line));
	const source = $derived<CodeReviewSource>({ kind: 'file', root: codeRootKey(file.root), path: file.path, hash });
	const review = untrack(() => new CodeReviewSession(source, backendId, projectId, client, taskId, threadId));
	const lineReview = $derived({ session: review, source, path: file.path });
	$effect(() => review.persist());
	async function draft() {
		await goto(review.recipient ? threadHref(backendId, projectId, review.recipient) : projectHref(backendId, projectId), { reset: false });
	}
</script>
<div class="checkout-text">
	{#if markdown}
		<div class="source-switch" role="group" aria-label="Markdown preview mode">
			<button aria-pressed={!sourceShown} onclick={() => sourceShown = false}>Rendered</button>
			<button aria-pressed={sourceShown} onclick={() => sourceShown = true}>Source</button>
		</div>
	{/if}
	{#if markdown && !sourceShown}
		<div class="rendered"><Markdown source={text} /></div>
	{:else if fitsCodeView(text)}
		<div class="source-and-review">
			<div class="source-editor">
				{#await loadCodeViewer() then {default: CodeViewer}}
					<CodeViewer {text} path={file.path} roomy {lineReview} line={file.line} {oncopylink} onquote={onquote ? (quote) => { onquote?.(quote); onclose(); } : undefined} />
				{:catch}<p class="m-5" role="alert">Could not load the source viewer.</p>{/await}
			</div>
			<CodeReviewTray session={review} ondraft={() => void draft()} />
		</div>
	{:else}
		<p class="px-4 py-2 text-xs" role="status">This file exceeds the interactive editor limit. Showing plain text.</p>
		<pre class="overflow-auto p-4 text-xs whitespace-pre-wrap break-all">{text}</pre>
	{/if}
</div>
<style>
	.checkout-text, .source-and-review { display:flex; flex:1; min-height:0; min-width:0; }
	.checkout-text { flex-direction:column; }
	.source-editor { flex:1; min-width:0; }
	.source-switch { display:flex; align-items:center; padding:4px 10px; gap:4px; border-bottom:1px solid var(--chat-border); }
	.source-switch button { min-height:32px; padding:3px 9px; border:1px solid var(--chat-border); border-radius:6px; font-size:12px; }
	.source-switch [aria-pressed='true'] { background:var(--chat-surface-2); font-weight:700; }
	.rendered { min-height:0; overflow:auto; padding:16px clamp(12px, 4vw, 48px); }
	@media(max-width:640px) { .source-switch button { min-height:44px; } }
</style>
