<script lang="ts">
	import type { TaskViewDesignProps } from '../../../src/lib/task-view/designs.js';
	let { model }: TaskViewDesignProps = $props();
</script>

<p>Classic: {model.task?.title}</p>
