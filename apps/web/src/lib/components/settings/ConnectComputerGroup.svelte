<script lang="ts">
	import { computerInviteHref } from '#lib/computer-invite.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import SettingsGroup from './SettingsGroup.svelte';

	let link = $state('');
	let invalid = $state(false);
	function openInvite(event: SubmitEvent): void {
		event.preventDefault();
		const target = computerInviteHref(link, location.origin);
		if (!target) { invalid = true; return; }
		link = '';
		// A full navigation lets the root layout clear pairing secrets before startup, as for an opened link.
		location.assign(target);
	}
</script>

<SettingsGroup title="Connect to a computer" description="Scan or paste a link">
	<form class="space-y-2 p-4 sm:p-5" onsubmit={openInvite}>
		<p class="text-sm text-muted-foreground">Scan with the device camera, or paste a pairing or connect link here.</p>
		<div class="flex gap-2">
			<Input class="min-h-11 min-w-0" aria-label="Pairing or connect link" aria-invalid={invalid} type="password" autocomplete="off" placeholder="Paste a link" required bind:value={link} oninput={() => (invalid = false)} />
			<Button class="min-h-11" type="submit">Open link</Button>
		</div>
		{#if invalid}<p role="alert" class="text-sm text-destructive">This is not a valid pairing or connect link.</p>{/if}
	</form>
</SettingsGroup>
