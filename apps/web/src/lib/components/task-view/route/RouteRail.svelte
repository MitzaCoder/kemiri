<script lang="ts">
	import CheckIcon from '@lucide/svelte/icons/check';
	import type { BoardTaskActivity, BoardTaskLive } from '@kemiri/protocol';
	import { activityMinute } from '#lib/activity-minute.js';
	import { exactTime, relativeTime } from '#lib/relative-time.js';
	import type { RouteStop } from '#lib/task-view/route/route.js';
	import type { TaskViewModel } from '#lib/task-view/model.svelte.js';
	import TaskLive from '#lib/components/TaskLive.svelte';
	import TaskLivePulse from '#lib/components/TaskLivePulse.svelte';

	let { stops, wide, model, live, now, onattention }: {
		stops: RouteStop[]; wide: boolean; model: TaskViewModel; live?: BoardTaskLive; now?: BoardTaskActivity; onattention: () => void;
	} = $props();
	let track = $state<HTMLDivElement>();
	let width = $state(0);
	let scroll = $state(0);
	let picked = $state<string>();
	let expanded = $state(false);
	const current = $derived(stops.find(stop => stop.state === 'now') ?? stops.find(stop => stop.state === 'waits'));
	const selected = $derived(stops.find(stop => stop.id === picked) ?? current);
	const selectedId = $derived(selected?.id);
	const stopCount = $derived(stops.length);
	const showingNow = $derived(current !== undefined && selected?.id === current.id);
	const stopWidth = $derived(Math.max(wide ? 88 : 100, width / Math.max(stops.length, 1)));
	const selectedCenter = $derived(Math.max(0, Math.min(width, (stops.findIndex(stop => stop.id === selected?.id) + 0.5) * stopWidth - scroll)));
	const hasLive = $derived(live !== undefined && now !== undefined);
	const showCard = $derived(selected !== undefined && (hasLive || picked === selected.id));
	const trailId = $props.id();

	$effect(() => {
		const id = selectedId;
		const columns = stopCount;
		const viewport = width;
		if (!id || !columns || !viewport) return;
		// Wait for the rail's layout and navigation scroll restoration before centring its stop.
		let frame = requestAnimationFrame(() => {
			frame = requestAnimationFrame(() => {
				const stop = track?.querySelector<HTMLElement>(`[data-route-stop="${id}"]`);
				if (!track || !stop) return;
				// Scroll just the rail; scrollIntoView would also pull the sheet out of place.
				const stopBounds = stop.getBoundingClientRect();
				const trackBounds = track.getBoundingClientRect();
				track.scrollLeft += stopBounds.left + stopBounds.width / 2 - trackBounds.left - trackBounds.width / 2;
				scroll = track.scrollLeft;
			});
		});
		return () => cancelAnimationFrame(frame);
	});

	function selectStop(stop: RouteStop): void {
		picked = hasLive || picked !== stop.id ? stop.id : undefined;
		if (stop.state === 'waits' && !hasLive) onattention();
	}
</script>

<section class="route-line" aria-label="Task route" style:--route-stop-width={`${stopWidth}px`} style:--route-stop-center={`${selectedCenter}px`}>
	<div class="route-track" bind:this={track} bind:clientWidth={width} onscroll={() => { scroll = track?.scrollLeft ?? 0; }}>
		<ol role="list" class="route-stops">
			{#each stops as stop, index (stop.id)}
				<li class="route-stop" data-state={stop.state} data-next={stops[index + 1]?.state}>
					<button type="button" data-route-stop={stop.id} aria-current={stop === current ? 'step' : undefined}
						aria-pressed={showCard && selected?.id === stop.id} onclick={() => selectStop(stop)}>
						<span class="route-dot" aria-hidden="true">{#if stop.state === 'done'}<CheckIcon />{:else if stop.state === 'waits'}!{/if}</span>
						<span class="route-stop-label" title={stop.label}>{stop.label}</span>
						{#if stop.state === 'now'}<small>Now</small>{:else if stop.state === 'waits'}<small>Waits for you</small>{/if}
					</button>
				</li>
			{/each}
		</ol>
	</div>
	{#if showCard && selected}
		<div class="route-live-zone">
			<div class="route-live-card">
				<div class="route-live-meta">
					<span>{showingNow && hasLive ? 'Live' : selected.state === 'done' ? 'Completed stop' : selected.state === 'waits' ? 'Waits for you' : 'On the route'}</span>
					{#if showingNow && hasLive && now}<time datetime={now.since} title={exactTime(now.since)}>{relativeTime(now.since, $activityMinute)}</time>
					{:else if selected.at}<time datetime={selected.at}>{exactTime(selected.at)}</time>{/if}
					{#if showingNow && live && now}
						<button type="button" class="route-small-button" aria-expanded={expanded} aria-controls={expanded ? trailId : undefined} onclick={() => expanded = !expanded}>{expanded ? 'Less' : 'So far'}</button>
					{:else if hasLive}<button type="button" class="route-small-button" onclick={() => picked = undefined}>Back to now</button>{/if}
				</div>
				{#if showingNow && live && now}
					<h2>{now.text}</h2>
					{#if live.pulse}<TaskLivePulse pulse={live.pulse} />{/if}
					{#if expanded}
						<div id={trailId} class="route-live-trail">
							<TaskLive {live} {now} backendId={model.backend.id} projectId={model.projectId} taskId={model.task!.id} news={model.news} />
						</div>
					{/if}
				{:else}
					<h2>{selected.label}</h2>
					{#if selected.detail !== selected.label}<p>{selected.detail}</p>{/if}
					{#if selected.taskId}<a href={model.taskHref(selected.taskId)} class="route-text-link">Open linked task</a>{/if}
					{#if selected.state === 'waits'}<button class="route-text-link" type="button" onclick={onattention}>Go to Your stop</button>{/if}
				{/if}
			</div>
			<span class="route-live-stem" aria-hidden="true"></span>
		</div>
	{/if}
</section>
