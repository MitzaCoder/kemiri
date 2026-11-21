<script lang="ts">
	import { untrack } from 'svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import type { HarnessClient } from '@kemiri/client';
	import X from '@lucide/svelte/icons/x';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { codeRootKey, type FileLocation } from '#lib/code/file-location.js';
	import { fileReadState, folderKey, parentFolder, treeRows, type RootChoice, type FileListing, type FileTreeRow, type ReadFile } from '#lib/code/files-view.js';
	import { codeLanguageForPath } from '#lib/code/languages.js';
	import { formatBytes } from '#lib/artifacts.js';
	import { copyText } from '#lib/clipboard.js';
	import GoToFile from './GoToFile.svelte';
	import FileTree from './FileTree.svelte';
	import CheckoutText from './CheckoutText.svelte';

	let { file, client, backendId, projectId, projectName, roots, taskId, threadId, changesHref, autofocusSearch = false, onselect, onclose, onquote, linkFor }: {
		file: FileLocation; client: HarnessClient; backendId: string; projectId: string; projectName: string; roots: RootChoice[];
		taskId?: string; threadId?: string; changesHref?: string; autofocusSearch?: boolean; onselect: (file: FileLocation) => void;
		onclose: () => void; onquote?: (quote: string) => void; linkFor: (file: FileLocation) => string;
	} = $props();
	const phone = new MediaQuery('(max-width: 640px)');
	let search = $state<GoToFile>();
	let closeButton = $state<HTMLButtonElement | null>(null);
	let showHidden = $state(false);
	let expanded = $state.raw(new Set<string>());
	let listings = $state.raw(new Map<string, FileListing>());
	let folderProblems = $state.raw(new Set<string>());
	const requests = new Set<string>();
	let directory = $state(untrack(() => parentFolder(file.path)));
	let revealedPath = $state<string>();
	let result = $state.raw<ReadFile>();
	let resultPath = $state<string>();
	let readError = $state('');
	let copyStatus = $state('');
	let retry = $state(0);
	const root = $derived(file.root);
	const rootKey = $derived(codeRootKey(root));
	const currentListing = $derived(listings.get(folderKey(root, phone.current ? directory : '', showHidden)));
	const folderError = $derived(folderProblems.has(folderKey(root, phone.current ? directory : '', showHidden)));
	const rows = $derived(treeRows(phone.current ? directory : '', path => listings.get(folderKey(root, path, showHidden)), phone.current ? new Set() : expanded));
	const truncated = $derived(currentListing?.truncated || rows.some(row => expanded.has(row.path) && listings.get(folderKey(root, row.path, showHidden))?.truncated));
	const preview = $derived(result && resultPath === file.path ? fileReadState(result) : undefined);
	const language = $derived(codeLanguageForPath(file.path));
	const crumbs = $derived((file.path ? parentFolder(file.path) : directory).split('/').filter(Boolean));
	const choices = $derived(roots.some(choice => codeRootKey(choice.root) === rootKey) ? roots : [...roots, { root, label: rootKey }]);

	async function list(path: string) {
		const requestedRoot = root, hidden = showHidden, key = folderKey(requestedRoot, path, hidden);
		if (requests.has(key) || listings.has(key)) return;
		requests.add(key);
		try {
			const listing = await client.listFiles(projectId, requestedRoot, path, hidden);
			listings = new Map(listings).set(key, listing);
			if (folderProblems.has(key)) { const next = new Set(folderProblems); next.delete(key); folderProblems = next; }
		} catch { folderProblems = new Set([...folderProblems, key]); }
		finally { requests.delete(key); }
	}
	$effect(() => {
		const path = phone.current ? directory : '';
		rootKey; showHidden;
		const children = phone.current ? [] : [...expanded];
		untrack(() => { void list(path); for (const folder of children) void list(folder); });
	});
	$effect(() => {
		const path = file.path;
		if (untrack(() => revealedPath !== path)) revealedPath = undefined;
	});
	$effect(() => {
		const {path, root: requestedRoot} = file, show = revealedPath === file.path;
		retry;
		result = undefined; readError = ''; copyStatus = '';
		if (!path) return;
		let stopped = false;
		void client.readFile(projectId, requestedRoot, path, show).then(row => { if (!stopped) { resultPath = path; result = row; } }, error => {
			if (!stopped) readError = error instanceof Error ? error.message : 'Could not open this file.';
		});
		return () => { stopped = true; };
	});
	function pick(path: string) { revealedPath = undefined; directory = parentFolder(path); onselect({ root, path }); }
	function browse(path: string) { directory = path; if (file.path) pickFolder(); }
	function pickFolder() { revealedPath = undefined; onselect({ root, path: '' }); }
	function activate(row: FileTreeRow) {
		if (row.entry.kind !== 'dir') { pick(row.path); return; }
		if (phone.current) { directory = row.path; return; }
		if (expanded.has(row.path)) collapse(row);
		else expanded = new Set([...expanded, row.path]);
	}
	function collapse(row: FileTreeRow) { const next = new Set(expanded); next.delete(row.path); expanded = next; }
	function shortcut(event: KeyboardEvent) {
		if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'p') return;
		event.preventDefault(); search?.focus();
	}
	async function copyLink(line: number) {
		copyStatus = await copyText(new URL(linkFor({ ...file, line }), location.href).href) ? 'Link copied.' : 'Could not copy the link.';
	}
