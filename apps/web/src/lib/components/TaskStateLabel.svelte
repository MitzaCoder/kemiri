<script lang="ts">
	import type { BoardTask } from '@kemiri/protocol';
	import { activityMinute } from '#lib/activity-minute.js';
	import { relativeTime } from '#lib/relative-time.js';
	import { taskDisplayWords } from '#lib/tasks.js';
	let { task, tasks = [] }: { task: BoardTask; tasks?: readonly BoardTask[] } = $props();
</script>
{taskDisplayWords(task, tasks)}{#if task.state?.kind === 'paused'}<span class="font-normal text-(--chat-fg-subtle)"> · {relativeTime(task.state.since, $activityMinute)}</span>{/if}
