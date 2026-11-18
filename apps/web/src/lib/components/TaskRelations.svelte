<script lang="ts">
	import TaskDetailText from './TaskDetailText.svelte';
	import ListFilterIcon from '@lucide/svelte/icons/list-filter';
	import TaskStatusBadge from '#lib/components/TaskStatusBadge.svelte';
	import { linkGroups, subtaskFraction, subtaskProgressText } from '#lib/task-relations.js';
	import type { BoardTask, BoardTaskBrief } from '@kemiri/protocol';

	/**
	 * A task's links, grouped by kind and shown from this task's side: what it is a subtask of, its subtasks (with how far
	 * they are), the task it was found while working on and what it led to, what it waits for and blocks, and related
	 * tasks. Each link opens that task. A link to a task that is done, dropped or archived stays, dimmed. "Show with
	 * linked" filters the task list to this task and everything linked to it.
	 */
	let {
		task,
		tasks,
		archivedLinks = [],
		hrefOf,
		blockersInNeedsYou,
		onshowlinked
	}: {
		task: BoardTask;
		/** Every task the board lists, to name a link's target. */
		tasks: readonly BoardTask[];
		/** Archived tasks the board names only by title and status. */
		archivedLinks?: readonly BoardTaskBrief[];
		hrefOf: (taskId: string) => string;
		blockersInNeedsYou: readonly string[];
		onshowlinked?: () => void;
	} = $props();

	const groups = $derived(linkGroups(task, tasks, archivedLinks)
		.map(group => group.kind === 'blockedBy' ? { ...group, items: group.items.filter(item => !blockersInNeedsYou.includes(item.id)) } : group)
		.filter(group => group.items.length > 0));
	const progressText = $derived(subtaskProgressText(task));
	const fraction = $derived(subtaskFraction(task));
</script>

{#if groups.length > 0 || progressText || blockersInNeedsYou.length > 0}
	<div class="flex flex-col gap-3" data-related>
		{#if progressText && !groups.some(group => group.kind === 'subtasks')}
			<p class="task-detail-heading">Subtasks <span class="font-normal tabular-nums">· {progressText}</span></p>
		{/if}
		{#each groups as group (group.kind)}
			<div class="flex flex-col gap-1" data-link-group={group.kind}>
				<p class="task-detail-heading flex flex-wrap items-baseline gap-x-2">
					{group.label}
					{#if group.kind === 'subtasks' && progressText}
						<span class="font-normal text-(--chat-fg-subtle) tabular-nums" data-subtask-progress>{progressText}</span>
					{/if}
				</p>
				{#if group.kind === 'subtasks' && fraction !== undefined}
					<div
						class="h-1.5 overflow-hidden rounded-full bg-(--chat-surface-2)"
						role="progressbar"
						aria-label="Subtasks done"
						aria-valuemin="0"
						aria-valuemax={task.subtaskCount?.total}
						aria-valuenow={task.subtaskCount?.done}
					>
						<div class="h-full rounded-full bg-(--task-status-done)" style="width: {Math.round(fraction * 100)}%"></div>
					</div>
				{/if}
				<ul class="flex flex-col gap-1">
					{#each group.items as item (item.id)}
						<li class="min-w-0">
							<a
								href={hrefOf(item.id)}
								class="task-fact-link relation-row"
								class:relation-closed={item.closed}
								data-link={item.id}
								data-link-closed={item.closed ? 'true' : undefined}
								title={item.archived ? `${item.id} is archived` : undefined}
							>
								<span class="min-w-0" class:line-through={item.status === 'dropped'}><TaskDetailText text={item.title || 'Not on the board'} focusable={false} /></span>
								<span class="task-id-chip">{item.id}</span>
								{#if item.archived}<span class="shrink-0 text-[0.6875rem] text-(--chat-fg-subtle)">archived</span>{/if}
								{#if item.status !== 'unknown'}<TaskStatusBadge status={item.status} class="shrink-0" />{/if}
							</a>
						</li>
					{/each}
				</ul>
			</div>
		{/each}
		{#if onshowlinked}
			<button type="button" class="task-fact-link justify-start text-(--chat-fg-muted) hover:underline" onclick={onshowlinked} data-show-linked
				title="Show this task and everything linked to it in the task list">
				<ListFilterIcon class="size-4" aria-hidden="true" />Show with linked
			</button>
		{/if}
	</div>
{/if}

<style>
	/* Done, dropped and archived targets stay, quieter than the live ones. */
	.relation-closed {
		color: var(--chat-fg-muted);
	}
	.relation-closed:hover,
	.relation-closed:focus-visible {
		color: var(--chat-fg);
	}
</style>
