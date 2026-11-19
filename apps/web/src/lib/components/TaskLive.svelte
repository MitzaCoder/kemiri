<script lang="ts">
	import { untrack } from 'svelte';
	import type { BoardTaskActivity, BoardTaskLive } from '@kemiri/protocol';
	import { liveSeenKey, visibleLiveLines, visitLiveTrail } from '#lib/task-live.js';
	import { activityMinute } from '#lib/activity-minute.js';
	import { exactTime, relativeTime } from '#lib/relative-time.js';
	import TaskLiveLine from './TaskLiveLine.svelte';

	let { live, now, backendId, projectId, taskId }: { live: BoardTaskLive; now: BoardTaskActivity; backendId: string; projectId: string; taskId: string } = $props();
	const chronological = $derived(visibleLiveLines(live.lines));
	const newestFirst = $derived(chronological.toReversed());
	const newestLimit = 3;
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
	<li class="live-unseen">New since you looked</li>
{/snippet}

<section class="task-live" aria-label="Live" data-task-live>
	<h2 class="live-heading">Live</h2>
	<p class="live-now"><strong>Now</strong> <span>{now.text}</span> <time datetime={now.since} title={exactTime(now.since)}>{relativeTime(now.since, $activityMinute)}</time></p>
	{#if newestFirst.length}
		<h3 class="live-heading">So far</h3>
		<ul role="list" class="live-trail">
			{#each newestFirst.slice(0, newestLimit) as line, index (line.id)}
				{#if index > 0 && index === unseen}{@render divider()}{/if}
				<TaskLiveLine {line} arrived={arrived.includes(line.id)} />
			{/each}
			{#if unseen > 0 && unseen === Math.min(newestLimit, newestFirst.length)}{@render divider()}{/if}
		</ul>
		{#if newestFirst.length > newestLimit}
			<details class="live-earlier">
				<summary>Earlier · {newestFirst.length - newestLimit}{#if unseen > newestLimit} · {unseen - newestLimit} new{/if}</summary>
				<ul role="list" class="live-trail">
					{#each newestFirst.slice(newestLimit) as line, index (line.id)}
						{#if index > 0 && index + newestLimit === unseen}{@render divider()}{/if}
						<TaskLiveLine {line} />
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
	.live-now { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.125rem 0.5rem; font-size: 0.875rem; overflow-wrap: anywhere; }
	.live-now strong, .live-now time, .live-earlier summary { font-size: 0.75rem; color: var(--chat-fg-muted); }
	.live-trail { display: grid; gap: 0.25rem; }
	.live-unseen { display: flex; align-items: center; gap: 0.5rem; color: var(--chat-fg-muted); font-size: 0.75rem; }
	.live-unseen::before, .live-unseen::after { content: ''; flex: 1; border-top: 1px solid var(--chat-border); }
	.live-earlier summary { cursor: pointer; padding-block: 0.375rem; }
</style>
