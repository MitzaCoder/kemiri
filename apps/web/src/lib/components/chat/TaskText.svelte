<script lang="ts">
	import { splitTaskMentions } from '#lib/task-chat.js';
	import { useTaskLinks } from '#lib/task-links.svelte.js';
	import RefChip from '../RefChip.svelte';
	import { useOpenTaskId } from '#lib/task-detail-context.js';
	import { isTaskSelfReference } from '#lib/task-reference-highlight.js';
	import TaskChip from './TaskChip.svelte';

	/**
	 * A line of the harness' words with each task it names as a link to that task, inline: put it in an element that
	 * truncates, so a long line ends in one ellipsis. `titles` adds the task's title to the
	 * link, for text that only has the ID.
	 */
	let { text, titles = false }: { text: string; titles?: boolean } = $props();

	const links = useTaskLinks();
	const openTaskId = useOpenTaskId();
	const pieces = $derived.by(() => {
		const current = links();
		return splitTaskMentions(text, id => isTaskSelfReference(id, openTaskId()) || current?.title(id) !== undefined);
	});
</script>

{#each pieces as piece, index (index)}
	{#if 'taskId' in piece}
		{#if isTaskSelfReference(piece.taskId, openTaskId())}<RefChip ref={piece.taskId} selfReference />
		{:else}<TaskChip taskId={piece.taskId} title={titles ? links()?.title(piece.taskId) : undefined} href={links()?.href(piece.taskId)} />{/if}
	{:else}
		{piece.text}
	{/if}
{/each}
