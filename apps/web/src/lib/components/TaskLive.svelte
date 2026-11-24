<script lang="ts">
	import { untrack } from 'svelte';
	import { liveCounterLabels, type BoardTaskActivity, type BoardTaskLive, type WorkerSummary } from '@kemiri/protocol';
	import { liveSeenKey, liveTrailBelowNow, liveTranscriptWorkers, visitLiveTrail, type LiveNewsActions } from '#lib/task-live.js';
	import { activityMinute } from '#lib/activity-minute.js';
	import { exactTime, relativeTime } from '#lib/relative-time.js';
	import TaskLivePulse from './TaskLivePulse.svelte';
	import TaskLivePlan from './TaskLivePlan.svelte';
	import TaskLiveLine from './TaskLiveLine.svelte';

	let { live, now, backendId, projectId, taskId, news, workers, workerHref }: {
		live: BoardTaskLive; now: BoardTaskActivity; backendId: string; projectId: string; taskId: string;
		news?: LiveNewsActions; workers: readonly WorkerSummary[]; workerHref: (worker: WorkerSummary) => string;
	} = $props();
	const { nowWorker, transcriptWorkers } = $derived(liveTranscriptWorkers(taskId, now, workers));
	const chronological = $derived(liveTrailBelowNow(live.lines, now, !!news));
	const newestFirst = $derived(chronological.toReversed());
	const newestLimit = 3;
	const counters = $derived(liveCounterLabels(live.counters));
	let visibility = $state<DocumentVisibilityState>('hidden');
	let unseen = $state(0);
	let arrived = $state<string[]>([]);
	let visit: ReturnType<typeof visitLiveTrail> | undefined;

	$effect(() => {
		const update = () => { visibility = document.visibilityState; };
		update();
		document.addEventListener('visibilitychange', update);
		return () => document.removeEventListener('visibilitychange', update);
	});
	$effect(() => {
		if (visibility !== 'visible') { visit = undefined; arrived = []; return; }
		const lines = chronological;
		const key = liveSeenKey(backendId, projectId, taskId);
		untrack(() => {
			visit ??= visitLiveTrail({ getItem: key => localStorage.getItem(key), setItem: (key, id) => localStorage.setItem(key, id) }, key);
			const next = visit(lines);
			unseen = next.unseen;
			if (next.arrived.length || arrived.some(id => !lines.some(line => line.id === id))) arrived = next.arrived;
		});
	});
</script>

{#snippet divider()}
	<li class="live-unseen"><span aria-hidden="true">↑</span> New since you looked</li>
{/snippet}

<section class="task-live" aria-label="Live" data-task-live>
	<header class="live-header">
		<h2 class="live-heading">Live</h2>
		{#if transcriptWorkers.length}
			<nav class="live-transcripts" aria-label="Worker transcripts">
				{#each transcriptWorkers as worker (worker.conversationId)}
					<a href={workerHref(worker)} aria-label={`Transcript for ${worker.id}`}>
						{transcriptWorkers.length > 1 ? `Transcript · ${worker.id}` : 'Transcript'}
					</a>
				{/each}
			</nav>
		{/if}
	</header>
	<p class="live-now">
		<strong>Now</strong>
		<span>{#if nowWorker}<a href={workerHref(nowWorker)} aria-label={`Transcript for ${nowWorker.id}`}>{nowWorker.id}</a>{now.text.slice(nowWorker.id.length)}{:else}{now.text}{/if}</span>
		<time datetime={now.since} title={exactTime(now.since)}>{relativeTime(now.since, $activityMinute)}</time>
	</p>
	{#if live.pulse}<TaskLivePulse pulse={live.pulse} />{/if}
	{#if counters.length}
		<ul class="live-counters" aria-label="Run counters" role="list">
			{#each counters as counter (counter)}<li>{counter}</li>{/each}
		</ul>
	{/if}
	{#if live.plan}<TaskLivePlan plan={live.plan} foldOnPhone />{/if}
	{#if newestFirst.length}
		<h3 class="live-heading">So far</h3>
		<ul role="list" class="live-trail">
			{#each newestFirst.slice(0, newestLimit) as line, index (line.id)}
				{#if index > 0 && index === unseen}{@render divider()}{/if}
				<TaskLiveLine {line} {news} arrived={arrived.includes(line.id)} />
			{/each}
			{#if unseen > 0 && unseen === Math.min(newestLimit, newestFirst.length)}{@render divider()}{/if}
		</ul>
		{#if newestFirst.length > newestLimit}
			<details class="live-earlier">
				<summary>Earlier · {newestFirst.length - newestLimit}{#if unseen > newestLimit} · {unseen - newestLimit} new{/if}</summary>
				<ul role="list" class="live-trail">
					{#each newestFirst.slice(newestLimit) as line, index (line.id)}
						{#if index > 0 && index + newestLimit === unseen}{@render divider()}{/if}
						<TaskLiveLine {line} {news} />
					{/each}
					{#if unseen > newestLimit && unseen === newestFirst.length}{@render divider()}{/if}
				</ul>
			</details>
		{/if}
	{/if}
</section>

<style>
	.task-live { display: grid; gap: 0.5rem; min-width: 0; padding: 0 0 0.875rem; border-bottom: 1px solid var(--chat-border); }
	.live-heading { font-size: 0.8125rem; font-weight: 600; }
	.live-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.25rem 0.75rem; }
	.live-transcripts { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; min-width: 0; font-size: 0.75rem; }
	.live-transcripts a { display: inline-flex; align-items: center; min-height: 1.5rem; overflow-wrap: anywhere; }
	.live-header a, .live-now a { text-decoration: underline; text-underline-offset: 0.15em; }
	.live-now { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.125rem 0.5rem; font-size: 0.875rem; overflow-wrap: anywhere; }
	.live-now strong, .live-now time, .live-earlier summary { font-size: 0.75rem; color: var(--chat-fg-muted); }
	.live-counters { display: flex; flex-wrap: wrap; gap: 0.25rem 0.875rem; color: var(--chat-fg-muted); font-size: 0.75rem; font-variant-numeric: tabular-nums; }
	.live-trail { display: grid; gap: 0.25rem; }
	.live-unseen { display: flex; align-items: center; gap: 0.5rem; color: var(--chat-fg-muted); font-size: 0.75rem; }
	.live-unseen::before, .live-unseen::after { content: ''; flex: 1; border-top: 1px solid var(--chat-border); }
	.live-earlier summary { cursor: pointer; padding-block: 0.375rem; }
</style>
