<script lang="ts">
	import type { ArtifactTaskFacts } from '@kemiri/protocol';
	import type { BackendConnection } from '#lib/harness.svelte.js';
	import { supportsArtifactLibrary } from '#lib/artifact-library.svelte.js';
	import { libraryDate } from '#lib/artifact-library.js';
	import { useArtifactFeed } from '#lib/artifacts.svelte.js';
	import { taskStatusWords } from '#lib/tasks.js';
	let { backend, projectId, artifactId, taskId, ontoggle }: { backend: BackendConnection; projectId: string; artifactId: string; taskId?: string; ontoggle: (id?: string) => void } = $props();
	const feed = useArtifactFeed(() => ({ client: backend.client, projectId, filter: { artifactId } }));
	let task = $state<ArtifactTaskFacts>();
	let homeId = $state<string>();
	let decisions = $state<number>();
	let comments = $state<number>();
	const home = $derived(homeId ?? feed.current?.artifacts.find(row => row.id === artifactId)?.taskId ?? taskId);
	$effect(() => {
		task = undefined; homeId = undefined; decisions = undefined; comments = undefined;
		if (!backend.ready) return;
		let active = true;
		if (supportsArtifactLibrary(backend)) void backend.client.readArtifactTrail(projectId, artifactId).then(trail => {
			if (!active) return;
			homeId = trail.artifact.taskId ?? undefined;
			const folder = trail.tasks.find(folder => folder.id === homeId);
			task = folder;
			decisions = folder?.decisions.length;
			comments = trail.comments.length;
		}).catch(() => {});
		else {
			const id = feed.current?.artifacts.find(row => row.id === artifactId)?.taskId ?? taskId;
			if (id) void backend.client.readBoard(projectId, { includeArchived: true }).then(board => {
				if (!active) return;
				const row = board.tasks.find(task => task.id === id);
				if (row) task = { ...row, projectId };
				decisions = board.decisions.filter(decision => decision.taskId === id).length;
			}).catch(() => {});
		}
		return () => { active = false; };
	});
</script>
{#if home}
	<label class="flex cursor-pointer items-start gap-2 rounded-lg border border-dashed border-(--chat-border) px-2 py-1.5 text-xs text-(--chat-fg-muted)" data-discussion-folder>
		<input type="checkbox" class="mt-0.5 size-4 shrink-0 accent-(--accent-2)" checked={taskId === home} onchange={event => ontoggle(event.currentTarget.checked ? home : undefined)} />
		<span><strong class="block font-semibold text-(--chat-fg)">Bring its task folder</strong>
			<span>Its task folder: {task?.title ?? home}{task ? `, ${taskStatusWords(task.status).toLowerCase()}${task.settledAt ? ` ${libraryDate(task.settledAt)}` : ''}` : ''}. It holds the task report{decisions === undefined ? '' : `, ${decisions} ${decisions === 1 ? 'decision' : 'decisions'}`}{comments === undefined ? '' : ` and ${comments} earlier ${comments === 1 ? 'comment' : 'comments'}`}.</span>
		</span>
	</label>
{/if}
