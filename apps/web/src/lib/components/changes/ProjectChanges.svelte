<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { projectHref, threadHref } from '#lib/backends.js';
	import { CodeReviewSession, sameReviewSource } from '#lib/code/code-review-session.svelte.js';
	import { codeLineDocument } from '#lib/code/code-review.js';
	import type { LineReviewTarget } from '#lib/code/line-review-editor.js';
	import CodeReviewTray from '../review/CodeReviewTray.svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import type { HarnessClient } from '@kemiri/client';
	import type { ChangedFile, ChangeSource } from '@kemiri/protocol';
	import XIcon from '@lucide/svelte/icons/x';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { loadCodeComparison } from '#lib/code/load-viewer.js';
	import { changeCommitPicker, changeCounts, changeFileDisplay, changeReadProblem, groupChangedFiles,
		readViewedChanges, setChangeViewed, viewedChangePrefix, type ChangeFile, type ChangeList } from '#lib/code/project-changes.js';

	let { backendId, client, projectId, repository, source, taskTitle, taskId, sourceThreadId, onclose, onfiles }: {
		backendId: string; client: HarnessClient; projectId: string; repository?: boolean; source: ChangeSource;
		taskTitle?: string; taskId?: string; sourceThreadId?: string; onclose: () => void; onfiles?: () => void;
	} = $props();

	const review = untrack(() => new CodeReviewSession(source, backendId, projectId, client, source.kind === 'task' ? source.taskId : taskId, sourceThreadId));
	$effect(() => { review.persist(); });
	const wide = new MediaQuery('(min-width: 641px)');
	let preferSplit = $state(false);
	const layout = $derived(wide.current && preferSplit ? 'split' : 'unified');
	let taskList = $state.raw<ChangeList>();
	let commitList = $state.raw<ChangeList>();
	let chosenCommit = $state<string>();
	let chosenPath = $state<string>();
	let file = $state.raw<ChangeFile>();
	let taskError = $state('');
	let commitError = $state('');
	let fileError = $state('');
	let attempt = $state(0);
	let viewed = $state.raw(new Set<string>());
	let opener: HTMLElement | undefined;
	let closeButton = $state<HTMLButtonElement | null>(null);
	let contentRef = $state<HTMLElement | null>(null);

	const picker = $derived(taskList ? changeCommitPicker(taskList, chosenCommit) : undefined);
	const commitHash = $derived(source.kind === 'commit' ? source.hash : picker?.commit?.hash);
	const activeSource = $derived.by((): ChangeSource | undefined => {
		if (commitHash) return { kind: 'commit', hash: commitHash };
		if (source.kind === 'task' && picker?.allowAll) return source;
	});
	const list = $derived(commitHash ? commitList : taskList);
	const files = $derived(list?.files ?? []);
	const counts = $derived(changeCounts(files));
	const groups = $derived(groupChangedFiles(files));
	const selected = $derived(files.find(row => row.path === chosenPath) ?? files.find(row => !row.binary) ?? files[0]);
	const selectedIndex = $derived(selected ? files.indexOf(selected) : -1);
	const prefix = $derived(activeSource && list ? viewedChangePrefix(backendId, projectId, activeSource, list) : '');
	const viewedCount = $derived(files.filter(row => viewed.has(prefix + row.path)).length);
	const isViewed = $derived(selected ? viewed.has(prefix + selected.path) : false);
	const display = $derived(file ? changeFileDisplay(file) : undefined);
	const lineReview = $derived.by((): LineReviewTarget | undefined => {
		if (!activeSource || !selected || !file || display?.kind !== 'compare') return;
		return { session: review, source: activeSource, path: selected.path, previousPath: selected.previousPath,
			disabledSides: [...(file.before ? [] : ['before'] as const), ...(file.after ? [] : ['after'] as const)] };
	});
	/** Only a task range can move. Commit comments are pinned to immutable Git objects. */
	async function recheckTaskComments(): Promise<void> {
		if (source.kind !== 'task') return;
		const taskSource = source;
		const paths = [...new Set([...review.comments, ...(review.editor ? [review.editor] : [])]
			.filter(comment => sameReviewSource(comment.source, taskSource)).map(comment => comment.anchor.path))];
		if (!paths.length) return;
		let fresh: ChangeList;
		try { fresh = await client.listChanges(projectId, taskSource); }
		catch { return; } // A failed read is not evidence that a line disappeared.
		for (const path of paths) {
			const row = fresh.files.find(file => file.path === path || file.previousPath === path);
			if (!row && fresh.truncated) continue;
			let current: ChangeFile | undefined;
			if (row && !row.binary) {
				try { current = await client.readChangeFile(projectId, taskSource, row.path); }
				catch { continue; }
			}
			for (const side of ['before', 'after'] as const) {
				const text = current?.[side]?.text;
				review.reconcile(taskSource, row?.path ?? path, side, text === undefined ? undefined : codeLineDocument(text), path);
			}
		}
	}

	async function draftInChat(): Promise<void> {
		const href = review.recipient ? threadHref(backendId, projectId, review.recipient) : projectHref(backendId, projectId);
		await goto(href, { reset: false });
		requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus());
	}

	const heading = $derived(source.kind === 'task' ? taskTitle ?? `Task ${source.taskId}` : commitList?.commits[0]?.subject || `Commit ${source.hash.slice(0, 12)}`);
	const statusLetter = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };

	onMount(() => { viewed = readViewedChanges(localStorage); });

	$effect(() => {
		const requested = source, changesClient = client, id = projectId;
		attempt;
		taskList = undefined;
		taskError = '';
		if (requested.kind !== 'task' || repository === false) return;
		let disposed = false;
		void changesClient.listChanges(id, requested).then(rows => { if (!disposed) taskList = rows; },
			error => { if (!disposed) taskError = changeReadProblem(error); });
		return () => { disposed = true; };
	});

	$effect(() => {
		const hash = commitHash, changesClient = client, id = projectId;
		attempt;
		commitList = undefined;
		commitError = '';
		if (!hash || repository === false) return;
		let disposed = false;
		void changesClient.listChanges(id, { kind: 'commit', hash }).then(rows => { if (!disposed) commitList = rows; },
			error => { if (!disposed) commitError = changeReadProblem(error); });
		return () => { disposed = true; };
	});

	$effect(() => {
		const requested = activeSource, row = selected, changesClient = client, id = projectId;
		attempt;
		file = undefined;
		fileError = '';
		if (!requested || !row) return;
		if (row.binary) { file = { binary: true }; return; }
		let disposed = false;
		// The destination path is the server's lookup key for renames.
		void changesClient.readChangeFile(id, requested, row.path).then(text => { if (!disposed) file = text; },
			error => { if (!disposed) fileError = changeReadProblem(error); });
		return () => { disposed = true; };
	});

	function selectCommit(event: Event & { currentTarget: HTMLSelectElement }): void {
		chosenCommit = event.currentTarget.value || undefined;
		chosenPath = undefined;
	}

	function moveFile(step: number): void {
		const target = files[selectedIndex + step];
		if (target) chosenPath = target.path;
	}

	function fileShortcut(event: KeyboardEvent): void {
		if (event.key === 'Escape' && review.editor) { event.preventDefault(); event.stopPropagation(); review.cancel(); return; }
		if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !(event.target instanceof HTMLElement) ||
			event.target.closest('select, input:not([type=checkbox]), textarea')) return;
		// Avoid Alt+Left/Right, the browser's Back and Forward keys.
		if (event.code === 'BracketLeft' || event.code === 'BracketRight') {
			event.preventDefault();
			moveFile(event.code === 'BracketLeft' ? -1 : 1);
		}
	}

	function toggleViewed(row: ChangedFile, checked: boolean): void {
		viewed = setChangeViewed(localStorage, prefix + row.path, checked, viewed);
	}
