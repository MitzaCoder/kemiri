<script lang="ts">
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { clockTime, paceView, percentLabel, resetLabel } from '#lib/subscription-usage.js';
	import { computerNames, limitForecasts, LIMIT_LABELS, type GlanceLimit } from '#lib/usage-glance.js';
	import { usageMoney } from '#lib/usage-money.js';
	import { harness } from '#lib/harness.svelte.js';
	import UsagePauseAction from './UsagePauseAction.svelte';
	import ProviderMark from './ProviderMark.svelte';
	import UsageChart from './UsageChart.svelte';
	import UsageGauge from './UsageGauge.svelte';

	let { limit, now, grouped = false, open = false, toggle, viewSubscription }: {
		limit: GlanceLimit; now: number; grouped?: boolean; open?: boolean;
		toggle: () => void; viewSubscription?: () => void;
	} = $props();
	const detailsId = $props.id();
	const subscription = $derived(limit.subscription.reading);
	const computers = $derived(computerNames(limit.subscription.members.map(member => member.computer)));
	const pauseComputers = $derived(limit.subscription.members.flatMap(member => {
		const backend = harness.backend(member.computer.id);
		return backend?.usagePauseLoaded && backend.ready ? [backend] : [];
	}));
	const forecasts = $derived(limitForecasts(limit, now));
	const reset = $derived(resetLabel(limit.pace, now));
	const exactReset = $derived(limit.pace.resetsAt !== null ? clockTime(limit.pace.resetsAt, now) : null);
	const paceDetail = $derived(limit.stale ? 'The provider has not reported a new reading yet.'
		: !limit.pace.early && limit.pace.exhaustsAt !== null
			? `At the window’s average pace, the limit is reached around ${clockTime(limit.pace.exhaustsAt, now)}, before it resets.`
			: limit.pace.kind === 'behind' && limit.pace.projectedAtReset !== null
				? `At the window’s average pace, usage ends near ${percentLabel(limit.pace.projectedAtReset)}.`
				: paceView(limit.pace, now).detail);
	const tone = $derived(limit.status === 'near' ? 'danger' : limit.status === 'hot' ? 'warn' : limit.status === 'room' ? 'calm' : 'muted');
</script>

<li class="limit" data-status={limit.status}>
	<button type="button" class="limit-toggle" onclick={toggle} aria-expanded={open} aria-controls={open ? detailsId : undefined}>
		<ProviderMark providerId={subscription.providerId} label={subscription.label} size={27} />
		<span class="min-w-0 flex-1">
			<span class="block break-words font-semibold">{grouped ? limit.window.label : subscription.label}</span>
			<span class="block text-[0.6875rem] text-muted-foreground">{grouped ? '' : `${limit.window.label} · `}{computers}</span>
		</span>
		<ChevronDown class="size-4 shrink-0 text-muted-foreground {open ? 'rotate-180' : ''}" />
	</button>
	<div class="limit-overview">
		<UsageGauge usedPercent={limit.window.usedPercent} elapsedShare={limit.stale ? null : limit.pace.elapsedShare} />
		<div class="pace-copy">
			<span class="status">{limit.stale ? 'Last reading' : LIMIT_LABELS[limit.status]}</span>
			<p>{paceDetail}</p>
			<time datetime={limit.window.resetsAt ?? undefined}>{reset}{exactReset && limit.pace.resetsAt! > now ? ` · ${exactReset}` : ''}</time>
		</div>
		<div class="limit-chart">
			<UsageChart window={limit.window} pace={limit.pace} {now} {tone} />
		</div>
	</div>
	{#each forecasts as forecast (forecast.computer.id)}
		<div class="forecast space-y-0.5 text-xs text-muted-foreground">
			<p>{limit.subscription.members.length > 1 ? `${forecast.computer.name} · ` : ''}{forecast.text}</p>
			{#if forecast.spenders.length}
				<p class="pt-0.5 text-[0.6875rem]">Top spenders here · last 10 minutes · API value</p>
				<ul>
					{#each forecast.spenders as spender}
						<li class="flex items-baseline justify-between gap-2"><span class="min-w-0 break-words">{spender.label} · {spender.model}</span><span class="shrink-0 tabular-nums">{usageMoney(spender.apiValue)}</span></li>
					{/each}
				</ul>
			{/if}
		</div>
	{/each}
	{#if pauseComputers.length}
		<div class="pause-actions">
			{#each pauseComputers as backend (backend.id)}
				<div class="flex items-center gap-2">
					{#if backend.usagePauses.some(pause => pause.providerLogin === subscription.providerId)}
						<span class="rounded bg-(--chat-surface-2) px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">Paused</span>
					{/if}
					<UsagePauseAction {backend} providerLogin={subscription.providerId} label={subscription.label}
						showComputer={limit.subscription.members.length > 1} />
				</div>
			{/each}
		</div>
	{/if}
	{#if open}
		<div id={detailsId} class="limit-details space-y-1 text-xs text-muted-foreground">
			<p>Chart: solid is used, dashed is even pace, and dotted is the window’s average pace continued. The dot marks now.</p>
			{#if subscription.account}<p class="break-words">{subscription.account}</p>{/if}
			{#if subscription.manualResets?.available}<p>{subscription.manualResets.available} saved reset{subscription.manualResets.available === 1 ? '' : 's'} available.</p>{/if}
			{#if viewSubscription}<button class="min-h-8 font-semibold text-foreground underline underline-offset-4" type="button" onclick={viewSubscription}>View {subscription.label} subscription</button>{/if}
		</div>
	{/if}
</li>

<style>
	.limit { --limit-tone: var(--accent-2); container-type: inline-size; min-width: 0; border: 1px solid var(--chat-border); border-radius: .8rem; background: var(--chat-surface); overflow: hidden; }
	.limit[data-status='near'] { --limit-tone: var(--chat-danger); }
	.limit[data-status='hot'] { --limit-tone: var(--chat-warning); }
	.limit[data-status='unknown'] { --limit-tone: var(--chat-fg-muted); }
	.limit-toggle { display: flex; align-items: center; gap: .6rem; width: 100%; padding: .6rem .75rem .35rem; text-align: left; font-size: .8125rem; }
	.limit-toggle:hover { background: var(--chat-surface-2); }
	.limit-toggle:focus-visible { outline: 2px solid var(--accent-2); outline-offset: -2px; }
	.limit-overview { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: .55rem .75rem; padding: .25rem .8rem .7rem; }
	.pace-copy { display: grid; justify-items: start; gap: .25rem; font-size: .75rem; color: var(--chat-fg-muted); line-height: 1.4; }
	.status { border-radius: 1rem; padding: .15rem .45rem; color: var(--limit-tone); background: color-mix(in oklab, var(--limit-tone) 12%, var(--chat-surface)); font-weight: 650; }
	.pace-copy time { font-size: .6875rem; font-variant-numeric: tabular-nums; }
	.limit-chart { grid-column: 1 / -1; padding: .2rem .25rem 0; }
	.forecast, .limit-details { border-top: 1px solid var(--chat-border); padding: .55rem .8rem; }
	.pause-actions { display: flex; gap: .4rem; justify-content: flex-end; flex-wrap: wrap; padding: 0 .65rem .55rem; }
	@container (min-width: 30rem) {
		.limit-overview { grid-template-columns: auto minmax(0, 1fr) minmax(0, 1.15fr); }
		.limit-chart { grid-column: auto; }
	}
</style>
