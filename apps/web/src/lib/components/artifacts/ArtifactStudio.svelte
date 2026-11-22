<script lang="ts">
	import { onMount } from 'svelte';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import type { ArtifactComment, ArtifactTaskFolder } from '@kemiri/protocol';
	import { artifactHistory, boardTaskFolders, libraryDate, studioCommentText, taskDoneSplit, type LibraryArtifact } from '#lib/artifact-library.js';
	import { artifactLibrary, supportsArtifactLibrary } from '#lib/artifact-library.svelte.js';
	import { isHtmlArtifact } from '#lib/artifact-preview.js';
	import { artifactVersions, selectedArtifactVersion } from '#lib/artifact-versions.js';
	import { artifactTitle } from '#lib/artifacts.js';
	import { downloadArtifact } from '#lib/artifacts.svelte.js';
	import { projectHref } from '#lib/backends.js';
	import type { BackendConnection } from '#lib/harness.svelte.js';
	import { taskHref } from '#lib/task-chat.js';
	import Markdown from '#lib/components/markdown/Markdown.svelte';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import ArtifactPinButton from './ArtifactPinButton.svelte';
	import DiscussButton from './DiscussButton.svelte';
	import ArtifactKindIcon from './ArtifactKindIcon.svelte';
	import ArtifactPlayer from './ArtifactPlayer.svelte';
	import ArtifactText from './ArtifactText.svelte';
	import ArtifactThumb from './ArtifactThumb.svelte';
	import ArtifactTaskState from './ArtifactTaskState.svelte';

	let { entry, backend, onclose }: { entry: LibraryArtifact; backend: BackendConnection; onclose: () => void } = $props();
	const artifact = $derived(entry.artifact);
	const projectId = $derived(artifact.projectId);
	const artifactId = $derived(artifact.id);
	const supported = $derived(supportsArtifactLibrary(backend));
	const versions = $derived(artifactVersions(artifact));
	let selectedVersion = $state<number>();
	const selected = $derived(selectedArtifactVersion(artifact, selectedVersion));
	let taskFolders = $state<ArtifactTaskFolder[]>([]);
	let comments = $state<ArtifactComment[]>([]);
	let trailRevision = $state(0);
	let trailProblem = $state('');
	let saving = $state(false);
	let actionProblem = $state('');
	let backButton = $state<HTMLButtonElement>();
	let filmstrip = $state<HTMLDivElement>();
	const homeTask = $derived(taskFolders.find(task => task.id === artifact.taskId) ?? entry.task);
	const homeFolder = $derived(taskFolders.find(task => task.id === artifact.taskId));
	const doneAt = $derived(homeTask?.status === 'done' ? homeTask.settledAt : null);
	const split = $derived(taskDoneSplit(versions, doneAt));
	const history = $derived(artifactHistory(versions, comments, doneAt, artifact.living?.since));

	onMount(() => backend.client.onBoardState(event => { if (event.projectId === projectId) trailRevision++; }));
	$effect(() => {
		if (!backend.ready) return;
		void trailRevision;
		void artifact.version;
		void artifact.living?.since;
		let current = true;
		trailProblem = '';
		if (supported) {
			void backend.client.readArtifactTrail(projectId, artifactId).then(trail => {
				if (current) { taskFolders = trail.tasks; comments = trail.comments; }
			}).catch(() => { if (current) trailProblem = 'Could not read the artifact history.'; });
		} else if (artifact.taskId) {
			void backend.client.readBoard(projectId, { includeArchived: true }).then(board => {
				if (current) taskFolders = boardTaskFolders(projectId, board);
			}).catch(() => {});
		}
		return () => { current = false; };
	});

	$effect(() => {
		void selected.id;
		if (!filmstrip) return;
		const selectedFrame = filmstrip.querySelector<HTMLElement>('[aria-pressed="true"]');
		if (!selectedFrame) return;
		const stripBounds = filmstrip.getBoundingClientRect();
		const frameBounds = selectedFrame.getBoundingClientRect();
		if (frameBounds.right > stripBounds.right) filmstrip.scrollLeft += frameBounds.right - stripBounds.right + 10;
		else if (frameBounds.left < stripBounds.left) filmstrip.scrollLeft -= stripBounds.left - frameBounds.left + 10;
	});

	function linkToTask(id: string) { return projectHref(backend.id, projectId) + taskHref(id); }
	function titleOfTask(id: string) { return taskFolders.find(task => task.id === id)?.title ?? id; }
	function hasVersion(version: number | null) { return version !== null && versions.some(snapshot => (snapshot.version ?? 1) === version); }

	async function toggleLiving() {
		if (!supported || saving) return;
		saving = true;
		actionProblem = '';
		try {
			const updated = await backend.client.setArtifactLiving(projectId, artifactId, !artifact.living);
			artifactLibrary.upsert(backend.id, updated);
		} catch (error) { actionProblem = error instanceof Error ? error.message : String(error); }
		finally { saving = false; }
	}

	async function download() {
		actionProblem = '';
		try { await downloadArtifact(backend.client, selected); }
		catch (error) { actionProblem = error instanceof Error ? error.message : String(error); }
	}
