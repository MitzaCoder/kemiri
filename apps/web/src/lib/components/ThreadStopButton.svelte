<script lang="ts">
	import CircleStopIcon from '@lucide/svelte/icons/circle-stop';
	import Banner from './Banner.svelte';
	import { Button } from './ui/button/index.js';
	import * as Dialog from './ui/dialog/index.js';
	import { Spinner } from './ui/spinner/index.js';
	import type { ProjectThreads } from '#lib/threads.svelte.js';
	import type { ThreadSummary } from '@kemiri/protocol';
	let { thread, threads, class: className = 'h-6 px-2 text-xs' }: { thread: ThreadSummary; threads: ProjectThreads; class?: string } = $props();
	let open = $state(false);
	let busy = $state(false);
	async function confirmStop() {
		if (busy) return;
		busy = true;
		const ok = await threads.stopThread(thread.id);
		busy = false;
		if (ok) open = false;
	}
</script>
<Button variant="ghost" size="sm" class={className} disabled={busy} onclick={() => open = true}><CircleStopIcon data-icon="inline-start" />Stop</Button>
<Dialog.Root bind:open>
	<Dialog.Content showCloseButton={!busy} class="sm:max-w-sm" onInteractOutside={event => { if (busy) event.preventDefault(); }} onEscapeKeydown={event => { if (busy) event.preventDefault(); }}>
		<Dialog.Header>
			<Dialog.Title>Stop {thread.title || 'this background job'}?</Dialog.Title>
			<Dialog.Description>Its running turn and its workers are aborted, and it does no more work. Main chat keeps what it reported so far.</Dialog.Description>
		</Dialog.Header>
		{#if threads.actionError?.threadId === thread.id}<Banner tone="error">{threads.actionError.message}</Banner>{/if}
		<Dialog.Footer>
			<Dialog.Close>{#snippet child({ props })}<Button {...props} variant="outline" size="sm" type="button" disabled={busy}>Keep it running</Button>{/snippet}</Dialog.Close>
			<Button variant="destructive" size="sm" type="button" disabled={busy} onclick={() => void confirmStop()}>{#if busy}<Spinner data-icon="inline-start" />{/if}Stop</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
