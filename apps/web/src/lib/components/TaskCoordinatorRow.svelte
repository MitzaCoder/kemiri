<script lang="ts">
	import type { BoardTask } from '@kemiri/protocol';
	import { useCoordinatorTaskView } from '#lib/coordinator-task-view.js';
	import { taskCoordinator } from '#lib/coordinators.js';
	import type { ProjectBoard } from '#lib/board.svelte.js';
	import CoordinatorMark from './CoordinatorMark.svelte';
	import TaskCoordinatorPicker from './TaskCoordinatorPicker.svelte';
	let { task, board }: { task: BoardTask; board: ProjectBoard | undefined } = $props();
	const getTaskView = useCoordinatorTaskView();
	const view = $derived(getTaskView?.());
	const owner = $derived(view?.roster.find(row => row.id === taskCoordinator(task)));
	let picked = $state<BoardTask>();
</script>
{#if view && board}
	<div class="flex shrink-0 items-center gap-2 border-b border-(--chat-border) px-4 py-1.5 text-xs">
		<span class="font-semibold text-(--chat-fg-muted)">Coordinator</span>
		{#if !task.archived}
			<button class="flex items-center gap-1.5 rounded-lg px-2 py-1 font-medium hover:bg-(--chat-surface-2)" aria-label={`Move to coordinator · ${owner?.title ?? taskCoordinator(task)}`} onclick={() => picked = task}>{#if owner}<CoordinatorMark thread={owner} />{/if}{owner?.title ?? taskCoordinator(task)} <span aria-hidden="true">▾</span></button>
		{:else}<span>{owner?.title ?? taskCoordinator(task)}</span>{/if}
	</div>
	{#if picked && picked.id === task.id}<TaskCoordinatorPicker task={picked} {board} roster={view.roster} onclose={() => picked = undefined} />{/if}
{/if}