</script>

{#snippet delta(additions: number, deletions: number)}
	<span class="delta" aria-label={`${additions} added, ${deletions} removed`}>
		<span class="text-(--chat-success)">+{additions}</span> <span class="text-(--chat-danger)">−{deletions}</span>
	</span>
{/snippet}

{#snippet fileNavigation()}
	<Button size="icon" variant="ghost" disabled={selectedIndex <= 0} aria-label="Previous file" title="Previous file (Alt+[)" aria-keyshortcuts="Alt+[" onclick={() => moveFile(-1)}><ChevronLeftIcon /></Button>
	<Button size="icon" variant="ghost" disabled={selectedIndex < 0 || selectedIndex >= files.length - 1} aria-label="Next file" title="Next file (Alt+])" aria-keyshortcuts="Alt+]" onclick={() => moveFile(1)}><ChevronRightIcon /></Button>
{/snippet}

<Dialog.Root open onOpenChange={open => { if (!open) onclose(); }}>
	<Dialog.Content showCloseButton={false} bind:ref={contentRef} data-project-changes onkeydown={fileShortcut}
		onOpenAutoFocus={event => { opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined; event.preventDefault(); closeButton?.focus(); }}
		onCloseAutoFocus={event => { if (opener?.isConnected && !contentRef?.contains(opener)) { event.preventDefault(); opener.focus(); } }}
		class="changes-dialog inset-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 ring-0 sm:max-w-none motion-reduce:animate-none motion-reduce:transition-none">
		<header class="changes-header">
			<Button bind:ref={closeButton} size="icon" variant="ghost" aria-label="Close changes" title="Close changes (Escape)" onclick={onclose}><XIcon /></Button>
			<div class="changes-title">
				<div class="flex min-w-0 items-center gap-2">
					<nav aria-label="Code view" class="view-label"><span aria-current="page">Changes</span>{#if onfiles}<button onclick={onfiles}>Files</button>{/if}</nav>
					{#if source.kind === 'task' && taskTitle}<span class="task-id-chip shrink-0">{source.taskId}</span>{/if}
					<Dialog.Title class="truncate text-sm font-semibold" title={heading}>{heading}</Dialog.Title>
				</div>
				{#if list}
					<p class="summary" aria-live="polite">{source.kind === 'task' && taskList ? `${taskList.commits.length} ${taskList.commits.length === 1 ? 'commit' : 'commits'} · ` : ''}{counts.files}{list.truncated ? '+' : ''} {counts.files === 1 ? 'file' : 'files'} · {@render delta(counts.additions, counts.deletions)}</p>
				{/if}
			</div>
			<div class="changes-options">
				{#if source.kind === 'task' && taskList?.commits.length && picker}
					<label class="min-w-0">
						<span class="sr-only">Commit to review</span>
						<select value={picker.commit?.hash ?? ''} onchange={selectCommit} class="commit-picker">
							{#if picker.allowAll}<option value="">All commits</option>{/if}
							{#each taskList.commits as commit (commit.hash)}<option value={commit.hash}>{commit.hash.slice(0, 8)} · {commit.subject || 'Untitled commit'}</option>{/each}
						</select>
					</label>
				{:else if source.kind === 'commit'}
					<code class="px-2 text-xs text-(--chat-fg-muted)" title={source.hash}>{source.hash.slice(0, 12)}</code>
				{/if}
				{#if wide.current && files.length}
					<div class="layout-picker" role="group" aria-label="Diff layout">
						<Button size="sm" variant="ghost" aria-pressed={layout === 'unified'} onclick={() => preferSplit = false}>Unified</Button>
						<Button size="sm" variant="ghost" aria-pressed={layout === 'split'} onclick={() => preferSplit = true}>Split</Button>
					</div>
				{/if}
			</div>
		</header>
		<Dialog.Description class="sr-only">Read-only changes in this project. Alt plus left or right bracket changes file. Alt plus Up or Down moves between changes in the diff.</Dialog.Description>
		{#if picker?.reason}<p class="change-notice" role="status">{picker.reason}</p>{/if}
		{#if repository === false}
			<p class="empty-state" role="status">This project has no Git repository to review.</p>
		{:else if taskError || commitError}
			<div class="empty-state" role="alert"><p>{taskError || commitError}</p><Button size="sm" variant="outline" onclick={() => attempt++}>Retry</Button></div>
		{:else if taskList && !taskList.commits.length}
			<p class="empty-state" role="status">No commits have been attributed to this task yet.</p>
		{:else if !list}
			<p class="empty-state" role="status">Reading changes…</p>
		{:else if !files.length || !selected}
			<p class="empty-state" role="status">No file changes in this {commitHash ? 'commit' : 'task range'}.</p>
		{:else}
			{#if list.truncated}<p class="change-notice" role="status">Showing the first {files.length} changed files. Totals are for these files only.</p>{/if}
			<div class="review-body">
				{#if wide.current}
					<nav class="file-rail" aria-label="Changed files">
						<div class="file-rail-heading"><span>Changed files</span><span>{viewedCount} of {files.length} viewed</span></div>
						{#each groups as group (group.folder)}
							<section class="file-group" aria-label={group.folder || 'Project root'}>
								<h3><FolderIcon size={14} aria-hidden="true" />{group.folder || '(project root)'}</h3>
								<ul>
									{#each group.entries as { file: row, name, index } (row.path)}
										<li class:current={selectedIndex === index}>
											<button class="file-select" aria-current={selectedIndex === index ? 'true' : undefined} title={row.path} onclick={() => chosenPath = row.path}
												aria-label={`${name}, ${row.status}, ${row.additions} added, ${row.deletions} removed${row.binary ? ', binary' : ''}`}>
												<span class="status-tile" data-status={row.status} aria-hidden="true">{statusLetter[row.status]}</span>
												<span class="file-name">{name}</span>
												{@render delta(row.additions, row.deletions)}
											</button>
											<input type="checkbox" class="viewed-checkbox" aria-label={`Viewed ${name}`} checked={viewed.has(prefix + row.path)} onchange={event => toggleViewed(row, event.currentTarget.checked)} />
										</li>
									{/each}
								</ul>
							</section>
						{/each}
					</nav>
				{/if}
				<section class="file-review" aria-label="Selected file changes">
					<div class="file-header">
						<div class="file-path" aria-live="polite" title={selected.path}>
							{#if selected.previousPath}<span class="text-(--chat-fg-muted)">{selected.previousPath} → </span>{/if}{selected.path}
							<span class="file-position">File {selectedIndex + 1} of {files.length} · {@render delta(selected.additions, selected.deletions)}</span>
						</div>
						<div class="file-actions">
							<label class="viewed-option"><input type="checkbox" checked={isViewed} onchange={event => toggleViewed(selected!, event.currentTarget.checked)} />Viewed</label>
							<div class="file-navigation" role="group" aria-label="Navigate files">{@render fileNavigation()}</div>
						</div>
					</div>
					{#if fileError}
						<div class="empty-state" role="alert"><p>{fileError}</p><Button size="sm" variant="outline" onclick={() => attempt++}>Retry</Button></div>
					{:else if !display}
						<p class="empty-state" role="status">Reading file…</p>
					{:else if display.kind === 'binary'}
						<p class="empty-state" role="status">This is a binary or non-text file. There is no text diff to show.</p>
					{:else if display.kind === 'patch'}
						<p class="change-notice" role="status">This file is too large to compare. {display.patch ? display.truncated ? 'Showing a truncated patch.' : 'Showing the plain patch.' : 'No patch is available.'}</p>
						{#if display.patch}
							<!-- svelte-ignore a11y_no_noninteractive_tabindex (the scrollable patch needs keyboard focus) -->
							<pre class="plain-patch" tabindex="0" role="region" aria-label="Plain patch">{display.patch}</pre>
						{/if}
					{:else if display.kind === 'text'}
						<p class="change-notice" role="status">This file exceeds the interactive viewer limit. Showing the file sides as plain text.</p>
						<div class="plain-sides">
							<!-- svelte-ignore a11y_no_noninteractive_tabindex (the scrollable text needs keyboard focus) -->
							<pre class="plain-patch" tabindex="0" role="region" aria-label="Before">{display.before}</pre>
							<!-- svelte-ignore a11y_no_noninteractive_tabindex (the scrollable text needs keyboard focus) -->
							<pre class="plain-patch" tabindex="0" role="region" aria-label="After">{display.after}</pre>
						</div>
					{:else}
						{#key selected.path}
							{#await loadCodeComparison()}
								<p class="empty-state" role="status">Opening diff…</p>
							{:then { default: CodeComparison }}
								<CodeComparison path={selected.path} {layout} {lineReview} beforeLabel="Before" afterLabel="After" before={{ content: display.before, truncated: false }} after={{ content: display.after, truncated: false }} />
							{:catch}
								<p class="empty-state" role="alert">Could not load the diff viewer. Reload the app to try again.</p>
							{/await}
						{/key}
					{/if}
				</section>
				<CodeReviewTray session={review} onrecheck={recheckTaskComments} ondraft={() => void draftInChat()} inlineEditor={!!lineReview && !!review.editor && sameReviewSource(lineReview.source, review.editor.source) && lineReview.path === review.editor.anchor.path} />
			</div>
		{/if}
		{#if (!files.length || !selected) && (review.comments.length || review.editor)}<CodeReviewTray session={review} onrecheck={recheckTaskComments} ondraft={() => void draftInChat()} />{/if}
	</Dialog.Content>
</Dialog.Root>

<style>
	.changes-header { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: max(6px, env(safe-area-inset-top)) max(10px, env(safe-area-inset-right)) 7px max(10px, env(safe-area-inset-left)); border-bottom: 1px solid transparent; border-image: var(--chat-grad) 1; background: var(--chat-surface); }
	.changes-title { min-width: 0; flex: 1; }
	.view-label { border: 1px solid var(--chat-border); background: var(--chat-surface-2); border-radius: 7px; padding: 3px 7px; font-size: .75rem; font-weight: 600; }
	.view-label { display:flex; gap:8px; align-items:center; }
	.view-label button { color:var(--chat-fg-muted); }
	.view-label button:hover { text-decoration:underline; }
	.summary, .file-position { margin-top: 1px; color: var(--chat-fg-muted); font-size: 12px; }
	.changes-options { display: flex; gap: 8px; align-items: center; min-width: 0; }
	.commit-picker, .layout-picker { max-width: min(32vw, 20rem); background: var(--chat-surface-2); border: 1px solid var(--chat-border); border-radius: 7px; }
	.commit-picker { min-height: 34px; padding: 0 6px; }
	.layout-picker { display: flex; padding: 2px; }
	.layout-picker :global(button[aria-pressed='true']) { background: var(--chat-bg); box-shadow: inset 0 0 0 1px var(--chat-border); }
	.review-body { min-height: 0; flex: 1; display: flex; }
	.file-rail { flex: 0 0 clamp(13rem, 23vw, 18rem); overflow: auto; border-inline-end: 1px solid var(--chat-border); padding: 10px 8px; background: var(--chat-surface); }
	.file-rail-heading { display: flex; justify-content: space-between; gap: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .02em; padding: 3px 4px 8px; color: var(--chat-fg-muted); }
	.file-group h3 { display: flex; align-items: center; gap: 6px; padding: 6px 5px; font-size: 12px; overflow-wrap: anywhere; color: var(--chat-fg-muted); }
	.file-group li { display: flex; align-items: center; margin-bottom: 1px; border-radius: 7px; padding-inline-end: 8px; }
	.file-group li:hover, .file-group li.current { background: var(--chat-surface-2); }
	.file-group li.current { box-shadow: inset 2px 0 var(--accent-2); }
	.file-select { flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px; padding: 6px 8px; min-height: 34px; border-radius: 7px; text-align: left; font-size: 12px; }
	.file-name { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.status-tile { color: var(--chat-warning); background: color-mix(in oklab, currentColor 15%, transparent); width: 1.25rem; height: 1.25rem; text-align: center; line-height: 1.25rem; border-radius: 5px; font-size: 10px; font-weight: 700; }
	.status-tile[data-status='added'] { color: var(--chat-success); }
	.status-tile[data-status='deleted'] { color: var(--chat-danger); }
	.status-tile[data-status='renamed'] { color: var(--accent-2); }
	.delta { font-family: var(--font-mono); white-space: nowrap; font-size: 11px; }
	.viewed-checkbox, .viewed-option input { accent-color: var(--accent-2); }
	.file-review { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
	.file-header { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 0 8px; background: var(--chat-bg); border-bottom: 1px solid var(--chat-border); }
	.file-path { font: 600 12px var(--font-mono); min-width: 0; overflow-wrap: anywhere; padding: 5px; }
	.file-position { display: block; font: 11px var(--font-sans); }
	.file-actions, .file-navigation { display: flex; align-items: center; }
	.file-actions { gap: 4px; }
	.viewed-option { display: flex; align-items: center; gap: 4px; font-size: 12px; }
	.empty-state { color: var(--chat-fg-muted); padding: 20px; }
	.empty-state :global(button) { margin-top: 8px; }
	.change-notice { margin: 0; padding: 7px 12px; border-bottom: 1px solid var(--chat-border); background: var(--chat-surface-2); color: var(--chat-fg-muted); font-size: 12px; }
	.plain-patch { overflow: auto; margin: 0; padding: 14px; font-size: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
	.plain-sides { overflow: auto; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
	@media (max-width: 640px) {
		.changes-header { gap: 4px; }
		.changes-options:has(select) { flex: 1 0 100%; padding-inline-start: 4px; }
		.commit-picker { max-width: 90vw; min-height: 44px; }
		.file-header { flex-wrap: wrap; gap: 0; }
		.file-path { flex: 1; }
		.viewed-option { min-height: 44px; }
		.file-navigation :global(button), .changes-header > :global(button) { min-width: 44px; min-height: 44px; }
		.plain-sides { grid-template-columns: minmax(0, 1fr); }
	}
</style>
