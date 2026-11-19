<script lang="ts">
	import type { UsageValueResponse } from '@kemiri/protocol';
	import { projectHref } from '#lib/backends.js';
	import Banner from '#lib/components/Banner.svelte';
	import type { BackendConnection } from '#lib/harness.svelte.js';
	import { taskHref } from '#lib/task-chat.js';
	import { usageModal } from '#lib/usage-modal.svelte.js';
	import { valueMoney, valueMonthRequest } from '#lib/subscription-value.js';
	import SubscriptionValueCard from './SubscriptionValueCard.svelte';
	import UsageSkeleton from './UsageSkeleton.svelte';

	let { backend, month, currentMonth, refreshCount }: {
		backend: BackendConnection;
		month: string;
		currentMonth: string;
		refreshCount: number;
	} = $props();

	let report = $state<UsageValueResponse>();
	let readError = $state('');
	let priceRevision = $state(0);
	let reading = $state(false);

	$effect(() => {
		const query = valueMonthRequest(month);
		// Manual refreshes and successful price changes both read the authoritative report again.
		void refreshCount;
		void priceRevision;
		if (!backend.ready) { reading = false; return; }
		let ignore = false;
		reading = true;
		readError = '';
		void backend.client.request<UsageValueResponse>(query).then((response) => {
			if (ignore) return;
			if (response.type === 'error') throw new Error(response.error.message);
			report = response;
		}).catch((error) => {
			if (!ignore) readError = error instanceof Error ? error.message : String(error);
		}).finally(() => {
			if (!ignore) reading = false;
		});
		return () => { ignore = true; };
	});

	async function savePrice(providerId: string, monthlyPrice: number | null): Promise<void> {
		const response = await backend.client.request({ type: 'subscriptions.price.set', providerId, monthlyPrice });
		if (response.type === 'error') throw new Error(response.error.message);
		if (response.type !== 'subscriptions.price.set') throw new Error('The backend did not confirm the price change.');
		priceRevision += 1;
	}

	function taskLink(projectId: string, taskId: string): string {
		return projectHref(backend.id, projectId) + taskHref(taskId);
	}

	function openTask(event: MouseEvent): void {
		if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) usageModal.open = false;
	}

	const limited = $derived(report?.subscriptions.filter((subscription) => subscription.windows.length > 0) ?? []);
	const noLimit = $derived(report?.subscriptions.filter((subscription) => subscription.windows.length === 0) ?? []);
</script>

{#snippet cards(subscriptions: UsageValueResponse['subscriptions'])}
	<div class="grid grid-cols-[repeat(auto-fit,minmax(min(100%,25rem),1fr))] items-start gap-3">
		{#each subscriptions as subscription (`${subscription.providerId}/${subscription.billing}`)}
			<SubscriptionValueCard {subscription} editable={month === currentMonth && backend.ready} savePrice={(amount) => savePrice(subscription.providerId, amount)} taskHref={taskLink} onTaskClick={openTask} />
		{/each}
	</div>
{/snippet}

<section aria-label="Subscription value on {backend.name}" aria-busy={reading} class="min-w-0 space-y-4">
	<div class="flex items-center gap-3 px-1">
		<h2 class="text-sm font-semibold tracking-tight">{backend.name}</h2>
		<span class="h-px flex-1 bg-(--chat-border)"></span>
	</div>
	{#if !backend.ready}
		<p class="text-sm text-(--chat-fg-muted)">{report ? 'Backend disconnected. Showing the last report.' : 'Waiting for the backend…'}</p>
	{:else if readError}
		<Banner tone="warning">Could not read subscription value: {readError}{report ? ' Showing the last report.' : ''}</Banner>
	{:else if !report}
		<UsageSkeleton />
	{/if}
	{#if report}
		{#if limited.length}
			<section aria-label="Subscriptions with limits" class="space-y-2">
				<h3 class="sr-only">Subscriptions with limits</h3>
				{@render cards(limited)}
			</section>
		{/if}
		{#if report.payAsYouGo.length}
			<section class="rounded-2xl border border-(--chat-border) bg-(--chat-surface)/55 p-4 sm:p-5">
				<h3 class="text-sm font-semibold">Paid at API prices</h3>
				<p class="mt-1 text-xs text-(--chat-fg-muted)">Recorded API-key costs at catalog rates.</p>
				<dl class="mt-3 divide-y divide-(--chat-border) text-sm">
					{#each report.payAsYouGo as key (key.providerId)}
						<div class="flex justify-between gap-3 py-2">
							<dt class="break-words">{key.label}</dt>
							<dd class="shrink-0 font-medium tabular-nums">{valueMoney(key.cost)}</dd>
						</div>
					{/each}
				</dl>
			</section>
		{/if}
		{#if noLimit.length}
			<section class="space-y-2">
				<h3 class="px-1 text-sm font-semibold">No limit reported</h3>
				{@render cards(noLimit)}
			</section>
		{/if}
		{#if !report.subscriptions.length && !report.payAsYouGo.length}
			<p class="rounded-2xl border border-dashed border-(--chat-border) px-4 py-5 text-sm text-(--chat-fg-muted)">No subscription or API-key usage recorded this month.</p>
		{/if}
		<p class="px-1 text-xs leading-relaxed text-(--chat-fg-muted)">
			API value adds up recorded requests at catalog rates, not invoice prices. Plan use, full use and points used elsewhere are estimates from observed limit changes{report.ledgerSince ? ` since ${new Date(report.ledgerSince).toLocaleDateString()}` : ''}.
			{report.assumed ? ' Billing for older requests was assumed from backend credentials.' : ''}
			{report.approximateMonth ? ' Older daily totals may cross a local month boundary.' : ''}
			{report.unpricedRequests ? ` ${report.unpricedRequests.toLocaleString()} ${report.unpricedRequests === 1 ? 'request had' : 'requests had'} no catalog price.` : ''}
		</p>
	{/if}
</section>
