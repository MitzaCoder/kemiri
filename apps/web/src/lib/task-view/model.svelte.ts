import { tick, untrack } from 'svelte';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import { drillIntoTask } from '#lib/task-navigation.js';
import { timelineGroupsSupported } from '#lib/timeline-groups.js';
import { liveNewsWorkLogHref, type LiveNewsActions } from '#lib/task-live.js';
import { taskDecided } from '#lib/task-record.js';
import { automaticTaskActivity, taskActivitySupported } from '#lib/task-activity.js';
import { reportFreshnessEnabled } from '#lib/report-freshness.js';
import { failedCheckLine, taskDetailFields, taskNeedsYou } from '#lib/task-details.js';
import { threadHref } from '#lib/backends.js';
import { useRefLinks } from '#lib/ref-links.svelte.js';
import { useArtifactFeed } from '#lib/artifacts.svelte.js';
import { blockersOf, draftFromTask, draftToInput } from '#lib/board.js';
import type { ProjectBoard } from '#lib/board.svelte.js';
import type { BackendConnection } from '#lib/harness.svelte.js';
import { relativeTime } from '#lib/relative-time.js';
import { shortWriterLabel, taskFromUrl, withTask } from '#lib/tasks.js';
import { questionAskedBy, taskOwner, threadName } from '#lib/threads.js';
import type {
	Artifact,
	BoardFeedback,
	BoardQuestion,
	BoardTask,
	BoardTaskTimelineResponse,
	BoardTaskStatus,
	BoardTimelineEntry,
	BoardTimelineGroup,
	BoardWriter,
	ThreadSummary,
	WorkerSummary
} from '@kemiri/protocol';

export type TaskViewInputs = {
	backend: BackendConnection;
	projectId: string;
	projectName?: string;
	board: ProjectBoard | undefined;
	workers: readonly WorkerSummary[];
	threads?: readonly ThreadSummary[];
	workerHref: (worker: WorkerSummary) => string;
	/** Shows the task list filtered to a task and everything linked to it; the sheet closes first. */
	onshowlinked?: (taskId: string) => void;
};

