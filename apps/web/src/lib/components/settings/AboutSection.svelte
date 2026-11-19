<script lang="ts">
	import { version as webVersion } from '../../../../package.json';
	import BrandMark from '#lib/components/BrandMark.svelte';
	import { harness } from '#lib/harness.svelte.js';
	import { backendVersion, versionLabel } from '#lib/aiki-version.js';
	import { backendSettingsHref } from '#lib/settings.js';
	import SettingsSection from './SettingsSection.svelte';
	import SettingsGroup from './SettingsGroup.svelte';
	import SettingsRow from './SettingsRow.svelte';
	import StatusChip from './StatusChip.svelte';
</script>

<SettingsSection title="About" description="Kemiri versions" icon="settings">
	<div class="flex items-center gap-3"><BrandMark /><span class="text-lg font-semibold">Kemiri</span></div>
	<SettingsGroup title="Versions">
		<SettingsRow label="This browser" hint="App version" control="auto">
			<span class="text-sm">{versionLabel(webVersion)}</span>
		</SettingsRow>
		{#each harness.backends as backend (backend.id)}
			{@const updates = backend.supports('release-updates') ? backend.status?.updates : undefined}
			<SettingsRow label={backend.name} hint={backendVersion(backend.connection.server?.version, backend.status) ?? 'Version unknown'} control="auto">
				{#if updates?.enabled && updates.available}
					<a class="inline-flex min-h-11 items-center" href={backendSettingsHref(backend.id, 'overview')} aria-label={`Update available on ${backend.name}`}>
						<StatusChip tone="info">Update available</StatusChip>
					</a>
				{/if}
			</SettingsRow>
		{/each}
	</SettingsGroup>
</SettingsSection>
