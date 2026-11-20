<script lang="ts">
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import BoardTaskEditor from './BoardTaskEditor.svelte';
	import SelectionQuote from './chat/SelectionQuote.svelte';
	import { provideOpenTaskId } from '#lib/task-detail-context.js';
	import { taskSheetViewport } from '#lib/task-sheet-viewport.js';
	import { createTaskViewModel, type TaskViewInputs } from '#lib/task-view/model.svelte.js';
	import { taskViewDesignPreference } from '#lib/task-view/preference.svelte.js';
	import '#lib/task-sheet.css';

	/** Task details over the project chat. Linked tasks keep a return trail; quoted text returns to chat. */
	let props: TaskViewInputs & { onquote?: (quote: string) => void } = $props();
	let sheet = $state<HTMLElement | null>(null);
	const model = createTaskViewModel(() => props, () => sheet);
	const { task, taskId, loading } = $derived(model);
	const { component: Design, sheetClass } = $derived(taskViewDesignPreference.current);

	$effect(() => {
		if (!sheet) return;
		return taskSheetViewport(sheet).destroy;
	});
	provideOpenTaskId(() => model.taskId);

	// Hand the quote over once the sheet closes so the chat composer keeps focus.
	let pendingQuote: string | undefined;
	function quote(text: string): void {
		pendingQuote = text;
		model.close();
	}
</script>

<Dialog.Root
	open={model.requestedId !== null}
	onOpenChange={(open) => {
		if (!open) model.close();
	}}
>
	<Dialog.Content
		bind:ref={sheet}
		showCloseButton={false}
		data-task-sheet
		onclick={model.openLinkedTask}
		onCloseAutoFocus={(event) => {
			if (pendingQuote === undefined) return;
			event.preventDefault();
			props.onquote?.(pendingQuote);
			pendingQuote = undefined;
		}}
		class="top-0 left-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 sm:max-w-none {sheetClass ?? ''}"
	>
		<Dialog.Description class="sr-only">A task: its report, questions, workers and history.</Dialog.Description>
		{#if task === undefined}
			<header class="flex shrink-0 items-center gap-2 border-b border-(--chat-border) px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
				<Dialog.Title class="min-w-0 flex-1 truncate text-base font-semibold">{taskId ?? 'Task'}</Dialog.Title>
				<Button variant="ghost" size="icon-sm" onclick={model.close} aria-label="Close the task page" title="Close the task page"><XIcon /></Button>
			</header>
			{#if loading}
				<div class="flex flex-col gap-2 px-4 py-6" role="status" aria-busy="true" aria-label="Loading {taskId ?? 'the task'}">
					<div class="skeleton h-5 w-32"></div>
					<div class="skeleton h-3 w-24"></div>
					<div class="skeleton mt-3 h-3.5 w-4/5"></div>
					<div class="skeleton h-3.5 w-full"></div>
					<div class="skeleton h-3.5 w-11/12"></div>
					<div class="skeleton mt-3 h-3 w-2/3"></div>
					<span class="sr-only">Loading {taskId ?? 'the task'}…</span>
				</div>
			{:else}
				<div class="px-4 py-6 text-sm text-(--chat-fg-subtle)">{taskId} is not on the board any more.</div>
			{/if}
		{:else}
			<Design {model} {editor} />
		{/if}
		{#if props.onquote}
			<SelectionQuote scope={model.quoteScope} onquote={quote} />
		{/if}
	</Dialog.Content>
</Dialog.Root>

{#snippet editor()}
	{#if task}
		<div class="task-reading mx-auto"><BoardTaskEditor {task} tasks={model.tasks}
			onsave={(input, options) => model.board!.saveTask(input, options)} onback={model.hideEditor} /></div>
	{/if}
{/snippet}
