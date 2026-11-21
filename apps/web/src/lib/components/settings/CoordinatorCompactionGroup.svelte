<script lang="ts">
	import { DEFAULT_COORDINATOR_COMPACTION, type CoordinatorCompaction } from '@kemiri/protocol';
	import type { BackendConnection } from '#lib/harness.svelte.js';
	import { SaveState } from '#lib/save-state.svelte.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import SaveStatus from './SaveStatus.svelte';
	import SettingsFold from './SettingsFold.svelte';
	import SettingsGroup from './SettingsGroup.svelte';
	import SettingsRow from './SettingsRow.svelte';

	let { backend }: { backend: BackendConnection } = $props();
	const groupId = $props.id();
	const backgroundId = `${groupId}-background`;
	const blockingId = `${groupId}-blocking`;
	const saveState = new SaveState();
	const savedBackground = $derived(backend.coordinatorCompaction?.backgroundPercent);
	const savedBlocking = $derived(backend.coordinatorCompaction?.blockingPercent);
	const defaults = DEFAULT_COORDINATOR_COMPACTION;
	let backgroundPercent = $state<number>();
	let blockingPercent = $state<number>();
	$effect(() => {
		backgroundPercent = savedBackground;
		blockingPercent = savedBlocking;
	});
	const disabled = $derived(backend.connection.status !== 'ready' || backend.coordinatorCompaction === undefined || saveState.status === 'saving');
	const changed = $derived(backgroundPercent !== savedBackground || blockingPercent !== savedBlocking);
	const atDefaults = $derived(savedBackground === defaults.backgroundPercent && savedBlocking === defaults.blockingPercent);

	async function apply(thresholds: CoordinatorCompaction): Promise<void> {
		if (disabled) return;
		if (await saveState.run(() => backend.setCoordinatorCompaction(thresholds))) {
			backgroundPercent = backend.coordinatorCompaction?.backgroundPercent;
			blockingPercent = backend.coordinatorCompaction?.blockingPercent;
		}
	}

	function save(): void {
		if (backgroundPercent === undefined || !Number.isInteger(backgroundPercent) || backgroundPercent < 20 || backgroundPercent > 90 ||
			blockingPercent === undefined || !Number.isInteger(blockingPercent) || blockingPercent < 30 || blockingPercent > 95 || blockingPercent <= backgroundPercent) {
			saveState.fail('Use whole percentages: background 20–90, wait 30–95 and higher than background.');
			return;
		}
		void apply({ backgroundPercent, blockingPercent });
	}
</script>

<SettingsGroup>
	<SettingsFold title="Conversation summaries">
		<p class="px-4 py-3 text-[0.8125rem] text-muted-foreground sm:px-5">
			For all coordinators on this computer. The percentages measure how full the model’s context window is.
		</p>
		{#if backend.coordinatorCompaction === undefined}
			<p class="px-4 py-3 text-sm text-muted-foreground sm:px-5">Summary settings are not loaded.</p>
		{:else}
			<form class="divide-y divide-(--chat-border)" novalidate onsubmit={(event) => { event.preventDefault(); save(); }}>
				<SettingsRow label="Start summarizing in the background at" for={backgroundId} hint="20–90%" control="auto">
					<div class="flex items-center gap-2">
						<Input id={backgroundId} type="number" min={20} max={90} step={1} inputmode="numeric" bind:value={backgroundPercent} {disabled} class="w-20 max-sm:h-11" />
						<span aria-hidden="true" class="text-sm text-muted-foreground">%</span>
					</div>
				</SettingsRow>
				<SettingsRow label="Pause and wait for the summary at" for={blockingId} hint="30–95%, higher than the background point" control="auto">
					<div class="flex items-center gap-2">
						<Input id={blockingId} type="number" min={30} max={95} step={1} inputmode="numeric" bind:value={blockingPercent} {disabled} class="w-20 max-sm:h-11" />
						<span aria-hidden="true" class="text-sm text-muted-foreground">%</span>
					</div>
				</SettingsRow>
				<div class="flex flex-wrap items-center gap-2 px-4 py-3 sm:px-5">
					<Button type="submit" disabled={disabled || !changed} class="max-sm:h-11">Save</Button>
					<Button type="button" variant="outline" disabled={disabled || (atDefaults && !changed)} class="max-sm:h-11" onclick={() => void apply(defaults)}>Reset to defaults</Button>
					<SaveStatus state={saveState} reserve={false} />
				</div>
			</form>
		{/if}
	</SettingsFold>
</SettingsGroup>
