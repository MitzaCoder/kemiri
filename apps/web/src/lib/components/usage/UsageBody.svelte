<script lang="ts">
	import ChartIcon from '@lucide/svelte/icons/chart-no-axes-column-increasing';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import InfoIcon from '@lucide/svelte/icons/info';
	import RefreshIcon from '@lucide/svelte/icons/refresh-cw';
	import XIcon from '@lucide/svelte/icons/x';
	import { page } from '$app/state';
	import { onMount, tick, untrack } from 'svelte';
	import type { CacheStats, UsageValueResponse } from '@kemiri/protocol';
	import Orb from '#lib/components/Orb.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { harness, type BackendConnection } from '#lib/harness.svelte.js';
	import { inAppBackVisible } from '#lib/settings-navigation.js';
	import { backendSettingsHref, generalSettingsHref } from '#lib/settings.js';
	import { overlayScroll } from '#lib/scrollbars.js';
	import { providerMark, resetLabel, updatedLabel } from '#lib/subscription-usage.js';
	import { usageBoard } from '#lib/subscription-usage.svelte.js';
	import { localValueMonth, valueMonthRequest } from '#lib/subscription-value.js';
	import { apiKeySpendRate, computerNames, mergeSubscriptions, providerSpend, quietLimits, rankedLimits, spendRows, subscriptionMonths,
		SPEND_DIMENSIONS, USAGE_BACKEND_KEY, USAGE_PERIODS, usagePeriodRequest, type SpendDimension, type SpendRow, type UsagePeriod } from '#lib/usage-glance.js';
	import { usageMoney } from '#lib/usage-money.js';
	import { UsageReads, type UsageRead } from '#lib/usage-reads.js';
	import CacheSection from './CacheSection.svelte';
	import GlanceLimitCard from './GlanceLimitCard.svelte';
	import GlanceSpendDetail from './GlanceSpendDetail.svelte';
	import GlanceSubscriptionDetail from './GlanceSubscriptionDetail.svelte';
	import ProviderMark from './ProviderMark.svelte';

	type Sheet = { kind: 'subscription'; key: string } | { kind: 'spend'; row: SpendRow };
	let sheetTrail = $state<Sheet[]>([]);
	const sheet = $derived(sheetTrail.at(-1));
	let sheetTrigger: HTMLElement | undefined;
	let sheetClose: HTMLButtonElement | null = $state(null);
	let sheetScroll: HTMLDivElement | null = $state(null);
	const usageId = $props.id();
	const backendTabs = $derived([{ id: '', name: 'All' }, ...harness.backends]);
	let backendTabList: HTMLDivElement | undefined = $state();
	let backendId = $state('');
	let period = $state<UsagePeriod>('rolling');
	let dimension = $state<SpendDimension>('task');
	let grouped = $state(false);
	let showQuiet = $state(false);
	let showAllSpend = $state(false);
	let expandedLimit = $state<string>();
	let now = $state(Date.now());
	let refreshRevision = $state(0);
	let recordedSnapshot = $state.raw<{ scope: string; reads: UsageRead<BackendConnection, CacheStats>[] }>();
	let monthlySnapshot = $state.raw<{ scope: string; reads: UsageRead<BackendConnection, UsageValueResponse>[] }>();
	const recordedReports = new UsageReads<BackendConnection, CacheStats>((scope, reads) => { recordedSnapshot = { scope, reads }; });
	const monthlyReports = new UsageReads<BackendConnection, UsageValueResponse>((scope, reads) => { monthlySnapshot = { scope, reads }; });

	const month = $derived(localValueMonth(new Date(now)));
	const monthLabel = $derived(new Date(`${month}-01T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
	const periodLabel = $derived(period === 'month' ? `${monthLabel} so far` : (USAGE_PERIODS.find(([key]) => key === period)?.[1] ?? ''));
	// Countdown ticks are not a polling schedule. Keep the range identity stable for drill-downs too.
	const recordedScope = $derived(JSON.stringify([usagePeriodRequest(period, month, new Date(now)), period === 'today' ? new Date(now).toDateString() : '']));
	const periodRequest = $derived((JSON.parse(recordedScope) as [ReturnType<typeof usagePeriodRequest>, string])[0]);
	const needsMonth = $derived(period === 'month' || sheet?.kind === 'subscription');
	const selectedId = $derived(harness.backends.some(backend => backend.id === backendId) ? backendId : '');
	const selectedTabIndex = $derived(backendTabs.findIndex(backend => backend.id === selectedId));
	const selectedBackends = $derived(harness.backends.filter(backend => !selectedId || backend.id === selectedId));
	const offline = $derived(selectedBackends.filter(backend => !backend.ready));
	const usageSources = $derived(selectedBackends.filter(backend => backend.supports('subscription-usage')).map(backend => usageBoard.for(backend)));
	const liveUsageSources = $derived(usageSources.filter(source => source.backend.ready));
	const liveSubscriptions = $derived(subscriptionsFrom(liveUsageSources));
	// Keep the cards above Spend in place while a computer reconnects. Only live sources drive the verdict.
	const subscriptions = $derived(subscriptionsFrom(usageSources));
	const limits = $derived(rankedLimits(subscriptions, now));
	const liveLimits = $derived(rankedLimits(liveSubscriptions, now));
	const quiet = $derived(quietLimits(limits, now));
	const quietKeys = $derived(new Set(quiet.map(limit => limit.key)));
	const visibleLimits = $derived(showQuiet ? limits : limits.filter(limit => !quietKeys.has(limit.key)));
	const attention = $derived(liveLimits.filter(limit => limit.status === 'near' || limit.status === 'hot').slice(0, 2));
	const newestUpdate = $derived(liveSubscriptions.map(subscription => subscription.reading.updatedAt ?? '').sort().at(-1));
	const recordedTargets = $derived(selectedBackends.filter(computer => computer.supports('cache-stats')).map(computer => ({ computer, ready: computer.ready })));
	const monthlyTargets = $derived(needsMonth ? selectedBackends.filter(computer => computer.supports('subscription-value')).map(computer => ({ computer, ready: computer.ready })) : []);
	const recordedReads = $derived(readsForTargets(recordedScope, recordedSnapshot, recordedTargets));
	const monthlyReads = $derived(readsForTargets(month, monthlySnapshot, monthlyTargets));
	const readingRecorded = $derived(readingUsage(recordedTargets, recordedReads));
	const readingMonth = $derived(readingUsage(monthlyTargets, monthlyReads));
	const refreshing = $derived(usageSources.some(source => source.refreshing) || readingRecorded || readingMonth);
	const recorded = $derived(recordedReads.flatMap(({ computer, report }) => report ? [{ computer, stats: report }] : []));
	const total = $derived(recorded.reduce((sum, { stats }) => sum + (stats.recorded?.totals.cost ?? stats.usage?.totals.cost ?? stats.totals.cost + (stats.keepWarm?.cost ?? 0)), 0));
	const rankedSpend = $derived(spendRows(recorded, dimension));
	const subscriptionSpend = $derived(providerSpend(recorded, subscriptions));
	const providerTotal = $derived(subscriptionSpend.reduce((sum, row) => sum + row.cost, 0));
	const months = $derived(subscriptionMonths(monthlyReads.flatMap(({ computer, report }) => report ? [{ computer, report }] : []), subscriptions));
	const selectedSubscription = $derived(sheet?.kind === 'subscription' ? subscriptions.find(subscription => subscription.key === sheet.key) : undefined);
	const knownPlanPrice = $derived([...months.values()].reduce((sum, entry) => sum + (entry.price?.monthlyPrice ?? 0), 0));
	const subscriptionMonthCost = $derived([...months.values()].reduce((sum, entry) => sum + entry.cost, 0));
	const completeComparison = $derived(months.size > 0 && [...months.values()].every(entry => entry.price?.monthlyPrice != null)
		&& selectedBackends.filter(backend => backend.supports('cache-stats') || backend.supports('subscription-usage'))
			.every(backend => monthlyReads.some(read => read.computer.id === backend.id && read.report)));
	const priceMarker = $derived(period === 'month' && completeComparison && knownPlanPrice > 0 ? knownPlanPrice : 0);
	const spendScale = $derived(Math.max(total, priceMarker));
	const promptTokens = $derived(recorded.reduce((sum, { stats }) => sum + stats.totals.inputTokens + stats.totals.cacheReadTokens + stats.totals.cacheWriteTokens, 0));
	const cacheRead = $derived(recorded.reduce((sum, { stats }) => sum + stats.totals.cacheReadTokens, 0));
	const signals = $derived([
		{ label: 'Prompt billed again', note: 'Estimated from inferred cache misses', cost: recorded.reduce((sum, { stats }) => sum + stats.totals.missedCost, 0) },
		{ label: 'Failed or stopped responses', note: 'Only responses with reported usage', cost: recorded.reduce((sum, { stats }) => sum + (stats.usage?.failed.cost ?? 0), 0) },
		{ label: 'Keep-warm', note: 'Scheduled cache refreshes', cost: recorded.reduce((sum, { stats }) => sum + (stats.keepWarm?.cost ?? 0), 0) },
		{ label: 'Check-ins and retries', note: 'Requests themselves, not follow-up turns', cost: recorded.reduce((sum, { stats }) => sum + (stats.usage?.checkIns.cost ?? 0) + (stats.usage?.retries.cost ?? 0), 0) },
	]);
	let scroll: HTMLDivElement | null = $state(null);

	onMount(() => {
		try { backendId = localStorage.getItem(USAGE_BACKEND_KEY) ?? ''; } catch { /* Storage is optional. */ }
		const timer = setInterval(() => now = Date.now(), 10_000);
		return () => {
			clearInterval(timer);
			recordedReports.stop();
			monthlyReports.stop();
		};
	});
	$effect(() => {
		backendTabList?.querySelectorAll('button')[selectedTabIndex]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	});
	$effect(() => {
		const sources = usageSources;
		untrack(() => { for (const source of sources) source.start(); });
		return () => { for (const source of sources) source.stop(); };
	});
	$effect(() => {
		const scope = recordedScope;
		const range = periodRequest;
		const targets = recordedTargets;
		const revision = refreshRevision;
		untrack(() => recordedReports.sync(scope, targets, revision, async computer => {
			const supported = computer.supports('recorded-usage');
			if (range.month && !supported) throw new Error('This computer does not report calendar-month usage yet.');
			return computer.client.readCacheStats({ ...range, ...(supported ? { recorded: true } : {}) });
		}));
	});
	$effect(() => {
		const scope = month;
		const query = valueMonthRequest(scope);
		const targets = monthlyTargets;
		const revision = refreshRevision;
		untrack(() => monthlyReports.sync(scope, targets, revision, async computer => {
			const report = await computer.client.request<UsageValueResponse>(query);
			if (report.type !== 'usage.value' || report.month !== scope) throw new Error('Unexpected subscription value reply.');
			return report;
		}));
	});

	function subscriptionsFrom(sources: typeof usageSources) {
		return mergeSubscriptions(sources.flatMap(source => source.subscriptions.map(subscription => ({ computer: source.backend, subscription }))));
	}
	function readsForTargets<T>(scope: string, snapshot: { scope: string; reads: UsageRead<BackendConnection, T>[] } | undefined, targets: { computer: BackendConnection }[]) {
		const reads = snapshot?.scope === scope ? snapshot.reads : [];
		return targets.flatMap(({ computer }) => reads.find(read => read.computer === computer) ?? []);
	}
	function readingUsage<T>(targets: { computer: BackendConnection; ready: boolean }[], reads: UsageRead<BackendConnection, T>[]) {
		return targets.some(({ computer, ready }) => ready && reads.find(read => read.computer === computer)?.loading !== false);
	}

	function pickBackend(id: string) {
		backendId = id;
		expandedLimit = undefined;
		try { localStorage.setItem(USAGE_BACKEND_KEY, id); } catch { /* The view still changes. */ }
	}
	function navigateBackendTabs(event: KeyboardEvent, index: number) {
		const count = backendTabs.length;
		let next: number;
		switch (event.key) {
			case 'ArrowLeft': next = (index - 1 + count) % count; break;
			case 'ArrowRight': next = (index + 1) % count; break;
			case 'Home': next = 0; break;
			case 'End': next = count - 1; break;
			default: return;
		}
		event.preventDefault();
		pickBackend(backendTabs[next].id);
		backendTabList?.querySelectorAll('button')[next]?.focus({ preventScroll: true });
	}
	function refresh() {
		now = Date.now();
		refreshRevision += 1;
		void Promise.allSettled(liveUsageSources.map(source => source.load(true)));
	}
	function jumpTo(id: string) {
		const heading = scroll?.querySelector<HTMLElement>(`#${id}`);
		heading?.focus({ preventScroll: true });
		heading?.scrollIntoView({ block: 'start' });
	}
	function openSheet(detail: Sheet) {
		if (!sheet) sheetTrigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		sheetTrail = [...sheetTrail, detail];
		void tick().then(() => { if (sheetScroll) sheetScroll.scrollTop = 0; sheetClose?.focus(); });
	}
	function openSpend(row: SpendRow) {
		if (row.subscriptionKey) openSheet({ kind: 'subscription', key: row.subscriptionKey });
		else openSheet({ kind: 'spend', row });
	}
	function restoreSheetFocus(event: Event) {
		event.preventDefault();
		sheetTrigger?.focus();
	}
</script>

<Dialog.Header class="usage-glance-heading">
	<Dialog.Title class="flex min-w-0 flex-1 items-center gap-2 text-xl font-bold tracking-tight"><ChartIcon class="hidden size-5 text-(--accent-2) sm:block" />Usage</Dialog.Title>
	{#if newestUpdate}<span class="hidden text-xs text-muted-foreground md:inline">{updatedLabel(newestUpdate, now)}</span>{/if}
	<Button variant="ghost" size="icon" onclick={refresh} disabled={refreshing || !selectedBackends.some(backend => backend.ready)} aria-label="Refresh usage" title="Refresh usage"><RefreshIcon class="size-4 {refreshing ? 'animate-spin motion-reduce:animate-none' : ''}" /></Button>
	{#if inAppBackVisible(page.state.navigation)}<Button variant="ghost" onclick={() => history.back()}>Back</Button>{/if}
	<Dialog.Close aria-label="Close usage" class="grid size-9 place-items-center rounded-md hover:bg-muted"><XIcon class="size-4" /></Dialog.Close>
	<Dialog.Description class="sr-only">Live subscription limits and recorded work at API prices.</Dialog.Description>
</Dialog.Header>

<div class="usage-backend-tabs" role="tablist" aria-label="Usage by computer" bind:this={backendTabList}>
	{#each backendTabs as backend, index (backend.id)}
		<button type="button" role="tab" id="{usageId}-backend-{index}" aria-selected={selectedTabIndex === index}
			aria-controls="{usageId}-overview" tabindex={selectedTabIndex === index ? 0 : -1}
			onclick={() => pickBackend(backend.id)} onkeydown={event => navigateBackendTabs(event, index)}>{backend.name}</button>
	{/each}
</div>

<div class="relative min-h-0 flex-1" role="tabpanel" id="{usageId}-overview" aria-labelledby="{usageId}-backend-{selectedTabIndex}">
	<div use:overlayScroll={'parent'} bind:this={scroll} class="usage-scroll">
		<nav class="usage-jumps" aria-label="Usage sections">
			<button onclick={() => jumpTo('usage-limits')} type="button">Limits</button>
			<button onclick={() => jumpTo('usage-spend')} type="button">Spend</button>
			<button onclick={() => jumpTo('usage-look')} type="button">Worth a look</button>
		</nav>
		<div class="usage-overview">
			<p class="verdict" data-attention={attention[0]?.status ?? 'room'} aria-live="polite">
				<span aria-hidden="true"></span>
				{#if attention.length}<span>
					{#each attention as limit, index (limit.key)}{#if index > 0}{'; '}{/if}<strong>{limit.subscription.reading.label}’s {limit.window.label.replace(/^(Weekly|Monthly)/, label => label.toLowerCase())} is {limit.status === 'near' ? 'nearly out' : 'running hot'}</strong> ({Math.round(limit.window.usedPercent!)}%){limit.pace.resetsAt === null ? ' · reset time unknown' : ` and ${resetLabel(limit.pace, now)}`}{/each}.
				</span>
				{:else if liveLimits.some(limit => limit.status === 'room')}<span><strong>No measured limit needs attention.</strong>{offline.length || liveLimits.some(limit => limit.status === 'unknown') ? ' Some readings are missing or out of date.' : ''}</span>
				{:else if liveUsageSources.some(source => !source.loaded && !source.error)}<span>Reading subscription limits…</span>
				{:else}<span><strong>No current limit readings.</strong> {selectedBackends.length ? 'Check the computers and their subscription sign-ins.' : 'Add a computer to see its usage.'}</span>{/if}
			</p>

			<section aria-labelledby="usage-limits">
				<div class="section-heading">
					<h2 id="usage-limits" tabindex="-1">Limits</h2>
					<div class="segments" role="group" aria-label="Limit order">
						<button type="button" aria-pressed={!grouped} onclick={() => grouped = false}>Closest first</button>
						<button type="button" aria-pressed={grouped} onclick={() => grouped = true}>By subscription</button>
					</div>
				</div>
				{#each usageSources.filter(source => !source.backend.ready && source.subscriptions.length > 0) as source (source.backend.id)}
					<p class="mb-2 text-xs text-muted-foreground">{source.backend.name} is offline. Showing its last limit readings.</p>
				{/each}
				<div class="limits-collection">
					{#if grouped}
						{#each subscriptions as subscription (subscription.key)}
							<button type="button" class="subscription-group" onclick={() => openSheet({ kind: 'subscription', key: subscription.key })}>
								<ProviderMark providerId={subscription.reading.providerId} label={subscription.reading.label} size={24} />
								<strong>{subscription.reading.label}</strong><small>{[subscription.reading.plan, computerNames(subscription.members.map(member => member.computer))].filter(Boolean).join(' · ')}</small><ChevronRight class="ml-auto size-4" />
							</button>
							<ul class="limit-grid">
								{#each limits.filter(limit => limit.subscription.key === subscription.key) as limit (limit.key)}{@render limitCard(limit, true)}{/each}
							</ul>
						{/each}
					{:else}
						<ul class="limit-grid">{#each visibleLimits as limit (limit.key)}{@render limitCard(limit, false)}{/each}</ul>
						{#if quiet.length}<button type="button" class="quiet-toggle" aria-expanded={showQuiet} onclick={() => showQuiet = !showQuiet}>
							{showQuiet ? 'Hide quiet limits' : `${quiet.length} more limit${quiet.length === 1 ? '' : 's'}, all under ${Math.floor(Math.max(...quiet.map(limit => limit.window.usedPercent ?? 0))) + 1}% · show`}
						</button>{/if}
					{/if}
					{#if !selectedBackends.length}
						<div class="empty-copy flex items-center gap-3"><Orb size={24} /><p>No subscription limits to show. <a href={generalSettingsHref('backends')}>Add a computer</a>.</p></div>
					{:else if !limits.length}<p class="empty-copy">No subscription limits to show.</p>{/if}
				</div>
				{#each liveUsageSources.filter(source => source.error) as source (source.backend.id)}<p class="mt-2 text-xs text-muted-foreground">Could not read limits on {source.backend.name}: {source.error}</p>{/each}
				{#each subscriptions.filter(subscription => subscription.reading.error || !subscription.windows.length) as subscription (subscription.key)}<p class="mt-2 text-xs text-muted-foreground"><button class="underline underline-offset-4" type="button" onclick={() => openSheet({ kind: 'subscription', key: subscription.key })}>{subscription.reading.label}</button> · {computerNames(subscription.members.map(member => member.computer))}: {subscription.reading.error ? `Usage unavailable — ${subscription.reading.error}` : 'No limit readings yet.'}</p>{/each}
				{#each liveUsageSources.filter(source => source.loaded && !source.subscriptions.length && !source.error) as source (source.backend.id)}<p class="mt-2 text-xs text-muted-foreground">No subscriptions on {source.backend.name}. <a class="underline underline-offset-4" href={backendSettingsHref(source.backend.id, 'accounts')}>Open Accounts</a></p>{/each}
			</section>

			<section aria-labelledby="usage-spend">
				<div class="section-heading">
					<h2 id="usage-spend" tabindex="-1">Spend</h2>
					<div class="segments" role="group" aria-label="Spend period">
						{#each USAGE_PERIODS as [key, label] (key)}<button type="button" aria-pressed={period === key} onclick={() => { period = key; showAllSpend = false; }}>{label}</button>{/each}
					</div>
				</div>
				{#each recordedReads.filter(read => read.error) as read (read.computer.id)}<p class="mb-2 text-xs text-muted-foreground">Could not refresh spend on {read.computer.name}.{read.report ? ' Showing the last reading.' : ` ${read.error}`}</p>{/each}
				{#if period === 'month'}
					{#each monthlyReads.filter(read => read.error) as read (read.computer.id)}<p class="mb-2 text-xs text-muted-foreground">Could not refresh monthly usage on {read.computer.name}.{read.report ? ' Showing the last reading.' : ''}</p>{/each}
				{/if}
				{#if offline.length}<p class="mb-2 text-xs text-muted-foreground">Not connected: {computerNames(offline)}.</p>{/if}
				<div class="spend-grid" aria-busy={readingRecorded}>
					<div class="usage-card spend-total">
						<p class="text-xs text-muted-foreground">{periodLabel}</p>
						{#if recorded.length}<p class="my-1 text-sm text-muted-foreground"><strong class="mr-1 text-[2rem] leading-tight tracking-tight text-foreground tabular-nums">{usageMoney(total)}</strong> of work at API prices</p>
						{:else if readingRecorded}<p role="status" class="py-3 text-sm text-muted-foreground">Reading spend…</p>
						{:else}<p class="py-3 text-sm text-muted-foreground">Recorded spend is unavailable for this selection.</p>{/if}
						{#if period === 'month' && recorded.length}
							{#if readingMonth && !monthlyReads.some(read => read.report)}<p class="mb-2 text-xs text-muted-foreground">Reading monthly prices…</p>
							{:else if completeComparison && knownPlanPrice > 0}<p class="mb-2 text-sm">Subscriptions cost <strong>{usageMoney(knownPlanPrice)}</strong> a month. Subscription work at API prices is <strong>{(subscriptionMonthCost / knownPlanPrice).toFixed(1)}×</strong> that price.</p>
							{:else if recorded.length}<p class="mb-2 text-xs text-muted-foreground">{knownPlanPrice > 0 ? `${usageMoney(knownPlanPrice)} a month in known plan prices. ` : ''}A full price comparison is not available.</p>{/if}
						{/if}
						{#if providerTotal > 0}
							<div class="spend-stack" aria-hidden="true">{#each subscriptionSpend as row (row.key)}<span style:flex-basis="{100 * row.cost / spendScale}%" style:background={providerMark(row.provider ?? '', row.label).accent}></span>{/each}{#if priceMarker}<b class="price-marker" title="Monthly subscription price" style:left="{Math.min(99.7, 100 * priceMarker / spendScale)}%"></b>{/if}</div>
						{/if}
						{#if subscriptionSpend.length}<ul class="divide-y divide-(--chat-border)">
							{#each subscriptionSpend as row (row.key)}<li>{@render spendButton(row, false)}</li>{/each}
						</ul>{/if}
					</div>
					<div class="usage-card spend-ranking">
						<h3>What cost most</h3>
						<div class="segments" role="group" aria-label="Group spend by">
							{#each SPEND_DIMENSIONS as [key, label] (key)}<button type="button" aria-pressed={dimension === key} onclick={() => { dimension = key; showAllSpend = false; }}>{label}</button>{/each}
						</div>
						{#if rankedSpend.length}
							<ol class="mt-1 divide-y divide-(--chat-border)">{#each (showAllSpend ? rankedSpend : rankedSpend.slice(0, 5)) as row (row.key)}<li>{@render spendButton(row, true)}</li>{/each}</ol>
							{#if rankedSpend.length > 5}<button type="button" class="quiet-toggle" aria-expanded={showAllSpend} onclick={() => showAllSpend = !showAllSpend}>{showAllSpend ? 'Show the top five' : `Show ${rankedSpend.length - 5} more`}</button>{/if}
						{:else if recorded.length}<p class="py-3 text-xs text-muted-foreground">No rows for this group and period.</p>{/if}
					</div>
				</div>
			</section>

			<section aria-labelledby="usage-look">
				<div class="section-heading"><h2 id="usage-look" tabindex="-1">Worth a look</h2><span class="text-xs text-muted-foreground">{periodLabel} · signals, not proof of waste</span></div>
				{#if recorded.length}
					<ul class="usage-card divide-y divide-(--chat-border)">
						{#each signals as signal (signal.label)}<li class="flex items-center gap-3 px-3 py-2.5 text-sm"><span class="min-w-0 flex-1 font-medium">{signal.label}<small class="block font-normal text-muted-foreground sm:ml-2 sm:inline">{signal.note}</small></span><strong class="shrink-0 tabular-nums">{usageMoney(signal.cost)}</strong></li>{/each}
					</ul>
					{#if promptTokens > 0}<p class="mt-2 text-xs text-muted-foreground">{Math.round(100 * cacheRead / promptTokens)}% of prompt tokens were read from cache.</p>{/if}
					<details class="usage-disclosure"><summary>Prompt-cache diagnosis</summary>
						{#each recorded as { computer, stats } (computer.id)}<div class="mt-4 min-w-0"><h3 class="mb-2 font-semibold">{computer.name}</h3><CacheSection {stats} days={Math.max(1, stats.days.length)} /></div>{/each}
					</details>
				{:else if readingRecorded}<p class="empty-copy">Reading prompt-cache numbers…</p>
				{:else}<p class="empty-copy">Prompt-cache numbers are unavailable for this selection.</p>{/if}
			</section>

			<details class="usage-disclosure info-disclosure">
				<summary><InfoIcon class="mr-1 inline size-3.5" /> About these numbers</summary>
				<div class="space-y-2 px-3 pb-3 text-xs text-muted-foreground">
					<p>Limits come from the provider and can include use outside Kemiri. The inner arc shows how much of the window has passed. The chart projects the window’s average pace; the forecast uses recent usage.</p>
					<p>Work at API prices is a catalog estimate, not a bill. The monthly comparison counts only subscription-covered work and does not prorate prices. A shared login counts once when its account and plan can be matched; recorded work from both computers is still counted.</p>
					<p>Prices and billed usage may differ from catalog estimates. Requests without a catalog price add tokens but no cost.{#if recorded.some(({ stats }) => stats.recorded?.approximate)} Some older daily totals cross the selected period’s boundary and are assigned by UTC noon.{/if}{#if monthlyReads.some(({ report }) => report?.assumed)} Some older requests use the current credential to infer their billing.{/if}</p>
					{#each recorded as { computer, stats } (computer.id)}<p>{computer.name}: prompt-cache details are kept for {stats.keptDays} days.{#if stats.liveSince} Recorded live since {new Date(stats.liveSince).toLocaleDateString()}; earlier requests did not record prompt changes.{/if}</p>{/each}
				</div>
			</details>
		</div>
	</div>
</div>

{#snippet limitCard(limit: (typeof limits)[number], inGroup: boolean)}
	<GlanceLimitCard {limit} {now} grouped={inGroup} open={expandedLimit === limit.key} toggle={() => expandedLimit = expandedLimit === limit.key ? undefined : limit.key}
		viewSubscription={() => openSheet({ kind: 'subscription', key: limit.subscription.key })} />
{/snippet}

{#snippet spendButton(row: SpendRow, ranking: boolean)}
	{@const rate = apiKeySpendRate(row, recorded)}
	<button class="spend-row" type="button" onclick={() => openSpend(row)}>
		{#if row.provider}<ProviderMark providerId={row.provider} label={row.label} size={23} />{/if}
		<span class="min-w-0 flex-1">
			<span class="block break-words font-medium">{row.label}</span>
			<span class="block text-[0.6875rem] text-muted-foreground">{computerNames(row.portions.map(portion => portion.computer))}</span>
			{#if rate !== undefined}<span class="block text-[0.6875rem] text-muted-foreground">{usageMoney(rate)}/h · last hour at API prices</span>{/if}
			{#if ranking && rankedSpend[0] && rankedSpend[0].cost > 0}<span aria-hidden="true" class="rank-bar"><span style:width="{100 * row.cost / rankedSpend[0].cost}%"></span></span>{/if}
		</span>
		<span class="shrink-0 text-right font-semibold tabular-nums">{usageMoney(row.cost)}{#if ranking && total > 0}<small class="block font-normal text-muted-foreground">{Math.round(100 * row.cost / total)}%</small>{/if}</span>
		<ChevronRight class="size-3.5 shrink-0 text-muted-foreground" />
	</button>
{/snippet}

<Dialog.Root open={sheet !== undefined} onOpenChange={open => { if (!open) sheetTrail = []; }}>
	<Dialog.Content showCloseButton={false} onCloseAutoFocus={restoreSheetFocus}
		class="left-auto right-0 top-0 bottom-0 flex h-dvh max-w-[min(100vw,34rem)] translate-x-0 translate-y-0 flex-col gap-0 rounded-r-none p-0 max-sm:inset-x-0 max-sm:top-auto max-sm:h-auto max-sm:max-h-[88dvh] max-sm:max-w-none max-sm:rounded-t-2xl max-sm:rounded-b-none">
		<Dialog.Header class="flex shrink-0 flex-row items-center gap-2 border-b border-(--chat-border) p-3">
			{#if sheetTrail.length > 1}<Button size="sm" variant="ghost" onclick={() => { sheetTrail = sheetTrail.slice(0, -1); if (sheetScroll) sheetScroll.scrollTop = 0; sheetClose?.focus(); }}>Back</Button>{/if}
			<Dialog.Title class="min-w-0 flex-1 break-words">{sheet?.kind === 'spend' ? sheet.row.label : selectedSubscription?.reading.label ?? 'Subscription'}</Dialog.Title>
			<Dialog.Description class="sr-only">Usage breakdown</Dialog.Description>
			<Button bind:ref={sheetClose} size="icon" variant="ghost" aria-label="Close breakdown" onclick={() => sheetTrail = []}><XIcon class="size-4" /></Button>
		</Dialog.Header>
		<div bind:this={sheetScroll} class="min-h-0 overflow-y-auto overscroll-contain p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
			{#if sheet?.kind === 'spend'}
				<GlanceSpendDetail row={sheet.row} period={periodRequest} {periodLabel} overallCost={total} openTask={openSpend} />
			{:else if selectedSubscription}
				<GlanceSubscriptionDetail subscription={selectedSubscription} monthly={months.get(selectedSubscription.key)} loading={readingMonth} {monthLabel} {now} />
			{:else}<p class="text-muted-foreground">This subscription is not available.</p>{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>

<style>
	:global(.usage-glance-heading) { display: flex; flex-direction: row; align-items: center; gap: .55rem; flex-shrink: 0; border-bottom: 1px solid var(--chat-border); padding: max(.55rem, env(safe-area-inset-top)) 1rem .55rem; }
	.usage-backend-tabs { display: flex; flex: none; gap: .25rem; min-width: 0; overflow-x: auto; overscroll-behavior-x: contain; padding-inline: 1rem; scroll-padding-inline: 1rem; border-bottom: 1px solid var(--chat-border); }
	.usage-backend-tabs button { flex: none; min-width: 3.75rem; min-height: 2.75rem; padding-inline: .85rem; border-bottom: 2px solid transparent; color: var(--chat-fg-muted); font-size: .875rem; font-weight: 650; white-space: nowrap; }
	.usage-backend-tabs button:hover { background: var(--chat-surface-2); }
	.usage-backend-tabs button[aria-selected='true'] { color: var(--chat-fg); border-bottom-color: var(--accent-2); }
	.usage-backend-tabs button:focus-visible { outline-offset: -4px; }
	.usage-scroll { position: absolute; inset: 0; overflow-y: auto; overscroll-behavior: contain; }
	.usage-jumps { position: sticky; top: 0; z-index: 1; display: flex; gap: 1.25rem; align-items: center; padding: .1rem 1.25rem; background: var(--chat-surface); border-bottom: 1px solid var(--chat-border); }
	.usage-jumps button { min-height: 2rem; color: var(--chat-fg-muted); font-size: .75rem; font-weight: 650; }
	.usage-jumps button:hover { color: var(--chat-fg); text-decoration: underline; text-underline-offset: 4px; }
	.usage-overview { display: grid; gap: 1rem; padding: .85rem 1.25rem max(1.5rem, env(safe-area-inset-bottom)); }
	.verdict { --verdict-tone: var(--accent-2); display: flex; align-items: baseline; gap: .6rem; border: 1px solid color-mix(in oklab, var(--verdict-tone) 30%, var(--chat-border)); border-radius: .75rem; padding: .65rem .8rem; background: color-mix(in oklab, var(--verdict-tone) 8%, var(--chat-surface)); font-size: .8125rem; line-height: 1.5; }
	.verdict[data-attention='near'] { --verdict-tone: var(--chat-danger); }
	.verdict[data-attention='hot'] { --verdict-tone: var(--chat-warning); }
	.verdict > span:first-child { width: .45rem; height: .45rem; flex: 0 0 .45rem; border-radius: 50%; background: var(--verdict-tone); }
	.section-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .35rem .5rem; margin-bottom: .4rem; }
	.section-heading h2 { font-size: 1.02rem; font-weight: 700; scroll-margin-top: 2.6rem; }
	.segments { display: inline-flex; max-width: 100%; flex-wrap: wrap; gap: .15rem; padding: .15rem; border: 1px solid var(--chat-border); border-radius: .55rem; font-size: .6875rem; }
	.segments button { min-height: 1.7rem; border-radius: .35rem; padding-inline: .6rem; white-space: nowrap; color: var(--chat-fg-muted); }
	.segments button:hover { background: var(--chat-surface-2); }
	.segments button[aria-pressed='true'] { color: var(--chat-fg); background: var(--chat-surface-2); font-weight: 650; }
	.usage-card { min-width: 0; border: 1px solid var(--chat-border); border-radius: .8rem; background: var(--chat-surface); overflow: hidden; }
	.limits-collection { container-type: inline-size; display: grid; gap: .5rem; }
	.limit-grid { display: grid; gap: .6rem; align-items: start; }
	@container (min-width: 42rem) { .limit-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
	.limits-collection .quiet-toggle, .subscription-group { border: 1px solid var(--chat-border); border-radius: .65rem; }
	.quiet-toggle { min-height: 2rem; display: block; width: 100%; padding: .25rem .8rem; text-align: left; font-size: .75rem; font-weight: 600; color: var(--chat-fg-muted); border-top: 1px solid var(--chat-border); }
	.quiet-toggle:hover, .subscription-group:hover, .spend-row:hover { background: var(--chat-surface-2); }
	.subscription-group { width: 100%; display: flex; gap: .5rem; align-items: center; text-align: left; padding: .5rem .8rem; background: var(--chat-surface-2); font-size: .8125rem; }
	.subscription-group small { color: var(--chat-fg-muted); }
	.spend-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .7rem; align-items: start; }
	.spend-total, .spend-ranking { padding: .7rem .75rem; }
	.spend-ranking h3 { margin-bottom: .4rem; font-size: .92rem; font-weight: 700; }
	.spend-stack { position: relative; display: flex; height: .5rem; overflow: hidden; margin: .55rem 0 .15rem; border-radius: 1rem; background: var(--chat-surface-2); }
	.spend-stack span { border-right: 1px solid var(--chat-surface); }
	.price-marker { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--chat-fg); }
	.spend-row { display: flex; width: 100%; gap: .45rem; align-items: center; text-align: left; padding: .4rem .2rem; font-size: .8125rem; }
	.rank-bar { display: block; height: 3px; margin-top: .2rem; max-width: 10rem; border-radius: 1rem; background: var(--chat-surface-2); }
	.rank-bar span { display: block; height: 100%; border-radius: inherit; background: var(--accent-2); }
	.empty-copy { padding: .7rem .8rem; font-size: .8125rem; color: var(--chat-fg-muted); }
	.empty-copy a { text-decoration: underline; }
	.usage-disclosure { margin-top: .45rem; }
	.usage-disclosure summary { cursor: pointer; padding: .4rem 0; font-size: .8125rem; font-weight: 650; }
	.info-disclosure { border-top: 1px solid var(--chat-border); }
	.info-disclosure summary { color: var(--chat-fg-muted); }
	@media (max-width: 639px) {
		.usage-overview { padding-inline: .75rem; gap: .8rem; }
		.usage-jumps { padding-inline: 1rem; }
		.spend-grid { grid-template-columns: minmax(0,1fr); }
		.segments button { min-height: 1.95rem; padding-inline: .43rem; }
	}
</style>
