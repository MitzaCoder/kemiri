<script lang="ts">
	import SearchIcon from '@lucide/svelte/icons/search';
	import type { HarnessClient } from '@kemiri/client';
	import type { Artifact, ArtifactsChangedEvent, BoardTask } from '@kemiri/protocol';
	import { artifactTitle, kindLabel } from '#lib/artifacts.js';
	import { applyProjectArtifactChange, projectArtifactSections } from '#lib/project-artifacts.js';
	import { exactTime, relativeTime } from '#lib/relative-time.js';
	import ArtifactDialog from './ArtifactDialog.svelte';
	import ArtifactKindIcon from './ArtifactKindIcon.svelte';
	import ArtifactPageThumb from './ArtifactPageThumb.svelte';
	import ArtifactPinButton from './ArtifactPinButton.svelte';

	let { client, projectId, tasks, ondiscuss }: {
		client: HarnessClient; projectId: string; tasks: readonly BoardTask[]; ondiscuss: () => void;
	} = $props();
	let rows = $state.raw<readonly Artifact[]>([]);
	let loaded = $state(false);
	let error = $state('');
	let query = $state('');
	let kind = $state<Artifact['kind'] | ''>('');
	let open = $state(false);
	let viewingId = $state<string>();
	let retry = $state<() => void>();
	const viewing = $derived(rows.find(row => row.id === viewingId));
	const taskTitles = $derived(new Map(tasks.map(task => [task.id, task.title])));
	const sections = $derived(projectArtifactSections(rows, query, taskTitles));
	const kinds = $derived([...new Set(sections.other.map(row => row.kind))].sort());
	const other = $derived(kind && kinds.includes(kind) ? sections.other.filter(row => row.kind === kind) : sections.other);

	$effect(() => {
		const backend = client;
		const project = projectId;
		let active = true;
		let pending: Map<string, ArtifactsChangedEvent> | undefined;
		async function load() {
			if (!backend.connected || pending) return;
			const changes = new Map<string, ArtifactsChangedEvent>();
			pending = changes;
			error = '';
			try {
				const catalogue = await backend.listArtifacts(project, { catalogue: true });
				if (active && pending === changes) rows = [...changes.values()].reduce((rows, change) => applyProjectArtifactChange(rows, change, project), catalogue as readonly Artifact[]);
			} catch (problem) {
				if (active && pending === changes) error = problem instanceof Error ? problem.message : String(problem);
			} finally {
				if (active && pending === changes) { pending = undefined; loaded = true; }
			}
		}
		const unsubscribe = backend.onArtifactsChanged(change => {
			if (change.projectId !== project) return;
			pending?.set(change.artifact.id, change);
			rows = applyProjectArtifactChange(rows, change, project);
		});
		const stopState = backend.subscribe(state => {
			if (state.status === 'ready') void load();
			else pending = undefined;
		});
		retry = () => void load();
		void load();
		return () => { active = false; unsubscribe(); stopState(); };
	});

	$effect(() => { if (open && !viewing) open = false; });

	function show(artifact: Artifact) {
		viewingId = artifact.id;
		open = true;
	}
</script>

{#snippet row(artifact: Artifact, html: boolean)}
	<li class="flex items-center gap-1 border-b border-(--chat-border) last:border-b-0">
		<button type="button" class="flex min-w-0 flex-1 items-center gap-3 rounded-md p-2 text-left hover:bg-(--chat-surface-2)" onclick={() => show(artifact)}>
			{#if html}
				<ArtifactPageThumb {artifact} {client} class="aspect-video w-23 rounded-md" />
			{:else}
				<ArtifactKindIcon kind={artifact.kind} class="size-4 shrink-0 text-(--chat-fg-subtle)" />
			{/if}
			<span class="min-w-0">
				<span class="block break-words text-sm font-medium">{artifactTitle(artifact)}</span>
				<span class="block break-words text-xs text-(--chat-fg-muted)">
					{#if artifact.taskId}{artifact.taskId}{taskTitles.get(artifact.taskId) ? ` · ${taskTitles.get(artifact.taskId)}` : ''}{:else}No home task{/if}
				</span>
				<span class="block text-xs text-(--chat-fg-subtle)">{artifact.versionCount ?? 1} {(artifact.versionCount ?? 1) === 1 ? 'version' : 'versions'} · <time datetime={artifact.createdAt} title={exactTime(artifact.createdAt)}>Updated {relativeTime(artifact.createdAt, Date.now())}</time></span>
			</span>
		</button>
		{#if html}<ArtifactPinButton {artifact} {client} />{/if}
	</li>
{/snippet}

<div class="min-h-0 flex-1 overflow-y-auto">
	<div class="mx-auto max-w-3xl space-y-4 p-3 pb-8">
		<label class="flex items-center gap-2 rounded-lg border border-(--chat-border) bg-(--chat-surface) px-3 focus-within:border-(--accent-2)">
			<SearchIcon class="size-4 shrink-0 text-(--chat-fg-subtle)" />
			<input type="search" class="min-w-0 flex-1 bg-transparent py-2 text-sm outline-none" placeholder="Search project artifacts" aria-label="Search project artifacts" bind:value={query} />
		</label>
		{#if error}<p class="text-sm text-(--chat-danger)" role="alert">{error} <button type="button" class="underline" onclick={retry}>Retry</button></p>{/if}
		{#if sections.pinned.length}
			<section aria-labelledby="pinned-artifacts-heading">
				<h3 id="pinned-artifacts-heading" class="mb-1 px-1 text-xs font-semibold text-(--accent-2)">Pinned HTML · {sections.pinned.length}</h3>
				<ul class="rounded-lg border border-(--chat-border) bg-(--chat-surface) px-1">{#each sections.pinned as artifact (artifact.id)}{@render row(artifact, true)}{/each}</ul>
			</section>
		{/if}
		{#if sections.html.length}
			<section aria-labelledby="html-artifacts-heading">
				<h3 id="html-artifacts-heading" class="mb-1 px-1 text-xs font-semibold text-(--chat-fg-muted)">HTML artifacts · {sections.html.length}</h3>
				<ul class="rounded-lg border border-(--chat-border) px-1">{#each sections.html as artifact (artifact.id)}{@render row(artifact, true)}{/each}</ul>
			</section>
		{/if}
		{#if sections.other.length}
			<details open={query.trim() !== ''} class="rounded-lg border border-(--chat-border) px-2 text-(--chat-fg-muted)">
				<summary class="cursor-pointer py-2 text-xs font-semibold">Other files · {sections.other.length}</summary>
				{#if kinds.length > 1}
					<label class="flex items-center gap-2 py-1 text-xs">Kind <select class="rounded-md border border-(--chat-border) bg-(--chat-surface) p-1" bind:value={kind}>
						<option value="">All kinds</option>
						{#each kinds as value (value)}<option {value}>{kindLabel(value, true)}</option>{/each}
					</select></label>
				{/if}
				<ul>{#each other as artifact (artifact.id)}{@render row(artifact, false)}{/each}</ul>
			</details>
		{/if}
		{#if !loaded}<p class="px-1 text-sm text-(--chat-fg-muted)">Loading artifacts…</p>
		{:else if !error && !rows.length}<p class="px-1 text-sm text-(--chat-fg-muted)">No saved artifacts in this project yet.</p>
		{:else if !sections.pinned.length && !sections.html.length && !sections.other.length}<p class="px-1 text-sm text-(--chat-fg-muted)">No artifacts match this search.</p>{/if}
	</div>
</div>

<ArtifactDialog artifact={viewing} {client} bind:open {ondiscuss} ondeleted={() => open = false} />
