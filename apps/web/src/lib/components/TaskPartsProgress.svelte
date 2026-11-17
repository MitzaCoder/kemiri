<script lang="ts">
	import type { BoardTask } from '@kemiri/protocol';
	import { taskPartProgress } from '#lib/task-parts.js';

	/** Inline contents only: the list keeps its disclosure button and spacing. */
	let { task }: { task: Pick<BoardTask, 'subtaskStates' | 'subtaskCount'> } = $props();
	const parts = $derived(taskPartProgress(task));
	const progress = $derived(task.subtaskCount);
</script>

{#if parts}
	<span class="parts-bar" class:proportional={parts.proportional} aria-hidden="true">
		{#each parts.segments as segment}<span class="part-segment {segment.tone}" style:flex-grow={segment.count}></span>{/each}
	</span>
	<span class="parts-text">{parts.text}</span>
{:else if progress && progress.total > 0}
	<svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true">
		<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.2" />
		<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5" pathLength="1" stroke-dasharray="{progress.done / progress.total} 1" transform="rotate(-90 8 8)" />
	</svg>
	{progress.done}/{progress.total}
{:else}Subtasks{/if}

<style>
	.parts-bar { display: inline-flex; flex: 0 0 48px; height: 6px; gap: 2px; overflow: hidden; border-radius: 2px; }
	.parts-bar.proportional { gap: 0; }
	.part-segment { flex-basis: 0; min-width: 0; background: var(--chat-fg-subtle); }
	.part-segment.done { background: var(--chat-success); }
	.part-segment.working { background: var(--tone-ring); }
	.part-segment.needs-you { background: var(--chat-warning); }
	.parts-text { white-space: normal; }
</style>
