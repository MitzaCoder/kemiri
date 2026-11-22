<script lang="ts">
	import MessageSquareIcon from '@lucide/svelte/icons/message-square';
	import type { Artifact } from '@kemiri/protocol';
	import type { HarnessClient } from '@kemiri/client';
	import { discussArtifact } from '#lib/artifact-discuss.svelte.js';
	import { artifactTitle } from '#lib/artifacts.js';
	let { artifact, client, onclose, compact = false, label = 'Discuss' }: { artifact: Artifact; client: HarnessClient; onclose?: () => void; compact?: boolean; label?: string } = $props();
	let problem = $state('');
	let opening = $state(false);
	async function discuss(event: MouseEvent) {
		event.stopPropagation();
		opening = true;
		problem = '';
		try { await discussArtifact(client, artifact, onclose); }
		catch (error) { problem = error instanceof Error ? error.message : String(error); }
		finally { opening = false; }
	}
</script>
<button type="button" aria-label="{label}: {artifactTitle(artifact)}" disabled={opening} onclick={discuss} class="inline-flex min-h-7 items-center gap-1.5 rounded-md px-2 font-medium text-(--accent-2) hover:bg-(--chat-surface-2) {compact ? 'text-xs' : 'text-sm'}">
	<MessageSquareIcon size={14} /> {label}
</button>
{#if problem}<span role="alert" class="text-xs text-(--chat-danger)">{problem}</span>{/if}
