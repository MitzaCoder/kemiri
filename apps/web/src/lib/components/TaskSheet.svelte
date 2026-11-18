<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { drillIntoTask } from "#lib/task-navigation.js";
	import { timelineGroupsSupported } from '#lib/timeline-groups.js';
	import TaskActivity from './TaskActivity.svelte';
	import TaskDelivery from './TaskDelivery.svelte';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { taskDecided } from '#lib/task-record.js';
	import { automaticTaskActivity, taskActivitySupported } from '#lib/task-activity.js';
	import { provideOpenTaskId } from '#lib/task-detail-context.js';
	import TaskDetailText from './TaskDetailText.svelte';
	import TaskText from './chat/TaskText.svelte';
	import ReportStaleAction from './ReportStaleAction.svelte';
	import { reportFreshnessEnabled, emptyFinishedResults } from '#lib/report-freshness.js';
	import { taskSheetViewport } from '#lib/task-sheet-viewport.js';
	import { overlayScroll } from '#lib/scrollbars.js';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import XIcon from '@lucide/svelte/icons/x';
	import CheckIcon from '@lucide/svelte/icons/check';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import '#lib/task-sheet.css';
	import { openFeedbackCount } from '#lib/task-relations.js';
	import { acceptanceMarkdown, failedCheckLine, taskDetailFields, taskDetailState, taskNeedsYou } from '#lib/task-details.js';
	import { threadHref } from '#lib/backends.js';
	import { splitMedia } from '#lib/media-gallery.js';
	import TaskRecordFold from './TaskRecordFold.svelte';
	import TaskProof from './artifacts/TaskProof.svelte';
	import { waitingSummary } from '#lib/task-waiting.js';
	import TaskReply from '#lib/components/TaskReply.svelte';
	import { formatMinutes } from '@kemiri/client';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import TaskFiles from '#lib/components/artifacts/TaskFiles.svelte';
	import TaskStatusMenu from '#lib/components/TaskStatusMenu.svelte';
	import TaskWaitingForm from '#lib/components/TaskWaitingForm.svelte';
	import BoardQuestionCard from '#lib/components/BoardQuestionCard.svelte';
	import BoardTaskEditor from '#lib/components/BoardTaskEditor.svelte';
	import Markdown from '#lib/components/markdown/Markdown.svelte';
	import TaskFeedback from '#lib/components/TaskFeedback.svelte';
	import TaskRelations from '#lib/components/TaskRelations.svelte';

	import TaskRefs from '#lib/components/TaskRefs.svelte';
	import { useRefLinks } from '#lib/ref-links.svelte.js';
	import { splitRefMentions } from '#lib/refs.js';
	import { useArtifactFeed } from '#lib/artifacts.svelte.js';
	import { blockersOf, draftFromTask, draftToInput } from '#lib/board.js';
	import type { ProjectBoard } from '#lib/board.svelte.js';
	import type { BackendConnection } from '#lib/harness.svelte.js';
	import { exactTime, relativeTime } from '#lib/relative-time.js';
	import { shortWriterLabel, taskFromUrl, taskRefs, withTask } from '#lib/tasks.js';
	import { questionAskedBy, taskOwner, threadName } from '#lib/threads.js';
	import SelectionQuote from '#lib/components/chat/SelectionQuote.svelte';
	import type {
		Artifact,
		BoardFeedback,
		BoardTask,
		BoardTaskTimelineResponse,
		BoardTaskStatus,
		BoardTimelineEntry,
		BoardTimelineGroup,
		BoardWriter,
		ThreadSummary,
		WorkerSummary
	} from '@kemiri/protocol';

	/** Task details over the project chat. Linked tasks keep a return trail; quoted text returns to chat. */
	let {
		backend,
		projectId,
		board,
		workers,
		threads = [],
		workerHref,
		onquote,
		onshowlinked
	}: {
		backend: BackendConnection;
		projectId: string;
		board: ProjectBoard | undefined;
		workers: readonly WorkerSummary[];
		threads?: readonly ThreadSummary[];
		workerHref: (worker: WorkerSummary) => string;
		onquote?: (quote: string) => void;
		/** Shows the task list filtered to a task and everything linked to it; the sheet closes first. */
		onshowlinked?: (taskId: string) => void;
	} = $props();

	const refLinks = useRefLinks();

	let body = $state<HTMLDivElement | null>(null);
	let sheet = $state<HTMLElement | null>(null);
	$effect(() => {
		if (!sheet) return;
		return taskSheetViewport(sheet).destroy;
	});
	/** A quote taken from the sheet, handed over once the sheet has closed so the composer keeps the focus. */
	let pendingQuote: string | undefined;

	function quote(text: string): void {
		pendingQuote = text;
		close();
	}

	const requestedId = $derived(taskFromUrl(page.url));
	const previousTask = $derived(page.state.taskTrail?.at(-1));
	function openLinkedTask(event: MouseEvent): void {
		if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		const anchor = (event.target as Element).closest('a[href]');
		if (!anchor || !task) return;
		const target = new URL(anchor.getAttribute('href')!, page.url.href);
		const id = taskFromUrl(target);
		if (target.origin !== page.url.origin || target.pathname !== page.url.pathname || !id || id === task.id) return;
		event.preventDefault();
		void goto(target, { reset: false, persistState: true, state: { taskTrail: drillIntoTask(page.state.taskTrail, task, id) } });
	}
	// The sheet keeps showing the task while it fades out.
	let shownId = $state<string | undefined>(undefined);
	$effect(() => {
		if (requestedId !== null) shownId = requestedId;
	});
	const taskId = $derived(requestedId ?? shownId);

	const liveTask = $derived(taskId === undefined ? undefined : board?.task(taskId));
	let archivedTask = $state<BoardTask | undefined>(undefined);
	let archivedChecked = $state<string | undefined>(undefined);
	const task = $derived(liveTask ?? (archivedTask?.id === taskId ? archivedTask : undefined));
	const lookedUp = $derived(taskId !== undefined && archivedChecked === taskId);

	// A task the live board does not list may be archived; read once to see.
	$effect(() => {
		const id = taskId;
		if (id === undefined || board === undefined || !board.loaded || liveTask !== undefined || archivedChecked === id) return;
		archivedChecked = id;
		void board
			.findArchived(id)
			.then((found) => {
				if (found !== undefined && taskId === id) archivedTask = found;
			})
			.catch(() => undefined);
	});

	let editing = $state(false);
	let confirmDrop = $state(false);
	let waitingForm = $state(false);
	let problem = $state<string | undefined>(undefined);
	let closing = $state(false);
	let reply = $state<{ focus(): void }>();

	// The timeline and the feedback come from one read, repeated when anything the board carries about the task moves.
	let timelineEntries = $state<BoardTimelineEntry[] | undefined>(undefined);
	let timelineGroups = $state<BoardTimelineGroup[] | undefined>(undefined);
	let delivery = $state<BoardTaskTimelineResponse['delivery']>();
	let timelineError = $state<string | undefined>(undefined);
	let feedbackEntries = $state<BoardFeedback[]>([]);
	let feedbackBusy = $state(false);
	let feedbackProblem = $state<string | undefined>(undefined);

	$effect(() => {
		void taskId;
		editing = false;
		confirmDrop = false;
		waitingForm = false;
		problem = undefined;
		timelineEntries = undefined;
		timelineGroups = undefined;
		delivery = undefined;
		timelineError = undefined;
		feedbackEntries = [];
		feedbackProblem = undefined;
	});

	const tasks = $derived(board?.tasks ?? []);
	const questions = $derived((board?.board?.questions ?? []).filter(question => question.taskId === task?.id));
	const decided = $derived(task ? taskDecided(task.id, board?.board?.decisions ?? [], questions) : []);
	const blockers = $derived(task === undefined ? [] : blockersOf(task, tasks).filter((blocker) => !blocker.settled));
	const needsYou = $derived(task === undefined ? undefined : taskNeedsYou(task, board?.board?.questions ?? [], blockers.length > 0, backend.supports('task-steps')));
	const taskFieldsEnabled = $derived(backend.connection.features?.includes('task-fields') === true);
	const fields = $derived(task ? taskDetailFields(task, taskFieldsEnabled) : undefined);
	const failedChecks = $derived(fields && failedCheckLine(fields.checks));
	const owner = $derived(task === undefined ? undefined : taskOwner(task, threads));
	const taskWorkers = $derived(
		task === undefined ? [] : task.workerIds.map((id) => ({ id, worker: workers.find((entry) => entry.id === id) }))
	);
	const activity = $derived(task === undefined ? undefined : automaticTaskActivity(task, taskActivitySupported(backend.connection.features)));
	const now = $derived(task?.status !== 'in_progress' ? undefined : (activity
		? ['working', 'deploy', 'idle', 'unknown'].includes(activity.kind) && !activity.refs.some(ref => questions.some(question => question.id === ref && question.status === 'open')) &&
			!(delivery && (activity.kind === 'deploy' || activity.refs.some(ref => ref.startsWith('deploy:'))))
			? { text: activity.text, at: activity.since, activity } : undefined
		: task.report.now.trim() ? { text: task.report.now, at: task.report.updatedAt ?? task.updatedAt } : undefined));
	const supportsDelivery = $derived(backend.supports('task-delivery'));
	const supportsLinks = $derived(backend.supports('task-links'));
	const staleReport = $derived(Boolean(task && reportFreshnessEnabled(backend.supports('task-freshness'), task) &&
		(task.report.freshness?.results.stale || task.report.freshness?.next.stale)));

	const supportsTimelineGroups = $derived(timelineGroupsSupported(backend.connection.features));
	// A stable primitive prevents activity/report-only board pushes from re-reading grouped history.
	const timelineReadKey = $derived.by(() => {
		if (!task || !board || !supportsLinks || (supportsTimelineGroups && (requestedId === null || backend.connection.status !== 'ready'))) return undefined;
		const revision = supportsTimelineGroups ? task.timelineRevision ?? 0 : [task.timelineRevision, task.snapshots, task.feedback, task.status, task.report.revision, task.revision, needsYou?.ownerQuestions.length, needsYou?.questionsForAgent.length, decided.length];
		return JSON.stringify([backend.id, projectId, task.id, supportsTimelineGroups, revision, supportsDelivery, supportsDelivery ? activity?.kind : undefined]);
	});
	$effect(() => {
		if (timelineReadKey === undefined) return;
		const currentBoard = untrack(() => board)!;
		const id = untrack(() => task)!.id;
		const grouped = untrack(() => supportsTimelineGroups);
		let cancelled = false;
		currentBoard.timeline(id, grouped, untrack(() => supportsDelivery))
			.then((read) => {
				if (cancelled) return;
				timelineEntries = read.entries;
				timelineGroups = grouped ? read.groups : undefined;
				feedbackEntries = read.feedback;
				delivery = read.delivery;
				timelineError = undefined;
			})
			.catch((cause: unknown) => {
				if (!cancelled) timelineError = cause instanceof Error ? cause.message : String(cause);
			});
		return () => { cancelled = true; };
	});

	async function setFeedback(entry: BoardFeedback, state: 'dismissed' | 'open'): Promise<void> {
		if (board === undefined || task === undefined || feedbackBusy) return;
		feedbackBusy = true;
		feedbackProblem = undefined;
		try {
			const saved = await board.setFeedback(task.id, entry.id, state);
			feedbackEntries = feedbackEntries.map((candidate) => (candidate.id === saved.id ? saved : candidate));
		} catch (error) {
			feedbackProblem = error instanceof Error ? error.message : String(error);
		} finally {
			feedbackBusy = false;
		}
	}

	function showLinked(): void {
		if (task === undefined) return;
		const id = task.id;
		close();
		onshowlinked?.(id);
	}

	const artifactFeed = useArtifactFeed(() =>
		taskId !== undefined && backend.supports('artifacts')
			? { client: backend.client, projectId, filter: { taskId } }
			: undefined
	);
	const artifacts = $derived(artifactFeed.current?.artifacts ?? []);
	const proof = $derived(splitMedia(artifacts).media.slice(0, 3));

	async function updateArtifactTags(artifact: Artifact, tags: string[]): Promise<void> {
		const row = await backend.client.updateArtifactTags(projectId, artifact.id, tags);
		artifactFeed.current?.upsert(row);
	}

	function ago(iso: string): string {
		return relativeTime(iso, Date.now());
	}

	function writerName(writer: BoardWriter): string {
		return shortWriterLabel(writer, threads);
	}

	function close(): void {
		void goto(withTask(page.url, null), { replace: true, reset: false });
	}

	async function completeReview(): Promise<void> {
		await setStatus('done');
		await tick();
		if (task?.status === 'done' && document.activeElement === document.body) {
			sheet?.querySelector<HTMLElement>('[data-status-trigger]')?.focus();
		}
	}

	async function setStatus(target: BoardTaskStatus, waitingFor?: string, waitUntil?: string): Promise<void> {
		if (board === undefined || task === undefined || closing) return;
		closing = true;
		problem = undefined;
		confirmDrop = false;
		const outcome = await board.saveTask(
			{ ...draftToInput(draftFromTask(task)), status: target, ...(waitingFor === undefined ? {} : { waitingFor }), ...(waitUntil === undefined ? {} : { waitUntil }) },
			{ taskId: task.id, expectedRevision: task.revision }
		);
		closing = false;
		if (outcome.kind === 'saved') {
			waitingForm = false;
			if (archivedTask?.id === task.id) archivedTask = outcome.task;
		} else if (outcome.kind === 'conflict') problem = `${task.id} changed while you were looking. Check it and try again.`;
		else if (outcome.kind === 'failed') problem = outcome.message;
	}
	provideOpenTaskId(() => taskId ?? undefined);
