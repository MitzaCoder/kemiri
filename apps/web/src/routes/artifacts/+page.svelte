<script lang="ts">
	import { tick } from 'svelte';
	import BoxesIcon from '@lucide/svelte/icons/boxes';
	import CheckSquareIcon from '@lucide/svelte/icons/square-check';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import ColumnsIcon from '@lucide/svelte/icons/columns-2';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import SearchIcon from '@lucide/svelte/icons/search';
	import ProjectsMenuButton from '#lib/components/ProjectsMenuButton.svelte';
	import DiscussButton from '#lib/components/artifacts/DiscussButton.svelte';
	import ArtifactShelfObject from '#lib/components/artifacts/ArtifactShelfObject.svelte';
	import ArtifactStudio from '#lib/components/artifacts/ArtifactStudio.svelte';
	import ArtifactTaskState from '#lib/components/artifacts/ArtifactTaskState.svelte';
	import CompareSlider from '#lib/components/artifacts/CompareSlider.svelte';
	import { artifactLibrary } from '#lib/artifact-library.svelte.js';
	import { filterLibrary, libraryDate, libraryKind, libraryLenses, libraryPairs, libraryPairTitle, libraryShelves, objectShape, type LibraryArtifact, type LibraryLens } from '#lib/artifact-library.js';
	import { artifactTitle, kindLabel } from '#lib/artifacts.js';
	import { flyShelfObjects, shelfObjectPositions } from '#lib/artifact-shelf-motion.js';
	import { harness } from '#lib/harness.svelte.js';
	import { inView } from '#lib/in-view.js';
	import { tagCounts } from '#lib/media-gallery.js';

	const lensIcons = { task: CheckSquareIcon, kind: LayersIcon, time: ClockIcon, pairs: ColumnsIcon, living: SparklesIcon };
	const lensNames = Object.keys(libraryLenses) as LibraryLens[];
	let lens = $state<LibraryLens>('task');
	let search = $state('');
	let project = $state('');
	let tags = $state<string[]>([]);
	let shelvesElement = $state<HTMLElement>();
	let browsing = $state<HTMLElement>();
	let studioKey = $state<string>();
	let studioEntry = $derived(artifactLibrary.entries.find(entry => entry.key === studioKey));
	let studioBackend = $derived(studioEntry ? harness.backend(studioEntry.backendId) : undefined);
	let studioOpener: HTMLElement | undefined;
	const projects = $derived([...new Map(artifactLibrary.entries.map(entry => [entry.project.key, entry.project])).values()].sort((left, right) => left.name.localeCompare(right.name)));
	const livingCount = $derived(artifactLibrary.entries.filter(({ artifact }) => artifact.living).length);
	const availableTags = $derived(tagCounts(filterLibrary(artifactLibrary.entries, project, [], search).map(entry => entry.artifact)));
	const visibleArtifacts = $derived(filterLibrary(artifactLibrary.entries, project, tags, search));
	const shelves = $derived(lens !== 'pairs' ? libraryShelves(visibleArtifacts, lens) : []);
	const pairs = $derived(lens === 'pairs' ? libraryPairs(visibleArtifacts) : []);
	let nearPairs = $state<Record<string, boolean>>({});

	async function chooseLens(next: LibraryLens) {
		if (next === lens) return;
		const positions = shelfObjectPositions(shelvesElement);
		lens = next;
		await tick();
		if (browsing) browsing.scrollTop = 0;
		if (lens === next) flyShelfObjects(shelvesElement, positions);
	}

	function chooseProject(next: string) { project = next; tags = []; }
	function toggleTag(tag: string) { tags = tags.includes(tag) ? tags.filter(selected => selected !== tag) : [...tags, tag]; }
	function openStudio(entry: LibraryArtifact, event: MouseEvent) {
		studioOpener = event.currentTarget as HTMLElement;
		studioKey = entry.key;
	}
	async function closeStudio() {
		studioKey = undefined;
		await tick();
		studioOpener?.focus({ preventScroll: true });
		studioOpener = undefined;
	}
	$effect(() => { if (studioKey && !studioEntry) void closeStudio(); });
</script>

<svelte:head><title>Artifacts · Kemiri</title></svelte:head>

