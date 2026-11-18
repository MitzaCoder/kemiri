<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import CircleIcon from '@lucide/svelte/icons/circle';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import type { BoardTaskTimelineResponse } from '@kemiri/protocol';

	let { delivery }: { delivery: NonNullable<BoardTaskTimelineResponse['delivery']> } = $props();
	const count = $derived(delivery.commits.length);
	const landed = $derived(delivery.integration?.landed);
	const deployLabel = { live: 'Deploy succeeded', pending: 'Not fully live', failed: 'Deploy failed', unknown: 'Status unknown' };
</script>

<section aria-label="Delivery" data-task-delivery>
	<h3 class="task-detail-heading mb-2">Delivery</h3>
	<ol role="list" class="flex flex-col gap-1 text-sm">
		<li class="delivery-step"><CheckIcon class="size-4 shrink-0 text-(--chat-success)" aria-hidden="true" /><span>Built <span class="delivery-detail">{count} {count === 1 ? 'commit' : 'commits'}</span></span></li>
		<li class="delivery-step">
			{#if landed === count}<CheckIcon class="size-4 shrink-0 text-(--chat-success)" aria-hidden="true" />{:else}<CircleIcon class="size-4 shrink-0 text-(--chat-fg-muted)" aria-hidden="true" />{/if}
			<span>Merged <span class="delivery-detail">{#if delivery.integration}{landed === count ? `On ${delivery.integration.ref.replace(/^refs\/heads\//, '')}` : landed ? `${landed} of ${count} on the integration ref` : 'Not landed'}{:else}Not observed{/if}</span></span>
		</li>
		<li class="delivery-step">
			{#if delivery.deployment === 'live'}<CheckIcon class="size-4 shrink-0 text-(--chat-success)" aria-hidden="true" />{:else}<CircleIcon class="size-4 shrink-0 text-(--chat-fg-muted)" aria-hidden="true" />{/if}
			<span>Live <span class="delivery-detail">{delivery.deployment ? deployLabel[delivery.deployment] : 'Not observed'}</span></span>
		</li>
	</ol>
	<details class="mt-1">
		<summary class="task-fold text-sm"><ChevronRightIcon class="size-4 shrink-0" aria-hidden="true" />Changes</summary>
		<ul role="list" class="flex flex-col gap-1 pl-6 text-xs text-(--chat-fg-muted)">
			{#each delivery.commits as commit (commit)}<li><code title={commit}>{commit.slice(0, 12)}</code></li>{/each}
		</ul>
	</details>
</section>

<style>
	.delivery-step { display: flex; align-items: baseline; gap: 0.5rem; }
	.delivery-step > :global(svg) { align-self: flex-start; margin-top: 0.125rem; }
	.delivery-detail { margin-inline-start: 0.375rem; color: var(--chat-fg-muted); overflow-wrap: anywhere; }
</style>
