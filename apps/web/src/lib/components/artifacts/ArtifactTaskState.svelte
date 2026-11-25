<script lang="ts">
	import type { ArtifactTaskFacts } from '@kemiri/protocol';
	import { libraryDate } from '#lib/artifact-library.js';
	import { taskDisplayWords, taskStatusTone } from '#lib/tasks.js';
	import { taskStateStatus } from '#lib/task-state.js';
	let { task }: { task: ArtifactTaskFacts } = $props();
</script>
<span class="task-state" style:--state-color="var(--task-status-{taskStatusTone(taskStateStatus(task))})">{taskDisplayWords(task)}{task.status === 'done' && task.settledAt ? ` ${libraryDate(task.settledAt)}` : ''}</span>
<style>
	.task-state { white-space:nowrap; border-radius:999px; padding:.16rem .5rem; font-size:.69rem; font-weight:600; color:var(--state-color); background:color-mix(in srgb,var(--state-color) 13%,transparent); }
</style>
