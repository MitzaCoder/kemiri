<script lang="ts">
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import type { BackendConnection } from '#lib/harness.svelte.js';
	import type { ProjectBoard } from '#lib/board.svelte.js';
	import type { WorkerSummary, ThreadSummary } from '@kemiri/protocol';
	import type { FilesNavigation } from '#lib/code/files-navigation.svelte.js';
	import { fileFromUrl, codeRootKey } from '#lib/code/file-location.js';
	import { changeSourceKey, changesFromUrl, withChanges } from '#lib/code/project-changes.js';
	import { taskFromUrl } from '#lib/tasks.js';
	let { backend, projectId, projectName, repository, board, navigation, threadId, workers = [], threads = [] }: {
		backend: BackendConnection; projectId: string; projectName: string; repository?: boolean; board?: ProjectBoard;
		navigation: FilesNavigation; threadId?: string; workers?: readonly WorkerSummary[]; threads?: readonly ThreadSummary[];
	} = $props();
	const source = $derived(changesFromUrl(page.url));
	const filesShown = $derived(navigation.available() && !!fileFromUrl(page.url));
	const working = $derived(source?.kind === 'working' ? source.root : undefined);
	const available = $derived(working ? backend.features?.includes('project-changes-working') : backend.features?.includes('project-changes'));
	const rootName = $derived(working?.kind === 'worker' ? workers.find(worker => worker.id === working?.workerId)?.title ?? codeRootKey(working)
		: working?.kind === 'thread' ? threads.find(thread => thread.id === working?.threadId)?.title ?? codeRootKey(working) : projectName);
	function close() {
		const back = withChanges(page.url);
		if (page.state.changesFrom === back) history.back();
		else void goto(back, { replace: true, reset: false, persistState: true, state: page.state });
	}
</script>
{#if source && !filesShown}
	{#if available}
		{#await import('./ProjectChanges.svelte') then { default: ProjectChanges }}
			{#key `${backend.id}:${projectId}:${changeSourceKey(source)}`}
				<ProjectChanges backendId={backend.id} client={backend.client} {projectId} repository={working?.kind === 'project' || !working ? repository : undefined} {source} {rootName}
					taskId={taskFromUrl(page.url) ?? undefined} sourceThreadId={working?.kind === 'thread' ? working.threadId : threadId}
					taskTitle={source.kind === 'task' ? board?.task(source.taskId)?.title : undefined} onclose={close}
					onfiles={navigation.available() ? () => void navigation.open('', undefined, false, working) : undefined} />
			{/key}
		{:catch}
			<div class="fixed inset-x-0 top-0 z-[60] flex items-center justify-between bg-(--chat-surface) p-4" role="alert">Could not load Changes. <button type="button" class="underline" onclick={close}>Close</button></div>
		{/await}
	{:else if working && backend.features !== undefined}
		<div class="fixed inset-x-0 top-0 z-[60] flex items-center justify-between bg-(--chat-surface) p-4" role="status">Uncommitted changes are not available on this backend. <button type="button" class="underline" onclick={close}>Close</button></div>
	{/if}
{/if}
