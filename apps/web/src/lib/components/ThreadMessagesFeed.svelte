<script lang="ts">
	import type { ThreadMessage } from '@kemiri/protocol';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import CoordinatorMark from './CoordinatorMark.svelte';
	import { threadMessageStatus, type ThreadMessageLinks } from '#lib/thread-messages.js';
	let { messages, links, loaded, error, taskId, showHeading = true }: { messages: readonly ThreadMessage[]; links: ThreadMessageLinks; loaded: boolean; error: boolean; taskId?: string; showHeading?: boolean } = $props();
	const rows = $derived(taskId ? messages.filter(message => message.taskId === taskId) : messages);
	let visible = $state(6);
	const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
	const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
</script>

<section class="peer-feed" class:standalone={showHeading} aria-label={showHeading ? (taskId ? 'Coordinator messages' : 'Between coordinators') : undefined}>
	{#if showHeading}<h3 class="text-sm font-semibold">{taskId ? 'Coordinator messages' : 'Between coordinators'}</h3>{/if}
	{#if error}
		<p class="mt-2 text-xs text-(--chat-fg-muted)" role="status">Could not read coordinator messages.</p>
	{:else if !loaded && !rows.length}
		<p class="mt-2 text-xs text-(--chat-fg-muted)">Loading messages…</p>
	{:else if !rows.length}
		<p class="mt-2 text-xs text-(--chat-fg-muted)">No coordinator messages yet.</p>
	{:else}
		<ul class="mt-2 divide-y divide-(--chat-border)">
			{#each rows.slice(0, visible) as message (message.id)}
				{@const from = links.thread(message.from)}
				{@const to = links.thread(message.to)}
				{@const status = threadMessageStatus(message)}
				<li class="min-w-0 py-2 first:pt-0">
					<div class="flex flex-wrap items-center gap-1.5 text-xs font-semibold">
						{#if from}<CoordinatorMark thread={from} />{/if}
						<a class="hover:underline" href={links.chat(message.from, message.id)}>{from?.title ?? message.from}</a>
						<ArrowRight class="size-3 text-(--chat-fg-muted)" aria-label="to" />
						{#if to}<CoordinatorMark thread={to} />{/if}
						<a class="hover:underline" href={links.chat(message.to, message.id)}>{to?.title ?? message.to}</a>
					</div>
					<p class="mt-1 truncate text-sm" title={message.firstLine}>{message.firstLine}</p>
					<div class="mt-1 flex flex-wrap gap-x-2 text-xs text-(--chat-fg-muted)">
						{#if message.taskId && !taskId}<a class="font-mono hover:underline" href={links.task(message.taskId)}>{message.taskId}</a>{/if}
						<span>{message.kind === 'note' ? 'Note' : message.kind === 'reply' ? 'Reply' : status ?? 'Request'}</span>
						<time datetime={message.at} title={date.format(new Date(message.at))}>{new Date(message.at).toDateString() === new Date().toDateString() ? clock.format(new Date(message.at)) : date.format(new Date(message.at))}</time>
					</div>
				</li>
			{/each}
		</ul>
		{#if rows.length > visible}<button class="text-xs font-semibold text-(--accent-2) hover:underline" onclick={() => visible += 12}>Show earlier messages</button>{/if}
	{/if}
</section>

<style>
	.peer-feed { min-width: 0; }
	.peer-feed.standalone { padding: .75rem; background: var(--chat-bg); }
</style>
