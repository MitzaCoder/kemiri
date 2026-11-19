<script lang="ts">
	import { tick } from 'svelte';
	import type { SubscriptionValue } from '@kemiri/protocol';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import Banner from '#lib/components/Banner.svelte';
	import { estimatedMoney, fullWindowLabel, realisedValue, valueMoney, valuePercent, valueRange } from '#lib/subscription-value.js';

	let { subscription, editable, savePrice, taskHref, onTaskClick }: {
		subscription: SubscriptionValue;
		editable: boolean;
		savePrice: (monthlyPrice: number | null) => Promise<void>;
		taskHref: (projectId: string, taskId: string) => string;
		onTaskClick: (event: MouseEvent) => void;
	} = $props();

	const headline = $derived(realisedValue(subscription));
	const binding = $derived(subscription.windows.find((window) => window.binding) ?? subscription.windows[0]);
	const fullUse = $derived(binding?.fullWindowValue && binding.windowsPerMonth
		? binding.fullWindowValue.estimate * binding.windowsPerMonth : null);
	const scale = $derived(Math.max(subscription.apiValue, subscription.price.monthlyPrice ?? 0, fullUse ?? 0));
	const modelScale = $derived(Math.max(0, ...subscription.models.map((model) => model.apiValue)));
	let editing = $state(false);
	let priceInput = $state<number | undefined>(undefined);
	let saving = $state(false);
	let priceError = $state('');
	let priceStatus = $state('');
	let priceAction: HTMLButtonElement | null = $state(null);
	let priceField: HTMLInputElement | null = $state(null);

	function startEditing(): void {
		priceInput = subscription.price.monthlyPrice ?? undefined;
		priceError = '';
		priceStatus = '';
		editing = true;
	}

	$effect(() => { if (editing) priceField?.focus(); });

	async function finishEditing(): Promise<void> {
		editing = false;
		priceError = '';
		await tick();
		priceAction?.focus();
	}

	async function updatePrice(amount: number | null): Promise<void> {
		if (saving || !editable || (amount !== null && (!Number.isFinite(amount) || amount <= 0))) return;
		saving = true;
		priceError = '';
		try {
			await savePrice(amount);
			priceStatus = amount === null ? 'Price reset.' : 'Price saved.';
			await finishEditing();
		} catch (error) {
			priceError = error instanceof Error ? error.message : String(error);
		} finally {
			saving = false;
		}
	}
</script>

