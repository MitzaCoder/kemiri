<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Star from '@lucide/svelte/icons/star';
	import { answerDay, answerPreview, answerTime, groupAnswers } from '#lib/answers.js';
	import type { ProjectAnswers } from '#lib/answers.svelte.js';
	import type { ProjectBoard } from '#lib/board.svelte.js';
	import { useTaskSearch } from '#lib/task-search.svelte.js';
	import type { Answer, BoardTask } from '@kemiri/protocol';
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
	let found = $state.raw<{ query: string; answers: Answer[] }>();
	let searchError = $state<string>();
	const shown = $derived(query ? found?.query === query ? found.answers : [] : catalogue.answers);
	const groups = $derived(groupAnswers(shown, now));
	const matchingTasks = $derived(query && !answerId ? search.search(new Set(tasks.map(task => task.id))) : []);

	$effect(() => {
		// Refetch the current search when its full catalogue changes, without narrowing the unread or reply index.
		void catalogue.answers;
		const term = query;
		searchError = undefined;
		if (!term || answerId || !catalogue.ready) return;
		let cancelled = false;
		const timer = setTimeout(async () => {
			try {
				const answers = await catalogue.requests.list(term);
				if (!cancelled) found = { query: term, answers };
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
								{@const taskId = row.taskId ?? row.related[0]}
								<li class="relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 px-2.5 py-2.5 hover:bg-(--chat-surface-2)/50">
									<span class="mt-0.5 text-(--accent-2)" title={row.pinned ? 'Pinned answer' : 'Answered'}>
										{#if row.pinned}<Star size={15} aria-hidden="true" />{:else}<Check size={15} aria-hidden="true" />{/if}
									</span>
									<div class="min-w-0 space-y-1">
										<a href={`${pathname}?answer=${row.id}`} onclick={onnavigate} class="block rounded-sm text-sm leading-snug {row.read ? 'font-medium' : 'font-bold'} after:absolute after:inset-0 after:rounded-lg focus-visible:after:outline" aria-label={row.read ? undefined : `${row.title}, unread`}>{row.title}</a>
										<p class="truncate text-xs leading-relaxed text-(--chat-fg-muted)">{answerPreview(row.answer)}</p>
										{#if taskId}<div class="relative w-fit max-w-full"><AnswerTaskChip id={taskId} task={tasks.find(task => task.id === taskId)} href={taskHref(taskId)} onclick={onleave} /></div>{/if}
									</div>
									<time datetime={row.at} class="pt-0.5 text-[0.6875rem] whitespace-nowrap tabular-nums text-(--chat-fg-subtle)">{row.pinned && answerDay(row.at, now) !== 'Today' ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(row.at)) : answerTime(row.at)}</time>
								</li>
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
