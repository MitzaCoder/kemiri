<script lang="ts">
	import type { ProjectApp } from '@kemiri/protocol';
	import { Button } from '#lib/components/ui/button/index.js';
	import QrCode from '#lib/components/QrCode.svelte';
	import { copyText } from '#lib/clipboard.js';
	import { APP_LINK_WARNING, appLink, appStateLabel } from '#lib/agent-apps.js';

	let { app, showDetails = false, warning = true, detail, update, readLog }: {
		app: ProjectApp;
		showDetails?: boolean;
		warning?: boolean;
		detail?: string;
		update?: (action: 'allow' | 'stop') => Promise<void>;
		readLog?: () => Promise<string>;
	} = $props();
	const link = $derived(appLink(app));
	let showQr = $state(false);
	let logOpen = $state(false);
	let log = $state<string>();
	let logError = $state<string>();
	let readingLog = $state(false);

	async function openLog() {
		if (!readLog || readingLog) return;
		logOpen = true;
		readingLog = true;
		logError = undefined;
		try { log = await readLog(); }
		catch (cause) { logError = cause instanceof Error ? cause.message : String(cause); }
		finally { readingLog = false; }
	}
	let busy = $state(false);
	let copied = $state(false);
	let error = $state<string>();
	let copyTimer: ReturnType<typeof setTimeout> | undefined;
	$effect(() => () => clearTimeout(copyTimer));

	async function act(action: 'allow' | 'stop') {
		if (!update || busy) return;
		busy = true;
		error = undefined;
		try { await update(action); }
		catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
		finally { busy = false; }
	}

	async function copy(url: string) {
		error = undefined;
		copied = await copyText(url);
		if (!copied) error = 'Could not copy the link. Select and copy the address instead.';
		clearTimeout(copyTimer);
		copyTimer = setTimeout(() => copied = false, 1500);
	}
</script>

<div class="app-row">
	<div class="app-name">
		<span class="app-dot" class:live={app.state === 'live'} class:pending={app.state === 'pending'} aria-hidden="true"></span>
		<div class="app-description">
			<strong>{app.name}</strong>
			{#if link}<div class="app-address">{link}</div>{/if}
			<div class="app-meta">{[appStateLabel(app), app.managed ? `Started by Kemiri · ${app.managed.survivesRestart ? 'survives restarts' : 'does not survive service restarts'}` : undefined, detail].filter(Boolean).join(' · ')}</div>
			{#if app.state === 'live' && app.addressMessage}<div class="app-warning">{app.addressMessage}</div>{/if}
		</div>
	</div>
	{#if link || (update && app.state !== 'unpublished')}
		<div class="app-actions">
			{#if link}
				<Button size="sm" class="open-app max-sm:min-h-11" onclick={() => window.open(link, '_blank', 'noopener')}>Open</Button>
				{#if showDetails}
					<Button size="sm" variant="outline" class="max-sm:min-h-11" onclick={() => void copy(link)}>{copied ? 'Copied' : 'Copy link'}</Button>
					<Button size="sm" variant="outline" class="max-sm:min-h-11" aria-pressed={showQr} onclick={() => showQr = !showQr}>QR</Button>
				{/if}
			{/if}
			{#if app.managed && readLog}
				<Button size="sm" variant="outline" class="max-sm:min-h-11" aria-expanded={logOpen} onclick={() => logOpen ? (logOpen = false) : void openLog()}>Logs</Button>
			{/if}
			{#if update && app.state !== 'unpublished'}
				{#if showDetails && app.state === 'pending'}
					<Button size="sm" variant="outline" class="max-sm:min-h-11" disabled={busy} title="Allow this app and future publishes in this project" onclick={() => void act('allow')}>Allow</Button>
				{/if}
				<Button size="sm" variant="outline" class={app.state === 'stopped' ? "max-sm:min-h-11" : "max-sm:min-h-11 text-(--chat-danger)"} disabled={busy} title={app.managed ? 'Stop the app process and remove its link' : 'Unpublish without stopping the process'} onclick={() => void act('stop')}>{app.state === 'stopped' ? 'Remove' : app.managed ? 'Stop app' : 'Unpublish'}</Button>
			{/if}
		</div>
	{/if}
	{#if link && warning}<p class="app-warning">{APP_LINK_WARNING}</p>{/if}
	{#if link && showDetails && showQr}
		<div class="app-qr"><QrCode value={link} label={`QR code for ${app.name}`} /></div>
	{/if}
	{#if logOpen}
		<section class="app-log" aria-label={`${app.name} logs`}>
			<div class="flex flex-wrap items-center justify-between gap-2"><strong>Recent app log</strong>
				<Button size="sm" variant="outline" disabled={readingLog} onclick={() => void openLog()}>Refresh log</Button>
			</div>
			{#if logError}<p role="alert" class="text-(--chat-danger)">{logError}</p>
			{:else if log === undefined}<p>Loading log…</p>
			{:else}<pre>{log || 'No output yet.'}</pre>{/if}
		</section>
	{/if}
	{#if error}<p class="col-span-full text-sm text-(--chat-danger)" role="alert">{error}</p>{/if}
</div>

<style>
	.app-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: .5rem 1rem; }
	.app-name { display: flex; gap: .65rem; align-items: baseline; min-width: 0; }
	.app-dot { width: .55rem; height: .55rem; flex: none; border-radius: 100%; background: var(--chat-fg-muted); }
	.app-dot.live { background: var(--chat-success); }
	.app-dot.pending { background: var(--chat-warning); }
	.app-description { min-width: 0; overflow-wrap: anywhere; }
	.app-meta { color: var(--chat-fg-muted); font-size: .8rem; }
	.app-address { color: var(--chat-success); font-family: var(--font-mono); font-size: .8rem; user-select: all; }
	.app-warning { grid-column: 1 / -1; color: var(--chat-warning); font-size: .75rem; }
	.app-actions { display: flex; flex-wrap: wrap; gap: .375rem; }
	.app-actions :global(.open-app) { background: var(--chat-success); color: var(--chat-bg); font-weight: 650; }
	.app-actions :global(.open-app:hover) { opacity: .85; }
	.app-log { grid-column: 1 / -1; min-width: 0; display: grid; gap: .4rem; border: 1px solid var(--chat-border); border-radius: .5rem; padding: .75rem; font-size: .8rem; }
	.app-log pre { max-height: 34dvh; overflow: auto; background: var(--chat-bg); border-radius: .25rem; padding: .5rem; white-space: pre-wrap; overflow-wrap: anywhere; }
	.app-qr { width: min(12rem, 100%); grid-column: 1 / -1; border-radius: .5rem; overflow: hidden; }
	@media (max-width: 640px) { .app-row { grid-template-columns: minmax(0, 1fr); } }
</style>
