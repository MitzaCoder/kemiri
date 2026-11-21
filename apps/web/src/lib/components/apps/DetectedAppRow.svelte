<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';

	let { port, update }: { port: number; update: (action: 'publish' | 'ignore') => Promise<void> } = $props();
	let busy = $state(false);
	let error = $state<string>();

	async function act(action: 'publish' | 'ignore') {
		busy = true;
		error = undefined;
		try { await update(action); }
		catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
		finally { busy = false; }
	}
</script>

<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
	<div class="flex items-baseline gap-2.5">
		<span class="size-2.5 shrink-0 rounded-full border border-dashed border-(--chat-warning)" aria-hidden="true"></span>
		<div>
			<strong>Port {port}, not published</strong>
			<p class="text-[.8rem] text-(--chat-fg-muted)">Detected · A process in this project listens on port {port}.</p>
		</div>
	</div>
	<div class="flex gap-1.5">
		<Button size="sm" variant="outline" class="max-sm:min-h-11" disabled={busy} onclick={() => void act('publish')}>Publish</Button>
		<Button size="sm" variant="outline" class="max-sm:min-h-11" disabled={busy} onclick={() => void act('ignore')}>Ignore</Button>
	</div>
</div>
{#if error}<p class="mt-2 text-sm text-(--chat-danger)" role="alert">{error}</p>{/if}
