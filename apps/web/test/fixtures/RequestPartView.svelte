<script lang="ts">
	import { Dialog } from 'bits-ui';
	import ClassicTaskView from '../../src/lib/components/task-view/ClassicTaskView.svelte';
	import type { TaskViewModel } from '../../src/lib/task-view/model.svelte.js';
	let { model }: { model: TaskViewModel } = $props();
</script>

<Dialog.Root open>
	{#snippet editor()}{/snippet}
	<ClassicTaskView {model} {editor} />
</Dialog.Root>
