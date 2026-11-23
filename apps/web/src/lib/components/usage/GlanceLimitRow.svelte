<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { clockTime, paceView, resetLabel } from '#lib/subscription-usage.js';
	import { computerNames, LIMIT_LABELS, type GlanceLimit } from '#lib/usage-glance.js';
	import { harness } from '#lib/harness.svelte.js';
	import UsagePauseAction from './UsagePauseAction.svelte';
	import ProviderMark from './ProviderMark.svelte';
	import UsageChart from './UsageChart.svelte';

	let { limit, now, grouped = false, open = false, toggle, viewSubscription }: {
		limit: GlanceLimit; now: number; grouped?: boolean; open?: boolean;
		toggle: () => void; viewSubscription?: () => void;
	} = $props();
	const chartId = $props.id();
	const subscription = $derived(limit.subscription.reading);
	const computers = $derived(computerNames(limit.subscription.members.map(member => member.computer)));
	const pauseComputers = $derived(limit.subscription.members.flatMap(member => {
		const backend = harness.backend(member.computer.id);
		return backend?.usagePauseLoaded && backend.ready ? [backend] : [];
	}));
	const reset = $derived(resetLabel(limit.pace, now));
	const exactReset = $derived(limit.pace.resetsAt !== null ? clockTime(limit.pace.resetsAt, now) : null);
	const paceDetail = $derived(limit.stale ? 'The provider has not reported a new reading yet.'
		: !limit.pace.early && limit.pace.exhaustsAt !== null
			? `At this rate, the limit is reached around ${clockTime(limit.pace.exhaustsAt, now)}, before it resets.`
			: paceView(limit.pace, now).detail);
	const tone = $derived(limit.status === 'near' ? 'danger' : limit.status === 'hot' ? 'warn' : limit.status === 'room' ? 'calm' : 'muted');
</script>

<li class="limit" data-status={limit.status}>
	<div class="limit-heading">
	<button type="button" class="limit-toggle" onclick={toggle} aria-expanded={open} aria-controls={open ? chartId : undefined}>
		<span class="provider flex min-w-0 items-center gap-2.5">
			<ProviderMark providerId={subscription.providerId} label={subscription.label} size={29} />
			<span class="min-w-0">
				<span class="block break-words font-semibold">{grouped ? limit.window.label : subscription.label}</span>
				<span class="block text-[0.6875rem] text-muted-foreground">{grouped ? '' : `${limit.window.label} · `}{computers}</span>
			</span>
		</span>
		<span class="meter" aria-hidden="true">
			<i style:width="{Math.min(limit.window.usedPercent ?? 0, 100)}%"></i>
			{#if limit.pace.elapsedShare !== null && !limit.stale}
				<b title="{Math.round(limit.pace.elapsedShare * 100)}% of the window has passed" style:left="{limit.pace.elapsedShare * 100}%"></b>
			{/if}
		</span>
		<span class="percentage font-semibold tabular-nums">{limit.window.usedPercent === null ? '—' : `${Math.round(limit.window.usedPercent)}%`}</span>
		<time class="reset" datetime={limit.window.resetsAt ?? undefined} title={exactReset ?? undefined}>{reset}<span class="hidden xl:inline">{exactReset && limit.pace.resetsAt! > now ? ` · ${exactReset}` : ''}</span></time>
		<span class="status">{limit.stale ? 'Last reading' : LIMIT_LABELS[limit.status]}</span>
		<span class="chevron"><ChevronDown class="size-3.5 text-muted-foreground {open ? 'rotate-180' : ''}" /></span>
	</button>
	{#if pauseComputers.length}
		<div class="pause-actions">
			{#each pauseComputers as backend (backend.id)}
				<UsagePauseAction {backend} providerLogin={subscription.providerId} label={subscription.label}
					showComputer={limit.subscription.members.length > 1} />
			{/each}
		</div>
	{/if}
	</div>
	{#if open}
		<div id={chartId} class="grid gap-3 border-t border-(--chat-border) px-3 py-3 sm:grid-cols-2 sm:px-4">
			<div>
				<UsageChart window={limit.window} pace={limit.pace} {now} {tone} />
				<p class="mt-1 text-[0.6875rem] text-muted-foreground">Solid: used · dashed: even pace · dotted: projection</p>
			</div>
			<div class="space-y-1 text-xs text-muted-foreground">
				<p class="font-medium text-foreground">{paceDetail}</p>
				{#if limit.pace.elapsedShare !== null && !limit.stale}<p>{Math.round(limit.pace.elapsedShare * 100)}% of the window has passed.</p>{/if}
				{#if subscription.account}<p class="break-words">{subscription.account}</p>{/if}
				{#if subscription.manualResets?.available}<p>{subscription.manualResets.available} saved reset{subscription.manualResets.available === 1 ? '' : 's'} available.</p>{/if}
				{#if viewSubscription}<button class="min-h-8 font-semibold text-foreground underline underline-offset-4" type="button" onclick={viewSubscription}>View {subscription.label} subscription</button>{/if}
			</div>
		</div>
	{/if}
</li>

<style>
	.limit { --limit-tone: var(--accent-2); }
	.limit[data-status='near'] { --limit-tone: var(--chat-danger); }
	.limit[data-status='hot'] { --limit-tone: var(--chat-warning); }
	.limit[data-status='unknown'] { --limit-tone: var(--chat-fg-subtle); }
	.limit-heading { display: flex; align-items: center; }
	.limit-heading > .limit-toggle { min-width: 0; flex: 1; }
	.pause-actions { display: flex; gap: .4rem; flex-wrap: wrap; padding: .25rem .75rem .25rem 0; }
	.limit-toggle {
		display: grid; grid-template-columns: minmax(9rem, 1.2fr) minmax(4rem, 1fr) 3rem minmax(7rem, .8fr) 6.5rem auto;
		align-items: center; gap: .7rem; width: 100%; padding: .45rem .85rem; text-align: left; font-size: .8125rem;
	}
	.limit-toggle:hover { background: var(--chat-surface-2); }
	.limit-toggle:focus-visible { outline: 2px solid var(--accent-2); outline-offset: -2px; }
	.meter { position: relative; height: .4rem; border-radius: 1rem; background: var(--chat-surface-2); }
	.meter i { display: block; height: 100%; border-radius: inherit; background: var(--limit-tone); }
	.meter b { position: absolute; top: -.16rem; height: .72rem; width: 2px; border-radius: 2px; background: var(--chat-fg); transform: translateX(-50%); }
	.percentage { text-align: right; }
	.reset, .status { font-size: .6875rem; white-space: nowrap; color: var(--chat-fg-muted); }
	.status { justify-self: end; }
	.limit[data-status='near'] .status, .limit[data-status='hot'] .status { color: var(--limit-tone); font-weight: 650; }
	@container (max-width: 710px) {
		.limit-heading { flex-wrap: wrap; }
		.limit-heading > .limit-toggle { flex-basis: 100%; }
		.pause-actions { padding: 0 .7rem .4rem; margin-left: auto; }
		.limit-toggle { grid-template-columns: minmax(4.75rem, 1fr) auto auto auto; gap: .35rem .55rem; padding: .48rem .7rem; }
		.provider { grid-column: 1 / 4; grid-row: 1; }
		.percentage { grid-column: 4; grid-row: 1; }
		.meter { grid-column: 1; grid-row: 2; }
		.reset { grid-column: 2; grid-row: 2; }
		.status { grid-column: 3; grid-row: 2; }
		.chevron { grid-column: 4; grid-row: 2; justify-self: end; }
	}
</style>
