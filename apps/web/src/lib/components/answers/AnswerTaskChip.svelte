<script lang="ts">
	import { taskDisplayToneClass, taskDisplayWords } from '#lib/tasks.js';
	import type { BoardTask } from '@kemiri/protocol';

	let { id, task, href, showTitle = false, onclick }: {
		id: string; task?: BoardTask; href: string; showTitle?: boolean; onclick: (event: MouseEvent) => void;
	} = $props();
	const status = $derived(task ? taskDisplayWords(task) : undefined);
</script>

<a {href} {onclick} data-no-task-preview title={task ? `${id} ${task.title} · ${status}` : id}
	class="inline-flex max-w-full items-center gap-1.5 rounded-full border border-(--chat-border) bg-(--chat-surface-2)/65 px-2 py-0.5 text-xs text-(--chat-fg-muted) hover:border-(--accent-2) hover:text-(--chat-fg) {task ? taskDisplayToneClass(task) : ''}">
	{#if task}<span class="task-status-dot" aria-hidden="true"></span>{/if}
	<span class="truncate"><span class="font-medium">{id}</span>{showTitle && task ? ` ${task.title}` : ''}{status ? ` · ${status}` : ''}</span>
</a>
