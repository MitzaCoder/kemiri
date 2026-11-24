<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import { canCopyToAnswers } from '#lib/answers.js';
	import type { BoardTask } from '@kemiri/protocol';

	let { task, supported, copy }: {
		task: Pick<BoardTask, 'id' | 'status' | 'parent'>; supported: boolean; copy: (taskId: string) => Promise<string>;
	} = $props();
	let copying = $state(false);
	let answerId = $state<string>();
	let error = $state<string>();

	async function copyRequest() {
		if (copying || answerId) return;
		copying = true;
		error = undefined;
		try { answerId = await copy(task.id); }
		catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
		finally { copying = false; }
	}
</script>

{#if canCopyToAnswers(task, supported)}
	<div class="flex flex-wrap items-center gap-x-3 gap-y-1">
		<Button variant="outline" size="sm" disabled={copying || !!answerId} onclick={copyRequest}>{copying ? 'Copying…' : 'Copy to Answers'}</Button>
		{#if answerId}
			<p class="text-xs text-(--chat-fg-muted)" role="status">Copied. <a class="font-medium text-(--accent-2) underline" href={`?answer=${answerId}`}>View answer</a></p>
		{/if}
		{#if error}<p class="text-xs text-(--chat-danger)" role="alert">Could not copy: {error}</p>{/if}
	</div>
{/if}
