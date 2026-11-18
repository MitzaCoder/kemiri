<script lang="ts">
	import { tick } from 'svelte';
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import CheckIcon from '@lucide/svelte/icons/check';
	import TaskIdChip from '../TaskIdChip.svelte';
	import { blockersOf } from '#lib/board.js';
	import type { ProjectBoard } from '#lib/board.svelte.js';
	import { canKeepOnTask, keepOnTask, taskFeedbackAnchor, type ReplyTaskMentions } from '#lib/chat/keep-on-task.js';
	import type { BackendConnection } from '#lib/harness.svelte.js';
	import { taskDetailState, taskNeedsYou } from '#lib/task-details.js';
	import { taskDisplayToneClass } from '#lib/tasks.js';
	import type { BoardTask } from '@kemiri/protocol';

	let { mentions, backend, projectId, board, hrefOf }: {
		mentions: ReplyTaskMentions;
		backend: BackendConnection;
		projectId: string;
		board: ProjectBoard | undefined;
		hrefOf: (taskId: string) => string;
	} = $props();
	const cards = $derived(mentions.taskIds.flatMap(id => {
		const task = board?.task(id);
		return task && !task.archived ? [task] : [];
	}));
	const visibleCount = 3;
	let kept = $state<Record<string, { pending?: boolean; feedbackId?: string; error?: string }>>({});

	function stateLabel(task: BoardTask): string {
		const needs = taskNeedsYou(task, board?.board?.questions ?? [], blockersOf(task, board?.tasks ?? []).some(blocker => !blocker.settled), backend.supports('task-steps'));
		return taskDetailState(task.status, needs, task.state?.kind);
	}

	async function keep(task: BoardTask, button: HTMLButtonElement): Promise<void> {
		if (kept[task.id]?.pending || kept[task.id]?.feedbackId || !canKeepOnTask(backend.supports('keep-on-task'), task)) return;
		kept[task.id] = { pending: true };
		try {
			const feedbackId = await keepOnTask(backend.client, projectId, task.id, mentions.reply);
			const restoreFocus = document.activeElement === button;
			const card = button.closest('[data-reply-task]');
			kept[task.id] = { feedbackId };
			await tick();
			if (restoreFocus) card?.querySelector<HTMLElement>('[data-kept-note]')?.focus({ preventScroll: true });
		} catch (error) {
			kept[task.id] = { error: error instanceof Error ? error.message : String(error) };
		}
	}
</script>

{#snippet card(task: BoardTask)}
	{@const status = kept[task.id]}
	<article class="rounded-xl border border-(--chat-border) bg-(--chat-surface) px-3 py-1" data-reply-task={task.id}>
		<div class="flex min-w-0 flex-wrap items-center justify-between gap-x-3">
			<a href={hrefOf(task.id)} class="group flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md py-1.5 focus-visible:outline-2 focus-visible:outline-(--chat-ring)">
				<div class="min-w-0 flex-1">
					<div class="flex flex-wrap items-baseline gap-x-1.5">
						<span class="text-sm font-semibold break-words group-hover:underline">{task.title}</span><TaskIdChip taskId={task.id} />
					</div>
					<span class="inline-flex items-center gap-1.5 text-xs text-(--chat-fg-muted) {taskDisplayToneClass(task)}"><span class="task-status-dot" aria-hidden="true"></span>{stateLabel(task)}</span>
				</div>
				<ArrowUpRightIcon class="size-3.5 shrink-0 text-(--chat-fg-muted)" aria-hidden="true" />
			</a>
			{#if status?.feedbackId}
				<a data-kept-note href="{hrefOf(task.id)}#{taskFeedbackAnchor(status.feedbackId)}" class="inline-flex min-h-11 items-center gap-1.5 rounded-md text-xs font-medium text-(--chat-fg-muted) hover:underline focus-visible:outline-2 focus-visible:outline-(--chat-ring)">
					<CheckIcon class="size-3.5" aria-hidden="true" />Kept on task<span class="sr-only">: open the note for {task.title}</span>
				</a>
			{:else if canKeepOnTask(backend.supports('keep-on-task'), task)}
				<button type="button" class="min-h-11 shrink-0 rounded-md px-2 text-xs font-semibold text-(--accent-2) hover:bg-(--chat-surface-2) focus-visible:outline-2 focus-visible:outline-(--chat-ring) aria-disabled:opacity-70"
					aria-disabled={status?.pending || undefined} onclick={(event) => void keep(task, event.currentTarget)}>
					{status?.pending ? 'Keeping…' : 'Keep on task'}<span class="sr-only">: {task.title}</span>
				</button>
			{/if}
		</div>
		{#if status?.error}<p class="pb-1.5 text-xs text-(--chat-danger)" role="alert">{status.error}</p>{/if}
	</article>
{/snippet}

{#if cards.length}
	<div class="mt-3 flex max-w-xl flex-col gap-2" data-no-task-preview aria-label="Tasks mentioned in this reply" role="group">
		{#each cards.slice(0, visibleCount) as task (task.id)}{@render card(task)}{/each}
		{#if cards.length > visibleCount}
			<details>
				<summary class="min-h-11 cursor-pointer content-center text-sm text-(--chat-fg-muted)">+{cards.length - visibleCount} more</summary>
				<div class="flex flex-col gap-2">{#each cards.slice(visibleCount) as task (task.id)}{@render card(task)}{/each}</div>
			</details>
		{/if}
	</div>
{/if}
