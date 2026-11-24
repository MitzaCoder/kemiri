<script lang="ts">
	import BanIcon from '@lucide/svelte/icons/ban';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CircleIcon from '@lucide/svelte/icons/circle';
	import CircleHelpIcon from '@lucide/svelte/icons/circle-help';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import LockIcon from '@lucide/svelte/icons/lock';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { PartProofCount, PartsDigest } from '@kemiri/protocol';
	import { PARTS_CHECKLIST_PREVIEW, partsChecklist } from '#lib/request-parts.js';
	import { partTone } from '#lib/task-parts.js';

	let { digest, partProof, taskHref }: { digest: PartsDigest; partProof: readonly PartProofCount[]; taskHref: (id: string) => string } = $props();
	const parts = $derived(partsChecklist(digest, partProof));
	const icons = {
		done: CheckIcon, dropped: BanIcon, working: CircleIcon, answer_needed: CircleHelpIcon, steps_needed: ListChecksIcon,
		failed: TriangleAlertIcon, review: ListChecksIcon, clarifying: CircleHelpIcon, paused: PauseIcon, blocked_by_task: LockIcon, waiting_outside: ClockIcon, todo: CircleIcon,
	};
</script>

{#snippet partRows(rows: typeof parts)}
	<ul class="divide-y divide-(--chat-border)" role="list">
		{#each rows as part (part.id)}
			{@const StateIcon = icons[part.state]}
			{@const tone = partTone(part.state)}
			<li>
				<a class="grid min-h-11 grid-cols-[1.125rem_minmax(0,1fr)_auto] items-start gap-2 rounded-md px-2 py-2 text-sm hover:bg-(--chat-surface-2) focus-visible:outline-2 focus-visible:outline-(--accent-2)" href={taskHref(part.id)}>
					<StateIcon class="size-4 mt-0.5 {tone === 'done' ? 'text-(--chat-success)' : tone === 'working' ? 'fill-current text-(--task-status-working)' : tone === 'needs-you' ? 'text-(--chat-warning)' : 'text-(--chat-fg-muted)'}" aria-label={part.label} role="img" />
					<span class="min-w-0">
						<span class="block font-semibold break-words">{part.title}</span>
						{#if part.summary}<span class="block truncate text-xs text-(--chat-fg-muted)" title={part.summary}>{part.summary}</span>{/if}
						{#if part.proofLabels.length}<span class="block text-xs text-(--chat-fg-muted)">{part.proofLabels.join(' · ')}</span>{/if}
					</span>
					<span class="text-right text-xs leading-5 {part.checks.includes('failed') ? 'text-(--chat-danger)' : 'text-(--chat-fg-muted)'}">{part.checks}</span>
				</a>
			</li>
		{/each}
	</ul>
{/snippet}

<section class="task-reading-section" aria-label="Parts">
	<h2 class="task-detail-heading">Parts <span class="font-normal text-(--chat-fg-muted)">· {digest.done} of {digest.total} done</span></h2>
	<div class="overflow-hidden rounded-lg border border-(--chat-border)">
		{@render partRows(parts.slice(0, PARTS_CHECKLIST_PREVIEW))}
		{#if parts.length > PARTS_CHECKLIST_PREVIEW}
			<details class="border-t border-(--chat-border)">
				<summary class="task-fold gap-1.5 px-2 text-sm font-medium"><ChevronRightIcon class="size-4 shrink-0" aria-hidden="true" />…{parts.length - PARTS_CHECKLIST_PREVIEW} more parts</summary>
				{@render partRows(parts.slice(PARTS_CHECKLIST_PREVIEW))}
			</details>
		{/if}
	</div>
</section>
