<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import CircleIcon from '@lucide/svelte/icons/circle';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { HarnessClient } from '@kemiri/client';
	import type { BoardTaskTimelineResponse, ChangeSource } from '@kemiri/protocol';
	import { changeCounts, withChanges, type ChangeList } from '#lib/code/project-changes.js';

	let { delivery, changesClient, projectId, taskId, showHeading = true }: {
		delivery: NonNullable<BoardTaskTimelineResponse['delivery']>; changesClient?: HarnessClient; projectId: string; taskId: string; showHeading?: boolean;
	} = $props();
	let expanded = $state(false);
	let details = $state<Record<string, ChangeList | null>>({});

	$effect(() => {
		const client = changesClient;
		const id = projectId;
		const hashes = delivery.commits;
		if (!expanded || !client) return;
		let disposed = false;
		let next = 0;
		const load = async () => {
			while (!disposed && next < hashes.length) {
				const hash = hashes[next++]!;
				if (untrack(() => details[hash])) continue;
				try {
					const commit = await client.listChanges(id, { kind: 'commit', hash });
					if (!disposed) details[hash] = commit;
				} catch { if (!disposed) details[hash] = null; }
			}
		};
		for (let i = 0; i < Math.min(4, hashes.length); i++) void load();
		return () => { disposed = true; };
	});

	function openChanges(event: MouseEvent, source: ChangeSource): void {
		if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		event.preventDefault();
		void goto(withChanges(page.url, source), {
			reset: false, persistState: true, state: { ...page.state, changesFrom: withChanges(page.url) },
		});
	}
	const count = $derived(delivery.commits.length);
	const landed = $derived(delivery.integration?.landed);
	const deployLabel = { live: 'Deploy succeeded', pending: 'Not fully live', failed: 'Deploy failed', unknown: 'Status unknown' };
</script>

<section aria-label={showHeading ? 'Delivery' : undefined} data-task-delivery>
	{#if showHeading}<h3 class="task-detail-heading mb-2">Delivery</h3>{/if}
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
	<details class="mt-1" ontoggle={event => expanded = event.currentTarget.open}>
		<summary class="task-fold text-sm"><ChevronRightIcon class="size-4 shrink-0" aria-hidden="true" />Changes</summary>
		{#if changesClient}
			{@const source = { kind: 'task', taskId } as const}
			<a class="review-changes" href={withChanges(page.url, source)} onclick={event => openChanges(event, source)}>Review changes</a>
		{/if}
		<ul role="list" class="flex flex-col gap-1 pl-6 text-xs text-(--chat-fg-muted)">
			{#each delivery.commits as commit (commit)}
				{@const listing = details[commit]}
				{@const subject = listing?.commits[0]?.subject}
				{@const counts = listing ? changeCounts(listing.files) : undefined}
				<li>
					{#if changesClient}
						{@const source = { kind: 'commit', hash: commit } as const}
						<a class="delivery-commit" href={withChanges(page.url, source)} onclick={event => openChanges(event, source)}>
							{#if subject}<span class="font-medium text-(--chat-fg)">{subject}</span>{/if}
							<span class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
								<code title={commit}>{commit.slice(0, 12)}</code>
								{#if counts}
									<span>{counts.files}{listing?.truncated ? '+' : ''} {counts.files === 1 ? 'file' : 'files'}</span>
									<span class="text-(--chat-success)">+{counts.additions}</span><span class="text-(--chat-danger)">−{counts.deletions}</span>
								{:else if listing === null}<span>Details unavailable</span>{/if}
							</span>
						</a>
					{:else}<code title={commit}>{commit.slice(0, 12)}</code>{/if}
				</li>
			{/each}
		</ul>
	</details>
</section>

<style>
	.delivery-step { display: flex; align-items: baseline; gap: 0.5rem; }
	.delivery-step > :global(svg) { align-self: flex-start; margin-top: 0.125rem; }
	.delivery-detail { margin-inline-start: 0.375rem; color: var(--chat-fg-muted); overflow-wrap: anywhere; }
	.review-changes, .delivery-commit { display: flex; min-height: 44px; flex-direction: column; justify-content: center; padding: 5px 8px; border-radius: 6px; overflow-wrap: anywhere; }
	.review-changes { width: fit-content; margin: 2px 0 5px 1.5rem; min-height: 34px; border: 1px solid var(--chat-border); color: var(--chat-fg); font-size: 12px; font-weight: 600; background: var(--chat-surface-2); }
	.delivery-commit:hover, .review-changes:hover { background: var(--chat-surface-2); text-decoration: underline; }
	@media (max-width: 640px) { .review-changes { min-height: 44px; } }
</style>
