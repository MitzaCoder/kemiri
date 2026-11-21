<script lang="ts">
	import type { BoardTask, ThreadSummary } from '@kemiri/protocol';
	import type { ProjectBoard } from '#lib/board.svelte.js';
	import { ownerThreadId, taskCoordinator } from '#lib/coordinators.js';
	import * as Dialog from './ui/dialog/index.js';
	import { Button } from './ui/button/index.js';
	import { untrack } from 'svelte';
	let { task, board, roster, onclose }: { task: BoardTask; board: ProjectBoard; roster: readonly ThreadSummary[]; onclose: () => void } = $props();
	const original = untrack(() => task);
	const from = taskCoordinator(original);
	const parts = untrack(() => board.tasks.filter(part => part.parent === original.id && !part.archived && taskCoordinator(part) === from));
	let destination = $state(from);
	let includeParts = $state(true);
	let pending = $state(false);
	let error = $state('');
	async function move(event: SubmitEvent) {
		event.preventDefault();
		if (pending || destination === from || !roster.some(row => row.id === destination && !row.archived)) return;
		pending = true;
		const owner = ownerThreadId(destination);
		const moved: string[] = [];
		for (const row of [original, ...(includeParts ? parts : [])]) {
			const { title, description, acceptance, status, blockedBy, blockedReason, writeScopes } = row;
			const outcome = await board.saveTask({ title, description, acceptance, status, blockedBy, blockedReason, writeScopes },
				{ taskId: row.id, expectedRevision: row.revision, ownerThreadId: owner });
			if (outcome.kind !== 'saved') {
				const reason = outcome.kind === 'failed' ? outcome.message : 'The task has changed. Close this picker and review the latest version.';
				error = `${moved.length ? `Moved ${moved.join(', ')}. ` : ''}Could not move ${row.id}: ${reason}`;
				pending = false; return;
			}
			moved.push(row.id);
		}
		pending = false;
		onclose();
	}
</script>
<Dialog.Root open onOpenChange={open => { if (!open && !pending) onclose(); }}>
	<Dialog.Content class="sm:max-w-md" showCloseButton={!pending}>
		<Dialog.Header><Dialog.Title>Move {task.id} to a coordinator</Dialog.Title><Dialog.Description>{task.title}</Dialog.Description></Dialog.Header>
		<form class="grid gap-4" onsubmit={move}>
			<label class="grid gap-1.5 text-sm font-medium">Coordinator
				<select bind:value={destination} disabled={pending} class="rounded-lg border border-(--chat-border) bg-(--chat-bg) px-2 py-2">
					{#each roster.filter(row => !row.archived || row.id === from) as row (row.id)}<option value={row.id}>{row.title}</option>{/each}
				</select>
			</label>
			{#if parts.length}<label class="flex items-start gap-2 text-sm"><input type="checkbox" bind:checked={includeParts} disabled={pending} /> Also move its parts in the same coordinator ({parts.length})</label>{/if}
			{#if error}<p class="text-sm text-(--chat-danger)" role="alert">{error}</p>{/if}
			<div class="flex justify-end gap-2"><Button variant="outline" disabled={pending} onclick={onclose}>Cancel</Button><Button type="submit" disabled={pending || destination === from || !!error}>{pending ? 'Moving…' : 'Move task'}</Button></div>
		</form>
	</Dialog.Content>
</Dialog.Root>
