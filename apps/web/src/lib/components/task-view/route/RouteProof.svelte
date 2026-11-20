<script lang="ts">
	import type { HarnessClient } from '@kemiri/client';
	import type { Artifact } from '@kemiri/protocol';
	import { artifactTitle } from '#lib/artifacts.js';
	import ArtifactDialog from '#lib/components/artifacts/ArtifactDialog.svelte';
	import ArtifactThumb from '#lib/components/artifacts/ArtifactThumb.svelte';

	let { media, client }: { media: readonly Artifact[]; client: HarnessClient } = $props();
	let preview = $state<Artifact>();
	let open = $state(false);
</script>

<ul role="list" aria-label="Proof" class="route-proof">
	{#each media as artifact (artifact.id)}
		<li>
			<button type="button" aria-label="Open proof: {artifactTitle(artifact)}" onclick={() => { preview = artifact; open = true; }}>
				<ArtifactThumb {artifact} {client} class="aspect-[8/5] w-full" />
				<span>{artifactTitle(artifact)}</span>
			</button>
		</li>
	{/each}
</ul>
<ArtifactDialog artifact={preview} {client} bind:open />
