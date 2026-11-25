<script lang="ts">
	import { taskDisplayToneClass, taskDisplayWords } from '#lib/tasks.js';
	import type { BoardTask } from '@kemiri/protocol';

	/** A task's status as a pill in its own colour (see `base.css`), the same one its row's edge and its chip's dot wear. */
	let {
		status, state, waiting,
		class: className = ''
	}: {
		status: BoardTask['status'];
		state?: BoardTask['state'];
		waiting?: BoardTask['waiting'];
		class?: string;
	} = $props();
</script>

<span class="task-status-badge {taskDisplayToneClass({ status, state })} {className}" data-task-status={state?.kind ?? status}>
	<span class="task-status-dot" aria-hidden="true"></span>{taskDisplayWords({ status, state, waiting })}
</span>
