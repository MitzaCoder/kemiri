<script lang="ts">
	import AnswerListRow from './AnswerListRow.svelte';
	import { groupAnswers, taskQuestionRow } from '#lib/answers.js';
	import type { ProjectAnswers } from '#lib/answers.svelte.js';
	import type { ProjectBoard } from '#lib/board.svelte.js';
	import { useTaskSearch } from '#lib/task-search.svelte.js';
	import type { Answer, BoardTask, TaskAnswerQuestion } from '@kemiri/protocol';
	import AnswerPage from './AnswerPage.svelte';
	import AnswerTaskChip from './AnswerTaskChip.svelte';
	import TaskSearchBox from '../TaskSearchBox.svelte';

	let { catalogue, board, answerId, now, pathname, taskHref, chatHref, onnavigate, onleave, onopenTask, onlist }: {
		catalogue: ProjectAnswers; board?: ProjectBoard; answerId?: string; now: number; pathname: string;
		taskHref: (id: string) => string; chatHref: (answer: Answer) => string | undefined;
		onnavigate: (event: MouseEvent) => void; onleave: (event: MouseEvent) => void; onopenTask: (id: string) => void; onlist: () => void;
	} = $props();
	const tasks: BoardTask[] = $derived(board?.tasks ?? []);
	const search = useTaskSearch(() => tasks, () => board);
	const query = $derived(search.query.trim());
	const answer = $derived(catalogue.answers.find(answer => answer.id === answerId));
	let found = $state.raw<{ query: string; answers: Answer[]; taskQuestions: TaskAnswerQuestion[] }>();
	let searchError = $state<string>();
	const shown = $derived(query && found?.query !== query ? [] : [
		...(query ? found!.answers : catalogue.answers),
		...(query ? found!.taskQuestions : catalogue.taskQuestions).map(taskQuestionRow),
	]);
	const groups = $derived(groupAnswers(shown, now));
	const matchingTasks = $derived(query && !answerId ? search.search(new Set(tasks.map(task => task.id))) : []);

	$effect(() => {
		// Refetch the current search when its full catalogue changes, without narrowing the unread or reply index.
		void catalogue.answers;
		void catalogue.taskQuestions;
		const term = query;
		searchError = undefined;
		if (!term || answerId || !catalogue.ready) return;
		let cancelled = false;
		const timer = setTimeout(async () => {
			try {
				const matches = await catalogue.requests.list(term);
				if (!cancelled) found = { query: term, ...matches };
			} catch (error) {
				if (!cancelled) searchError = error instanceof Error ? error.message : String(error);
			}
		}, 180);
		return () => { cancelled = true; clearTimeout(timer); };
	});
</script>

{#if !answerId}
	<div class="shrink-0 border-b border-(--chat-border) px-2.5 py-2.5 sm:px-3">
		<TaskSearchBox query={search.query} onchange={search.setQuery} label="Search answers and tasks" />
	</div>
{/if}
<div class="min-h-0 flex-1 overflow-y-auto" data-overlay-scrollbar>
	{#if answerId && answer}
		{#key answerId}
			<AnswerPage {answer} {catalogue} {now} {tasks} listHref={pathname} {taskHref} chatHref={chatHref(answer)} {onnavigate} {onleave} {onopenTask} ondelete={onlist} />
		{/key}
	{:else if answerId}<a href={pathname} onclick={onnavigate} class="mx-4 mt-3 inline-block text-sm text-(--accent-2) hover:underline">‹ Answers</a>{/if}
	{#if catalogue.error}
		<p class="p-4 text-sm text-(--chat-danger)" role="alert">Could not load answers: {catalogue.error}
			<button class="font-medium underline" onclick={() => catalogue.refresh(true)}>Retry</button>
		</p>
	{:else if !catalogue.loaded}
		<p class="p-4 text-sm text-(--chat-fg-muted)" role="status">Loading answers…</p>
	{:else if answerId}
		{#if !answer}<p class="p-4 text-sm text-(--chat-fg-muted)">This answer is no longer available.</p>{/if}
	{:else}
		<div class="mx-auto w-full max-w-3xl px-3 pb-5">
			{#if searchError}
				<p class="py-4 text-sm text-(--chat-danger)" role="alert">Could not search answers: {searchError}</p>
			{:else if query && found?.query !== query}
				<p class="py-4 text-sm text-(--chat-fg-muted)" role="status">{catalogue.ready ? 'Searching answers…' : 'Waiting for the connection to search answers.'}</p>
			{:else if !shown.length}
				<p class="py-4 text-sm text-(--chat-fg-muted)">{query ? 'No matching answers.' : 'No answers yet. Quick questions and their replies will appear here.'}</p>
			{:else}
				{#each groups as group (group.day)}
					<section aria-label={group.day}>
						<h3 class="px-1 pt-4 pb-1 text-xs font-semibold text-(--chat-fg-muted)">{group.day}</h3>
						<ul class="divide-y divide-(--chat-border) rounded-lg border border-(--chat-border) bg-(--chat-bg)">
							{#each group.answers as row (row.id)}
								<AnswerListRow {row} {now} {pathname} {tasks} {taskHref} {onnavigate} {onleave} />
							{/each}
						</ul>
					</section>
				{/each}
			{/if}
			{#if matchingTasks.length}
				<section aria-label="Matching tasks" class="mt-4">
					<h3 class="px-1 pb-1 text-xs font-semibold text-(--chat-fg-muted)">Matching tasks</h3>
					<ul class="space-y-1">
						{#each matchingTasks as match (match.id)}
							<li><AnswerTaskChip id={match.id} task={tasks.find(task => task.id === match.id)} href={taskHref(match.id)} showTitle onclick={onleave} /></li>
						{/each}
					</ul>
				</section>
			{/if}
		</div>
	{/if}
</div>