</script>

<Dialog.Root open={true} onOpenChange={open => { if (!open) onclose(); }}>
	<Dialog.Content size="viewer" showCloseButton={false} class="flex h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 ring-0 sm:h-dvh sm:w-screen"
		onOpenAutoFocus={event => { event.preventDefault(); backButton?.focus(); }}
		onCloseAutoFocus={event => event.preventDefault()} data-artifact-studio>
		<header class="studio-header">
			<button class="studio-back" type="button" bind:this={backButton} onclick={onclose} aria-label="Back to shelves"><ArrowLeftIcon size={16} /><span>Shelves</span></button>
			<div class="studio-heading">
				<ArtifactKindIcon kind={artifact.kind} class="size-4 shrink-0 text-(--accent-2)" />
				<Dialog.Title class="truncate text-base font-semibold">{artifactTitle(artifact)}</Dialog.Title>
				<span class="studio-filename" title={artifact.name}>{artifact.name}</span>
			</div>
			<Dialog.Description class="sr-only">Artifact Studio. Read the artifact, its versions and its history.</Dialog.Description>
			{#if backend.supports('project-artifacts') && isHtmlArtifact(artifact)}<ArtifactPinButton {artifact} client={backend.client} />{/if}
			<DiscussButton artifact={selected} client={backend.client} {onclose} compact />
			{#if supported}<button type="button" class="keep-alive" role="switch" aria-checked={!!artifact.living} disabled={saving || !backend.ready} onclick={toggleLiving}><span class="switch-track" aria-hidden="true"></span>Keep alive</button>{/if}
			<button class="studio-download" type="button" onclick={download} aria-label="Download version" title="Download version"><DownloadIcon size={16} /></button>
		</header>
		{#if actionProblem}<p class="studio-problem" role="alert">{actionProblem}</p>{/if}
		<div class="studio-layout">
			<section class="studio-artifact" aria-label="Artifact and versions">
				<div class="artifact-view" class:document-view={selected.kind === 'text'}>
					{#key selected.id}
						{#if selected.kind === 'text'}
							<div class="studio-document"><ArtifactText artifact={selected} client={backend.client} roomy fullSpace={isHtmlArtifact(selected)} reviewSourceThreadId={selected.threadId === 'main' ? undefined : selected.threadId} {onclose} /></div>
						{:else}
							<div class="studio-player"><ArtifactPlayer artifact={selected} client={backend.client} roomy /></div>
						{/if}
					{/key}
				</div>
				<div class="version-filmstrip" bind:this={filmstrip} role="group" aria-label="Versions">
					{#each versions as version, index (version.id)}
						{#if index === split}<span class="done-marker" title="Task done {libraryDate(doneAt!)}">Task done</span>{/if}
						<button type="button" class="version-frame" aria-pressed={selected.id === version.id} aria-label="Version {version.version ?? 1}, {libraryDate(version.createdAt)}{version.madeForTaskId ? `, ${titleOfTask(version.madeForTaskId)}` : ''}" onclick={() => selectedVersion = version.version ?? 1}>
							<ArtifactThumb artifact={version} client={backend.client} class="filmstrip-thumb" duration={false} play={false} />
							<span>v{version.version ?? 1} · {libraryDate(version.createdAt)}</span>
							{#if version.madeForTaskId}<span class="version-task" title={titleOfTask(version.madeForTaskId)}>{titleOfTask(version.madeForTaskId)}</span>{/if}
						</button>
					{/each}
				</div>
			</section>
			<aside class="studio-context" aria-label="Origin and history">
				<section class="studio-origin">
					<h2>Comes from</h2>
					<div class="studio-home-task">
						{#if artifact.taskId}<a href={linkToTask(artifact.taskId)}>{homeTask?.title ?? `Task ${artifact.taskId}`}</a>{:else}<strong>Chat, no task</strong>{/if}
						{#if homeTask}<ArtifactTaskState task={homeTask} />{/if}
					</div>
					<p class="studio-project">{entry.project.name}{homeTask?.archived ? ' · Archived task' : ''}</p>
					{#if homeTask?.summary}<div class="studio-summary"><Markdown source={homeTask.summary} /></div>{/if}
					{#if homeFolder?.decisions.length}
						<details><summary>What the task found</summary><ul>
							{#each homeFolder.decisions as decision (decision.id)}<li><Markdown source={decision.text} />{#if decision.why}<div class="decision-why"><Markdown source={decision.why} /></div>{/if}</li>{/each}
						</ul></details>
					{/if}
					{#if artifact.laterTaskIds?.length}
						<h3>Later tasks</h3><ul class="later-tasks">
							{#each artifact.laterTaskIds as id (id)}
								{@const task = taskFolders.find(folder => folder.id === id)}
								<li><a href={linkToTask(id)}>{titleOfTask(id)}</a>{#if task}<ArtifactTaskState {task} />{/if}</li>
							{/each}
						</ul>
					{/if}
				</section>
				<section class="studio-history">
					<h2>History</h2>
					{#if trailProblem}<p role="status">{trailProblem} <button type="button" onclick={() => trailRevision++}>Try again</button></p>{/if}
					<ol>
						{#each history as event (event)}
							{#if event.kind === 'save'}
								<li class="history-save"><LayersIcon size={13} /><span>{event.first === event.last ? `Version ${event.first.version ?? 1}` : `Versions ${event.first.version} to ${event.last.version}`} saved by {event.author} · {libraryDate(event.at)}{event.first !== event.last ? ` to ${libraryDate(event.last.createdAt)}` : ''}</span></li>
							{:else if event.kind === 'done'}<li class="history-done">Task done · {libraryDate(event.at)}</li>
							{:else if event.kind === 'living'}<li class="history-living">The artifact lives on · {libraryDate(event.at)}</li>
							{:else if event.kind === 'comment'}
								{@const commentText = studioCommentText(event.comment.text)}
								<li class="history-comment">
									<p class="comment-facts">Owner · {libraryDate(event.at)}{#if event.comment.version !== null} · {#if hasVersion(event.comment.version)}<button type="button" onclick={() => selectedVersion = event.comment.version ?? undefined}>Version {event.comment.version}</button>{:else}Version {event.comment.version}{/if}{/if}</p>
									{#if commentText}<Markdown source={commentText} />{/if}
									{#if event.comment.state === 'addressed'}<p class="comment-addressed">Addressed{event.comment.note ? ` · ${event.comment.note}` : ''}</p>{/if}
								</li>
							{/if}
						{/each}
					</ol>
				</section>
			</aside>
		</div>
	</Dialog.Content>
</Dialog.Root>

<style>
	.studio-header { display:flex; flex:none; align-items:center; gap:16px; padding:9px 20px; border-bottom:1px solid var(--chat-border); background:var(--chat-bg); }
	.studio-heading { display:flex; align-items:center; flex:1; gap:9px; min-width:0; }
	.studio-filename { color:var(--chat-fg-subtle); font: .72rem var(--font-mono,monospace); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	.studio-back,.studio-download,.keep-alive { display:flex; flex:none; align-items:center; justify-content:center; gap:7px; border-radius:8px; min-height:32px; padding:0 6px; font-size:.78rem; }
	.studio-back,.studio-download { color:var(--chat-fg-muted); }
	.studio-back:hover,.studio-download:hover,.keep-alive:hover { background:var(--chat-surface-2); }
	.keep-alive { font-weight:650; }
	.switch-track { display:block; position:relative; width:32px; height:19px; border-radius:12px; background:var(--chat-border); }
	.switch-track::after { content:''; position:absolute; top:2px; left:2px; width:15px; height:15px; border-radius:50%; background:white; transition:translate .16s ease; }
	.keep-alive[aria-checked='true'] .switch-track { background:linear-gradient(105deg,#20bdde,#a26bec,#ee7b5e); }
	.keep-alive[aria-checked='true'] .switch-track::after { translate:13px; }
	.studio-layout { display:grid; grid-template-columns:minmax(0,1fr) clamp(300px,28vw,468px); flex:1; min-height:0; }
	.studio-artifact { display:flex; flex-direction:column; min-width:0; min-height:0; }
	.artifact-view { display:flex; flex:1; min-height:0; justify-content:center; overflow:auto; padding:clamp(12px,2vw,30px); background:radial-gradient(ellipse at top,color-mix(in srgb,var(--accent-2) 9%,transparent),transparent 75%),var(--chat-surface); }
	.studio-document,.studio-player { display:flex; flex-direction:column; min-width:0; width:min(100%,920px); }
	.studio-player { align-self:center; }
	.version-filmstrip { display:flex; align-items:stretch; flex:none; gap:6px; overflow:auto; padding:10px; border-top:1px solid var(--chat-border); background:var(--chat-bg); scrollbar-width:thin; }
	.version-frame { display:flex; flex:0 0 83px; flex-direction:column; align-items:center; justify-content:center; gap:4px; padding:5px 2px; min-width:0; min-height:65px; border:1px solid transparent; border-radius:9px; color:var(--chat-fg-subtle); font: .67rem var(--font-mono,monospace); }
	.version-frame:hover,.version-frame[aria-pressed='true'] { border-color:var(--accent-2); background:var(--chat-surface-2); color:var(--chat-fg); }
	.version-frame :global(.filmstrip-thumb) { width:42px; height:33px; border-radius:4px; background:var(--chat-surface-2); color:var(--accent-2); }
	.version-task { width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:var(--accent-2); }
	.done-marker { display:grid; place-items:center; min-width:25px; border-inline:1px dashed var(--chat-border); writing-mode:vertical-rl; rotate:180deg; font-size:.65rem; color:var(--task-status-done); }
	.studio-context { min-width:0; overflow:auto; border-left:1px solid var(--chat-border); background:var(--chat-bg); }
	.studio-origin,.studio-history { padding:16px 18px; overflow-wrap:anywhere; }
	.studio-origin { border-bottom:1px solid var(--chat-border); background:var(--chat-surface); }
	.studio-origin h2,.studio-history h2,.studio-origin h3 { margin:0 0 7px; color:var(--chat-fg-subtle); font-size:.69rem; font-weight:750; letter-spacing:.06em; text-transform:uppercase; }
	.studio-origin h3 { margin-top:12px; }
	.studio-home-task,.later-tasks li { display:flex; align-items:center; flex-wrap:wrap; gap:6px; font-weight:650; }
	.studio-home-task a:hover,.later-tasks a:hover { text-decoration:underline; }
	.studio-project,.decision-why { color:var(--chat-fg-muted); font-size:.77rem; }
	.studio-summary,.studio-origin details { margin-top:8px; font-size:.82rem; }
	.studio-origin summary { cursor:pointer; color:var(--accent-2); }
	.studio-origin details ul { padding-left:16px; list-style:disc; }
	.studio-history ol,.later-tasks { display:grid; gap:8px; }
	.history-save,.history-done,.history-living { display:flex; justify-content:center; align-items:center; gap:6px; text-align:center; font-size:.72rem; color:var(--chat-fg-muted); }
	.history-save :global(svg) { flex:none; }
	.history-done { color:var(--task-status-done); font-weight:650; }
	.history-done::before,.history-done::after { content:''; flex:1; height:1px; background:var(--chat-border); }
	.history-living { font-weight:700; color:var(--accent-2); }
	.history-comment { justify-self:end; width:fit-content; max-width:95%; padding:8px 12px; border:1px solid color-mix(in srgb,var(--accent-2) 35%,var(--chat-border)); border-radius:12px 12px 3px 12px; background:color-mix(in srgb,var(--accent-2) 12%,var(--chat-surface)); font-size:.8rem; }
	.comment-facts { color:var(--chat-fg-muted); font-size:.68rem; }
	.comment-facts button,.studio-history [role='status'] button { color:var(--accent-2); text-decoration:underline; }
	.comment-addressed { margin-top:5px; color:var(--task-status-done); font-size:.72rem; }
	.studio-problem { padding:4px 16px; color:var(--chat-danger); }
	@media(max-width:700px) {
		.studio-header { gap:4px; padding:7px 8px; }
		.studio-filename,.studio-back span,.studio-heading :global(svg) { display:none; }
		.studio-layout { display:block; overflow:auto; }
		.artifact-view { min-height:220px; max-height:68dvh; padding:10px; }
		.artifact-view.document-view { flex:none; height:53dvh; }
		.studio-player { align-self:start; }
		.studio-context { border-left:0; border-top:1px solid var(--chat-border); overflow:visible; }
	}
	@media(prefers-reduced-motion:reduce) { .switch-track::after { transition:none; } }
</style>
