<script lang="ts">
	import { overlayScroll } from '#lib/scrollbars.js';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ArchiveRestoreIcon from '@lucide/svelte/icons/archive-restore';
	import CalendarClockIcon from '@lucide/svelte/icons/calendar-clock';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { Button } from '#lib/components/ui/button/index.js';
	import ThreadStopButton from './ThreadStopButton.svelte';
	import ThreadFacts from '#lib/components/chat/ThreadFacts.svelte';
	import ThreadStatusBadge from '#lib/components/chat/ThreadStatusBadge.svelte';
	import { exactTime, relativeTime } from '#lib/relative-time.js';
	import { isThreadActive } from '@kemiri/client';
	import { partitionFinishedJobs, sortThreads, threadActivityLine, threadStartedByText } from '#lib/threads.js';
	import type { ProjectThreads } from '#lib/threads.svelte.js';
	import type { BoardQuestion, ThreadSummary } from '@kemiri/protocol';

	/**
	 * Main's background jobs: what each does now, its workers and tasks, who started it and when, with open, stop
	 * (behind a confirmation) and archive. The body of the sidebar's Background tab; archived threads sit behind a
	 * toggle. Nothing here starts a thread: the user asks main.
	 */
	let {
		threads,
		hrefOf,
		scheduleName,
		now,
		currentThreadId,
		questions = []
	}: {
		threads: ProjectThreads | undefined;
		hrefOf: (threadId: string) => string;
		scheduleName?: (scheduleId: string) => string | undefined;
		/** Ticks, so the relative times move on. */
		now: number;
		currentThreadId?: string;
		questions?: readonly BoardQuestion[];
	} = $props();

	const ordered = $derived(sortThreads(threads?.background ?? []));
	const live = $derived(ordered.filter((thread) => !thread.archived));
	const grouped = $derived(partitionFinishedJobs(live, now));
	const archived = $derived(ordered.filter((thread) => thread.archived));

	let busyId = $state<string | undefined>(undefined);

	async function archive(thread: ThreadSummary, archive: boolean): Promise<void> {
		if (threads === undefined) return;
		busyId = thread.id;
		await threads.archive(thread.id, archive);
		busyId = undefined;
	}

	function timeOf(thread: ThreadSummary): { text: string; title: string } {
		const at = thread.finishedAt ?? thread.updatedAt;
		const verb = thread.finishedAt !== null ? 'Ended' : thread.status === 'running' ? 'Active' : 'Updated';
		return { text: `${verb} ${relativeTime(at, now)}`, title: `Started ${exactTime(thread.createdAt)} · ${verb.toLowerCase()} ${exactTime(at)}` };
	}
</script>

