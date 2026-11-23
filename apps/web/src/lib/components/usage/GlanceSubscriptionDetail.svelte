<script lang="ts">
	import { projectHref } from '#lib/backends.js';
	import { harness } from '#lib/harness.svelte.js';
	import { backendSettingsHref } from '#lib/settings.js';
	import { taskHref } from '#lib/task-chat.js';
	import { usageModal } from '#lib/usage-modal.svelte.js';
	import { computerNames, rankedLimits, type GlanceSubscription, type SubscriptionMonth } from '#lib/usage-glance.js';
	import { usageMoney } from '#lib/usage-money.js';
	import GlanceLimitCard from './GlanceLimitCard.svelte';
	import SubscriptionResets from './SubscriptionResets.svelte';

	let { subscription, monthly, loading, monthLabel, now }: {
		subscription: GlanceSubscription; monthly: SubscriptionMonth | undefined; loading: boolean; monthLabel: string; now: number;
	} = $props();
	let openedLimit = $state<string>();
	const limits = $derived(rankedLimits([subscription], now));
	const price = $derived(monthly?.price);
	const models = $derived.by(() => {
		const grouped = new Map<string, { model: string; cost: number; computers: SubscriptionMonth['portions'][number]['computer'][] }>();
		for (const { value, computer } of monthly?.portions ?? []) for (const model of value.models) {
			const total = grouped.get(model.model) ?? { model: model.model, cost: 0, computers: [] };
			total.cost += model.apiValue;
			total.computers.push(computer);
			grouped.set(model.model, total);
		}
		return [...grouped.values()].sort((a, b) => b.cost - a.cost);
	});
	const tasks = $derived(monthly?.portions.flatMap(({ value, computer }) => value.topTasks.map(task => ({ ...task, computer })))
		.sort((a, b) => b.apiValue - a.apiValue) ?? []);
	const coordinatorProjects = $derived(monthly?.portions.flatMap(({ value, computer }) => (value.coordinatorProjects ?? []).map(project => ({ ...project, computer })))
		.sort((a, b) => b.apiValue - a.apiValue) ?? []);

	const resetMember = $derived(subscription.members.find(member => member.subscription.manualResets != null));
	const resetBackend = $derived(harness.backends.find(backend => backend.id === resetMember?.computer.id && backend.ready));

	function followTask(event: MouseEvent) {
		if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) usageModal.open = false;
	}
</script>

<p class="text-xs text-muted-foreground">{[subscription.reading.plan, monthLabel, computerNames(subscription.members.map(member => member.computer))].filter(Boolean).join(' · ')}</p>
{#if subscription.reading.account}<p class="mt-1 break-words text-xs text-muted-foreground">{subscription.reading.account}</p>{/if}
<section class="mt-4 space-y-2">
	<h3 class="font-semibold">Limits</h3>
	{#if limits.length}
		<div class="subscription-limits"><ul class="grid gap-2">
			{#each limits as limit (limit.key)}<GlanceLimitCard {limit} {now} grouped open={openedLimit === limit.key} toggle={() => openedLimit = openedLimit === limit.key ? undefined : limit.key} />{/each}
		</ul></div>
	{:else}<p class="text-muted-foreground">No limits reported.</p>{/if}
	{#if resetMember}<SubscriptionResets subscription={resetMember.subscription} {...(resetBackend ? { backend: resetBackend } : {})} />{/if}
</section>
<section class="mt-5 space-y-2">
	<h3 class="font-semibold">This month</h3>
	{#if loading}<p role="status" class="text-muted-foreground">Reading this month’s usage…</p>
	{:else if monthly}
		<p><strong class="text-2xl tabular-nums">{usageMoney(monthly.cost)}</strong> <span class="text-muted-foreground">of work at API prices</span></p>
		{#if monthly.portions.length < subscription.members.length}<p class="text-xs text-muted-foreground">Some computers did not report this month’s subscription usage.</p>{/if}
		<p class="text-muted-foreground">{price?.monthlyPrice != null ? `${usageMoney(price.monthlyPrice)} a month${price.kind === 'default' ? ' · default price' : ''}` : 'Monthly price not set'}{price?.monthlyPrice && monthly.portions.length === subscription.members.length ? ` · ${(monthly.cost / price.monthlyPrice).toFixed(1)}× the price` : ''}</p>
		{#if monthly.priceConflict}<p class="text-xs text-muted-foreground">Prices differ across computers. The comparison uses an owner price before a default, and the highest when those differ.</p>{/if}
		{#if price?.source}<a class="text-xs underline underline-offset-4" href={price.source} target="_blank" rel="noopener noreferrer">Price source{price.checkedOn ? ` · checked ${price.checkedOn}` : ''}</a>{/if}
	{:else}<p class="text-muted-foreground">No monthly subscription report is available.</p>{/if}
	<div class="flex flex-wrap gap-x-3 gap-y-1">
		{#each subscription.members as { computer } (computer.id)}<a class="text-xs underline underline-offset-4" href={backendSettingsHref(computer.id, 'accounts')} onclick={followTask}>Accounts on {computer.name}</a>{/each}
	</div>
</section>
{#if models.length}
	<section class="mt-5 space-y-2">
		<h3 class="font-semibold">Models</h3>
		<ul class="divide-y divide-(--chat-border) rounded-xl border border-(--chat-border) px-3">
			{#each models as model (model.model)}<li class="flex justify-between gap-3 py-2"><span class="min-w-0 break-words">{model.model}<small class="block text-muted-foreground">{computerNames(model.computers)}</small></span><strong class="shrink-0 tabular-nums">{usageMoney(model.cost)}</strong></li>{/each}
		</ul>
	</section>
{/if}
{#if tasks.length || coordinatorProjects.length}
	<section class="mt-5 space-y-2">
		<h3 class="font-semibold">Top tasks and coordinator work</h3>
		<ul class="divide-y divide-(--chat-border) rounded-xl border border-(--chat-border)">
			{#each tasks as task (JSON.stringify([task.computer.id, task.projectId, task.taskId]))}<li><a class="flex justify-between gap-3 px-3 py-2 hover:bg-muted" href={projectHref(task.computer.id, task.projectId) + taskHref(task.taskId)} onclick={followTask}><span class="min-w-0 break-words">{task.title}<small class="block text-muted-foreground">{task.computer.name} · {task.taskId}</small></span><strong class="shrink-0 tabular-nums">{usageMoney(task.apiValue)}</strong></a></li>{/each}
			{#each coordinatorProjects as project (JSON.stringify([project.computer.id, project.projectId]))}<li class="flex justify-between gap-3 px-3 py-2"><span class="min-w-0 break-words">Coordinator · {harness.backends.find(backend => backend.id === project.computer.id)?.projects.find(entry => entry.id === project.projectId)?.name ?? project.projectId}<small class="block text-muted-foreground">{project.computer.name}</small></span><strong class="shrink-0 tabular-nums">{usageMoney(project.apiValue)}</strong></li>{/each}
		</ul>
	</section>
{/if}

<style>
	.subscription-limits { container-type: inline-size; }
</style>