/** One reactive model per sheet, kept alive when the rendered design changes. */
export function createTaskViewModel(inputs: () => TaskViewInputs, getSheet: () => HTMLElement | null) {
	const { backend, projectId, projectName, board, workers, threads = [], workerHref, onshowlinked } = $derived(inputs());
	const refLinks = useRefLinks();

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
	let reply: { focus(): void } | undefined;
	let quoteScope = $state<HTMLElement | null>(null);

	function registerReply(nextReply: { focus(): void }) {
		reply = nextReply;
		return () => { if (reply === nextReply) reply = undefined; };
	}

	/** Attach this Svelte action to the element that contains quotable task text. */
	function registerQuoteScope(node: HTMLElement) {
		quoteScope = node;
		return { destroy: () => { if (quoteScope === node) quoteScope = null; } };
	}

	function focusReply(): void { reply?.focus(); }

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
	const taskLiveEnabled = $derived(backend.supports('task-live'));
	const news = $derived<LiveNewsActions | undefined>(taskLiveEnabled && backend.supports('task-live-watcher') && task ? {
		markWrong: async (lineId) => {
			const response = await backend.client.request({ type: 'board.live.mark_wrong', projectId, taskId: task!.id, lineId });
			if (response.type === 'error') throw new Error(response.error.message);
		},
		workLogHref: (line, entryId) => liveNewsWorkLogHref(backend.id, projectId, workers, line, entryId),
	} : undefined);
	const liveNow = $derived(taskLiveEnabled && task?.live && task.state?.kind === 'working'
		? task.state.sentence ?? activity : undefined);
	const supportsDelivery = $derived(backend.supports('task-delivery'));
	const changesClient = $derived(backend.supports('project-changes') ? backend.client : undefined);
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

	const feedbackLoading = $derived(timelineReadKey !== undefined && timelineEntries === undefined && timelineError === undefined);

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
			getSheet()?.querySelector<HTMLElement>('[data-status-trigger]')?.focus();
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
	const loading = $derived(board === undefined || !board.loaded || !lookedUp);
	const supportsWaiting = $derived(backend.supports('task-waiting'));
	const supportsUsage = $derived(backend.supports('task-usage'));
	const supportsArtifactTags = $derived(backend.supports('artifact-tags'));
	const supportsClarify = $derived(board?.clarifyEnabled ?? false);
	const viewTaskKey = $derived(`${backend.id}/${projectId}/${task?.id}`);

	function pickStatus(status: BoardTaskStatus): void {
		confirmDrop = status === 'dropped';
		waitingForm = status === 'waiting';
		if (!confirmDrop && !waitingForm) void setStatus(status);
	}

	return {
		get backend() { return backend; },
		get changesClient() { return changesClient; },
		get projectId() { return projectId; },
		get projectName() { return projectName; },
		get board() { return board; },
		get requestedId() { return requestedId; },
		get previousTask() { return previousTask; },
		get taskId() { return taskId; },
		get task() { return task; },
		get loading() { return loading; },
		get tasks() { return tasks; },
		get archivedLinks() { return board?.archivedLinks; },
		get viewTaskKey() { return viewTaskKey; },
		get editing() { return editing; },
		get waitingForm() { return waitingForm; },
		get confirmDrop() { return confirmDrop; },
		get closing() { return closing; },
		get problem() { return problem; },
		get quoteScope() { return quoteScope; },
		get refLinks() { return refLinks()?.links; },
		get questions() { return questions; },
		get decided() { return decided; },
		get blockers() { return blockers; },
		get needsYou() { return needsYou; },
		get fields() { return fields; },
		get failedChecks() { return failedChecks; },
		get owner() { return owner; },
		get workers() { return workers; },
		get taskWorkers() { return taskWorkers; },
		get activity() { return activity; },
		get now() { return now; },
		get liveNow() { return liveNow; },
		get news() { return news; },
		get staleReport() { return staleReport; },
		get taskFieldsEnabled() { return taskFieldsEnabled; },
		get taskLiveEnabled() { return taskLiveEnabled; },
		get supportsLinks() { return supportsLinks; },
		get supportsDelivery() { return supportsDelivery; },
		get supportsTimelineGroups() { return supportsTimelineGroups; },
		get supportsWaiting() { return supportsWaiting; },
		get supportsUsage() { return supportsUsage; },
		get supportsArtifactTags() { return supportsArtifactTags; },
		get supportsClarify() { return supportsClarify; },
		get timelineEntries() { return timelineEntries; },
		get timelineGroups() { return timelineGroups; },
		get delivery() { return delivery; },
		get timelineError() { return timelineError; },
		get feedbackEntries() { return feedbackEntries; },
		get feedbackLoading() { return feedbackLoading; },
		get feedbackBusy() { return feedbackBusy; },
		get feedbackProblem() { return feedbackProblem; },
		get artifacts() { return artifacts; },
		get showLinked() { return onshowlinked === undefined ? undefined : showLinked; },
		showEditor: () => { editing = true; },
		hideEditor: () => { editing = false; },
		cancelWaiting: () => { waitingForm = false; },
		cancelDrop: () => { confirmDrop = false; },
		goBack: () => history.back(),
		taskHref: (id: string) => withTask(page.url, id),
		threadHref: (id: string) => threadHref(backend.id, projectId, id),
		workerHref: (id: string) => {
			const worker = workers.find(entry => entry.id === id);
			return worker ? workerHref(worker) : undefined;
		},
		threadName: (id: string) => threadName(id, threads),
		questionAskedBy: (question: BoardQuestion) => questionAskedBy(question, threads),
		answerQuestion: (question: BoardQuestion, text: string) => board!.answer(question.id, question.revision, text),
		clarifyQuestion: (question: BoardQuestion, text: string) => board!.clarify(question.id, question.revision, text),
		ago,
		writerName,
		close,
		openLinkedTask,
		setStatus,
		pickStatus,
		completeReview,
		setFeedback,
		updateArtifactTags,
		registerQuoteScope,
		registerReply,
		focusReply,
	};
}

export type TaskViewModel = ReturnType<typeof createTaskViewModel>;
