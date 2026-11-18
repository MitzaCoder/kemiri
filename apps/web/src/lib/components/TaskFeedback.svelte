<script lang="ts">
	import Markdown from '#lib/components/markdown/Markdown.svelte';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { Button } from '#lib/components/ui/button/index.js';
	import { exactTime, relativeTime } from '#lib/relative-time.js';
	import { feedbackStateWords, sortedFeedback } from '#lib/task-relations.js';
	import { markdownText, type BoardFeedback } from '@kemiri/protocol';

	let { entries, openCount, busy, problem, onset, threadName }: {
		entries: readonly BoardFeedback[];
		openCount: number;
		busy: boolean;
		problem?: string;
		onset: (entry: BoardFeedback, state: 'dismissed' | 'open') => void;
		threadName: (threadId: string) => string;
	} = $props();
	const sorted = $derived(sortedFeedback(entries));
</script>

{#snippet note(entry: BoardFeedback, settled: boolean)}
	<div class="flex flex-col gap-2 pb-2">
		<p class="text-xs text-(--chat-fg-muted)">
			{#if !settled}{feedbackStateWords(entry.state)} · {/if}
			<time datetime={entry.at} title={exactTime(entry.at)}>{relativeTime(entry.at, Date.now())}</time>
			{#if entry.threadId !== 'main'} · {threadName(entry.threadId)}{/if}
		</p>
		<Markdown source={entry.text} class="task-detail-markdown" userMessage />
		{#if entry.images}<p class="text-(--chat-fg-muted)">{entry.images} image{entry.images === 1 ? '' : 's'}</p>{/if}
		{#if entry.note}
			<div class="border-l-2 border-(--chat-border-strong) pl-3" data-feedback-note>
				<p class="task-detail-heading mb-1">Reply</p>
				<Markdown source={entry.note} class="task-detail-markdown" />
			</div>
		{/if}
		<Button variant="ghost" class="min-h-11 self-start" disabled={busy} onclick={() => onset(entry, settled ? 'open' : 'dismissed')}>
			{settled ? 'Reopen note' : 'Dismiss note'}
		</Button>
	</div>
{/snippet}

{#if problem}<p class="text-(--chat-danger)" role="alert">{problem}</p>
{:else if sorted.length === 0 && openCount > 0}<p class="text-(--chat-fg-muted)" role="status">Loading notes…</p>{/if}
{#if sorted.length > 0}
	<ul data-feedback>
		{#each sorted as entry (entry.id)}
			<li class="border-t border-(--chat-border) pt-1" data-feedback-entry={entry.id} data-state={entry.state}>
				{#if entry.state === 'addressed' || entry.state === 'dismissed'}
					<details>
						<summary class="task-fold">
							<ChevronRightIcon class="size-4 shrink-0" aria-hidden="true" />
							<span class="min-w-0 flex-1 truncate">{markdownText(entry.text) || 'Note with attachment'}</span>
							<span class="shrink-0 text-xs text-(--chat-fg-muted)">{feedbackStateWords(entry.state)}</span>
						</summary>
						{@render note(entry, true)}
					</details>
				{:else}
					{@render note(entry, false)}
				{/if}
			</li>
		{/each}
	</ul>
{/if}
