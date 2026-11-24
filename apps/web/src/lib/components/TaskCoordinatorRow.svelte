<script lang="ts">
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import type { BoardTask } from '@kemiri/protocol';
	import { useCoordinatorTaskView } from '#lib/coordinator-task-view.js';
	import { taskCoordinator } from '#lib/coordinators.js';
	import type { ProjectBoard } from '#lib/board.svelte.js';
	import CoordinatorMark from './CoordinatorMark.svelte';
	import TaskCoordinatorPicker from './TaskCoordinatorPicker.svelte';
	let { task, board, compact }: { task: BoardTask; board: ProjectBoard | undefined; compact: boolean } = $props();
	const getTaskView = useCoordinatorTaskView();
	const view = $derived(getTaskView?.());
	const owner = $derived(view?.roster.find(row => row.id === taskCoordinator(task)));
	const label = $derived(owner?.title ?? taskCoordinator(task));
	let picked = $state<BoardTask>();
	export function canMove(): boolean { return !!view && !!board && !task.archived; }
	export function openPicker(): void { if (canMove()) picked = task; }
</script>
{#if view && board}
	<div class={compact ? 'min-w-0 max-w-full' : 'flex shrink-0 items-center gap-2 border-b border-(--chat-border) px-4 py-1.5 text-xs'}>
		{#if !compact}<span class="font-semibold text-(--chat-fg-muted)">Coordinator</span>{/if}
		{#if !task.archived}
			<button class={compact ? 'task-meta-chip' : 'flex items-center gap-1.5 rounded-lg px-2 py-1 font-medium hover:bg-(--chat-surface-2)'} aria-label={`Move to coordinator · ${label}`} onclick={openPicker}>
				{#if owner}<CoordinatorMark thread={owner} />{/if}
				<span class="truncate">{label}</span>
				{#if compact}<ChevronDownIcon class="size-3 shrink-0" aria-hidden="true" />{:else}<span aria-hidden="true">▾</span>{/if}
			</button>
		{:else}<span class:task-meta-chip={compact}>{label}</span>{/if}
	</div>
	{#if picked && picked.id === task.id}<TaskCoordinatorPicker task={picked} {board} roster={view.roster} onclose={() => picked = undefined} />{/if}
{/if}
