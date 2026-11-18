<script lang="ts">
	import { useOpenTaskId } from '#lib/task-detail-context.js';
	import { isTaskSelfReference } from '#lib/task-reference-highlight.js';
	import { splitTaskMentions } from '#lib/task-chat.js';
	import RefChip from './RefChip.svelte';

	/** For detail prose that was plain text: leave everything except self-references alone. */
	let { text, focusable = true }: { text: string; focusable?: boolean } = $props();
	const openTaskId = useOpenTaskId();
	const pieces = $derived(splitTaskMentions(text, id => isTaskSelfReference(id, openTaskId())));
</script>
{#each pieces as piece}{#if 'taskId' in piece}<RefChip ref={piece.taskId} selfReference {focusable} />{:else}{piece.text}{/if}{/each}
