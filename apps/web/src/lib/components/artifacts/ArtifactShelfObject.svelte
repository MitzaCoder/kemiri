<script lang="ts">
	import type { HarnessClient } from '@kemiri/client';
	import type { Artifact } from '@kemiri/protocol';
	import { artifactTitle, isMarkdownArtifact } from '#lib/artifacts.js';
	import { libraryKind, objectShape } from '#lib/artifact-library.js';
	import { useArtifactSource } from '#lib/artifacts.svelte.js';
	import { readArtifactText } from '#lib/artifact-text.js';
	import { inView } from '#lib/in-view.js';
	import ArtifactPageThumb from './ArtifactPageThumb.svelte';
	import ArtifactThumb from './ArtifactThumb.svelte';

	let { artifact, client }: { artifact: Artifact; client: HarnessClient } = $props();
	const shape = $derived(objectShape(artifact));
	const count = $derived(artifact.versionCount ?? artifact.version ?? 1);
	let visible = $state(false);
	let excerpt = $state('');
	const plainText = $derived(shape === 'slip' || (shape === 'paper' && isMarkdownArtifact(artifact)));
	const source = useArtifactSource(() => visible && plainText ? { client, projectId: artifact.projectId, artifactId: artifact.id } : undefined);
	$effect(() => {
		const url = source.current?.url;
		excerpt = '';
		if (!url) return;
		const abort = new AbortController();
		void readArtifactText(url, artifact.size, abort.signal, fetch, 1024).then(preview => {
			if (!abort.signal.aborted) excerpt = preview.content;
		}).catch(() => {});
		return () => abort.abort();
	});
</script>

<span class="object-space" data-shape={shape} aria-hidden="true" use:inView={() => visible = true}>
	<span class="object" class:stacked={count > 1} class:deep-stack={count > 2}>
		<span class="object-face" class:living={artifact.living}>
			{#if shape === 'paper' && libraryKind(artifact) === 'page' && !plainText}
				<span class="paper-heading">{artifactTitle(artifact)}</span>
				<ArtifactPageThumb {artifact} {client} />
				<span class="paper-lines"></span>
			{:else if plainText}
				<span class="paper-heading">{artifactTitle(artifact)}</span>
				<span class="text-excerpt">{excerpt}</span>
			{:else}
				<ArtifactThumb {artifact} {client} class="size-full" />
			{/if}
		</span>
		{#if count > 1}<span class="version-count" title="{count} versions">{count}</span>{/if}
	</span>
</span>

<style>
	.object-space { display:flex; align-items:end; justify-content:center; height:var(--shelf-object-height, 164px); padding:7px 9px 0; }
	.object { position:relative; isolation:isolate; width:100%; height:100%; border-radius:5px; background:var(--chat-surface-2); box-shadow:0 4px 12px #0003; }
	.object-face { position:absolute; inset:0; display:flex; flex-direction:column; background:var(--chat-surface-2); border:1px solid var(--chat-border); border-radius:inherit; overflow:hidden; }
	.stacked::before,.deep-stack::after { content:''; position:absolute; z-index:-1; inset:0; border:1px solid var(--chat-border); border-radius:inherit; background:var(--chat-surface); transform:translate(6px,-5px); }
	.deep-stack::after { z-index:-2; transform:translate(11px,-9px); }
	[data-shape='phone'] .object { border-radius:16px; }
	[data-shape='phone'] .object-face { padding:8px 3px 3px; background:var(--chat-surface-2); }
	[data-shape='phone'] .object-face::before { content:''; position:absolute; top:3px; left:41%; width:18%; height:2px; border-radius:2px; background:var(--chat-fg-subtle); }
	[data-shape='phone'] :global(.artifact-thumb) { border-radius:10px; }
	[data-shape='screen'] .object { height:73%; margin-bottom:13px; border-radius:7px; }
	[data-shape='screen'] .object-face { padding:3px; }
	[data-shape='screen'] .object::before { content:''; position:absolute; inset:100% 35% auto; height:13px; border:0; background:var(--chat-surface-2); transform:none; clip-path:polygon(28% 0,72% 0,100% 100%,0 100%); }
	[data-shape='recording'] .object,[data-shape='picture'] .object { height:74%; }
	[data-shape='file'] .object { height:83%; }
	[data-shape='paper'] .object-face,[data-shape='slip'] .object-face { padding:10px; }
	[data-shape='paper'] .object-face { border-top:2px solid var(--accent-2); }
	[data-shape='slip'] .object-face { background:light-dark(#302d3c,#181622); color:#eee9fa; }
	.paper-heading { display:block; font-size:.62rem; font-weight:700; line-height:1.25; margin-bottom:7px; }
	.paper-lines { display:block; flex:1; margin:8px 3px; opacity:.55; background:repeating-linear-gradient(to bottom,var(--chat-border) 0px 2px,transparent 2px 7px); }
	.text-excerpt { font: .57rem/1.45 var(--font-mono, monospace); white-space:pre-wrap; overflow-wrap:anywhere; overflow:hidden; mask-image:linear-gradient(black 65%,transparent 100%); }
	[data-shape='slip'] .text-excerpt { color:#a8b9b3; }
	.version-count { position:absolute; top:-5px; right:-5px; display:grid; place-items:center; min-width:20px; height:19px; padding:0 4px; background:var(--chat-fg); color:var(--chat-bg); border-radius:7px; font:bold .68rem var(--font-mono, monospace); }
	.living::after { content:''; position:absolute; inset:0; border-radius:inherit; padding:2px; pointer-events:none; background:linear-gradient(115deg,#22d3ee,#8585ff,#f180ef,#fb9b49,#22d3ee); background-size:230% 100%; mask:linear-gradient(black 0 0) content-box,linear-gradient(black 0 0); mask-composite:exclude; animation:living-ring 4s linear infinite alternate; }
	@keyframes living-ring { to { background-position:100% 0; } }
	@media(prefers-reduced-motion:reduce) { .living::after { animation:none; } }
</style>
