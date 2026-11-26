<script lang="ts">
	import { MediaQuery } from 'svelte/reactivity';
	import { tick } from 'svelte';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import { questionBadgeText } from '#lib/board.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import ThreadStatusBadge from './chat/ThreadStatusBadge.svelte';
	import { conversationChoices, conversationMenuIndex } from '#lib/conversation-switcher.js';
	import CoordinatorMark from './CoordinatorMark.svelte';
	import CoordinatorBadges from './CoordinatorBadges.svelte';
	import { coordinatorBadges, coordinatorHref, coordinatorStatus } from '#lib/coordinators.js';
	import { threadActivityLine } from '#lib/threads.js';
	import { overviewRosterLine } from '#lib/coordinator-overview.js';
	import type { BoardQuestion, Overview, ThreadSummary } from '@kemiri/protocol';
	let { shown = true, projectName, backendId, projectId, threadId, threads, questions, now, counts, onshowall, roster, seen, onnew, onalltasks, onmanage, onedit, onprefetch, archivedCoordinator, overviewRows, onrosteropen }: {
		shown?: boolean; projectName: string; backendId: string; projectId: string; threadId?: string;
		threads: readonly ThreadSummary[]; questions: readonly BoardQuestion[]; now: number;
		counts: { needsYou: number; working: number }; onshowall: () => void;
		roster?: readonly ThreadSummary[]; seen?: (id: string) => string | null;
		archivedCoordinator?: ThreadSummary;
		overviewRows?: Overview['coordinators'];
		onrosteropen?: (open: boolean) => void;
		onedit?: (coordinator: ThreadSummary) => void; onprefetch?: (id: string) => void;
		onnew?: () => void; onalltasks?: () => void; onmanage?: () => void;
	} = $props();
	const phone = new MediaQuery('(max-width: 639px)');
	const switcherId = $props.id();
	let open = $state(false);
	let expanded = $state(false);
	$effect(() => { if (!shown) open = false; });
	$effect(() => onrosteropen?.(shown && open && !!roster));
	let trigger = $state<HTMLButtonElement | null>(null);
	const choices = $derived(conversationChoices(roster ? threads.filter(row => row.kind !== 'coordinator') : threads, backendId, projectId, threadId, now));
	const thread = $derived(archivedCoordinator ?? threads.find(thread => thread.id === (threadId ?? (roster ? 'main' : undefined))));
	const coordinator = $derived(thread && (thread.main || thread.kind === 'coordinator') ? thread : undefined);
	const coordinatorActivity = $derived(coordinator ? coordinatorBadges(coordinator) : undefined);
	const otherCoordinatorsNeedingAttention = $derived(roster?.filter(row => row.id !== (threadId ?? 'main') && coordinatorBadges(row).needsYou > 0).length ?? 0);
	const attentionBadge = $derived(questionBadgeText(otherCoordinatorsNeedingAttention));
	const titleTooltip = $derived(coordinator?.area || 'Switch conversation (Alt+J)');
	function close() { open = false; trigger?.focus(); }
	function choose(event: MouseEvent, current: boolean) {
		if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
		if (current) event.preventDefault();
		close();
	}
	function keyboard(event: KeyboardEvent) {
		if (event.key === 'Escape') { event.preventDefault(); close(); return; }
		const menu = event.currentTarget as HTMLElement;
		const rows = Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"]'));
		const index = conversationMenuIndex(event.key, rows.indexOf(document.activeElement as HTMLElement), rows.length);
		if (index !== undefined) { event.preventDefault(); rows[index]?.focus(); }
	}
	async function focusMenu(event: Event) {
		event.preventDefault(); await tick();
		document.querySelector<HTMLElement>('[data-conversation-menu] [role="menuitem"]')?.focus();
	}
	function shortcut(event: KeyboardEvent) {
		if (shown && !event.defaultPrevented && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === 'j') {
			event.preventDefault(); open = true;
		}
	}
</script>

<svelte:window onkeydown={shortcut} />

