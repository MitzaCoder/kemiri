<script lang="ts">
	import type { ThreadMessage } from '@kemiri/protocol';
	import ArrowUpRight from '@lucide/svelte/icons/arrow-up-right';
	import CoordinatorMark from './CoordinatorMark.svelte';
	import { coordinatorColor } from '#lib/coordinators.js';
	import { threadMessageAnchor, threadMessageCard, type ThreadMessageLinks } from '#lib/thread-messages.js';
	let { message, viewing, links, highlighted }: { message: ThreadMessage; viewing: string; links: ThreadMessageLinks; highlighted: boolean } = $props();
	const card = $derived(threadMessageCard(message, viewing, id => links.thread(id)?.title ?? id));
	const peer = $derived(links.thread(card.peer));
</script>

<article id={threadMessageAnchor(message.id)} class:highlighted style:--peer-color={coordinatorColor(peer)} class="peer-card">
	<div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
		{#if peer}<CoordinatorMark thread={peer} />{/if}
		<a class="inline-flex items-center gap-1 font-semibold hover:underline" href={links.chat(card.peer, message.id)} title="Open this message in the other chat">{card.heading}<ArrowUpRight class="size-3 text-(--chat-fg-muted)" /></a>
		{#if message.taskId}<a class="peer-task" href={links.task(message.taskId)}>{message.taskId}</a>{/if}
		{#if card.status}<span class:awaiting={!message.replied} class="peer-status">{card.status}</span>{/if}
	</div>
	<p class="mt-1 whitespace-pre-wrap break-words text-(--chat-fg-muted)">{message.text}</p>
</article>

<style>
	.peer-card { border: 1px solid var(--chat-border); border-inline-start: 3px solid var(--peer-color); border-radius: .65rem; padding: .55rem .75rem; background: color-mix(in srgb, var(--peer-color) 6%, var(--chat-bg)); font-size: .8125rem; }
	.peer-card.highlighted { outline: 2px solid var(--peer-color); outline-offset: 2px; }
	.peer-task, .peer-status { font-size: .6875rem; color: var(--chat-fg-muted); }
	.peer-task { border: 1px solid var(--chat-border); border-radius: .3rem; padding-inline: .3rem; font-family: monospace; }
	.peer-task:hover { text-decoration: underline; }
	.awaiting { font-weight: 600; }
</style>