{#snippet row(thread: ThreadSummary)}
	{@const time = timeOf(thread)}
	{@const error = threads?.actionError?.threadId === thread.id ? threads.actionError.message : undefined}
	<div
		class="thread-row flex min-w-0 flex-col rounded-xl border border-(--chat-border) transition-colors"
		class:opacity-75={thread.archived}
		data-thread={thread.id}
	>
		<a href={hrefOf(thread.id)} class="flex min-w-0 flex-col gap-1 rounded-t-xl px-3 pt-2 pb-1.5 hover:bg-(--chat-surface-2)/60">
			<span class="flex min-w-0 items-center gap-2">
				<span class="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold">{thread.title || thread.id}</span>
				<ThreadStatusBadge {thread} class="shrink-0" />
				<ChevronRightIcon class="size-3.5 shrink-0 text-(--chat-fg-subtle)" />
			</span>
			<span
				class="line-clamp-2 text-xs break-words {thread.status === 'failed' ? 'text-(--chat-danger)' : 'text-(--chat-fg-muted)'}"
			>
				{threadActivityLine(thread, questions, now)}
			</span>
			{#if thread.id === currentThreadId}<span class="text-xs font-medium text-(--accent-2)">You are here</span>{/if}
			<ThreadFacts {thread} />
			<span class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[0.6875rem] text-(--chat-fg-subtle)">
				{#if thread.startedBy === 'schedule'}<CalendarClockIcon class="size-3" aria-hidden="true" />{/if}
				<span class="truncate">{threadStartedByText(thread, scheduleName)}</span>
				<span aria-hidden="true">·</span>
				<span title={time.title}>{time.text}</span>
			</span>
		</a>
		<div class="flex items-center gap-1 border-t border-(--chat-border)/60 px-1.5 py-1">
			{#if isThreadActive(thread) && threads}
				<ThreadStopButton {thread} {threads} />
			{/if}
			{#if thread.archived}
				<Button variant="ghost" size="sm" class="h-6 px-2 text-xs" disabled={busyId === thread.id} onclick={() => void archive(thread, false)}>
					<ArchiveRestoreIcon data-icon="inline-start" />Restore
				</Button>
			{:else if !isThreadActive(thread)}
				<Button variant="ghost" size="sm" class="h-6 px-2 text-xs" disabled={busyId === thread.id} onclick={() => void archive(thread, true)}>
					<ArchiveIcon data-icon="inline-start" />Archive
				</Button>
			{/if}
			<a href={hrefOf(thread.id)} class="ml-auto px-2 text-xs font-medium text-(--chat-fg-muted) hover:underline">Open</a>
		</div>
		{#if error}
			<p class="px-3 pb-1.5 text-xs break-words text-(--chat-danger)">{error}</p>
		{/if}
	</div>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col">
	<div class="shrink-0 border-b border-(--chat-border)/70 px-4 py-2.5 text-xs text-(--chat-fg-subtle)">
		<p class="mx-auto w-full max-w-3xl">
			Background jobs report back to Main chat. Ask Main chat to start, steer or stop one.
		</p>
	</div>

	<div class="relative flex min-h-0 flex-1 flex-col">
	<div use:overlayScroll={'parent'} class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-2">
		<div class="mx-auto flex w-full max-w-3xl flex-col gap-1.5">
			{#if threads?.error}
				<p class="px-1 py-2 text-xs break-words text-(--chat-danger)">{threads.error}</p>
			{/if}

			{#if live.length === 0}
				<p class="px-1 py-4 text-sm text-(--chat-fg-subtle)">
					{#if threads?.loaded}
						No background jobs yet. Ask Main chat to start one, or use a schedule.
					{:else}
						Loading background jobs…
					{/if}
				</p>
			{/if}

			{#each grouped.visible as thread (thread.id)}
				{@render row(thread)}
			{/each}

			{#if grouped.finished.length > 0}
				<details class="mt-2"><summary class="cursor-pointer py-2 text-xs text-(--chat-fg-muted)">Finished ({grouped.finished.length})</summary><div class="flex flex-col gap-1.5">{#each grouped.finished as thread (thread.id)}{@render row(thread)}{/each}</div></details>
			{/if}
			{#if threads?.loaded}
				<button
					type="button"
					class="mt-1 flex items-center gap-1.5 self-start rounded-lg px-1 py-1 text-xs text-(--chat-fg-subtle) hover:text-(--chat-fg)"
					aria-pressed={threads.showArchived}
					onclick={() => threads?.setShowArchived(!threads.showArchived)}
				>
					<ArchiveIcon class="size-3.5" />
					{threads.showArchived ? `Hide archived${archived.length > 0 ? ` (${archived.length})` : ''}` : 'Show archived'}
				</button>
			{/if}

			{#if threads?.showArchived}
				{#if archived.length === 0}
					<p class="px-1 text-xs text-(--chat-fg-subtle)">No archived background jobs.</p>
				{/if}
				{#each archived as thread (thread.id)}
					{@render row(thread)}
				{/each}
			{/if}
		</div>
	</div>
	</div>
</div>

<style>
	.thread-row {
		background: color-mix(in oklab, var(--chat-surface) 55%, transparent);
	}
</style>
