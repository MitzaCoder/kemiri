<script lang="ts">
	import { openWorkingChanges } from '#lib/code/working-changes-navigation.js';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import type { BackendConnection } from '#lib/harness.svelte.js';
	import type { WorkerSummary, ThreadSummary } from '@kemiri/protocol';
	import { fileFromUrl, codeRootKey, withFile } from '#lib/code/file-location.js';
	import { closeFiles, selectFileLocation, type FilesNavigation } from '#lib/code/files-navigation.svelte.js';
	import { fileRootChoices } from '#lib/code/files-view.js';
	import { changesFromUrl, withChanges } from '#lib/code/project-changes.js';
	import { taskFromUrl } from '#lib/tasks.js';
	import { draftKey } from '#lib/drafts.js';
	import { moveReviewToDraft } from '#lib/artifact-review-draft.js';
	import { projectHref, threadHref } from '#lib/backends.js';
	let { backend, projectId, projectName, repository, navigation, workers = [], threads = [], threadId, onquote }: {
		backend: BackendConnection; projectId: string; projectName: string; repository?: boolean; navigation: FilesNavigation;
		workers?: readonly WorkerSummary[]; threads?: readonly ThreadSummary[]; threadId?: string; onquote?: (quote: string) => void;
	} = $props();
	const file = $derived(navigation.available() ? fileFromUrl(page.url) : undefined);
	const taskId = $derived(taskFromUrl(page.url) ?? undefined);
	const roots = $derived(fileRootChoices(projectName, workers, threads));
	const explicitChanges = $derived(changesFromUrl(page.url));
	let hasTaskChanges = $state(false);
	$effect(() => {
		const task = taskId;
		hasTaskChanges = false;
		if (!file || explicitChanges || !task || !backend.features?.includes('project-changes')) return;
		let stale = false;
		void backend.client.listChanges(projectId, { kind: 'task', taskId: task }).then(list => { if (!stale) hasTaskChanges = list.commits.length > 0; }, () => {});
		return () => { stale = true; };
	});
	const changesHref = $derived(explicitChanges ? withFile(page.url) : hasTaskChanges && taskId ? withChanges(new URL(withFile(page.url), page.url.href), {kind:'task',taskId}) : undefined);
	function shortcut(event: KeyboardEvent) {
		if (event.defaultPrevented || file || !navigation.available() || !(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'p') return;
		event.preventDefault(); void navigation.open('', undefined, true);
	}
	function quote(text: string) {
		if (onquote) { onquote(text); return; }
		const recipient = taskId ? undefined : threadId;
		moveReviewToDraft(localStorage, window, draftKey(backend.id, projectId, recipient), text.split('\n').map(line => `> ${line}`).join('\n'), taskId);
		void goto(recipient ? threadHref(backend.id, projectId, recipient) : projectHref(backend.id, projectId), { reset: false });
	}
</script>
<svelte:window onkeydown={shortcut} />
{#if file}
	{#await import('./ProjectFiles.svelte') then {default: ProjectFiles}}
		{#key `${backend.id}:${projectId}:${codeRootKey(file.root)}`}
			<ProjectFiles {file} client={backend.client} backendId={backend.id} {projectId} {projectName} {roots} {taskId} {threadId}
				{changesHref} onworking={backend.features?.includes('project-changes-working') && (file.root.kind !== 'project' || repository !== false) ? () => void openWorkingChanges(file.root) : undefined} autofocusSearch={page.state.searchFiles === true} onselect={file => void selectFileLocation(file)} onclose={closeFiles} onquote={quote} linkFor={file => withFile(page.url, file)} />
		{/key}
	{:catch}<div class="fixed inset-x-0 top-0 z-[60] bg-(--chat-surface) p-3" role="alert">Could not load Files. <button class="underline" onclick={closeFiles}>Close</button></div>{/await}
{/if}