</script>

<Dialog.Root open onOpenChange={open => { if (!open) onclose(); }}>
	<Dialog.Content showCloseButton={false} data-project-files onkeydown={shortcut}
		onOpenAutoFocus={event => { event.preventDefault(); if (autofocusSearch) search?.focus(); else closeButton?.focus(); }}
		class="inset-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 ring-0 sm:max-w-none motion-reduce:animate-none">
		<header class="files-header">
			<Button bind:ref={closeButton} size="icon" variant="ghost" aria-label="Close files" onclick={onclose}><X /></Button>
			<nav aria-label="Code view" class="tabs">{#if changesHref}<a href={changesHref}>Changes</a>{/if}<span aria-current="page">Files</span></nav>
			<Dialog.Title class="min-w-0 flex-1 truncate text-sm font-semibold">{projectName}</Dialog.Title>
			<label><span class="sr-only">Checkout root</span><select aria-label="Checkout root" value={rootKey} onchange={event => {
				const choice = choices.find(choice => codeRootKey(choice.root) === event.currentTarget.value);
				if (choice) onselect({ root: choice.root, path: '' });
			}}>{#each choices as choice (codeRootKey(choice.root))}<option value={codeRootKey(choice.root)}>{choice.label}</option>{/each}</select></label>
		</header>
		<Dialog.Description class="sr-only">Browse this checkout without changing it. Control or Command P finds a file.</Dialog.Description>
		<div class="files-body">
			<aside class:reading={!!file.path && phone.current} class="file-rail" aria-label="Browse checkout">
				<div class="rail-controls">
					<GoToFile bind:this={search} {client} {projectId} {root} onselect={pick} autocue={autofocusSearch} />
					{#if !file.path || !phone.current}<label class="hidden-toggle"><input type="checkbox" bind:checked={showHidden} />Show hidden</label>{/if}
				</div>
				{#if !file.path || !phone.current}
					{#if phone.current && directory}<div class="folder-back"><Button size="sm" variant="ghost" onclick={() => directory = parentFolder(directory)}>← {parentFolder(directory).split('/').at(-1) || 'Root'}</Button><span class="truncate">{directory}</span></div>{/if}
					{#if folderError}<p class="listing-note" role="alert">Could not list this folder. <button class="underline" onclick={() => void list(phone.current ? directory : '')}>Retry</button></p>
					{:else if !currentListing}<p class="listing-note" role="status">Reading folder…</p>
					{:else if !rows.length}<p class="listing-note">This folder is empty.</p>{/if}
					{#if truncated}<p class="listing-note" role="status">Only the first 1,000 entries per folder are shown.</p>{/if}
					<FileTree {rows} {expanded} selected={file.path} phone={phone.current} onactivate={activate} oncollapse={collapse} />
				{/if}
			</aside>
			{#if file.path}
				<section class="file-content" aria-label="Open file">
					<div class="file-heading">
						<nav aria-label="File breadcrumb"><button onclick={() => browse('')}>Root</button>{#each crumbs as crumb, index}<span aria-hidden="true">/</span><button onclick={() => browse(crumbs.slice(0, index + 1).join('/'))}>{crumb}</button>{/each}<span aria-hidden="true">/</span><strong title={file.path}>{file.path.split('/').at(-1)}</strong></nav>
						<p>{language}{result ? ` · ${formatBytes(result.size)}` : ''} <span>Read-only</span></p>
					</div>
					{#if readError}<div class="file-note" role="alert">{readError} <Button variant="outline" size="sm" onclick={() => retry++}>Retry</Button></div>
					{:else if !preview}<p class="file-note" role="status">Reading file…</p>
					{:else if preview.kind === 'sensitive'}<div class="file-note"><strong>Hidden by default</strong><p>This filename may contain sensitive material.</p><Button variant="outline" onclick={() => revealedPath = file.path}>Show</Button></div>
					{:else if preview.kind === 'binary'}<p class="file-note">Binary file · {preview.mimeType}</p>
					{:else if preview.kind === 'too-large'}<p class="file-note">Too large to preview · {formatBytes(preview.size)}</p>
					{:else if preview.kind === 'text'}{#key file.path}<CheckoutText {file} hash={preview.hash} text={preview.text} {backendId} {projectId} {taskId} {threadId} {client} markdown={language === 'markdown'} {onquote} oncopylink={line => void copyLink(line)} {onclose} />{/key}
					{:else}<p class="file-note">No text preview is available.</p>{/if}
					{#if copyStatus}<p class="sr-only" role="status">{copyStatus}</p>{/if}
				</section>
			{:else if !phone.current}<div class="file-content file-note">Choose a file from the tree or use Go to file.</div>{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>

<style>
	.files-header { display:flex; align-items:center; gap:8px; padding:6px 10px; border-bottom:1px solid transparent; border-image:var(--chat-grad) 1; background:var(--chat-surface); }
	.files-header select { max-width:min(35vw,20rem); min-height:34px; padding:0 8px; border:1px solid var(--chat-border); border-radius:7px; background:var(--chat-bg); font-size:12px; }
	.tabs { display:flex; border:1px solid var(--chat-border); border-radius:8px; padding:2px; background:var(--chat-surface-2); }
	.tabs > * { padding:4px 8px; border-radius:5px; font-size:12px; }
	.tabs [aria-current] { background:var(--chat-bg); font-weight:700; }
	.files-body { flex:1; min-height:0; display:flex; }
	.file-rail { flex:0 0 clamp(13rem,23vw,18rem); min-height:0; overflow:auto; border-inline-end:1px solid var(--chat-border); background:var(--chat-surface); }
	.rail-controls { padding:8px; }
	.hidden-toggle { display:flex; align-items:center; gap:6px; min-height:28px; margin-top:2px; font-size:12px; }
	.hidden-toggle input { accent-color:var(--accent-2); }
	.file-content { display:flex; flex:1; flex-direction:column; min-width:0; min-height:0; }
	.file-heading { padding:5px 12px; border-bottom:1px solid var(--chat-border); }
	.file-heading nav, .folder-back { display:flex; align-items:center; gap:6px; min-width:0; overflow:auto; font:12px var(--font-mono); }
	.file-heading nav > * { flex:none; }
	.file-heading nav button { padding:4px; color:var(--chat-fg-muted); text-decoration:underline; }
	.file-heading p { color:var(--chat-fg-muted); font-size:11px; }
	.file-heading p span { margin-inline-start:4px; padding:1px 5px; border:1px solid var(--chat-border); border-radius:5px; }
	.listing-note, .file-note { padding:12px; color:var(--chat-fg-muted); }
	.file-note :global(button) { width:fit-content; margin-top:6px; }
	@media(max-width:640px) {
		.files-header { flex-wrap:wrap; } .files-header > label { width:100%; } .files-header select { max-width:100%; width:100%; min-height:44px; }
		.files-header :global(button), .hidden-toggle, .file-heading button, .file-note :global(button) { min-height:44px; }
		.files-body { flex-direction:column; } .file-rail { flex:1; border-inline-end:0; } .file-rail.reading { flex:none; overflow:visible; }
		.folder-back { padding:0 8px; } .folder-back :global(button) { min-height:44px; }
	}
</style>
