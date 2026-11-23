<script lang="ts">
	import type { UsageDrainMode } from '@kemiri/protocol';
	import type { BackendConnection } from '#lib/harness.svelte.js';
	import { SaveState } from '#lib/save-state.svelte.js';
	import SettingsRow from './SettingsRow.svelte';

	let { backend }: { backend: BackendConnection } = $props();
	const modeId = $props.id();
	const saveState = new SaveState();

	async function changeMode(select: HTMLSelectElement): Promise<void> {
		const mode = select.value as UsageDrainMode;
		if (!await saveState.run(() => backend.setUsageDrainMode(mode))) select.value = backend.usageDrainMode ?? '';
	}
</script>

<SettingsRow label="Fast usage drain" for={modeId} hint="When subscription use rises fast on this computer." status={saveState}>
	<select id={modeId} value={backend.usageDrainMode ?? ''}
		disabled={!backend.ready || backend.usageDrainMode === undefined || saveState.status === 'saving'}
		onchange={(event) => void changeMode(event.currentTarget)}
		class="min-h-11 w-full rounded-md border border-(--chat-border) bg-(--chat-bg) px-3 text-base sm:text-sm">
		{#if backend.usageDrainMode === undefined}<option value="">Loading…</option>{/if}
		<option value="pause-and-tell">Pause and tell me</option>
		<option value="tell-only">Tell me only</option>
		<option value="off">Off</option>
	</select>
</SettingsRow>
