<script lang="ts">
	import type { TaskViewDesignProps } from '../../../src/lib/task-view/designs.js';
	import { taskViewDesignPreference } from '../../../src/lib/task-view/preference.svelte.js';

	let { model, editor }: TaskViewDesignProps = $props();
	const Design = $derived(taskViewDesignPreference.current.component);
</script>

<Design {model} {editor} />
