<script lang="ts">
	import { page } from '$app/state';
	import CopyButton from '#lib/components/CopyButton.svelte';
	import QrCode from '#lib/components/QrCode.svelte';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import { connectHref, isConnectUrl, MAX_CONNECT_BACKENDS, shareableName } from '#lib/connect.js';
	import { harness } from '#lib/harness.svelte.js';

	/**
	 * The link that sets up another device: the chosen backends ride in the fragment, so no server sees them, and the
	 * other device shows them for confirmation instead of asking the user to type addresses on a phone keyboard.
	 *
	 * Only HTTPS backends can travel: a link leaves this browser, so a development backend on loopback stays here.
	 */
	let { backendId }: { backendId: string } = $props();
	let included = $state<string[]>([]);

	const chosen = $derived(harness.backends.filter(backend =>
		(backend.id === backendId || included.includes(backend.id)) && isConnectUrl(backend.url)));
	const primary = $derived(harness.backend(backendId));
	const otherComputers = $derived(harness.backends.filter(backend => backend.id !== backendId && isConnectUrl(backend.url)));
	/** What to show under the choices: a link, a nudge, or a cap the selection has run into. */
	const share = $derived.by((): { kind: 'empty' } | { kind: 'too-many' } | { kind: 'link'; href: string } => {
		if (chosen.length === 0) return { kind: 'empty' };
		if (chosen.length > MAX_CONNECT_BACKENDS) return { kind: 'too-many' };
		return {
			kind: 'link',
			href: connectHref(
				page.url.origin,
				chosen.map((backend) => ({ name: shareableName(backend.name), url: backend.url })),
			),
		};
	});

	function toggle(id: string, checked: boolean): void {
		included = checked ? [...included, id] : included.filter(entry => entry !== id);
	}
</script>

<div class="flex flex-col gap-3" data-testid="connect-device">
	<p class="text-sm text-muted-foreground">This link shares computer addresses without signing in.</p>
	{#if primary && isConnectUrl(primary.url)}
		<p class="text-sm font-medium">{primary.name}</p>
	{:else}
		<p class="text-sm text-muted-foreground">This computer stays in this browser: connect links carry only HTTPS addresses.</p>
	{/if}
	{#if otherComputers.length}
		<div class="flex flex-col gap-2">
			{#each otherComputers as backend (backend.id)}
				<label class="flex items-center gap-2 text-sm">
					<Checkbox checked={included.includes(backend.id)} onCheckedChange={(value) => toggle(backend.id, value === true)} aria-label="Include {backend.name}" />
					Include {backend.name}
				</label>
			{/each}
		</div>
	{/if}

	{#if share.kind === 'too-many'}
		<p class="text-sm text-muted-foreground">
			A link carries at most {MAX_CONNECT_BACKENDS} computers. Leave some out and make a second link.
		</p>
	{:else if share.kind === 'link'}
		<div class="flex flex-col gap-3 sm:flex-row sm:items-start">
			<div class="w-40 max-w-full shrink-0 self-center rounded-md bg-white p-1.5">
				<QrCode value={share.href} />
			</div>
			<div class="flex min-w-0 flex-1 flex-col gap-2">
				<span class="text-xs font-medium text-muted-foreground">Connect link</span>
				<div class="flex items-start gap-2">
					<code
						data-testid="connect-link"
						class="min-w-0 flex-1 rounded-md border bg-muted/40 px-2 py-1 font-mono text-xs break-all"
						>{share.href}</code
					>
					<CopyButton text={() => share.href} label="Copy connect link" />
				</div>
				<p class="text-xs text-muted-foreground">
					Scan the code or send the link to the other device, then confirm there.
				</p>
			</div>
		</div>
	{/if}
</div>
