<script lang="ts">
	import type { HarnessClient } from '@kemiri/client';
	import type { Artifact } from '@kemiri/protocol';
	import { artifactTitle } from '#lib/artifacts.js';
	import ArtifactDialog from './ArtifactDialog.svelte';
	import ArtifactThumb from './ArtifactThumb.svelte';

	let { media, client }: { media: readonly Artifact[]; client: HarnessClient } = $props();
	let preview = $state<Artifact>();
	let open = $state(false);
</script>

<ul class="grid max-w-lg grid-cols-3 gap-2.5" aria-label="Proof">
	{#each media as artifact (artifact.id)}
		<li class="min-w-0">
			<button type="button" class="block min-h-11 w-full overflow-hidden rounded-lg border border-(--chat-border-strong) hover:border-(--accent-2) focus-visible:outline-2 focus-visible:outline-(--chat-ring)"
				aria-label="Open proof: {artifactTitle(artifact)}" title={artifactTitle(artifact)} onclick={() => { preview = artifact; open = true; }}>
				<ArtifactThumb {artifact} {client} class="aspect-[8/5] w-full" />
			</button>
		</li>
	{/each}
</ul>
<ArtifactDialog artifact={preview} {client} bind:open />
