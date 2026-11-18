<script lang="ts">
	import { markdownText, type BoardQuestion, type BoardTask, type BoardTaskBrief, type WorkerSummary } from '@kemiri/protocol';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import CircleHelpIcon from '@lucide/svelte/icons/circle-help';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import LockIcon from '@lucide/svelte/icons/lock';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import CircleIcon from '@lucide/svelte/icons/circle';
	import CheckIcon from '@lucide/svelte/icons/check';
	import BanIcon from '@lucide/svelte/icons/ban';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { activityMinute } from '#lib/activity-minute.js';
	import type { AnswerOutcome } from '#lib/board.svelte.js';
	import { taskNowText, taskRowActivity } from '#lib/task-activity.js';
	import { taskPartProgress } from '#lib/task-parts.js';
	import { taskPeekParts, taskPeekResults, taskPeekWorkers } from '#lib/task-peek.js';
	import { emptyFinishedResults } from '#lib/report-freshness.js';
	import { exactTime, relativeTime } from '#lib/relative-time.js';
	import { rowGist, taskDisplayToneClass, taskDisplayWords, taskSectionOf } from '#lib/tasks.js';
	import TaskIdChip from './TaskIdChip.svelte';
	import TaskActivityLine from './TaskActivityLine.svelte';
	import TaskPartsProgress from './TaskPartsProgress.svelte';
	import BoardQuestionCard from './BoardQuestionCard.svelte';
	import ReportSectionFreshness from './ReportSectionFreshness.svelte';
	import TaskRelationChips from './TaskRelationChips.svelte';
	import WorkerStatusBadge from './chat/WorkerStatusBadge.svelte';
	import { Button } from './ui/button/index.js';

	/** Content only. The graph host owns placement, focus, dismissal and touch behaviour. */
	let {
		task, tasks = [], questions = [], workers = [], archivedLinks = [],
		activityEnabled = false, freshnessEnabled = false, layout = 'card', taskHref,
		onAnswer, onWorker, onOpenTask, onShowLinked
	}: {
		task: BoardTask;
		tasks?: readonly BoardTask[];
		questions?: readonly BoardQuestion[];
		workers?: readonly WorkerSummary[];
		archivedLinks?: readonly BoardTaskBrief[];
		activityEnabled?: boolean;
		freshnessEnabled?: boolean;
		layout?: 'card' | 'sheet';
		taskHref?: (taskId: string) => string;
		/** Same adapter as the question pin: (q, text) => board.answer(q.id, q.revision, text). */
		onAnswer?: (question: BoardQuestion, answer: string) => Promise<AnswerOutcome>;
		onWorker: (workerId: string) => void;
		onOpenTask: (taskId: string) => void;
		onShowLinked: (taskId: string) => void;
	} = $props();

	const waiting = $derived(questions.filter(question => question.taskId === task.id && question.status === 'open'));
	const activity = $derived(taskRowActivity(task, activityEnabled, tasks));
	const parts = $derived(taskPeekParts(task, tasks, questions));
	const hasParts = $derived(!!taskPartProgress(task) || (task.subtaskCount?.total ?? 0) > 0 || parts.listed.length > 0 || parts.done > 0);
	const gist = $derived(rowGist({ task, waiting, section: taskSectionOf(task, waiting.length) }, activityEnabled));
	const nowText = $derived(markdownText(taskNowText(task, activityEnabled)));
	const results = $derived(taskPeekResults(task.report.results));
	const nextText = $derived(markdownText(task.report.next));
	const assignedWorkers = $derived(taskPeekWorkers(task, workers));
</script>

