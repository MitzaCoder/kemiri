<script lang="ts">
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import type { HarnessClient } from '@kemiri/client';
	import { projectHref, threadHref } from '../backends.js';
	import { CodeReviewSession } from './code-review-session.svelte.js';
	import CodeViewer from './CodeViewer.svelte';
	import CodeReviewTray from '../components/review/CodeReviewTray.svelte';
	let { text, path, languageHint, backendId, projectId, artifactId, version, client, threadId, taskId, onclose }: {
		text: string; path: string; languageHint?: string; backendId: string; projectId: string; artifactId: string; version: number;
		client: HarnessClient; threadId?: string; taskId?: string; onclose?: () => void;
	} = $props();
	const source = untrack(() => ({ kind: 'artifact' as const, versionId: `${artifactId.replace(/~\d+$/, '')}~${version}` }));
	const review = untrack(() => new CodeReviewSession(source, backendId, projectId, client, taskId, threadId));
	const lineReview = $derived({ session: review, source, path });
	$effect(() => { review.persist(); });
	async function draftInChat(): Promise<void> {
		onclose?.();
		await goto(review.recipient ? threadHref(backendId, projectId, review.recipient) : projectHref(backendId, projectId), { reset: false });
		requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus());
	}
</script>

<div class="reviewed-source">
	<div class="source-editor"><CodeViewer {text} {path} {languageHint} {lineReview} roomy /></div>
	<CodeReviewTray session={review} ondraft={() => void draftInChat()} />
</div>

<style>
	.reviewed-source { display: flex; position: relative; min-height: 0; height: 100%; }
	.source-editor { flex: 1; min-width: 0; }
</style>
