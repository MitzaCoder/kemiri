<script lang="ts">
	import type { RefStatus } from '@kemiri/protocol';
	import TaskDetailText from './TaskDetailText.svelte';
	import ChevronDownIcon from '@lucide/svelte/icons/chevron-down';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import { useRefLinks } from '#lib/ref-links.svelte.js';
	import { refHref, refStatusToneClass, refStatusWords, refTooltip } from '#lib/refs.js';
	import { refLabel } from '#lib/tasks.js';
	import { taskRefSummary } from '#lib/task-ref-summary.js';
	let { refs, compact }: { refs: readonly string[]; compact: boolean } = $props();
	const links = useRefLinks();
	let expanded = $state(false);
	const contentId = $props.id();
	const summary = $derived(taskRefSummary(refs.map((ref) => links()?.status(ref))));
</script>

{#snippet refState(status: RefStatus | undefined)}
	{#if status}
		<span class="inline-flex min-w-0 items-center gap-1.5 font-medium {refStatusToneClass(status)}">
			<span class="task-status-dot shrink-0" aria-hidden="true"></span><span class:truncate={compact}>{refStatusWords(status)}</span>
		</span>
	{:else}<span class="text-(--chat-fg-subtle)">Link</span>{/if}
{/snippet}

{#if compact && refs.length <= 2}
	{#each refs as ref (ref)}
		{@const status = links()?.status(ref)}
		{@const href = status?.url ?? refHref(ref, links()?.links)}
		{@const label = refLabel(ref, links()?.links)}
		<svelte:element this={href ? 'a' : 'span'} {href} target={href ? '_blank' : undefined} rel={href ? 'noopener noreferrer' : undefined}
			class="task-meta-chip" title={refTooltip(ref, label, links()?.links, status)}>
			<span class="max-w-36 truncate font-mono">{label}</span>{@render refState(status)}
		</svelte:element>
	{/each}
{:else}
	<div data-task-refs class={compact ? 'task-ref-disclosure' : 'min-w-0 rounded-lg border border-(--chat-border)/70'}>
		{#if compact}
			<button type="button" class="task-meta-chip" aria-expanded={expanded} aria-controls={contentId} onclick={() => expanded = !expanded}>
				{summary.counts}<ChevronDownIcon class="size-3 shrink-0 {expanded ? 'rotate-180' : ''}" aria-hidden="true" />
			</button>
		{:else}
			<button type="button" aria-expanded={expanded} aria-controls={contentId} onclick={() => expanded = !expanded}
				class="flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-(--chat-surface-2)/70 focus-visible:outline-2 focus-visible:outline-(--chat-ring)">
				<ChevronRightIcon class="size-3.5 shrink-0 text-(--chat-fg-subtle) {expanded ? 'rotate-90' : ''}" aria-hidden="true" />
				<span class="min-w-0 flex-1 text-xs">
					<span class="block font-medium text-(--chat-fg-muted)">{summary.counts}</span>
					{#if summary.status}<span class="block text-[0.6875rem] {summary.attention ? 'text-(--chat-danger)' : 'text-(--chat-fg-subtle)'}">{summary.status}</span>{/if}
				</span>
				<span class="shrink-0 text-[0.6875rem] text-(--chat-fg-subtle)">{expanded ? 'Hide' : 'Show'}</span>
			</button>
		{/if}
		<div id={contentId} hidden={!expanded} class:task-ref-list-container={compact}>
			{#if expanded}
				<!-- svelte-ignore a11y_no_noninteractive_tabindex (the bounded refs region supports keyboard scrolling) -->
				<div role="region" aria-label="Task references" tabindex={compact ? undefined : 0} data-task-ref-list
					class={compact ? 'mt-1 rounded-lg border border-(--chat-border) px-2.5 py-1' : 'max-h-[min(15rem,25dvh)] overflow-y-auto overscroll-contain border-t border-(--chat-border)/70 px-2.5 py-1'}>
					<ul class="flex flex-col gap-0.5">
						{#each refs as ref (ref)}
							{@const status = links()?.status(ref)}
							{@const href = status?.url ?? refHref(ref, links()?.links)}
							{@const label = refLabel(ref, links()?.links)}
							<li class="min-w-0">
								<svelte:element this={href ? 'a' : 'span'} {href} target={href ? '_blank' : undefined} rel={href ? 'noopener noreferrer' : undefined}
									title={refTooltip(ref, label, links()?.links, status)} class="ref-line flex min-h-9 min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md py-1.5 text-xs hover:bg-(--chat-surface-2)/70">
									<span class="task-ref max-w-[9rem] truncate">{label}</span>
									{@render refState(status)}
									{#if href}<ExternalLinkIcon class="ml-auto size-3 shrink-0 text-(--chat-fg-subtle)" aria-hidden="true" />{/if}
									{#if status?.title}<span class="basis-full break-words text-(--chat-fg-subtle)"><TaskDetailText text={status.title} /></span>{/if}
								</svelte:element>
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>
	</div>
{/if}