{#snippet stateGlyph(entry: BoardTask)}
	<span class="{taskDisplayToneClass(entry)} inline-flex h-5 w-4 shrink-0 items-center justify-center" title={taskDisplayWords(entry, tasks)}>
		{#if entry.state && entry.state.kind !== 'working'}
			{@const StateIcon = ({ failed: TriangleAlertIcon, answer_needed: CircleHelpIcon, steps_needed: CircleHelpIcon, clarifying: CircleHelpIcon, review: EyeIcon, paused: PauseIcon, blocked_by_task: LockIcon, waiting_outside: ClockIcon, todo: CircleIcon, done: CheckIcon, dropped: BanIcon })[entry.state.kind]}
			<StateIcon class="size-3.5 text-(--task-status)" aria-hidden="true" />
		{:else}<span class="task-status-dot" aria-hidden="true"></span>{/if}
	</span>
{/snippet}

<article class="task-peek {taskDisplayToneClass(task)}" class:sheet={layout === 'sheet'} data-task-peek={task.id} data-no-task-preview aria-label="{task.id}: {task.title}">
	<header class="flex items-start gap-2">
		{@render stateGlyph(task)}
		<h3 class="min-w-0 flex-1 text-sm leading-5 font-semibold break-words">{task.title}</h3>
		<TaskIdChip taskId={task.id} />
	</header>
	<div class="peek-body flex min-h-0 flex-col gap-3">
		<div class="text-xs text-(--chat-fg-muted)">
			{#if hasParts}
				<div class="flex items-center gap-1"><TaskPartsProgress {task} /></div>
			{:else if activity}<TaskActivityLine {activity} compact stateTone={taskDisplayToneClass(task)} />
			{:else}<p>{gist || taskDisplayWords(task, tasks)}</p>{/if}
		</div>
		{#if parts.listed.length || parts.done}
			<section aria-label="Parts">
				<h4>Parts</h4>
				<ul class="flex flex-col gap-1">
					{#each parts.listed as part (part.id)}
						<li class="flex items-start gap-2 text-xs">{@render stateGlyph(part)}<span class="min-w-0 flex-1 break-words">{part.title}</span><TaskIdChip taskId={part.id} /></li>
					{/each}
				</ul>
				{#if parts.done}<p class="mt-1 text-xs text-(--chat-fg-subtle)">+ {parts.done} done</p>{/if}
			</section>
		{/if}
		{#each waiting as question (question.id)}
			<div>
				<p class="mb-1 text-[0.6875rem] text-(--chat-fg-subtle)" title={exactTime(question.askedAt)}>{question.id} · asked {relativeTime(question.askedAt, $activityMinute)}</p>
				<BoardQuestionCard {question} compact optionsOnly onanswer={onAnswer} />
			</div>
		{/each}
		{#if nowText}<section aria-label="Now"><h4>Now</h4><p class="text-xs break-words">{nowText}</p></section>{/if}
		{#if results.length || emptyFinishedResults(task)}
			<section aria-label="Results">
				<h4>Results</h4>
				{#if results.length}<ul class="list-disc space-y-1 pl-4 text-xs break-words">{#each results as result}<li>{result}</li>{/each}</ul>
				{:else}<p class="text-xs text-(--chat-fg-subtle)">No results yet · work finished</p>{/if}
				{#if freshnessEnabled && task.report.freshness}<ReportSectionFreshness section={task.report.freshness.results} emptyResults={emptyFinishedResults(task)} />{/if}
			</section>
		{/if}
		{#if nextText}
			<section aria-label="Next">
				<h4>Next</h4><p class="line-clamp-2 text-xs break-words">{nextText}</p>
				{#if freshnessEnabled && task.report.freshness}<ReportSectionFreshness section={task.report.freshness.next} />{/if}
			</section>
		{/if}
		{#if assignedWorkers.length}
			<section aria-label="Workers">
				<h4>Workers</h4>
				<ul>
					{#each assignedWorkers as worker (worker.id)}
						<li><button type="button" class="worker-row flex w-full items-center gap-2 rounded-lg px-1 py-2 text-left text-xs hover:bg-(--chat-surface-2)" onclick={() => onWorker(worker.id)} aria-label="Show worker {worker.id}">
							<span class="min-w-0 flex-1 break-words font-medium">{worker.id}</span>
							<WorkerStatusBadge status={worker.status} />
							<time class="text-(--chat-fg-subtle)" datetime={worker.updatedAt} title={exactTime(worker.updatedAt)}>{relativeTime(worker.updatedAt, $activityMinute)}</time>
							<ChevronRightIcon class="size-3.5 shrink-0" aria-hidden="true" />
						</button></li>
					{/each}
				</ul>
			</section>
		{/if}
		<TaskRelationChips {task} {tasks} {archivedLinks} hrefOf={taskHref} onopen={onOpenTask} />
	</div>
	<footer class="flex shrink-0 items-center gap-2 border-t border-(--chat-border) pt-3">
		<Button size="sm" onclick={() => onOpenTask(task.id)}>Open task</Button>
		<Button size="sm" variant="outline" onclick={() => onShowLinked(task.id)}>Show linked</Button>
	</footer>
</article>

<style>
	.task-peek { display: flex; flex-direction: column; gap: 12px; width: 360px; max-width: 100%; padding: 16px; border: 1px solid var(--chat-border); border-radius: 16px; color: var(--chat-fg); background: var(--chat-surface); box-shadow: 0 12px 40px color-mix(in oklab, var(--chat-fg) 12%, transparent); }
	.peek-body { max-height: 65dvh; overflow-y: auto; overscroll-behavior: contain; }
	h4 { margin-bottom: 4px; color: var(--chat-fg-subtle); font-size: 0.6875rem; font-weight: 600; }
	.sheet { width: 100%; border-bottom: 0; border-radius: 20px 20px 0 0; padding-bottom: max(16px, env(safe-area-inset-bottom)); }
	.sheet .peek-body { max-height: 70dvh; }
	.worker-row:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
	@media (pointer: coarse) { .worker-row { min-height: 44px; } }
</style>