{#snippet bar(amount: number, maximum: number, color: string)}
	<div aria-hidden="true" class="h-1.5 overflow-hidden rounded-full bg-(--chat-surface-2)">
		<div class="h-full rounded-full {color}" style:width="{maximum > 0 ? 100 * amount / maximum : 0}%"></div>
	</div>
{/snippet}

<article class="flex min-w-0 flex-col gap-4 rounded-2xl border border-(--chat-border) bg-(--chat-surface)/55 p-4 sm:p-5">
	<header class="space-y-2">
		<h4 class="text-sm font-semibold break-words">
			{subscription.label}{#if subscription.plan}<span class="font-normal text-(--chat-fg-muted)">{' · ' + subscription.plan}</span>{/if}
		</h4>
		<div>
			<p class="text-2xl font-semibold tracking-tight tabular-nums">{headline.headline}</p>
			{#if headline.comparison}<p class="mt-1 text-sm text-(--chat-fg-muted)">{headline.comparison}</p>{/if}
		</div>
		<div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-(--chat-fg-muted)">
			{#if subscription.price.kind === 'default'}
				<details>
					<summary class="cursor-pointer underline decoration-dotted underline-offset-4">default price</summary>
					<p class="mt-1">
						{#if subscription.price.checkedOn}Checked {subscription.price.checkedOn}.{/if}
						{#if subscription.price.source}<a class="underline underline-offset-2" href={subscription.price.source} target="_blank" rel="noopener noreferrer">Price source</a>{/if}
					</p>
				</details>
			{:else if subscription.price.kind === 'owner'}
				<span>Owner price</span>
			{/if}
			{#if editable}
				<Button bind:ref={priceAction} size="sm" variant="outline" type="button" onclick={startEditing} aria-expanded={editing}>
					{headline.priceAction}
				</Button>
			{:else if subscription.price.kind === 'none'}
				<span>{headline.priceAction} in the current month.</span>
			{/if}
		</div>
		{#if editing && editable}
			<form class="space-y-2 rounded-xl border border-(--chat-border) p-3" onsubmit={(event) => { event.preventDefault(); if (priceInput !== undefined) void updatePrice(priceInput); }}>
				<label class="block text-xs font-medium">
					Monthly price (USD)
					<Input bind:ref={priceField} type="number" min="0.01" step="0.01" required bind:value={priceInput} class="mt-1 w-32" />
				</label>
				<div class="flex flex-wrap gap-1">
					<Button type="submit" size="sm" disabled={saving}>{saving ? 'Saving…' : 'Save price'}</Button>
					{#if subscription.price.kind === 'owner'}
						<Button type="button" size="sm" variant="outline" disabled={saving} onclick={() => void updatePrice(null)}>Reset to default</Button>
					{/if}
					<Button type="button" size="sm" variant="ghost" disabled={saving} onclick={finishEditing}>Cancel</Button>
				</div>
				{#if priceError}<Banner tone="error">Could not save price: {priceError}</Banner>{/if}
			</form>
		{/if}
		<span class="sr-only" role="status">{priceStatus}</span>
	</header>

	{#if binding}
		<dl class="space-y-2 text-xs">
			{#each [{ label: 'Monthly price', amount: subscription.price.monthlyPrice, color: 'bg-(--chat-fg-muted)', format: valueMoney }, { label: 'API value used', amount: subscription.apiValue, color: 'bg-(--accent-2)', format: valueMoney }, { label: 'At full use · estimated', amount: fullUse, color: 'bg-(--accent-2)/35', format: estimatedMoney }] as comparison (comparison.label)}
				{#if comparison.amount !== null}
					<div class="space-y-1">
						<div class="flex justify-between gap-2"><dt class="text-(--chat-fg-muted)">{comparison.label}</dt><dd class="font-medium tabular-nums">{comparison.format(comparison.amount)}</dd></div>
						{@render bar(comparison.amount, scale, comparison.color)}
					</div>
				{/if}
			{/each}
		</dl>

		<dl class="grid grid-cols-3 gap-2 border-y border-(--chat-border) py-3 text-xs">
			<div>
				<dt class="text-(--chat-fg-muted)">Plan used this month</dt>
				<dd class="mt-1 font-semibold tabular-nums">{valuePercent(subscription.planUsed)}</dd>
			</div>
			<div>
				<dt class="text-(--chat-fg-muted)">{fullWindowLabel(binding)}</dt>
				{#if binding.fullWindowValue}
					<dd class="mt-1 font-semibold tabular-nums">≈ {estimatedMoney(binding.fullWindowValue.estimate)}</dd>
					<dd class="text-(--chat-fg-muted)">{valueRange(binding.fullWindowValue)}</dd>
				{:else}
					<dd class="mt-1 font-semibold">not enough use yet</dd>
				{/if}
			</div>
			<div>
				<dt class="text-(--chat-fg-muted)">Used elsewhere</dt>
				<dd class="mt-1 font-semibold tabular-nums">{valuePercent(binding.elsewhereShare)}</dd>
			</div>
		</dl>

		{#if subscription.models.length}
			<section class="space-y-2" aria-label="Models">
				<h5 class="text-sm font-semibold">Models</h5>
				<ul class="space-y-2">
					{#each subscription.models as model (model.model)}
						<li class="space-y-1 text-xs">
							<div class="flex justify-between gap-2"><span class="[overflow-wrap:anywhere]">{model.model}</span><span class="shrink-0 font-medium tabular-nums">{valueMoney(model.apiValue)}</span></div>
							{@render bar(model.apiValue, modelScale, 'bg-(--accent-2)/65')}
							<p class="text-(--chat-fg-muted)">
								{#if model.valuePerPoint}≈ {estimatedMoney(model.valuePerPoint.estimate)} per point · {valueRange(model.valuePerPoint)}
								{:else if model.scopedWindowId !== null}not enough use yet
								{:else}not measured separately{/if}
							</p>
						</li>
					{/each}
				</ul>
			</section>
		{/if}

		<section class="space-y-2" aria-label="Where it went">
			<h5 class="text-sm font-semibold">Where it went</h5>
			{#if subscription.topTasks.length}
				<ul class="space-y-1.5 text-xs">
					{#each subscription.topTasks as task (`${task.projectId}/${task.taskId}`)}
						<li class="flex justify-between gap-3">
							<a class="break-words underline underline-offset-3" href={taskHref(task.projectId, task.taskId)} onclick={onTaskClick}>{task.taskId} · {task.title}</a>
							<span class="shrink-0 font-medium tabular-nums">{valueMoney(task.apiValue)}</span>
						</li>
					{/each}
				</ul>
				<p class="text-xs text-(--chat-fg-muted)">Top tasks include their subtasks. Coordinator work is not spread across tasks.</p>
			{:else}
				<p class="text-xs text-(--chat-fg-muted)">No recorded work linked to tasks this month.</p>
			{/if}
		</section>
	{/if}
</article>
