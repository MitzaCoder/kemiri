<script lang="ts">
	import OverviewIcon from '@lucide/svelte/icons/layout-dashboard';
	import CoordinatorOverview from './CoordinatorOverview.svelte';
	import ListIcon from '@lucide/svelte/icons/list';
	import KanbanIcon from '@lucide/svelte/icons/square-kanban';
	import NetworkIcon from '@lucide/svelte/icons/network';
	import TaskGraph from '#lib/components/TaskGraph.svelte';
	import TaskBoard from '#lib/components/TaskBoard.svelte';
	import TasksPanel from '#lib/components/TasksPanel.svelte';
	import type { ProjectBoard } from '#lib/board.svelte.js';
	import type { TasksViewMode } from '#lib/kanban.js';
	import { tasksView } from '#lib/tasks-view.svelte.js';
	import type { Overview, ThreadSummary, WorkerSummary } from '@kemiri/protocol';

	/**
	 * The full-width Tasks view: list, board, graph or overview, with a switch this device remembers. The sidebar
	 * at its usual width always shows the list; this view is the sidebar expanded, or its sheet on a narrow screen.
	 */
	let {
		board,
		workers = [],
		graphWorkers = workers,
		selectedTaskId = null,
		scope,
		backendId,
		projectId,
		threads = [],
		workerHref,
		taskHref, supportsOverview, overview, overviewError, roster, questionHref, coordinatorHref, oncoordinator,
		canNote,
		onsendreason
	}: {
		board: ProjectBoard | undefined;
		workers?: readonly WorkerSummary[];
		graphWorkers?: readonly WorkerSummary[];
		selectedTaskId?: string | null;
		scope: string;
		backendId: string;
		projectId: string;
		threads?: readonly ThreadSummary[];
		workerHref?: (worker: WorkerSummary) => string;
		taskHref: (taskId: string) => string;
		supportsOverview: boolean;
		overview?: Overview;
		overviewError?: string;
		roster: readonly ThreadSummary[];
		questionHref: (id: string) => string;
		coordinatorHref: (id: string) => string;
		oncoordinator: (id: string, event: MouseEvent) => void;
		canNote: boolean;
		onsendreason?: (taskId: string, text: string) => Promise<void>;
	} = $props();

	const MODES: { mode: TasksViewMode; label: string; icon: typeof ListIcon }[] = [
		{ mode: 'list', label: 'List', icon: ListIcon },
		{ mode: 'board', label: 'Board', icon: KanbanIcon },
		{ mode: 'graph', label: 'Graph', icon: NetworkIcon },
		{ mode: 'overview', label: 'Overview', icon: OverviewIcon }
	];
	const mode = $derived(!supportsOverview && tasksView.mode === 'overview' ? 'list' : tasksView.mode);
</script>

{#snippet viewSwitch()}
	<div class="inline-flex h-7 items-center gap-0.5 rounded-lg bg-(--chat-surface-2)/70 p-0.5" role="group" aria-label="Show the tasks as">
		{#each MODES.filter(entry => supportsOverview || entry.mode !== 'overview') as entry (entry.mode)}
			{@const selected = mode === entry.mode}
			<button
				type="button"
				class="inline-flex h-6 items-center gap-1 rounded-md px-1.5 sm:gap-1.5 sm:px-2 text-xs font-semibold transition-colors {selected
					? 'bg-(--chat-bg) text-(--chat-fg) shadow-sm'
					: 'text-(--chat-fg-subtle) hover:text-(--chat-fg)'}"
				aria-pressed={selected}
				data-tasks-view={entry.mode}
				onclick={() => tasksView.set(entry.mode)}
			>
				<entry.icon class="hidden size-3.5 min-[420px]:block" />{entry.label}
			</button>
		{/each}
	</div>
{/snippet}

{#if mode === 'overview'}
	<div class="shrink-0 border-b border-(--chat-border) px-3 py-2">{@render viewSwitch()}</div>
	<CoordinatorOverview snapshot={overview} board={board?.board} {roster} error={overviewError} {taskHref} {questionHref} {coordinatorHref} {oncoordinator} />
{:else if mode === 'board'}
	<TaskBoard {board} {workers} {threads} {workerHref} {taskHref} {canNote} {onsendreason} {viewSwitch} />
{:else if mode === 'graph'}
	{#key scope}<TaskGraph {board} {scope} {backendId} {projectId} {selectedTaskId} workers={graphWorkers} {threads} {taskHref} {viewSwitch} />{/key}
{:else}
	<TasksPanel {board} {threads} {workers} {workerHref} {taskHref} toolbarStart={viewSwitch} />
{/if}