<main class="library">
	<header class="library-header">
		<div class="library-heading">
			<ProjectsMenuButton />
			<div class="library-title">
				<h1>Artifacts</h1>
				<p>{artifactLibrary.entries.length} kept across {projects.length} {projects.length === 1 ? 'project' : 'projects'}.{livingCount ? ` ${livingCount} ${livingCount === 1 ? 'is' : 'are'} living.` : ''} Done tasks keep their shelf.</p>
			</div>
			<label class="library-search"><SearchIcon size={15} /><input type="search" aria-label="Find artifacts" placeholder="Find by name, task, kind or tag" bind:value={search} /></label>
		</div>
		<div class="library-controls">
			<div class="lens-scroll"><div class="lenses" role="group" aria-label="Library lens">
				{#each lensNames as name (name)}
					{@const Icon = lensIcons[name]}
					<button type="button" aria-pressed={lens === name} onclick={() => void chooseLens(name)}><Icon size={15} />{libraryLenses[name]}</button>
				{/each}
			</div></div>
			<div class="library-filters" aria-label="Filter artifacts">
				<div class="project-filters" role="group" aria-label="Projects">
					<button type="button" class="filter-chip" aria-pressed={!project} onclick={() => chooseProject('')}>All projects</button>
					{#each projects as entry (entry.key)}
						<button type="button" class="filter-chip" aria-pressed={project === entry.key} onclick={() => chooseProject(entry.key)}>
							<span class="project-dot" style:--project-hue={projectHue(entry.key)}></span>{entry.name}{projects.filter(other => other.name === entry.name).length > 1 ? ` · ${harness.backend(entry.backendId)?.name ?? entry.backendId}` : ''}
						</button>
					{/each}
				</div>
				{#if availableTags.length || tags.length}
					<div class="tag-filters" role="group" aria-label="Tags">
						{#each [...availableTags, ...tags.filter(tag => !availableTags.some(entry => entry.tag === tag)).map(tag => ({ tag, count: 0 }))] as { tag, count } (tag)}
							<button type="button" class="filter-chip" aria-pressed={tags.includes(tag)} onclick={() => toggleTag(tag)}>{tag} <span>{count}</span></button>
						{/each}
					</div>
				{/if}
			</div>
		</div>
	</header>

	<div class="library-browsing" bind:this={browsing}>
		{#if artifactLibrary.problems.length}
			<div class="library-problems" role="status">{artifactLibrary.problems.join(' ')} <button type="button" onclick={() => artifactLibrary.retry()}>Try again</button></div>
		{/if}
		<div bind:this={shelvesElement}>
			{#if lens === 'pairs' && pairs.length}
				<div class="compare-shelves">
					{#each pairs as { before, after } (after.key)}
						{@const backend = harness.backend(after.backendId)}
						{#if backend}
							<section class="compare-shelf" data-shelf-object={after.key}>
								<div class="compare-heading"><h2>{libraryPairTitle(before.artifact, after.artifact)}</h2><span>{after.task?.title ?? after.project.name}</span></div>
								<div class="compare-view" use:inView={() => nearPairs[after.key] = true}>
									<CompareSlider before={before.artifact} after={after.artifact} client={backend.client} near={nearPairs[after.key] === true} />
								</div>
								<div class="compare-links"><button type="button" onclick={event => openStudio(before, event)}>Open before</button><button type="button" onclick={event => openStudio(after, event)}>Open after</button></div>
							</section>
						{/if}
					{/each}
				</div>
			{:else if shelves.length}
				<div class="shelves" class:living-shelves={lens === 'living'}>
					{#each shelves as shelf (shelf.key)}
						<section class="shelf">
							<header class="shelf-heading">
								{#if shelf.project}<span class="project-dot" style:--project-hue={projectHue(shelf.project.key)}></span>{/if}
								<h2>{shelf.title}</h2>
								{#if shelf.task}<ArtifactTaskState task={shelf.task} />{/if}
								{#if shelf.project}<span class="shelf-project">{shelf.project.name}</span>{/if}
							</header>
							<div class="shelf-objects">
								{#each shelf.entries as entry (entry.key)}
									{@const backend = harness.backend(entry.backendId)}
									{@const artifact = entry.artifact}
									{#if backend}
										<div class="shelf-object-actions" data-shelf-object={entry.key}>
										<button type="button" class="shelf-card" data-shape={objectShape(artifact)} onclick={event => openStudio(entry, event)}>
											<ArtifactShelfObject {artifact} client={backend.client} />
											<span class="shelf-ledge"></span>
											<span class="shelf-caption"><strong>{artifactTitle(artifact)}</strong>
												<span class="shelf-facts">{kindLabel(libraryKind(artifact))} · v{artifact.version ?? 1} · {libraryDate(artifact.createdAt)}{(artifact.versionCount ?? 1) > 1 ? ` · ${artifact.versionCount} versions` : ''}</span>
												{#if artifact.living}<span class="living-label">● Living</span>{/if}
											</span>
										</button>
										<DiscussButton {artifact} client={backend.client} compact />
										</div>
									{/if}
								{/each}
							</div>
						</section>
					{/each}
				</div>
			{:else}
				<div class="library-empty">
					<BoxesIcon size={28} />
					{#if artifactLibrary.loading}<h2>Loading artifacts…</h2>
					{:else if project || tags.length || search}<h2>No matching artifacts</h2><button type="button" onclick={() => { project = ''; tags = []; search = ''; }}>Clear filters</button>
					{:else if lens === 'pairs'}<h2>No before and after pairs</h2><p>Pairs share the same tags except for before and after.</p>
					{:else if lens === 'living'}<h2>No living artifacts</h2><p>Open an artifact and switch on Keep alive to see it here.</p>
					{:else}<h2>No artifacts yet</h2><p>Saved files will appear here.</p>{/if}
				</div>
			{/if}
		</div>
	</div>
</main>

{#if studioEntry && studioBackend}
	{#key studioEntry.key}<ArtifactStudio entry={studioEntry} backend={studioBackend} onclose={closeStudio} />{/key}
{/if}

<script module lang="ts">
	function projectHue(key: string) { return [...key].reduce((hue, char) => (hue * 31 + char.charCodeAt(0)) % 360, 0); }
</script>

<style>
	.library { display:flex; flex-direction:column; min-height:0; flex:1; background:var(--chat-bg); color:var(--chat-fg); }
	.library-header { border-bottom:1px solid var(--chat-border); padding:19px clamp(14px,2.2vw,36px) 13px; background:radial-gradient(ellipse at 14% 0%,color-mix(in srgb,var(--accent-2) 10%,transparent),transparent 65%),var(--chat-surface); }
	.library-heading { display:flex; align-items:center; gap:12px; }
	.library-title { flex:1; min-width:0; }
	h1 { display:flex; align-items:center; gap:10px; margin:0; font-size:clamp(1.55rem,2.3vw,2rem); font-weight:740; letter-spacing:-.04em; }
	.library-title p,.library-empty p { margin:2px 0 0; color:var(--chat-fg-muted); font-size:.82rem; }
	.library-search { display:flex; align-items:center; gap:9px; width:min(300px,32%); padding:7px 11px; border:1px solid var(--chat-border); border-radius:10px; color:var(--chat-fg-subtle); background:var(--chat-bg); }
	.library-search input { width:100%; font-size:.79rem; color:var(--chat-fg); outline:none; }
	.library-search:focus-within { outline:2px solid var(--accent-2); }
	.library-controls { display:flex; flex-wrap:wrap; align-items:center; gap:10px 16px; margin-top:14px; }
	.lens-scroll,.library-filters { min-width:0; overflow:auto; scrollbar-width:thin; }
	.lenses,.library-filters,.project-filters,.tag-filters { display:flex; align-items:center; gap:5px; }
	.lenses { width:max-content; padding:3px; border-radius:14px; background:var(--chat-surface-2); }
	.lenses button { position:relative; display:flex; align-items:center; gap:7px; padding:8px 11px; color:var(--chat-fg-muted); border-radius:11px; white-space:nowrap; font-size:.8rem; font-weight:550; }
	.lenses button:hover,.lenses button[aria-pressed='true'] { background:var(--chat-bg); color:var(--chat-fg); }
	.lenses button[aria-pressed='true']::after { content:''; position:absolute; inset:auto 13px 1px; height:2px; border-radius:4px; background:linear-gradient(90deg,#00cce0,#9b78ff,#ff923e); }
	.tag-filters { margin-left:6px; padding-left:9px; border-left:1px solid var(--chat-border); }
	.filter-chip { display:flex; align-items:center; gap:5px; border:1px solid var(--chat-border); padding:3px 8px; border-radius:999px; color:var(--chat-fg-muted); white-space:nowrap; font-size:.71rem; }
	.filter-chip:hover,.filter-chip[aria-pressed='true'] { border-color:var(--accent-2); color:var(--accent-2); background:color-mix(in srgb,var(--accent-2) 9%,transparent); }
	.filter-chip span:not(.project-dot),.shelf-project { color:var(--chat-fg-subtle); }
	.project-dot { flex:none; width:8px; height:8px; border-radius:50%; background:light-dark(hsl(var(--project-hue) 64% 43%),hsl(var(--project-hue) 86% 68%)); }
	.library-browsing { flex:1; overflow:auto; padding:23px clamp(14px,2.2vw,36px) 32px; background:radial-gradient(ellipse at 0 0,color-mix(in srgb,var(--accent-2) 6%,transparent),transparent 60%); }
	.shelves { display:flex; flex-wrap:wrap; align-items:flex-start; gap:26px 25px; }
	.shelf { min-width:0; max-width:100%; }
	.shelf-heading,.compare-heading { display:flex; flex-wrap:wrap; align-items:center; gap:6px 8px; margin:0 5px 10px; }
	.shelf-heading h2,.compare-heading h2 { font-weight:680; font-size:1rem; line-height:1.25; }
	.shelf-project,.compare-heading span { font-size:.71rem; }
	.shelf-objects { display:flex; flex-wrap:wrap; row-gap:11px; }
	.shelf-object-actions { transform-origin:top left; }
	.shelf-card { width:143px; text-align:left; padding:0; display:flex; flex-direction:column; transform-origin:top left; }
	.shelf-card[data-shape='phone'] { width:105px; }
	.shelf-card[data-shape='screen'],.shelf-card[data-shape='recording'],.shelf-card[data-shape='picture'] { width:183px; }
	.shelf-card:hover { color:var(--accent-2); }
	.shelf-ledge { display:block; height:10px; background:linear-gradient(color-mix(in srgb,var(--chat-border) 85%,var(--accent-2)) 2px,color-mix(in srgb,var(--chat-surface-2) 85%,transparent) 3px,transparent 10px); }
	.shelf-caption { display:grid; gap:2px; padding:3px 9px 0; }
	.shelf-caption strong { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:2; line-clamp:2; overflow:hidden; font-size:.81rem; font-weight:650; line-height:1.25; overflow-wrap:anywhere; }
	.shelf-facts { font-size:.68rem; color:var(--chat-fg-subtle); }
	.living-label { color:var(--accent-2); font-size:.7rem; font-weight:650; }
	.living-shelves { --shelf-object-height:215px; }
	.living-shelves .shelf-card { width:180px; }
	.living-shelves .shelf-card[data-shape='phone'] { width:128px; }
	.living-shelves .shelf-card[data-shape='screen'],.living-shelves .shelf-card[data-shape='picture'],.living-shelves .shelf-card[data-shape='recording'] { width:240px; }
	.compare-shelves { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr)); gap:24px; }
	.compare-shelf { transform-origin:top left; }
	.compare-heading span { color:var(--chat-fg-muted); }
	.compare-view { position:relative; aspect-ratio:16/10; overflow:hidden; border:1px solid var(--chat-border); border-radius:11px; background:var(--chat-surface-2); }
	.compare-links { display:flex; justify-content:space-between; padding:7px 5px; }
	.compare-links button,.library-problems button,.library-empty button { color:var(--accent-2); font-size:.8rem; text-decoration:underline; text-underline-offset:3px; }
	.library-empty { display:grid; justify-items:center; gap:6px; text-align:center; padding:55px 12px; color:var(--chat-fg-muted); }
	.library-empty h2 { font-weight:650; color:var(--chat-fg); }
	.library-problems { margin-bottom:16px; color:var(--chat-fg-muted); font-size:.85rem; }
	@media(max-width:640px) {
		.library-header { padding:10px 12px; }
		.library-heading { flex-wrap:wrap; gap:6px; }
		.library-title p { font-size:.72rem; }
		.library-search { width:100%; margin-top:3px; }
		.library-controls { gap:7px; margin-top:9px; }
		.lens-scroll,.library-filters { width:100%; }
		.library-browsing { padding:16px 12px 24px; }
		.shelves { display:grid; gap:22px; }
		.shelf-heading { margin-left:1px; }
		.shelf-objects { flex-wrap:nowrap; overflow:auto; padding:4px 3px 7px; scroll-snap-type:x proximity; scrollbar-width:thin; }
		.shelf-object-actions { flex:none; scroll-snap-align:start; }
	}
</style>
