<script lang="ts">
	import ArrowDownWideNarrowIcon from '@lucide/svelte/icons/arrow-down-wide-narrow';
	import ArrowUpWideNarrowIcon from '@lucide/svelte/icons/arrow-up-wide-narrow';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import type { BoardTask, BoardTaskSnapshot, BoardWriter } from '@kemiri/protocol';
	import type { ProjectBoard } from '#lib/board.svelte.js';
	import { exactTime } from '#lib/relative-time.js';
	import { activityDays, activityText, taskActivityRows, type ActivityRow } from '#lib/task-record.js';
	import { timelineOrder } from '#lib/timeline-order.svelte.js';
	import { timelineClock } from '#lib/timeline-groups.js';
	import TaskSnapshotDetail from './TaskSnapshotDetail.svelte';
	import TaskLiveLine from './TaskLiveLine.svelte';
	import { visibleLiveLines } from '#lib/task-live.js';

	let { board, task, sources, loading, error, writerName, workerHref, taskHref }: {
		board: ProjectBoard | undefined;
		task: BoardTask;
		sources: Omit<Parameters<typeof taskActivityRows>[0], 'snapshots'>;
		loading: boolean;
		error: string | undefined;
		writerName: (writer: BoardWriter) => string;
		workerHref: (id: string) => string | undefined;
		taskHref: (id: string) => string;
	} = $props();

	let snapshots = $state<BoardTaskSnapshot[]>([]);
	let snapshotsLoading = $state(false);
	let snapshotError = $state<string>();
	$effect(() => {
		const id = task.id;
		if (!board || !task.snapshots) return;
		let cancelled = false;
		snapshotsLoading = true;
		board.history(id).then(read => {
			if (!cancelled) { snapshots = read; snapshotError = undefined; }
		}).catch(cause => {
			if (!cancelled) snapshotError = cause instanceof Error ? cause.message : String(cause);
		}).finally(() => { if (!cancelled) snapshotsLoading = false; });
		return () => { cancelled = true; };
	});
	const previousSnapshot = $derived(new Map(snapshots.map((snapshot, index) => [snapshot.seq, snapshots[index - 1]])));
	const pageSize = 6;
	let limit = $state(pageSize);
	const rows = $derived(taskActivityRows({ ...sources, snapshots }));
	const days = $derived(activityDays(rows, timelineOrder.order, limit));
</script>

{#snippet activityLine(row: ActivityRow)}
	{#if row.at}<time class="activity-time" datetime={row.at} title={exactTime(row.at)}>{timelineClock(row.at)}</time>{:else}<span class="activity-time" aria-hidden="true">—</span>{/if}
	<span class="min-w-0 {row.live ? '[overflow-wrap:anywhere]' : 'truncate'}" title={activityText(row.label)}>{#if row.now}<span class="font-semibold">Now · </span>{/if}{activityText(row.label)}</span>
{/snippet}

<div class="flex flex-col gap-2" data-task-activity>
	{#if error || snapshotError}<p class="text-xs text-(--chat-danger)" role="alert">{error ?? snapshotError}</p>{/if}
	{#if rows.length > 0}
		<div class="flex items-center justify-between gap-2 text-xs text-(--chat-fg-muted)">
			<span>{rows.length} {rows.length === 1 ? 'event' : 'events'}</span>
			<button type="button" class="inline-flex size-11 items-center justify-center rounded-lg hover:bg-(--chat-surface-2)" aria-label={timelineOrder.order === 'newest' ? 'Newest first; show oldest first' : 'Oldest first; show newest first'} title={timelineOrder.order === 'newest' ? 'Newest first' : 'Oldest first'} onclick={() => { timelineOrder.toggle(); limit = pageSize; }} data-timeline-order>
				{#if timelineOrder.order === 'newest'}<ArrowDownWideNarrowIcon class="size-4" />{:else}<ArrowUpWideNarrowIcon class="size-4" />{/if}
			</button>
		</div>
		{#each days as { day, entries } (day)}
			<div>
				<h4 class="mb-1 text-xs font-semibold text-(--chat-fg-muted)">{day}</h4>
				<ul role="list" class="divide-y divide-(--chat-border)">
					{#each entries as row (row.id)}
						{@const worker = row.workerId ? workerHref(row.workerId) : undefined}
						{@const href = row.taskId ? taskHref(row.taskId) : worker}
						<li>
							{#if row.live || row.snapshot || row.detail || (row.fact && row.fact.endAt !== row.fact.at) || row.label.length > 42}
								<details>
									<summary class="activity-line cursor-pointer">
										{@render activityLine(row)}<ChevronRightIcon class="activity-chevron ml-auto size-4 shrink-0" aria-hidden="true" />
									</summary>
									<div class="flex flex-col gap-2 pb-3 pl-2 text-sm">
										{#if row.snapshot}
											<TaskSnapshotDetail {task} snapshot={row.snapshot} before={previousSnapshot.get(row.snapshot.seq)} {writerName} />
										{:else}
											{#if row.fact && row.fact.endAt !== row.fact.at}<p class="text-xs text-(--chat-fg-muted)">Started {exactTime(row.fact.at)}</p>{/if}
											{#if row.live}
												<ul role="list" class="flex flex-col gap-1">
													{#each visibleLiveLines(row.live.lines) as line (line.id)}<TaskLiveLine {line} />{/each}
												</ul>
											{/if}
											{#if row.detail || !row.live}<p>{activityText(row.detail || row.label)}</p>{/if}
										{/if}
										{#if href}<a {href} class="underline">{worker ? 'Open worker' : 'Open linked task'}</a>{/if}
									</div>
								</details>
							{:else if href}<a {href} class="activity-line underline">{@render activityLine(row)}</a>
							{:else}<div class="activity-line">{@render activityLine(row)}</div>{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/each}
		{#if limit < rows.length}
			<button type="button" class="min-h-11 self-start text-sm underline" onclick={() => { limit += pageSize; }}>Show more activity</button>
		{/if}
	{:else if loading || snapshotsLoading}<p class="text-sm text-(--chat-fg-muted)" role="status">Loading activity…</p>
	{:else if !error && !snapshotError}<p class="text-sm text-(--chat-fg-muted)">No activity recorded yet.</p>{/if}
</div>

<style>
	.activity-line { display: flex; align-items: center; gap: 0.5rem; min-height: 2.25rem; font-size: 0.875rem; }
	.activity-line::-webkit-details-marker { display: none; }
	details[open] > summary > :global(.activity-chevron) { transform: rotate(90deg); }
	.activity-time { min-width: 4.75rem; flex: none; color: var(--chat-fg-muted); font-size: 0.75rem; font-variant-numeric: tabular-nums; }
</style>
