<script lang="ts">
	import type { BackendConnection } from '#lib/harness.svelte.js';
	import { normalizeUserName } from '@kemiri/protocol';
	import SettingsGroup from './SettingsGroup.svelte';
	import SettingsRow from './SettingsRow.svelte';
	import AutoInput from './AutoInput.svelte';
	let { backend }: { backend: BackendConnection } = $props();
</script>

{#if backend.features?.includes('user-settings')}
	<SettingsGroup title="About you">
		<SettingsRow label="Your name" for="your-name" hint="Optional · up to 80 characters. Agents use this name across all projects on this computer, from their next turn. Clear it to stop using a name.">
			<AutoInput id="your-name" value={backend.userName} placeholder="What should agents call you?" disabled={!backend.ready || !backend.userSettingsLoaded}
				commit={(name) => backend.setUserName(normalizeUserName(name))} />
		</SettingsRow>
	</SettingsGroup>
{/if}
