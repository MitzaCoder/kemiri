<script lang="ts">
	import { DEFAULT_APP_SETTINGS, type AppSettings } from '@kemiri/protocol';
	import type { BackendConnection } from '#lib/harness.svelte.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import SettingsGroup from './SettingsGroup.svelte';
	import SettingsRow from './SettingsRow.svelte';

	let { backend }: { backend: BackendConnection } = $props();
	let saved = $state<AppSettings>();
	let mode = $state<AppSettings['addresses']['mode']>(DEFAULT_APP_SETTINGS.addresses.mode);
	let template = $state('');
	let policy = $state<AppSettings['policy']>(DEFAULT_APP_SETTINGS.policy);
	let busy = $state(false);
	let error = $state<string>();
	const draft = $derived<AppSettings>({ addresses: mode === 'template' ? { mode, template } : { mode }, policy });
	const dirty = $derived(saved && JSON.stringify(saved) !== JSON.stringify(draft));

	function apply(settings: AppSettings) {
		saved = settings;
		mode = settings.addresses.mode;
		template = settings.addresses.mode === 'template' ? settings.addresses.template : '';
		policy = settings.policy;
	}

	$effect(() => {
		if (backend.connection.status !== 'ready') return;
		let active = true;
		let pushed = false;
		const stop = backend.client.onAppSettingsChanged(settings => { pushed = true; if (!dirty) apply(settings); });
		void backend.client.getAppSettings().then(settings => { if (active && !pushed) apply(settings); })
			.catch(cause => { if (active) error = cause.message; });
		return () => { active = false; stop(); };
	});

	async function save() {
		busy = true;
		error = undefined;
		try { apply(await backend.client.setAppSettings(draft)); }
		catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
		finally { busy = false; }
	}
</script>

<SettingsGroup title="Agent apps">
	<SettingsRow label="App addresses" for="app-address-mode" hint="How new apps get an address on this backend. This does not set up network access.">
		<select id="app-address-mode" bind:value={mode} disabled={!saved || busy} class="app-setting-control">
			<option value="off">Off</option>
			<option value="template">Address template</option>
		</select>
	</SettingsRow>
	{#if mode === 'template'}
		<SettingsRow label="Address template" for="app-address-template" hint={'Use an HTTP or HTTPS URL containing {port}. Add {path} to place the app path, or it will be appended.'} control="full">
			<input id="app-address-template" bind:value={template} disabled={!saved || busy} placeholder={'http://oven.example.test:{port}'} class="app-setting-control w-full font-mono" />
		</SettingsRow>
	{/if}
	<SettingsRow label="Agents may publish apps" for="app-publish-policy" hint="Ask requires approval in Running apps before agents may publish in a project.">
		<select id="app-publish-policy" bind:value={policy} disabled={!saved || busy} class="app-setting-control">
			<option value="off">Off</option>
			<option value="ask">Ask</option>
			<option value="on">On</option>
		</select>
	</SettingsRow>
	<SettingsRow label="App settings" hint="Changes apply to new publications. Stop removes an existing link from Kemiri." control="auto">
		<Button size="sm" class="max-sm:min-h-11" disabled={!dirty || busy || backend.connection.status !== 'ready'} onclick={() => void save()}>Save app settings</Button>
	</SettingsRow>
	{#if error}<p role="alert" class="px-4 py-2 text-sm text-(--chat-danger)">{error}</p>{/if}
</SettingsGroup>

<style>
	.app-setting-control { min-height: 2.5rem; border: 1px solid var(--chat-border); border-radius: .5rem; padding: .375rem .625rem; background: var(--chat-surface); color: var(--chat-fg); }
	@media (max-width: 640px) { .app-setting-control { min-height: 2.75rem; } }
</style>
