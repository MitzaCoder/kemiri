<script lang="ts">
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import { backgroundJobPresentation, threadName, type ThreadCards } from '#lib/threads.js';
	import type { TranscriptItem } from '#lib/transcript.js';
	import ThreadStatusBadge from './ThreadStatusBadge.svelte';

	/**
	 * A background job's completion card (first summary line, artifacts and Open), failure card,
	 * or message. The server admits these as user
	 * inputs; they are never drawn as something the user typed.
	 */
	let {
		item,
		cards
	}: {
		item: Extract<TranscriptItem, { kind: 'thread' }>;
		cards?: ThreadCards;
	} = $props();

	const notice = $derived(item.notice);
	const threadId = $derived(item.threadId ?? undefined);
	const thread = $derived(threadId === undefined ? undefined : cards?.threads.find((entry) => entry.id === threadId));
	const name = $derived(threadId === undefined ? 'A background job' : threadName(threadId, cards?.threads ?? []));
	const href = $derived(threadId === undefined || threadId === 'main' ? undefined : cards?.href(threadId));
</script>

{#if notice.kind === 'finished' || notice.kind === 'failed'}
	<div
		class="thread-card my-2 min-w-0 overflow-hidden rounded-2xl border border-(--chat-border) bg-(--chat-surface)/60"
		data-thread-card={threadId}
		data-thread-notice={notice.kind}
	>
		<div class="flex min-w-0 items-start gap-2.5 px-3 py-2">
			<span class="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg bg-(--primary)/10 text-(--primary)">
				<LayersIcon class="size-3.5" />
			</span>
			<div class="min-w-0 flex-1">
				<p class="text-[0.8125rem] font-semibold">{name}</p>
				<p class="line-clamp-2 text-xs break-words {notice.kind === 'failed' ? 'text-(--chat-danger)' : 'text-(--chat-fg-muted)'}">
					{#if notice.kind === 'finished'}
						{thread ? backgroundJobPresentation({ ...thread, state: 'finished', summary: notice.summary }).line : notice.summary.split('\n').find(line => line.trim()) || 'Finished.'}
					{:else}
						{notice.reason || 'Its last turn failed.'}
					{/if}
				</p>
			</div>
			{#if thread}
				<ThreadStatusBadge {thread} />
			{:else}
				<span class="text-xs {notice.kind === 'finished' ? 'text-(--chat-success)' : 'text-(--chat-danger)'}">
					{notice.kind === 'finished' ? 'Finished' : 'Failed'}
				</span>
			{/if}
		</div>
		<div class="flex justify-end border-t border-(--chat-border)/60 px-3 py-1">
			{#if href}
				<a {href} class="inline-flex items-center gap-1 text-xs font-medium text-(--chat-fg-muted) hover:underline">
					Open<ArrowRightIcon class="size-3" />
				</a>
			{/if}
		</div>
		{#if notice.kind === 'finished' && threadId !== undefined && cards?.artifacts}
			{@render cards.artifacts(threadId, item.timestamp)}
		{/if}
	</div>
{:else}
	<div
		class="thread-card animate-rise flex min-w-0 items-start gap-2 self-start rounded-xl border border-dashed border-(--chat-border) bg-(--chat-surface)/40 px-3 py-1.5 text-xs"
		data-thread-card={threadId}
		data-thread-notice={notice.kind}
	>
		{#if notice.kind === 'message'}
			<MessageSquareIcon class="mt-0.5 size-3.5 shrink-0 text-(--chat-fg-subtle)" />
		{:else}
			<LayersIcon class="mt-0.5 size-3.5 shrink-0 text-(--chat-fg-subtle)" />
		{/if}
		<span class="min-w-0 flex-1 break-words text-(--chat-fg-muted)">
			{#if notice.kind === 'message'}
				<span class="font-medium text-(--chat-fg)">From {name}:</span>
				{notice.message}
			{:else}
				{notice.text}
			{/if}
		</span>
		{#if href}
			<a {href} class="shrink-0 font-medium text-(--chat-fg-subtle) hover:underline">Open</a>
		{/if}
	</div>
{/if}
