<script lang="ts">
	import { markdownText, type BoardQuestion, type BoardTask, type ModelInfo, type ThreadSummary, type WorkerSummary } from '@kemiri/protocol';
	import { activityMinute } from '#lib/activity-minute.js';
	import { threadHref, workerHref } from '#lib/backends.js';
	import { modelLabel } from '#lib/harness.svelte.js';
	import { elapsedFor, exactTime, relativeTime } from '#lib/relative-time.js';
	import { taskActivityAge } from '#lib/task-activity.js';
	import { workerMotion } from '#lib/worker-motion.js';
	import { workerDoingNow, workerRunsIn, workerTranscriptThread } from '#lib/worker-peek.js';
	import GraphMascot from './graph/GraphMascot.svelte';
	import GraphMascotDefs from './graph/GraphMascotDefs.svelte';
	import TaskIdChip from './TaskIdChip.svelte';
	import WorkerStatusBadge from './chat/WorkerStatusBadge.svelte';
	import { Button } from './ui/button/index.js';

	/** Content only. The graph host owns placement, focus, dismissal and touch behaviour. */
	let {
		worker, thread, backendId, projectId, task, questions = [], models = [],
		activityEnabled = false, layout = 'card', onOpenTask
	}: ({ worker: WorkerSummary; thread?: never } | { thread: ThreadSummary; worker?: never }) & {
		backendId: string;
		projectId: string;
		task?: BoardTask | null;
		questions?: readonly BoardQuestion[];
		models?: readonly ModelInfo[];
		activityEnabled?: boolean;
		layout?: 'card' | 'sheet';
		onOpenTask: (taskId: string) => void;
	} = $props();

	const entry = $derived((worker ?? thread)!);
	const assignedTask = $derived(task?.id === entry.taskId ? task : undefined);
	const doingNow = $derived(worker ? workerDoingNow(worker, assignedTask, activityEnabled) : undefined);
	const activity = $derived(doingNow?.source === 'activity' ? doingNow.activity : undefined);
	const nowText = $derived(markdownText(activity?.text ?? thread?.current ?? ''));
	const report = $derived(markdownText(worker?.lastReport ?? thread?.summary ?? ''));
	const reportAt = $derived(thread?.finishedAt ?? entry.updatedAt);
	const transcriptHref = $derived(worker
		? workerHref(backendId, projectId, worker.id, workerTranscriptThread(worker))
		: threadHref(backendId, projectId, entry.id));
	// Each content instance has one private set of gradients, independent of the canvas SVG.
	const componentId = $props.id();
	const gradientPrefix = $derived(`worker-peek-${componentId}`);
</script>

<article class="worker-peek" class:sheet={layout === 'sheet'} data-worker-peek={entry.id} data-no-task-preview aria-label={thread ? `Background job: ${entry.title}` : `Worker: ${entry.id}`}>
	<svg width="0" height="0" aria-hidden="true" class="mascot-defs"><GraphMascotDefs {gradientPrefix} /></svg>
	<header class="flex items-start gap-2">
		<GraphMascot state={workerMotion(entry, assignedTask, questions)} size={40} backgroundJob={!!thread} still {gradientPrefix} />
		<div class="min-w-0 flex-1">
			{#if thread}<p class="mb-1 text-[0.6875rem] font-semibold text-(--chat-fg-subtle)">Background job</p>{/if}
			<h3 class="text-sm leading-5 font-semibold break-words">{entry.id}</h3>
			<p class="mt-0.5 text-xs break-words text-(--chat-fg-muted)">{entry.title}</p>
			<div class="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
				<WorkerStatusBadge status={entry.status} />
				<time datetime={entry.updatedAt} title="Last updated {exactTime(entry.updatedAt)}" class="text-(--chat-fg-subtle)">· {elapsedFor(entry.updatedAt, $activityMinute)}</time>
			</div>
		</div>
	</header>
	<div class="peek-body flex min-h-0 flex-col gap-3">
		{#if nowText}
			<section aria-label="Doing now">
				<h4>Doing now</h4><p class="text-xs whitespace-pre-line break-words">{nowText}</p>
				{#if activity && taskActivityAge(activity, $activityMinute)}<p class="mt-1 text-[0.6875rem] text-(--chat-fg-subtle)" title={exactTime(activity.since)}>{taskActivityAge(activity, $activityMinute)}</p>{/if}
			</section>
		{/if}
		{#if report}
			<section aria-label="Last report">
				<h4>Last report · <time datetime={reportAt} title={exactTime(reportAt)}>{relativeTime(reportAt, $activityMinute)}</time></h4>
				<p class="line-clamp-4 text-xs whitespace-pre-line break-words">{report}</p>
			</section>
		{/if}
		{#if entry.failure}
			<section aria-label="Why it failed" class="rounded-lg border border-(--chat-danger)/30 bg-(--chat-danger)/5 p-3">
				<h4 class="text-(--chat-danger)!">Why it failed</h4>
				<p class="text-xs whitespace-pre-line break-words">{entry.failure}</p>
			</section>
		{/if}
		<dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
			<dt>Task</dt><dd>{#if entry.taskId}<button type="button" class="task-link flex items-start gap-1.5 rounded text-left hover:underline" onclick={() => onOpenTask(entry.taskId!)}><TaskIdChip taskId={entry.taskId} /><span class="break-words">{assignedTask?.title ?? 'Open task'}</span></button>{:else}<span class="text-(--chat-fg-subtle)">No task</span>{/if}</dd>
			<dt>Model</dt><dd class="break-words">{modelLabel(entry.model, models)} · thinking {entry.thinkingLevel ?? 'default'}</dd>
			<dt>Runs in</dt><dd>{workerRunsIn(worker?.isolation ?? 'workspace')}</dd>
			<dt>Started</dt><dd><time datetime={entry.createdAt} title={exactTime(entry.createdAt)}>{relativeTime(entry.createdAt, $activityMinute)}</time></dd>
		</dl>
	</div>
	<footer class="flex shrink-0 flex-wrap items-center gap-2 border-t border-(--chat-border) pt-3">
		<Button size="sm" href={transcriptHref}>{thread ? 'Open chat' : 'Open transcript'}</Button>
		{#if entry.taskId}<Button size="sm" variant="outline" onclick={() => onOpenTask(entry.taskId!)}>Open task</Button>{/if}
	</footer>
</article>

<style>
	.worker-peek { display: flex; flex-direction: column; gap: 12px; width: 360px; max-width: 100%; padding: 16px; border: 1px solid var(--chat-border); border-radius: 16px; color: var(--chat-fg); background: var(--chat-surface); box-shadow: 0 12px 40px color-mix(in oklab, var(--chat-fg) 12%, transparent); }
	.mascot-defs { position: absolute; overflow: hidden; pointer-events: none; }
	.peek-body { max-height: 65dvh; overflow-y: auto; overscroll-behavior: contain; }
	h4 { margin-bottom: 4px; color: var(--chat-fg-subtle); font-size: 0.6875rem; font-weight: 600; }
	dt { color: var(--chat-fg-subtle); }
	.sheet { width: 100%; border-bottom: 0; border-radius: 20px 20px 0 0; padding-bottom: max(16px, env(safe-area-inset-bottom)); }
	.sheet .peek-body { max-height: 70dvh; }
	.task-link:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
	@media (pointer: coarse) { .task-link, footer :global([data-slot='button']) { min-height: 44px; } }
</style>
