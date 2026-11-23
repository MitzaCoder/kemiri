<script lang="ts">
	import UsageDrainRow from "./UsageDrainRow.svelte";
	import AppSettingsGroup from './AppSettingsGroup.svelte';
	import YourNameGroup from "./YourNameGroup.svelte";
	import CoordinatorCompactionGroup from "./CoordinatorCompactionGroup.svelte";
	import DevicesSection from './DevicesSection.svelte';
	import Banner from '#lib/components/Banner.svelte';
	import ConnectionBadge from '#lib/components/ConnectionBadge.svelte';
	import DeployBanner from '#lib/components/DeployBanner.svelte';
	import MachineLine from '#lib/components/MachineLine.svelte';
	import MemoryMaintenanceGroup from '#lib/components/settings/MemoryMaintenanceGroup.svelte';
	import ReleaseLine from '#lib/components/ReleaseLine.svelte';
	import SettingsGroup from '#lib/components/settings/SettingsGroup.svelte';
	import SettingsRow from '#lib/components/settings/SettingsRow.svelte';
	import SettingsSection from '#lib/components/settings/SettingsSection.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import AutoInput from '#lib/components/settings/AutoInput.svelte';
	import CopyButton from '#lib/components/CopyButton.svelte';
	import { notifications } from '#lib/notifications.svelte.ts';
	import { harness, type BackendConnection } from '#lib/harness.svelte.js';
	import { COMPUTER_SECTIONS, generalSettingsHref, type ComputerSectionId } from '#lib/settings.js';
	import { navigateSettings } from '#lib/settings-navigation.svelte.js';
	import SoftwareUpdatesGroup from './SoftwareUpdatesGroup.svelte';

	let { backend, section }: { backend: BackendConnection; section: Exclude<ComputerSectionId, 'accounts' | 'mcp'> } = $props();
	const sectionInfo = $derived(COMPUTER_SECTIONS.find(entry => entry.id === section)!);
	let confirmingRemove = $state(false);

	async function remove(): Promise<void> {
		await notifications.disableBackend(backend);
		harness.removeBackend(backend.id);
		await navigateSettings(generalSettingsHref('backends'), true);
	}
</script>

<SettingsSection title={sectionInfo.label} description={sectionInfo.hint} icon={sectionInfo.icon}>
{#if section === 'overview'}
	{#if backend.lastError}<Banner tone="error">{backend.lastError}</Banner>{/if}
	{#if backend.connection.status !== 'ready'}
		<Banner tone="warning">
			{#if backend.connection.status === 'connecting' || backend.connection.status === 'reconnecting'}
				Connecting to {backend.name}…
			{:else}
				{backend.name} is offline.{backend.connection.error ? ` ${backend.connection.error}` : ''}
			{/if}
		</Banner>
	{/if}

	{#if backend.supports('server-status')}
		<DeployBanner status={backend.status} dismissed={harness.dismissedDeploys} ondismiss={(deploy) => harness.dismissDeploy(deploy)} />
	{/if}
	<SettingsGroup title="Status">
		<SettingsRow label="Connection" control="auto"><ConnectionBadge {backend} /></SettingsRow>
		{#if backend.supports('server-status')}
			<SettingsRow label="Release" hint="The commit this computer runs." control="full">
				<ReleaseLine release={backend.status?.release} deploy={backend.status?.deploy} />
			</SettingsRow>
			<SettingsRow label="Machine" hint="Disk space on the host." control="full">
				<MachineLine status={backend.status} />
			</SettingsRow>
		{/if}
	</SettingsGroup>

	<SoftwareUpdatesGroup {backend} />
{:else if section === 'you'}
	<YourNameGroup {backend} />
	{#if backend.supports('memory-maintenance')}<MemoryMaintenanceGroup {backend} />{/if}
{:else if section === 'devices'}
	<DevicesSection {backend} />
{:else if section === 'advanced'}
	{#if backend.features?.includes('apps')}<AppSettingsGroup {backend} />{/if}
	{#if backend.features?.includes('coordinator-compaction-settings')}
		{#key backend.id}<CoordinatorCompactionGroup {backend} />{/key}
	{/if}
	<SettingsGroup title="This computer">
		{#if backend.supports('usage-drain')}
			{#key backend.id}<UsageDrainRow {backend} />{/key}
		{/if}
		<SettingsRow label="Name on this device" hint="Only for you, in this browser." chip="This device only" for="backend-name">
			<AutoInput id="backend-name" value={backend.name} commit={(next) => harness.renameBackend(backend.id, next)} />
		</SettingsRow>
		<SettingsRow label="Address" hint="Where the app connects." control="auto">
			<div class="flex min-w-0 items-center gap-1 sm:max-w-80">
				<code class="min-w-0 flex-1 rounded-lg bg-(--chat-surface-2)/60 px-2.5 py-1.5 font-mono text-xs break-all">{backend.url}</code>
				<CopyButton text={backend.url} label="Copy the address" />
			</div>
		</SettingsRow>
	</SettingsGroup>

	<SettingsGroup title="Remove" tone="danger">
		<SettingsRow
			label="Remove this computer from this browser"
			hint="Its projects and data stay on the computer."
			chip="This device only"
			control="auto"
		>
			{#if confirmingRemove}
				<div class="flex flex-wrap gap-2 sm:justify-end">
					<Button variant="outline" class="max-sm:h-11" onclick={() => (confirmingRemove = false)}>Keep it</Button>
					<Button variant="destructive" class="max-sm:h-11" onclick={() => void remove()}>Remove {backend.name}</Button>
				</div>
			{:else}
				<Button variant="destructive" class="max-sm:h-11" onclick={() => (confirmingRemove = true)}>Remove</Button>
			{/if}
		</SettingsRow>
	</SettingsGroup>
{/if}
</SettingsSection>
