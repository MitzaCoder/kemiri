<script lang="ts">
	import { Button } from './ui/button/index.js';
	import ThreadStopButton from './ThreadStopButton.svelte';
	import BoardQuestionCard from './BoardQuestionCard.svelte';
	import { backgroundJobBandText } from '#lib/background-job-page.js';
	import { inThread, questionPin } from '#lib/threads.js';
	import { openQuestions } from '#lib/board.js';
	import type { ThreadSummary } from '@kemiri/protocol';
	import type { ProjectThreads } from '#lib/threads.svelte.js';
	import type { ProjectBoard } from '#lib/board.svelte.js';
	let { thread, projectName, mainHref, threads, board, now, scheduleName }: {
		thread: ThreadSummary; projectName: string; mainHref: string; threads: ProjectThreads;
		board?: ProjectBoard; now: number; scheduleName?: string;
	} = $props();
	const text = $derived(backgroundJobBandText(thread, now, scheduleName));
	const waiting = $derived(board?.board ? openQuestions(board.board).filter(question => inThread(question, thread.id)) : []);
	let chosen = $state<string | undefined>(undefined);
	const pin = $derived(questionPin(waiting, chosen));
	function nextQuestion() {
		const index = waiting.findIndex(question => question.id === pin.current?.id);
		chosen = waiting[(index + 1) % waiting.length]?.id;
	}
</script>
<section aria-label="About this background job" data-background-job-band class="job-band shrink-0 border-y border-(--accent-2)/20 px-3 py-1 sm:px-4">
	<div class="flex min-w-0 flex-wrap items-center gap-x-2">
		<p class="min-w-0 flex-1 text-xs leading-5 max-sm:basis-full text-(--chat-fg-muted)">
			<span class="font-medium text-(--chat-fg)">Background job of {projectName}</span> · {text.origin} · {text.outcome}
		</p>
		<div class="ml-auto flex shrink-0 items-center gap-1">
			<Button href={mainHref} variant="ghost" size="sm" class="min-h-11 px-2 text-xs">← Main chat</Button>
			{#if text.canStop}<ThreadStopButton {thread} {threads} class="min-h-11 px-2 text-xs" />{/if}
		</div>
	</div>
	{#if pin.current && board}
		<div class="pb-2" data-job-question>
			<div class="flex items-center gap-2 text-xs text-(--chat-fg-muted)">
				<p class="py-1 font-medium text-(--chat-warning)">It is waiting for your answer</p>
				{#if waiting.length > 1}<button type="button" class="ml-auto min-h-11 px-2 text-(--accent-2)" onclick={nextQuestion} aria-label="Show another waiting question">+{waiting.length - 1} more</button>{/if}
			</div>
			{#key pin.current.id}
				<BoardQuestionCard question={pin.current} compact strip onanswer={(question, answer) => board!.answer(question.id, question.revision, answer)} />
			{/key}
		</div>
	{/if}
</section>
<style>
	.job-band { background: color-mix(in oklab, var(--accent-2) 6%, var(--chat-surface)); }
</style>
