<script lang="ts">
	import type { BackendConnection } from '#lib/harness.svelte.js';
	import Banner from '#lib/components/Banner.svelte';
	import { pauseWaitLabel, subscriptionProviderLabel } from '#lib/usage-glance.js';
	import UsagePauseAction from './UsagePauseAction.svelte';

	let { backend }: { backend: BackendConnection } = $props();
</script>

{#if backend.usagePauseLoaded}
	{#each backend.usagePauses as pause (pause.providerLogin)}
		{@const label = subscriptionProviderLabel(pause.providerLogin, backend.providers.find(provider => provider.id === pause.providerLogin)?.name)}
		<Banner tone="warning">
			<div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
				<div>
					<p class="font-semibold">{label} work is paused on this computer.</p>
					<p>{pause.reason} {pauseWaitLabel(pause)}</p>
				</div>
				<UsagePauseAction {backend} providerLogin={pause.providerLogin} {label} />
			</div>
		</Banner>
	{/each}
{/if}