{#snippet title()}
	{#if roster}
		{#if coordinator}<span class="flex shrink-0 items-center @max-[7rem]/switcher:hidden"><CoordinatorMark thread={coordinator} /></span>{/if}
		<span class="min-w-0 leading-tight"><small class="block truncate text-[.65rem] text-(--chat-fg-muted)">{projectName}</small><strong class="block truncate">{thread?.title || threadId || 'General'}</strong></span>
		{#if coordinator}
			{#if coordinator.archived}
				<span class="shrink-0 text-xs text-(--chat-fg-subtle)">Archived</span>
			{:else if coordinatorActivity?.paused}
				<span class="shrink-0 text-(--chat-fg-muted) @max-[7rem]/switcher:sr-only" role="img" aria-label="Paused" title="Paused"><PauseIcon class="size-3.5" /></span>
			{:else if coordinatorActivity?.working}
				<span class="shrink-0 text-(--accent-2) @max-[7rem]/switcher:sr-only" role="img" aria-label="Working" title="Working"><LoaderCircleIcon class="size-3.5 motion-safe:animate-spin" /></span>
			{/if}
		{:else if thread}<ThreadStatusBadge {thread} class="shrink-0" />{/if}
	{:else}
		<span class="min-w-0 truncate"><strong>{threadId ? thread?.title || threadId : projectName}</strong>{#if !threadId}<span class="font-normal text-(--chat-fg-subtle)"> · Main chat</span>{/if}</span>
		{#if thread}<ThreadStatusBadge {thread} class="shrink-0" />{/if}
	{/if}
	<ChevronDownIcon class="size-3.5 shrink-0 text-(--chat-fg-muted)" />
	{#if attentionBadge}
		<span class="coordinator-attention shrink-0" title={`${otherCoordinatorsNeedingAttention} other coordinators need attention`}>
			<span aria-hidden="true">{attentionBadge}</span><span class="sr-only">{otherCoordinatorsNeedingAttention} other {otherCoordinatorsNeedingAttention === 1 ? 'coordinator needs' : 'coordinators need'} attention</span>
		</span>
	{/if}
{/snippet}
{#snippet list()}
	<div role="menu" tabindex="-1" aria-label="Conversations" data-conversation-menu onkeydown={keyboard} class="max-h-[70dvh] overflow-y-auto overscroll-contain p-1">
		{#if roster}
			{#each archivedCoordinator ? [...roster, archivedCoordinator] : roster as coordinator (coordinator.id)}
				{@const here = coordinator.id === (threadId ?? 'main')}
				{@const areaId = `${switcherId}-area-${coordinator.id}`}
				{@const facts = overviewRosterLine(overviewRows?.find(row => row.coordinatorId === coordinator.id)?.counts)}
				<div class="coordinator-choice" class:current-coordinator={here}>
					<a role="menuitem" href={coordinatorHref(backendId, projectId, coordinator.id)} onclick={event => choose(event, here)}
						onpointerenter={event => { if (event.pointerType === 'mouse' && !here) onprefetch?.(coordinator.id); }}
						aria-current={here ? 'page' : undefined} aria-describedby={areaId} class="conversation-choice">
						<span class="flex items-center gap-2"><CoordinatorMark thread={coordinator} /><strong class="min-w-0 flex-1 wrap-anywhere">{coordinator.title}</strong><span class="shrink-0 text-xs text-(--chat-fg-muted)">{coordinator.archived ? 'Archived' : coordinatorBadges(coordinator).state}</span><CoordinatorBadges thread={coordinator} seen={seen?.(coordinator.id)} /></span>
						{#if facts}<span class="pl-8 text-xs text-(--chat-fg-muted)" data-overview-facts>{facts}</span>{/if}
						{#if coordinatorStatus(coordinator)}<span class="truncate pl-8 text-xs text-(--chat-fg-subtle)">{coordinatorStatus(coordinator)}</span>{/if}
					</a>
					<div class="flex items-start gap-2 px-3 pb-2 pl-11 text-xs text-(--chat-fg-muted)">
						<p id={areaId} class="min-w-0 flex-1 wrap-anywhere whitespace-pre-line">{coordinator.area || 'No area set'}</p>
						{#if here && !coordinator.archived && onedit}
							<button role="menuitem" aria-label="Edit area" class="shrink-0 rounded px-1.5 py-0.5 font-medium text-(--accent-2) hover:bg-(--chat-surface-2) focus-visible:outline-2" onclick={() => { close(); onedit(coordinator); }}>Edit</button>
						{/if}
					</div>
				</div>
				{#each [...choices.visible, ...(expanded ? choices.finished : [])].filter(job => (job.thread.parentThreadId ?? 'main') === coordinator.id) as row (row.href)}
					<div class="ml-5 border-l border-(--chat-border) pl-2">{@render job(row)}</div>
				{/each}
			{/each}
			{#if choices.finished.length}<button role="menuitem" class="conversation-choice w-full" aria-expanded={expanded} onclick={() => expanded = !expanded}>Finished jobs ({choices.finished.length})</button>{/if}
			<div class="mt-1 flex flex-wrap gap-1 border-t border-(--chat-border) pt-1">
				<button role="menuitem" class="conversation-choice font-semibold" onclick={() => { close(); onnew?.(); }}>+ New coordinator</button>
				<button role="menuitem" class="conversation-choice" onclick={() => { close(); onalltasks?.(); }}>All tasks</button>
				<button role="menuitem" class="conversation-choice" onclick={() => { close(); onmanage?.(); }}>Manage</button>
			</div>
		{:else}
		<a role="menuitem" href={choices.main.href} onclick={event => choose(event, choices.main.current)} class="conversation-choice">
			<span class="font-semibold">Main chat</span>
			<span class="text-xs text-(--chat-fg-muted)">You talk here. It hands big jobs to the background and reports back.</span>
			{#if choices.main.current}<span class="text-xs text-(--accent-2)">You are here</span>{/if}
		</a>
		<h2 class="px-3 pt-3 pb-1 text-xs font-semibold text-(--chat-fg-subtle)">Background jobs</h2>
		{#each choices.visible as row (row.href)}{@render job(row)}{/each}
		{#if choices.finished.length}
			<button role="menuitem" aria-expanded={expanded} class="conversation-choice w-full text-left text-sm" onclick={() => expanded = !expanded}>Finished ({choices.finished.length}) {expanded ? '▴' : '▾'}</button>
			{#if expanded}{#each choices.finished as row (row.href)}{@render job(row)}{/each}{/if}
		{/if}
		<button role="menuitem" class="conversation-choice mt-1 w-full border-t border-(--chat-border) text-left font-medium" onclick={() => { close(); onshowall(); }}>All background jobs</button>
		{/if}
	</div>
{/snippet}
{#snippet job(row: ReturnType<typeof conversationChoices>['visible'][number])}
	<a role="menuitem" href={row.href} onclick={event => choose(event, row.current)} class="conversation-choice">
		<span class="flex items-center gap-2"><span class="min-w-0 flex-1 truncate font-semibold">{row.title}</span><ThreadStatusBadge thread={row.thread} /></span>
		<span class="line-clamp-2 text-xs text-(--chat-fg-muted)">{threadActivityLine(row.thread, questions, now)}</span>
		{#if row.current}<span class="text-xs text-(--accent-2)">You are here</span>{/if}
	</a>
{/snippet}

<div class="@container/switcher flex min-w-0 flex-1 flex-wrap items-center gap-1 sm:flex-nowrap">
	{#if phone.current}
		<Dialog.Root bind:open>
			<Dialog.Trigger bind:ref={trigger} class="switcher-trigger max-sm:w-full" aria-haspopup="menu" aria-keyshortcuts="Alt+J" title={titleTooltip}>{@render title()}</Dialog.Trigger>
			<Dialog.Content class="top-auto bottom-0 left-0 w-full max-w-none translate-x-0 translate-y-0 gap-1 rounded-b-none p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]" onOpenAutoFocus={focusMenu} onCloseAutoFocus={event => { event.preventDefault(); trigger?.focus(); }}>
				<Dialog.Title class="px-3 py-2 font-semibold">{roster ? 'Coordinators' : 'Conversations'}</Dialog.Title>
				<Dialog.Description class="sr-only">{roster ? 'Switch between coordinators and their background jobs.' : 'Switch between Main chat and background jobs.'}</Dialog.Description>
				{@render list()}
			</Dialog.Content>
		</Dialog.Root>
	{:else}
		<Popover.Root bind:open>
			<Popover.Trigger bind:ref={trigger} class="switcher-trigger max-sm:w-full" aria-haspopup="menu" aria-keyshortcuts="Alt+J" title={titleTooltip}>{@render title()}</Popover.Trigger>
			<Popover.Content align="start" class="w-[28rem] max-w-[calc(100vw-2rem)] gap-0 p-1" onOpenAutoFocus={focusMenu} onCloseAutoFocus={event => { event.preventDefault(); trigger?.focus(); }}>{@render list()}</Popover.Content>
		</Popover.Root>
	{/if}
	{#if !roster}<div class="flex shrink-0 gap-1 pb-1 text-[0.625rem] sm:pb-0" aria-label="Background job counts">
		<span class="rounded-full bg-(--chat-warning)/10 px-1.5 py-1 text-(--chat-warning)" title="Background jobs needing you">{counts.needsYou} needs you</span>
		<span class="rounded-full bg-(--chat-surface-2) px-1.5 py-1 text-(--chat-fg-muted)" title="Background jobs working">{counts.working} working</span>
	</div>{/if}
</div>
<style>
	:global(.switcher-trigger) { display:flex; align-items:center; gap:0.375rem; min-width:0; min-height:2.75rem; border-radius:0.375rem; padding:0.25rem 0.375rem; font-size:0.9375rem; text-align:left; }
	:global(.switcher-trigger:hover) { background:var(--chat-surface-2); }
	:global(.switcher-trigger:focus-visible) { outline:2px solid var(--accent-2); }
	.conversation-choice { display:flex; flex-direction:column; gap:0.25rem; padding:0.625rem 0.75rem; border-radius:0.375rem; font-size:0.8125rem; }
	.coordinator-choice { border-radius: 0.375rem; }
	.coordinator-choice .conversation-choice { padding-bottom: 0.25rem; }
	.current-coordinator { box-shadow:inset 2px 0 var(--accent-2); background:color-mix(in srgb,var(--accent-2) 8%,var(--chat-bg)); }
	.coordinator-attention { min-width: 1rem; padding-inline: 0.25rem; border-radius: 1rem; background: color-mix(in srgb, var(--chat-warning) 12%, var(--chat-bg)); color: var(--chat-warning); font-size: 0.625rem; font-weight: 600; text-align: center; }
	.conversation-choice:hover, .conversation-choice:focus { background:var(--chat-surface-2); outline:2px solid transparent; }
</style>
