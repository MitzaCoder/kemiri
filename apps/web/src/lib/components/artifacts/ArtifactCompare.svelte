<script lang="ts">
	import type { Artifact } from '@kemiri/protocol';
	import type { HarnessClient } from '@kemiri/client';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { artifactReadProblem } from '#lib/artifact-text.js';
	import { artifactComparisonPair, readComparisonVersion, type ComparisonText } from '#lib/code/artifact-comparison.js';
	import { loadCodeComparison } from '#lib/code/load-viewer.js';

	let { open = $bindable(false), versions, viewedVersion, client }: {
		open?: boolean; versions: Artifact[]; viewedVersion?: number; client: HarnessClient;
	} = $props();
	let olderVersion = $state<number>();
	let newerVersion = $state<number>();
	let texts = $state<[ComparisonText, ComparisonText]>();
	let problem = $state('');
	let attempt = $state(0);
	const defaults = $derived(artifactComparisonPair(versions, viewedVersion));
	const older = $derived(versions.find(version => version.version === olderVersion) ?? defaults?.before);
	const newer = $derived(versions.find(version => version.version === newerVersion) ?? defaults?.after);
	const textVersions = $derived(versions.filter(version => version.kind === 'text'));
	const valid = $derived(older !== undefined && newer !== undefined && (older.version ?? 0) < (newer.version ?? 0));

	$effect(() => { if (!open) { olderVersion = undefined; newerVersion = undefined; } });
	$effect(() => {
		attempt;
		const before = older, after = newer;
		texts = undefined;
		problem = '';
		if (!open || !valid || !before || !after) return;
		const controller = new AbortController();
		const read = (version: Artifact) => readComparisonVersion(version,
			() => client.readArtifactUrl(version.projectId, version.id), controller.signal);
		void Promise.all([read(before), read(after)]).then(fetched => {
			if (!controller.signal.aborted) texts = fetched;
		}, error => {
			if (!controller.signal.aborted) problem = artifactReadProblem(error);
			controller.abort();
		});
		return () => controller.abort();
	});
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex h-dvh max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[90dvh] sm:w-[min(90vw,100rem)] sm:max-w-none sm:rounded-lg" data-artifact-comparison>
		<header class="shrink-0 border-b border-(--chat-border) px-4 py-3 pr-12">
			<Dialog.Title class="truncate text-base font-semibold">Compare {newer?.name ?? 'artifact versions'}</Dialog.Title>
			<Dialog.Description class="sr-only">Read-only comparison of two saved versions.</Dialog.Description>
			<div class="mt-2 flex flex-wrap gap-3 text-xs">
				<label class="flex items-center gap-1.5">Before
					<select class="min-h-8 rounded border border-(--chat-border) bg-(--chat-surface) px-2" value={older?.version} onchange={event => olderVersion = Number(event.currentTarget.value)}>
						{#each textVersions as version (version.id)}<option value={version.version}>Version {version.version}</option>{/each}
					</select>
				</label>
				<label class="flex items-center gap-1.5">After
					<select class="min-h-8 rounded border border-(--chat-border) bg-(--chat-surface) px-2" value={newer?.version} onchange={event => newerVersion = Number(event.currentTarget.value)}>
						{#each textVersions as version (version.id)}<option value={version.version}>Version {version.version}</option>{/each}
					</select>
				</label>
			</div>
		</header>
		{#if problem}
			<p class="p-4 text-sm" role="alert">{problem} <button class="underline" onclick={() => attempt++}>Retry</button></p>
		{:else if !valid}
			<p class="p-4 text-sm" role="status">Choose an older version for Before and a newer version for After.</p>
		{:else if texts && older && newer}
			{#await loadCodeComparison()}
				<p class="p-4 text-sm" role="status">Opening comparison…</p>
			{:then { default: CodeComparison }}
				<CodeComparison before={texts[0]} after={texts[1]} beforeLabel={`Version ${older.version}`} afterLabel={`Version ${newer.version}`} path={newer.name} />
			{:catch}
				<p class="p-4 text-sm" role="alert">Could not open the comparison viewer. Close this view to read each version separately.</p>
			{/await}
		{:else}
			<p class="p-4 text-sm" role="status">Reading versions…</p>
		{/if}
	</Dialog.Content>
</Dialog.Root>
