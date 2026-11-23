<script lang="ts">
	import type { BackendConnection } from '#lib/harness.svelte.js';
	import { Button } from '#lib/components/ui/button/index.js';

	let { backend, providerLogin, label, showComputer = false }: {
		backend: BackendConnection; providerLogin: string; label: string; showComputer?: boolean;
	} = $props();
	const pause = $derived(backend.usagePauses.find(entry => entry.providerLogin === providerLogin));
	let busy = $state(false);
	let error = $state('');

	async function toggle() {
		busy = true;
		error = '';
		try { await backend.setUsagePaused(providerLogin, !pause); }
		catch (failure) { error = failure instanceof Error ? failure.message : 'Could not change the pause.'; }
		finally { busy = false; }
	}
</script>

<div>
	<Button variant="outline" size="sm" disabled={busy || !backend.ready} onclick={() => void toggle()}
		aria-label="{pause ? 'Resume' : 'Pause'} {label} on {backend.name}">
		{busy ? 'Saving…' : pause ? 'Resume' : 'Pause'}{showComputer ? ` · ${backend.name}` : ''}
	</Button>
	{#if error}<p class="mt-1 text-xs" role="alert">{error}</p>{/if}
</div>
