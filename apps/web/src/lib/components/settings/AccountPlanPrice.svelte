<script lang="ts">
	import type { SubscriptionPrice } from '@kemiri/protocol';
	import type { BackendConnection } from '#lib/harness.svelte.js';
	import { SaveState } from '#lib/save-state.svelte.js';
	import { valueMoney } from '#lib/subscription-value.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import AutoInput from './AutoInput.svelte';
	import SaveStatus from './SaveStatus.svelte';

	let { backend, providerId, price, onprice }: {
		backend: BackendConnection;
		providerId: string;
		price: SubscriptionPrice;
		onprice: (price: SubscriptionPrice) => void;
	} = $props();
	const fieldId = $props.id();
	const save = new SaveState();
	let editing = $state(false);
	let priceFieldVersion = $state(0);
	let resetFailed = $state(false);

	async function savePrice(monthlyPrice: number | null): Promise<void> {
		const response = await backend.client.request({ type: 'subscriptions.price.set', providerId, monthlyPrice });
		if (response.type === 'error') throw new Error(response.error.message);
		if (response.type !== 'subscriptions.price.set') throw new Error('The computer did not confirm the price change.');
		onprice(response.price);
	}

	async function commit(text: string): Promise<void> {
		resetFailed = false;
		const amount = Number(text);
		if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a price greater than zero.');
		await savePrice(amount);
	}

	async function resetPrice(): Promise<void> {
		resetFailed = !(await save.run(() => savePrice(null)));
		if (!resetFailed) priceFieldVersion += 1;
	}
</script>

<div class="space-y-2 rounded-lg bg-(--chat-surface-2)/50 p-3 text-sm">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<p>Monthly plan price: {price.monthlyPrice === null ? 'Not set' : valueMoney(price.monthlyPrice)}{price.kind === 'default' ? ' (default)' : ''}</p>
		<Button type="button" size="sm" variant="outline" aria-expanded={editing} disabled={!backend.ready || save.status === 'saving'} onclick={() => { editing = !editing; save.reset(); }}>
			{editing ? 'Done' : 'Edit'}
		</Button>
	</div>
	{#if editing}
		<div class="flex flex-wrap items-end gap-2">
			<div class="min-w-40 flex-1 space-y-1">
				<label for={fieldId} class="font-medium">Monthly price (USD)</label>
				{#key priceFieldVersion}
					<AutoInput id={fieldId} type="number" min={0.01} step={0.01} value={price.monthlyPrice?.toString() ?? ''} state={save} disabled={!backend.ready || save.status === 'saving'} {commit} />
				{/key}
			</div>
			<Button type="button" variant="outline" disabled={!backend.ready || save.status === 'saving' || price.kind !== 'owner'} onclick={() => void resetPrice()}>Reset to default</Button>
		</div>
		<SaveStatus state={save} onretry={resetFailed ? () => void resetPrice() : undefined} reserve={false} />
	{/if}
</div>
