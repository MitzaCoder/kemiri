<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { readTaskRecordFold, saveTaskRecordFold, type TaskRecordRow } from '#lib/task-details.js';

	let { row, title, count, children }: { row: TaskRecordRow; title: string; count?: number; children: Snippet } = $props();
	let expanded = $state(untrack(() => readTaskRecordFold(row)));
	const contentId = $props.id();

	function toggle(): void {
		expanded = !expanded;
		saveTaskRecordFold(row, expanded);
	}
</script>

<div class="border-t border-(--chat-border)">
	<h3>
		<button type="button" class="task-fold" aria-expanded={expanded} aria-controls={contentId} onclick={toggle}>
			<ChevronRightIcon class="size-4 shrink-0 {expanded ? 'rotate-90' : ''}" aria-hidden="true" />{title}
			{#if count !== undefined}<span class="ml-auto pr-2 text-xs font-normal text-(--chat-fg-muted)">{count}</span>{/if}
		</button>
	</h3>
	<div id={contentId} hidden={!expanded}>
		{#if expanded}<div class="flex flex-col gap-3 pb-4">{@render children()}</div>{/if}
	</div>
</div>