</script>

<Dialog.Root
	open={requestedId !== null}
	onOpenChange={(open) => {
		if (!open) close();
	}}
>
	<Dialog.Content
		bind:ref={sheet}
		showCloseButton={false}
		data-task-sheet
		onclick={openLinkedTask}
		onCloseAutoFocus={(event) => {
			if (pendingQuote === undefined) return;
			event.preventDefault();
			onquote?.(pendingQuote);
			pendingQuote = undefined;
		}}
		class="top-0 left-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 sm:right-0 sm:left-auto sm:w-[min(74rem,calc(100vw-3rem))] sm:max-w-none sm:rounded-l-2xl"
	>
		<Dialog.Description class="sr-only">A task: its report, questions, workers and history.</Dialog.Description>
		{#if task === undefined}
			<header class="flex shrink-0 items-center gap-2 border-b border-(--chat-border) px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3">
				<Dialog.Title class="min-w-0 flex-1 truncate text-base font-semibold">{taskId ?? 'Task'}</Dialog.Title>
				<Button variant="ghost" size="icon-sm" onclick={close} aria-label="Close the task page" title="Close the task page"><XIcon /></Button>
			</header>
			{#if board === undefined || !board.loaded || !lookedUp}
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
			<header
				class="task-header flex max-h-[35%] shrink-0 flex-col overflow-y-auto overscroll-contain gap-2 border-b border-(--chat-border) px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3"
			>
				{#if previousTask}
					<Button variant="ghost" class="min-h-11 max-w-full justify-start" title={`Back to ${previousTask.id}`} onclick={() => history.back()}>
						<span class="truncate">← {previousTask.id} · <TaskDetailText text={previousTask.title} focusable={false} /></span>
					</Button>
				{/if}
				<div class="flex items-center gap-2">
					<span class="font-mono text-xs text-(--chat-fg-subtle)">{task.id}</span>
					<TaskStatusMenu status={task.status} {task} label={taskDetailState(task.status, needsYou!, task.state?.kind)} disabled={closing} supportsWaiting={backend.supports('task-waiting')} onpick={(status) => {
						confirmDrop = status === 'dropped';
						waitingForm = status === 'waiting';
						if (!confirmDrop && !waitingForm) void setStatus(status);
					}} />
					<span class="flex-1"></span>
					{#if !editing}
						<Button variant="ghost" size="icon-sm" class="size-11" onclick={() => (editing = true)} aria-label="Edit {task.id}" title="Edit the task"><PencilIcon /></Button>
					{/if}
					<Button variant="ghost" size="icon-sm" class="size-11" onclick={close} aria-label="Close the task page" title="Close the task page"><XIcon /></Button>
				</div>
				<Dialog.Title class="text-lg leading-snug font-semibold break-words"
					>{#each splitRefMentions(task.title, refLinks()?.links) as piece, index (index)}{#if piece.href}<a
								href={piece.href}
								target="_blank"
								rel="noopener noreferrer"
								class="underline decoration-(--chat-border-strong) underline-offset-2 hover:decoration-current">{piece.text}</a
							>{:else}<TaskText text={piece.text} />{/if}{/each}</Dialog.Title
				>
				{#if fields?.goal}<p class="max-w-[60ch] text-base [overflow-wrap:anywhere] text-(--chat-fg-muted)">{fields.goal}</p>{/if}
				{#key task.id}
					{#if taskRefs(task).length > 0}<TaskRefs refs={taskRefs(task)} />{/if}
				{/key}

				{#if waitingForm}
					<TaskWaitingForm waiting={task.waiting} busy={closing} onsave={(note, until)=>setStatus('waiting',note,until)} oncancel={()=>waitingForm=false}/>
				{:else if confirmDrop}
					<div class="flex flex-wrap items-center gap-2"><span class="text-xs"><TaskDetailText text={`Drop ${task.id}? It will not be done.`} /></span><Button variant="destructive" size="sm" disabled={closing} onclick={()=>setStatus('dropped')}>Drop it</Button><Button variant="ghost" size="sm" onclick={()=>confirmDrop=false}>Keep</Button></div>
				{/if}
				{#if problem}
					<p class="text-xs text-(--chat-danger)" role="alert"><TaskDetailText text={problem} /></p>
				{/if}
			</header>

			<div class="relative flex min-h-0 flex-1 flex-col">
				<div bind:this={body} data-navigation-scroll="task-body" use:overlayScroll={'parent'}
					class="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-task-body>
					{#key `${backend.id}/${projectId}/${task.id}`}
						{#if editing}
							<div class="task-reading mx-auto"><BoardTaskEditor {task} {tasks}
								onsave={(input, options) => board!.saveTask(input, options)} onback={() => (editing = false)} /></div>
						{:else}
							<div class="task-details-layout">
								<div class="task-reading">
									{#snippet questionCard(question: NonNullable<typeof needsYou>['ownerQuestions'][number])}
										<BoardQuestionCard {question} {taskFieldsEnabled} plain askedBy={questionAskedBy(question, threads)}
											onclarify={board?.clarifyEnabled ? (entry, text) => board!.clarify(entry.id, entry.revision, text) : undefined}
											onanswer={(entry, text) => board!.answer(entry.id, entry.revision, text)} />
									{/snippet}
									{#if needsYou?.show}
										<section class="task-needs-you" aria-label="Needs you" data-needs-you>
											<h2 class="task-detail-heading">Needs you</h2>
											{#each needsYou.ownerQuestions as question (question.id)}{@render questionCard(question)}{/each}
											{#if needsYou.stepsMarkdown}
											<div class="flex flex-col gap-3" data-task-steps>
												<h3 class="font-semibold">Your steps</h3>
												<Markdown source={needsYou.stepsMarkdown} class="task-detail-markdown" />
											</div>
										{/if}
										{#if needsYou.review}
												<div class="flex flex-col gap-3">
													<h3 class="font-semibold">Check the work</h3>
													{#if task.report.next.trim()}<Markdown source={task.report.next} class="task-detail-markdown" />{/if}
													<div class="flex flex-wrap gap-2">
														<Button class="min-h-11" disabled={closing} onclick={completeReview}>It works: close the task</Button>
														<Button class="min-h-11" variant="outline" onclick={() => reply?.focus()}>Something is off…</Button>
													</div>
												</div>
											{/if}
											{#if needsYou.blocked}
												<div class="flex flex-col gap-1">
													{#if task.blockedReason}<Markdown source={task.blockedReason} class="task-detail-markdown" />{/if}
													{#if blockers.length > 0}
														<h3 class="task-detail-heading">Blocked by</h3>
														<ul>{#each blockers as blocker (blocker.id)}
															<li><a class="task-fact-link" href={withTask(page.url, blocker.id)}><TaskDetailText text={blocker.title || 'Not on the board'} focusable={false} /> <span class="task-id-chip">{blocker.id}</span></a></li>
														{/each}</ul>
													{/if}
												</div>
											{/if}
											</section>
									{/if}

									<section class="task-reading-section" aria-label="What you get">
										<h2 class="task-detail-heading">What you get</h2>
										{#if fields?.summary}<p class="text-[1.0625rem] font-medium">{fields.summary}</p>{/if}
										{#if staleReport}
											<div class="task-stale-report flex min-h-11 flex-wrap items-center gap-x-1 text-(--chat-fg-muted)"><span>Report may be out of date.</span><ReportStaleAction {backend} {projectId} taskId={task.id} /></div>
										{/if}
										{#if task.report.results.trim()}<Markdown source={task.report.results} class="task-detail-markdown" />
										{:else if !fields?.summary && !failedChecks}<p class="text-(--chat-fg-muted)">{emptyFinishedResults(task) ? 'No results yet · work finished' : 'Nothing written yet.'}</p>{/if}
										{#if failedChecks}<p class="text-(--chat-danger)">{failedChecks}</p>{/if}
										{#if proof.length > 0}<TaskProof media={proof} client={backend.client} />{/if}
									</section>

									{#if artifacts.length > 0}
										<section class="task-reading-section" aria-label="Files">
											<h2 class="task-detail-heading">Files ({artifacts.length})</h2>
											<TaskFiles {artifacts} client={backend.client} {projectId} onupdatetags={backend.supports('artifact-tags') ? updateArtifactTags : undefined} />
										</section>
									{/if}

									{#if fields?.notDoneMarkdown}
										<section class="task-reading-section" aria-label="Not done">
											<h2 class="task-detail-heading">Not done</h2>
											<Markdown source={fields.notDoneMarkdown} class="task-detail-markdown" />
										</section>
									{/if}

									{#if !needsYou?.review && task.report.next.trim()}
										<section class="task-reading-section" aria-label="Next">
											<h2 class="task-detail-heading">Next</h2>
											<Markdown source={task.report.next} class="task-detail-markdown" />
										</section>
									{/if}
									{#if needsYou?.questionsForAgent.length}
										<section class="task-reading-section" aria-label="Waiting for an agent reply">
											<h2 class="task-detail-heading">Waiting for an agent reply</h2>
											{#each needsYou.questionsForAgent as question (question.id)}{@render questionCard(question)}{/each}
										</section>
									{/if}

									{#if supportsLinks && (feedbackEntries.length || openFeedbackCount(task) || feedbackProblem || timelineError)}
										<section class="task-reading-section" aria-label="Your notes">
											<h2 class="task-detail-heading">Your notes</h2>
											<TaskFeedback entries={feedbackEntries} openCount={openFeedbackCount(task)} busy={feedbackBusy}
												problem={feedbackProblem ?? timelineError} onset={setFeedback} threadName={(id) => threadName(id, threads)} />
										</section>
									{/if}

									<section aria-label="The record">
										<h2 class="task-detail-heading mb-2">The record</h2>
										<TaskRecordFold row="request" title="The request">
											{#if task.description.trim()}<Markdown source={task.description} class="task-detail-markdown" />
											{:else if !task.acceptance?.trim()}<p class="text-(--chat-fg-muted)">No request written.</p>{/if}
											{#if task.acceptance?.trim()}
												<div><h4 class="mb-1 font-semibold">Done when</h4><Markdown source={acceptanceMarkdown(task.acceptance)} class="task-detail-markdown" /></div>
											{/if}
										</TaskRecordFold>
										{#if fields?.checks.length}
											<TaskRecordFold row="checks" title="Checks">
												<ul role="list" class="flex flex-col gap-1.5">
													{#each fields.checks as check}
														<li class="flex items-baseline gap-2">
															{#if check.result === 'passed'}
																<CheckIcon class="size-4 shrink-0 self-start mt-1 text-(--chat-success)" aria-hidden="true" />
															{:else}
																<XIcon class="size-4 shrink-0 self-start mt-1 text-(--chat-danger)" aria-hidden="true" />
															{/if}
															<span><span class="sr-only">{check.result}: </span>{check.name}{#if check.count !== undefined} <span class="text-(--chat-fg-muted)">· {check.count.toLocaleString()}</span>{/if}{#if check.note?.trim()} <span class="text-sm text-(--chat-fg-muted)">— {check.note}</span>{/if}</span>
														</li>
													{/each}
												</ul>
											</TaskRecordFold>
										{/if}
										{#if decided.length}
											<TaskRecordFold row="decided" title="Decided" count={decided.length}>
												<ul role="list" class="divide-y divide-(--chat-border)">
													{#each decided as row (row.id)}
														<li>
															<details>
																<summary class="task-fold gap-2 pr-2 text-sm font-medium">
																	<ChevronRightIcon class="size-4 shrink-0" aria-hidden="true" />
																	<span class="min-w-0 break-words"><TaskDetailText text={row.decision?.text ?? (row.question?.answer || 'Question answered')} focusable={false} /></span>
																</summary>
																<div class="flex flex-col gap-2 pb-3 pl-6 text-sm text-(--chat-fg-muted)">
																	{#if row.question}
																		<div><p class="text-xs font-semibold">Question</p><Markdown source={row.question.text} /></div>
																		{#if row.decision && row.question.answer}<div><p class="text-xs font-semibold">Answer</p><Markdown source={row.question.answer} /></div>{/if}
																		<p class="text-xs">{writerName({ author: 'user', threadId: null, workerId: null })} {#if row.question.answeredAt}· <time datetime={row.question.answeredAt}>{exactTime(row.question.answeredAt)}</time>{/if}</p>
																	{:else}<p class="text-xs">{threadName(row.decision?.threadId ?? 'main', threads)} · <time datetime={row.at}>{exactTime(row.at)}</time></p>{/if}
																	{#if row.why}<Markdown source={row.why} />{/if}
																</div>
															</details>
														</li>
													{/each}
												</ul>
											</TaskRecordFold>
										{/if}
										{#if supportsLinks || task.snapshots || taskWorkers.length || now}
											<TaskRecordFold row="activity" title="Activity">
												<TaskActivity {board} {task} {writerName} loading={supportsLinks && timelineEntries === undefined} error={timelineError}
													sources={{ entries: timelineEntries, groups: timelineGroups, questions, decisions: decided, feedback: feedbackEntries, workers: taskWorkers, now, deliveryShown: !!delivery }}
													workerHref={(id) => { const worker = workers.find(entry => entry.id === id); return worker ? workerHref(worker) : undefined; }}
													taskHref={(id) => withTask(page.url, id)} />
											</TaskRecordFold>
										{/if}
									</section>
								</div>

								<aside class="task-about" aria-label="About this task">
									<h2 class="task-detail-heading">About this task</h2>
									{#if delivery}<TaskDelivery {delivery} />{/if}
									<dl class="task-facts">
										{#if owner}<div><dt>Owner thread</dt><dd>{#if owner.threadId}<a class="task-fact-link underline" href={threadHref(backend.id, projectId, owner.threadId)}>{owner.label}</a>{:else}{owner.label}{/if}</dd></div>{/if}
										{#if task.status === 'waiting' && task.waiting}<div><dt>Waiting details</dt><dd><TaskDetailText text={waitingSummary(task)} /></dd></div>{/if}
										{#if task.archived}<div><dt>Status</dt><dd>Archived</dd></div>{/if}
									</dl>
									<TaskRelations {task} {tasks} archivedLinks={board?.archivedLinks} hrefOf={(id) => withTask(page.url, id)}
										blockersInNeedsYou={needsYou?.blocked ? blockers.map(blocker => blocker.id) : []}
										onshowlinked={onshowlinked === undefined ? undefined : showLinked} />
									<dl class="task-facts">
										<div><dt>Created</dt><dd><time datetime={task.createdAt} title={exactTime(task.createdAt)}>{ago(task.createdAt)}</time></dd></div>
										<div><dt>Updated</dt><dd><time datetime={task.updatedAt} title={exactTime(task.updatedAt)}>{ago(task.updatedAt)}</time></dd></div>
										{#if task.settledAt}<div><dt>Closed</dt><dd><time datetime={task.settledAt} title={exactTime(task.settledAt)}>{ago(task.settledAt)}</time></dd></div>{/if}
										{#if task.inProgressMinutes !== undefined && task.inProgressMinutes > 0}<div><dt>Time in progress</dt><dd data-in-progress>{formatMinutes(task.inProgressMinutes)}</dd></div>{/if}
									</dl>
								</aside>
							</div>
						{/if}
					{/key}
				</div>
			</div>
			{#if !editing}
				<footer class="max-h-[45%] shrink-0 overflow-y-auto border-t border-(--chat-border)" data-task-reply>
					<div class="mx-auto w-full max-w-3xl">
						{#key `${backend.id}/${projectId}/${task.id}`}
							<TaskReply bind:this={reply} {backend} {projectId} taskId={task.id} />
						{/key}
					</div>
				</footer>
			{/if}
		{/if}
		{#if onquote}
			<SelectionQuote scope={body} onquote={quote} />
		{/if}
	</Dialog.Content>
</Dialog.Root>
