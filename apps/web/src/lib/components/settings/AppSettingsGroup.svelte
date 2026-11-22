<script lang="ts">
	import { DEFAULT_APP_SETTINGS, DEFAULT_TAILSCALE_SERVE_RANGE, type AppSettings, type TailscaleAppStatus } from '@kemiri/protocol';
	import type { BackendConnection } from '#lib/harness.svelte.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import SettingsGroup from './SettingsGroup.svelte';
	import SettingsRow from './SettingsRow.svelte';

	let { backend }: { backend: BackendConnection } = $props();
	let saved = $state<AppSettings>();
	let mode = $state<AppSettings['addresses']['mode']>(DEFAULT_APP_SETTINGS.addresses.mode);
	let template = $state('');
	let tailscale = $state<TailscaleAppStatus>();
	let startPort = $state<number | undefined>(DEFAULT_TAILSCALE_SERVE_RANGE.startPort);
	let endPort = $state<number | undefined>(DEFAULT_TAILSCALE_SERVE_RANGE.endPort);
	let policy = $state<AppSettings['policy']>(DEFAULT_APP_SETTINGS.policy);
	let busy = $state(false);
	let error = $state<string>();
	const draft = $derived<AppSettings>({ addresses: mode === 'template' ? { mode, template } :
		mode === 'tailscale-serve' ? { mode, startPort: startPort ?? 0, endPort: endPort ?? 0 } : { mode }, policy });
	const dirty = $derived(saved && JSON.stringify(saved) !== JSON.stringify(draft));

	function apply(settings: AppSettings) {
		saved = settings;
		mode = settings.addresses.mode;
		template = settings.addresses.mode === 'template' ? settings.addresses.template : '';
		startPort = settings.addresses.mode === 'tailscale-serve' ? settings.addresses.startPort : DEFAULT_TAILSCALE_SERVE_RANGE.startPort;
		endPort = settings.addresses.mode === 'tailscale-serve' ? settings.addresses.endPort : DEFAULT_TAILSCALE_SERVE_RANGE.endPort;
		policy = settings.policy;
	}

	$effect(() => {
		if (backend.connection.status !== 'ready') return;
		let active = true;
		let pushed = false;
		const stop = backend.client.onAppSettingsChanged(settings => { pushed = true; if (!dirty) apply(settings); });
		void backend.client.getAppSettingsWithStatus().then(response => {
			if (!active) return;
			tailscale = response.tailscale;
			if (!pushed) apply(response.settings);
		})
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
	<SettingsRow label="App addresses" for="app-address-mode" hint="How app links reach devices. Links are not behind Kemiri sign-in.">
		<select id="app-address-mode" bind:value={mode} disabled={!saved || busy} class="app-setting-control w-full">
			<option value="off">Off</option>
			<option value="template">Address template</option>
			{#if tailscale || mode === 'tailscale-reserved'}<option value="tailscale-reserved">Tailscale HTTPS (reserved ports)</option>{/if}
			{#if tailscale || mode === 'tailscale-serve'}<option value="tailscale-serve">Tailscale HTTPS (advanced)</option>{/if}
		</select>
		{#snippet below()}
			{#if tailscale?.reservedPorts}
				<p class={tailscale.reservedPorts.ok ? 'text-sm text-muted-foreground' : 'text-sm text-(--chat-warning)'}>
					{tailscale.reservedPorts.message}
				</p>
			{/if}
			{#if mode === 'tailscale-serve'}
				<p class="text-sm text-(--chat-warning)">Advanced: gives Kemiri the right to change Tailscale Serve. Reserved ports do not need this permission.</p>
			{/if}
		{/snippet}
	</SettingsRow>
	{#if mode === 'template'}
		<SettingsRow label="Address template" for="app-address-template" hint={'Use an HTTP or HTTPS URL containing {port}. Add {path} to place the app path, or it will be appended.'} control="full">
			<input id="app-address-template" bind:value={template} disabled={!saved || busy} placeholder={'http://oven.example.test:{port}'} class="app-setting-control w-full font-mono" />
		</SettingsRow>
	{:else if mode === 'tailscale-serve'}
		<SettingsRow label="HTTPS port range" hint="Reserve 1–100 ports for app links. Do not include 8443 or Kemiri’s port." control="full">
			<div class="flex flex-wrap gap-2">
				<label class="grid gap-1 text-sm">First port<input type="number" min="1024" max="65535" bind:value={startPort} disabled={!saved || busy} class="app-setting-control w-28" /></label>
				<label class="grid gap-1 text-sm">Last port<input type="number" min="1024" max="65535" bind:value={endPort} disabled={!saved || busy} class="app-setting-control w-28" /></label>
			</div>
		</SettingsRow>
		{#if tailscale}
			<SettingsRow label="Tailscale status" hint="Reopen Settings to check again after making a change." control="full">
				<ul class="space-y-1 text-sm">
					{#each [tailscale.installed, tailscale.running, tailscale.magicDns, tailscale.https, tailscale.operator] as line}
						<li class={line.ok ? 'text-(--chat-fg-muted)' : 'text-(--chat-warning)'}>{line.message}</li>
					{/each}
				</ul>
			</SettingsRow>
		{/if}
	{/if}
	<SettingsRow label="Agents may publish apps" for="app-publish-policy" hint="Ask requires approval in Running apps before agents may publish in a project.">
		<select id="app-publish-policy" bind:value={policy} disabled={!saved || busy} class="app-setting-control">
			<option value="off">Off</option>
			<option value="ask">Ask</option>
			<option value="on">On</option>
		</select>
	</SettingsRow>
	<SettingsRow label="App settings" hint="Changing the address mode updates running apps and may change their links." control="auto">
		<Button size="sm" class="max-sm:min-h-11" disabled={!dirty || busy || backend.connection.status !== 'ready'} onclick={() => void save()}>Save app settings</Button>
	</SettingsRow>
	{#if error}<p role="alert" class="px-4 py-2 text-sm text-(--chat-danger)">{error}</p>{/if}
</SettingsGroup>

<style>
	.app-setting-control { min-height: 2.5rem; border: 1px solid var(--chat-border); border-radius: .5rem; padding: .375rem .625rem; background: var(--chat-surface); color: var(--chat-fg); }
	@media (max-width: 640px) { .app-setting-control { min-height: 2.75rem; } }
</style>
