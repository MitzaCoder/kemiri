<script lang="ts">
	import type { RecordedUsage, RecordedUsageGroup, UsageDetailRequest } from '@kemiri/protocol';
	import { projectHref } from '#lib/backends.js';
	import { tokens } from '#lib/cache-stats.js';
	import { harness } from '#lib/harness.svelte.js';
	import { taskHref } from '#lib/task-chat.js';
	import { computerNames, sumUsage, type SpendRow } from '#lib/usage-glance.js';
	import { usageMoney } from '#lib/usage-money.js';
	import { usageModal } from '#lib/usage-modal.svelte.js';
	import Banner from '#lib/components/Banner.svelte';

	let { row, period, periodLabel, overallCost, openTask }: {
		row: SpendRow; period: Omit<UsageDetailRequest, 'type' | 'id' | 'selection'>; periodLabel: string;
		overallCost: number; openTask: (row: SpendRow) => void;
	} = $props();

	let readings = $state<{ computerId: string; usage?: RecordedUsage; problem?: string }[]>([]);
	let loading = $state(true);
	const totals = $derived(sumUsage(row.portions.map(portion => portion.group)));
	const selection = $derived(row.portions[0]?.selection);

	$effect(() => {
		const queries = row.portions.map(({ computer, selection }) => ({ computer, selection, backend: harness.backends.find(backend => backend.id === computer.id) }));
		const range = period;
		let ignore = false;
		loading = true;
		readings = [];
		void Promise.all(queries.map(async ({ computer, selection, backend }) => {
			const computerId = computer.id;
			if (!backend?.ready) return { computerId, problem: `${computer.name} is not connected.` };
			if (!selection || !backend.supports('recorded-usage')) return { computerId, problem: `${computer.name} does not report this breakdown yet.` };
			try { return { computerId, usage: await backend.client.readUsageDetail({ ...range, selection }) }; }
			catch { return { computerId, problem: `Could not read the breakdown from ${computer.name}.` }; }
		})).then((answers) => {
			if (ignore) return;
			readings = answers;
			loading = false;
		});
		return () => { ignore = true; };
	});

	const sections = [ ['byTask', 'Tasks', 'task'], ['byProject', 'Projects', 'project'], ['byModel', 'Models', 'model'], ['byRole', 'Who called', 'role'] ] as const;
	function breakdown(field: typeof sections[number][0]) {
		const totals = new Map<string, { label: string; cost: number; row: SpendRow }>();
		for (const { computerId, usage } of readings) {
			const computer = row.portions.find(portion => portion.computer.id === computerId)!.computer;
			for (const group of usage?.[field] ?? []) {
				const [projectId, taskId] = field === 'byTask' ? JSON.parse(group.key) as [string, string | null] : [null, null];
				const key = field === 'byTask' || field === 'byProject' ? JSON.stringify([computerId, group.key]) : group.key;
				const total = totals.get(key) ?? { label: group.label, cost: 0, row: { key, label: group.label, cost: 0, portions: [] } };
				total.cost += group.cost;
				total.row.cost += group.cost;
				total.row.portions.push({ computer, group, selection: projectId !== null && taskId !== null ? { kind: 'task', projectId, taskId } : null });
				totals.set(key, total);
			}
		}
		return [...totals.values()].sort((a, b) => b.cost - a.cost || a.row.key.localeCompare(b.row.key));
	}

	const tokenFields: [keyof RecordedUsageGroup, string][] = [ ['inputTokens', 'Input'], ['cacheReadTokens', 'Cache read'], ['cacheWriteTokens', 'Cache write'], ['outputTokens', 'Output'] ];
	function followTask(event: MouseEvent) {
		if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) usageModal.open = false;
	}
</script>

<p class="text-xs text-muted-foreground">{periodLabel} · {computerNames(row.portions.map(portion => portion.computer))}</p>
<p class="text-3xl font-bold tracking-tight tabular-nums">{usageMoney(totals.cost)}</p>
<p class="text-sm text-muted-foreground">of work at API prices{overallCost > 0 ? ` · ${(100 * totals.cost / overallCost).toFixed(1)}% of everything recorded` : ''}</p>
{#if row.portions.length > 1}
	<dl class="mt-3 grid gap-1 text-xs text-muted-foreground">
		{#each row.portions as portion (portion.computer.id)}<div class="flex justify-between gap-2"><dt>{portion.computer.name}</dt><dd>{usageMoney(portion.group.cost)}</dd></div>{/each}
	</dl>
{/if}
{#if selection?.kind === 'task' && row.portions[0]}
	<a class="mt-3 inline-block font-semibold underline underline-offset-4" href={projectHref(row.portions[0].computer.id, selection.projectId) + taskHref(selection.taskId)} onclick={followTask}>Open the task</a>
{/if}
{#if loading}<p class="mt-4 text-sm text-muted-foreground" role="status">Reading breakdown…</p>{/if}
{#each readings.filter(reading => reading.problem) as reading (reading.computerId)}<Banner tone="warning">{reading.problem}</Banner>{/each}
{#each sections as [field, title, kind] (field)}
	{@const groups = breakdown(field)}
	{#if selection?.kind !== kind && groups.length}
		<section class="mt-5">
			<h3 class="mb-2 font-semibold">{title}</h3>
			<ul class="divide-y divide-(--chat-border) rounded-xl border border-(--chat-border)">
				{#each groups as group (group.row.key)}
					<li>
						{#snippet breakdownRow()}
							<span class="min-w-0 break-words">{group.label}<small class="block text-muted-foreground">{computerNames(group.row.portions.map(portion => portion.computer))}</small></span>
							<span class="shrink-0 font-semibold tabular-nums">{usageMoney(group.cost)}</span>
						{/snippet}
						{#if group.row.portions[0]?.selection}
							<button class="flex w-full justify-between gap-3 px-3 py-2.5 text-left hover:bg-muted" type="button" onclick={() => openTask(group.row)}>{@render breakdownRow()}</button>
						{:else}
							<div class="flex justify-between gap-3 px-3 py-2.5">{@render breakdownRow()}</div>
						{/if}
					</li>
				{/each}
			</ul>
		</section>
	{/if}
{/each}
<section class="mt-5">
	<h3 class="mb-2 font-semibold">Tokens</h3>
	<dl class="divide-y divide-(--chat-border) rounded-xl border border-(--chat-border) px-3">
		{#each tokenFields as [field, label] (field)}<div class="flex justify-between gap-3 py-2"><dt>{label}</dt><dd class="tabular-nums" title={String(totals[field])}>{tokens(Number(totals[field]))}</dd></div>{/each}
	</dl>
</section>
{#if totals.unpricedRequests > 0}<p class="mt-3 text-xs text-muted-foreground">{totals.unpricedRequests} requests had no catalog price.</p>{/if}
