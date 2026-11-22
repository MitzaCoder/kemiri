<script lang="ts">
	import PinIcon from '@lucide/svelte/icons/pin';
	import PinOffIcon from '@lucide/svelte/icons/pin-off';
	import type { HarnessClient } from '@kemiri/client';
	import { isHtmlArtifact, type Artifact } from '@kemiri/protocol';

	let { artifact, client }: { artifact: Artifact; client: HarnessClient } = $props();
	let saving = $state(false);
	let problem = $state('');
	const action = $derived(artifact.pinned ? 'Unpin' : 'Pin');
	const title = $derived(`${action} ${artifact.title || artifact.name}`);

	async function toggle() {
		saving = true;
		problem = '';
		try { await client.setArtifactPinned(artifact.projectId, artifact.id, !artifact.pinned); }
		catch (error) { problem = error instanceof Error ? error.message : String(error); }
		finally { saving = false; }
	}
</script>

{#if artifact.kind === 'text' && isHtmlArtifact(artifact)}
	<div class="relative shrink-0">
		<button type="button" class="grid size-9 place-items-center rounded-md text-(--chat-fg-muted) hover:bg-(--chat-surface-2) aria-pressed:text-(--accent-2) disabled:opacity-50" aria-label={title} title={title} aria-pressed={!!artifact.pinned} disabled={saving} onclick={toggle}>
			{#if artifact.pinned}<PinOffIcon class="size-4" />{:else}<PinIcon class="size-4" />{/if}
		</button>
		{#if problem}<p role="alert" class="absolute z-10 right-0 w-48 rounded-lg border border-(--chat-border) bg-(--chat-surface) p-2 text-xs text-(--chat-danger)">{problem}</p>{/if}
	</div>
{/if}
