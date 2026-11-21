<script lang="ts">
	import CoordinatorMark from './CoordinatorMark.svelte';
	import type { landingTurnPresentation } from '#lib/landing-turn.js';
	let { turn }: { turn: NonNullable<ReturnType<typeof landingTurnPresentation>> } = $props();
</script>

<p class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-(--chat-fg-muted)" aria-label="Landing turn status">
	<strong class="font-semibold text-(--chat-fg)">Landing turn:</strong>
	{#if turn.holder}
		<span class="inline-flex items-center gap-1">{#if turn.holder.thread}<CoordinatorMark thread={turn.holder.thread} />{/if}{turn.holder.title}{turn.holder.taskId ? ` (${turn.holder.taskId})` : ''}</span>
	{:else}
		<span>Free</span>
	{/if}
	{#if turn.waiting.length}
		<span>· waiting:</span>
		{#each turn.waiting as waiter, index (waiter.id)}
			<span class="inline-flex items-center gap-1">{#if waiter.thread}<CoordinatorMark thread={waiter.thread} />{/if}{waiter.title}{index < turn.waiting.length - 1 ? ',' : ''}</span>
		{/each}
	{/if}
</p>
