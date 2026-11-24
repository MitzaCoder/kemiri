<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import Star from '@lucide/svelte/icons/star';
	import MessageCircle from '@lucide/svelte/icons/message-circle';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import { answerDay, answerPreview, answerTime, answerWorkLabel, type TaskQuestionRow } from '#lib/answers.js';
	import type { Answer, BoardTask } from '@kemiri/protocol';
	import AnswerTaskChip from './AnswerTaskChip.svelte';

	let { row, now, pathname, tasks, taskHref, onnavigate, onleave }: {
		row: Answer | TaskQuestionRow; now: number; pathname: string; tasks: readonly BoardTask[];
		taskHref: (id: string) => string; onnavigate: (event: MouseEvent) => void; onleave: (event: MouseEvent) => void;
	} = $props();
	const taskId = $derived(row.taskId ?? ('related' in row ? row.related[0] : undefined));
	const taskQuestion = $derived('feedbackId' in row ? row : undefined);
	const answer = $derived('related' in row ? row : undefined);
	const work = $derived(answer?.working);
</script>

<li class="relative grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-2 px-2.5 py-2.5 hover:bg-(--chat-surface-2)/50">
	<span class="mt-0.5 flex h-[15px] w-[15px] items-center justify-center text-(--accent-2)" aria-hidden="true">
		{#if taskQuestion}<MessageCircle size={15} />
		{:else if work?.status === 'failed' || work?.status === 'stopped' || work?.status === 'unavailable'}<CircleAlert size={15} class="text-(--chat-danger)" />
		{:else if work}<span class="size-2 rounded-full bg-current {work.status === 'running' ? 'motion-safe:animate-pulse' : ''}"></span>
		{:else if row.pinned}<Star size={15} title="Pinned answer" />{:else}<Check size={15} title="Answered" />{/if}
	</span>
	<div class="min-w-0 space-y-1">
		{#if taskQuestion}
			<a href={taskHref(taskQuestion.taskId)} onclick={onleave} class="block rounded-sm text-sm leading-snug font-medium after:absolute after:inset-0 after:rounded-lg focus-visible:after:outline">{row.title}</a>
			<p class="truncate text-xs leading-relaxed text-(--chat-fg-muted)">{taskQuestion.note ? answerPreview(taskQuestion.note) : 'Question on a task'}</p>
		{:else if answer}
			<a href={`${pathname}?answer=${answer.id}`} onclick={onnavigate} class="block rounded-sm text-sm leading-snug {answer.read || work ? 'font-medium' : 'font-bold'} after:absolute after:inset-0 after:rounded-lg focus-visible:after:outline" aria-label={answer.read || work ? undefined : `${row.title}, unread`}>{row.title}</a>
			<p class="truncate text-xs leading-relaxed {work?.status === 'failed' ? 'text-(--chat-danger)' : 'text-(--chat-fg-muted)'}">{work ? answerWorkLabel(work, row.at, now) : answerPreview(answer.answer)}</p>
		{/if}
		{#if taskId}<div class="relative w-fit max-w-full"><AnswerTaskChip id={taskId} task={tasks.find(task => task.id === taskId)} href={taskHref(taskId)} onclick={onleave} /></div>{/if}
	</div>
	<time datetime={row.at} class="pt-0.5 text-[0.6875rem] whitespace-nowrap tabular-nums text-(--chat-fg-subtle)">{row.pinned && answerDay(row.at, now) !== 'Today' ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(row.at)) : answerTime(row.at)}</time>
</li>
