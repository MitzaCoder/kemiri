<script lang="ts">
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import ServerIcon from '@lucide/svelte/icons/server';
	import BackendForm from '#lib/components/BackendForm.svelte';
	import ConnectComputerGroup from './ConnectComputerGroup.svelte';
	import SettingsGroup from '#lib/components/settings/SettingsGroup.svelte';
	import SettingsRow from '#lib/components/settings/SettingsRow.svelte';
	import SettingsSection from '#lib/components/settings/SettingsSection.svelte';
	import StatusChip from '#lib/components/settings/StatusChip.svelte';
	import SuggestedBackends from '#lib/components/SuggestedBackends.svelte';
	import { connectionView } from '#lib/connection.js';
	import { harness } from '#lib/harness.svelte.js';
	import { missingPublished } from '#lib/published-backends.js';
	import { backendSettingsHref } from '#lib/settings.js';
	import { suggestedBackends } from '#lib/suggested-backends.svelte.js';

	/**
	 * General → Backends: the servers this browser knows, each opening its own page (status, rename, accounts and API
	 * keys, memory maintenance), then the ways to add one: a published suggestion, a typed address, another device.
	 */
	const suggested = $derived(missingPublished(suggestedBackends.backends, harness.backends.map(({ url }) => url)));

	function addBackend(input: { name: string; url: string }): void {
		harness.addBackend(input.name, input.url);
	}
</script>

<SettingsSection title="Computers" term="Backends" description="Computers this browser connects to" icon="server">
	<SettingsGroup title="Your computers">
		{#each harness.backends as backend (backend.id)}
			{@const view = connectionView(backend.connection)}
			<a
				href={backendSettingsHref(backend.id)}
				data-backend-row={backend.id}
				class="group flex min-h-14 items-center gap-3 px-4 py-3 transition-colors hover:bg-(--chat-surface-2)/50 sm:px-5"
			>
				<span class="grid size-9 shrink-0 place-items-center rounded-lg bg-(--chat-surface-2)/70 text-(--chat-fg-muted)">
					<ServerIcon class="size-4" aria-hidden="true" />
				</span>
				<span class="flex min-w-0 flex-1 flex-col">
					<span class="truncate text-sm font-semibold">{backend.name}</span>
					<span class="truncate font-mono text-xs text-muted-foreground">{backend.url}</span>
				</span>
				<StatusChip tone={view.tone === 'ok' ? 'ok' : view.tone === 'err' ? 'err' : view.tone === 'warn' ? 'warn' : 'muted'}>
					{view.label}
				</StatusChip>
				<ChevronRightIcon class="size-4 shrink-0 text-(--chat-fg-subtle)" aria-hidden="true" />
			</a>
		{:else}
			<p class="px-5 py-6 text-center text-sm text-muted-foreground">No computers yet. Add one below.</p>
		{/each}
	</SettingsGroup>

	{#if suggested.length > 0}
		<SettingsGroup title="Suggested computers" description="Published beside the app. One tap adds one and connects.">
			<div class="px-4 py-4 sm:px-5"><SuggestedBackends backends={suggested} /></div>
		</SettingsGroup>
	{/if}

	<SettingsGroup title="Add a computer">
		<SettingsRow label="Name and address" hint="A short computer name expands to the published domain." control="full">
			{#snippet learn()}
				A backend is a Kemiri server reached over HTTPS: the app opens wss://&lt;address&gt;/ws and keeps one
				connection per backend. The list is stored in this browser.
			{/snippet}
			<BackendForm onsubmit={addBackend} />
		</SettingsRow>
	</SettingsGroup>

	<ConnectComputerGroup />
</SettingsSection>
