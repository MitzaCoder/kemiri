<script lang="ts">
	import { hasMultipleTaskCoordinators, taskCoordinatorInAllView, useCoordinatorTaskView, tasksInCoordinatorView, questionsInCoordinatorView } from '#lib/coordinator-task-view.js';
	import { coordinatorRoster, externalParts, taskCoordinator } from '#lib/coordinators.js';
	import CoordinatorMark from './CoordinatorMark.svelte';
	import TaskStateLabel from './TaskStateLabel.svelte';
	import TaskIdChip from './TaskIdChip.svelte';
	import { taskRowActivity } from '#lib/task-activity.js';
	import CardMarkdown from './markdown/CardMarkdown.svelte';
	import TaskSearchBox from './TaskSearchBox.svelte';
	import { useTaskSearch } from '#lib/task-search.svelte.js';
	import { page } from '$app/state';
	import { projectHref, threadHref, workerHref as workerTranscriptHref } from '#lib/backends.js';
	import TaskFamilyMeta from './TaskFamilyMeta.svelte';
	import { familyExpansionKey, loadFamilyExpansion, needsFamilyAttention, saveFamilyExpansion, taskFamilies, taskFamilySections, taskFamilyCount, type TaskFamily } from '#lib/task-families.js';
	import { requestAttentionLink, requestRows } from '#lib/request-parts.js';
	import { waitingSummary } from '#lib/task-waiting.js';
	import { overlayScroll } from '#lib/scrollbars.js';
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import CircleHelpIcon from '@lucide/svelte/icons/circle-help';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import GitBranchIcon from '@lucide/svelte/icons/git-branch';
	import { flip } from 'svelte/animate';
	import { slide } from 'svelte/transition';
	import { MediaQuery } from 'svelte/reactivity';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import LockIcon from '@lucide/svelte/icons/lock';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import CircleIcon from '@lucide/svelte/icons/circle';
	import CheckIcon from '@lucide/svelte/icons/check';
	import BanIcon from '@lucide/svelte/icons/ban';
	import { Button } from '#lib/components/ui/button/index.js';
	import Banner from '#lib/components/Banner.svelte';
	import BoardQuestionCard from '#lib/components/BoardQuestionCard.svelte';
	import BoardTaskEditor from '#lib/components/BoardTaskEditor.svelte';
	import LooseWorkers from '#lib/components/LooseWorkers.svelte';
	import RefChip from '#lib/components/RefChip.svelte';
	import TaskFilters from '#lib/components/TaskFilters.svelte';
	import { applyTaskFilter } from '#lib/task-relations.js';
	import { useTaskFilter } from '#lib/tasks-view.svelte.js';
	const taskFilter = useTaskFilter();
	import { useRefLinks } from '#lib/ref-links.svelte.js';
	import { relativeTime } from '#lib/relative-time.js';
	import { answeredQuestions } from '#lib/board.js';
	import { questionNeedsAnswer } from '#lib/question-clarify.js';
	import type { ProjectBoard } from '#lib/board.svelte.js';
	import {
		isWarning,
		looseWaiting,
		refLabel,
		rowGist,
		SECTION_LABELS,
		taskRefs,
		taskSections,
		taskSectionOf,
		waitingOn,
		taskDisplayToneClass,
		type TaskRow,
		type TaskSection,
		type TaskSectionId
	} from '#lib/tasks.js';
	import { questionAskedBy } from '#lib/threads.js';
	import type { AttentionFailure, BoardQuestion, ThreadSummary, WorkerSummary } from '@kemiri/protocol';
	import { untrack, type Snippet } from 'svelte';

	/**
	 * The project's tasks, the body of the sidebar's Tasks tab: every task grouped by what it needs from the user (needs
	 * you, ready for review, blocked, working, to do, recently closed). A row opens the task's sheet (`taskHref`); the
	 * questions and warnings that name no task are answered right here. Decisions and answered questions fold at the
	 * bottom.
	 */
	let {
		board,
		threads = [],
		workers = [],
		workerHref,
		taskHref,
		onopentask,
		toolbarStart
	}: {
		board: ProjectBoard | undefined;
		threads?: readonly ThreadSummary[];
		/** The project's workers, and where one opens: the ones no task lists show under the tasks. */
		workers?: readonly WorkerSummary[];
		workerHref?: (worker: WorkerSummary) => string;
		/** Where a task's sheet opens: the page's URL with `?task=<id>`. */
		taskHref: (taskId: string) => string;
		/** Called when a row is chosen, so the caller can step aside for the sheet. */
		onopentask?: (taskId: string) => void;
		/** Shown at the start of the toolbar: the full-width view's List | Board switch. */
		toolbarStart?: Snippet;
	} = $props();

	const refLinks = useRefLinks();

	// Quiet work starts folded. Remember explicit choices per parent, backend and project.
	const expansionKey = $derived(familyExpansionKey(page.params.backend ?? '', page.params.id ?? ''));
	let savedExpansion = $state<{ key: string; choices: Record<string, boolean> } | null>(null);
	const expansion = $derived(savedExpansion?.key === expansionKey ? savedExpansion.choices : {});

	function familyStorage(): Storage | undefined {
		try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
	}

	$effect(() => {
		const key = expansionKey;
		untrack(() => { savedExpansion = { key, choices: loadFamilyExpansion(key, familyStorage()) }; });
	});

	function toggleFamily(id: string): void {
		const choices = { ...expansion, [id]: expansion[id] !== true };
		savedExpansion = { key: expansionKey, choices };
		saveFamilyExpansion(expansionKey, choices, familyStorage());
	}

	function foldWithArrow(event: KeyboardEvent, family: TaskFamily): void {
		if (!family.canToggle || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
		if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
		event.preventDefault();
		if ((event.key === 'ArrowRight') !== family.expanded) toggleFamily(family.row.task.id);
	}

	const reducedMotion = new MediaQuery('(prefers-reduced-motion: reduce)');
	let tasksList: HTMLDivElement;
	let jumpedTask = $state<string>();
	let jumpFlashTimer: ReturnType<typeof setTimeout>;
	$effect(() => () => clearTimeout(jumpFlashTimer));

	function jumpToNeedsYou(taskId: string): void {
		const target = tasksList.querySelector<HTMLElement>(`[data-section="needs_you"] [data-task="${CSS.escape(taskId)}"]`);
		if (!target) return;
		target.querySelector<HTMLAnchorElement>('.task-row-link')?.focus({ preventScroll: true });
		target.scrollIntoView({ block: 'center', behavior: reducedMotion.current ? 'instant' : 'smooth' });
		jumpedTask = taskId;
		clearTimeout(jumpFlashTimer);
		jumpFlashTimer = setTimeout(() => { jumpedTask = undefined; }, 1200);
	}

	let adding = $state(false);
	let sectionOpen = $state<Partial<Record<TaskSectionId, boolean>>>({});
	let answeredOpen = $state(false);
	let decisionsOpen = $state(false);

	const tasks = $derived(board?.tasks ?? []);
	const getTaskView = useCoordinatorTaskView();
	const coordinatorView = $derived(getTaskView?.());
	const scoped = $derived(tasksInCoordinatorView(tasks, coordinatorView));
	const questions = $derived(questionsInCoordinatorView(board?.board?.questions ?? [], coordinatorView));
	const shownIds = $derived(new Set(scoped.map(task => task.id)));
	/** The tasks the focus filter lets through; every other count reads the whole board. */
	const shownTasks = $derived(applyTaskFilter(scoped, taskFilter.current));
	const search = useTaskSearch(() => tasks, () => board);
	const searching = $derived(search.query.trim().length > 0);
	const searchHits = $derived(search.search(new Set(shownTasks.filter(task => (board?.showArchived || !task.archived) && (sectionOpen.closed === true || !['done', 'dropped'].includes(task.status))).map(task => task.id))));
	const searchHitById = $derived(new Map(searchHits.map(hit => [hit.id, hit])));
	const searchFamilies = $derived.by(() => {
		const rows = new Map(sections.flatMap(section => section.rows.map(row => [row.task.id, row] as const)));
		return searchHits.flatMap(hit => { const row = rows.get(hit.id); return row ? [{ row, role: 'task', children: [], canToggle: false, expanded: true, foldedCount: 0 } satisfies TaskFamily] : []; });
	});
	const sections = $derived(
		board?.board === undefined
			? []
			: taskSections({ tasks: shownTasks, questions }, { includeArchived: board.showArchived })
	);
	const requestAttention = $derived(board?.requestAttention === true);
	const partsByRequest = $derived.by(() => {
		if (!requestAttention) return undefined;
		const parts = new Map<string, TaskRow[]>();
		for (const { rows } of taskSections({ tasks, questions: board?.board?.questions ?? [] }, { includeArchived: board?.showArchived })) {
			for (const row of rows) {
				const id = row.task.requestId ?? row.task.parent;
				if (id == null) continue;
				const siblings = parts.get(id) ?? [];
				siblings.push(row);
				parts.set(id, siblings);
			}
		}
		return parts;
	});
	const familySections = $derived(taskFamilySections(sections, requestAttention).map((section) => ({ section, families: taskFamilies(section, expansion, partsByRequest) })));
	const loose = $derived(board?.board === undefined ? [] : looseWaiting({ tasks: scoped, questions }));
	const answered = $derived(board?.board === undefined ? [] : answeredQuestions({ ...board.board, questions }));
	const decisions = $derived(board?.board?.decisions ?? []);
	const needsYouSection = $derived(familySections.find(entry => entry.section.id === 'needs_you')?.section);
	const visibleFailedTasks = $derived(new Set((searching ? searchFamilies.map(family => family.row) : needsYouSection?.rows ?? [])
		.filter(row => row.task.state?.kind === 'failed').map(row => row.task.state?.fromPartId ?? row.task.id)));
	const failures = $derived(coordinatorRoster(threads).filter(thread => coordinatorView?.coordinatorId !== undefined
		? thread.id === coordinatorView.coordinatorId : !coordinatorView?.hidden.has(thread.id))
		.flatMap(thread => thread.attentionFailures ?? []).filter(failure => !failure.taskId || !visibleFailedTasks.has(failure.taskId)));
	let dismissing = $state<string>();
	let dismissError = $state<string>();

	function failureHref(failure: AttentionFailure): string {
		const backendId = page.params.backend ?? '';
		const projectId = board?.projectId ?? '';
		const threadId = failure.threadId === 'main' ? undefined : failure.threadId;
		if (failure.workerId) return workerTranscriptHref(backendId, projectId, failure.workerId, threadId);
		return threadId ? threadHref(backendId, projectId, threadId) : projectHref(backendId, projectId);
	}

	async function dismissFailure(failure: AttentionFailure) {
		if (dismissing !== undefined) return;
		dismissing = failure.id;
		dismissError = undefined;
		try { await board?.acknowledgeFailure(failure.id); }
		catch { dismissError = 'Could not dismiss the failure. Try again.'; }
		finally { dismissing = undefined; }
	}

	const empty = $derived(board?.loaded === true && scoped.length === 0 && loose.length === 0 && failures.length === 0);
	const archivedShown = $derived(board?.showArchived === true ? requestRows(scoped, requestAttention).filter((task) => task.archived).length : 0);
	const openCount = $derived(requestRows(shownTasks, requestAttention).filter((task) => !task.archived && task.status !== 'done' && task.status !== 'dropped').length);

	function isOpen(section: TaskSection): boolean {
		return sectionOpen[section.id] ?? (section.rows.some(needsFamilyAttention) || !section.collapsedByDefault);
	}

	function toggle(section: TaskSection): void {
		sectionOpen[section.id] = !isOpen(section);
	}

	function ago(iso: string): string {
		return relativeTime(iso, Date.now());
	}

	function taskLabelOf(question: BoardQuestion): string | undefined {
		if (question.taskId === null) return undefined;
		const title = board?.task(question.taskId)?.title;
		return title === undefined ? question.taskId : `${question.taskId} · ${title}`;
	}

</script>

{#snippet failureRows()}
	{#each failures as failure (failure.id)}
		<li class="flex min-h-11 items-center gap-1 px-2 py-1 text-sm">
			<a class="flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 hover:underline" href={failureHref(failure)}>
				<TriangleAlertIcon class="size-4 shrink-0 text-(--chat-fg-muted)" />
				<span>{failure.kind === 'worker' ? 'A worker failed' : failure.kind === 'job' ? 'A job failed' : 'A coordinator failed'}: {failure.title}</span>
			</a>
			<Button size="sm" variant="ghost" aria-label="Dismiss failure: {failure.title}" disabled={dismissing !== undefined} onclick={() => dismissFailure(failure)}>Dismiss</Button>
		</li>
	{/each}
	{#if dismissError}<li role="alert" class="px-2 py-1 text-sm">{dismissError}</li>{/if}
{/snippet}


{#snippet countPill(count: number, accent = false)}
	<span
		class="rounded-full px-1.5 text-[0.6875rem] leading-4 font-medium tabular-nums {accent
			? 'bg-(--accent-2)/15 text-(--accent-2)'
			: 'bg-(--chat-surface-2) text-(--chat-fg-subtle)'}">{count}</span
	>
{/snippet}

{#snippet sectionTitle(title: string, count?: number, accent = false)}
	<h3 class="flex items-center gap-1.5 px-1 text-[0.8125rem] font-semibold {accent ? 'text-(--accent-2)' : 'text-(--chat-fg-muted)'}">
		{title}
		{#if count !== undefined}{@render countPill(count, accent)}{/if}
	</h3>
{/snippet}

{#snippet refChips(refs: readonly string[])}
	{@const current = refLinks()}
	{#each refs.slice(0, 2) as ref (ref)}
		<RefChip {ref} links={current?.links} status={current?.status(ref)} />
	{/each}
	{#if refs.length > 2}
		<span class="text-(--chat-fg-subtle)" title={refs.slice(2).map((ref) => refLabel(ref, current?.links)).join('\n')}>+{refs.length - 2}</span>
	{/if}
{/snippet}

{#snippet taskRows(families: TaskFamily[], depth = 0)}
	{#each families as family (`${family.role}:${family.row.task.id}`)}
		<li class="task-row-item" data-no-task-preview
			animate:flip={{ duration: searching || reducedMotion.current ? 0 : 180 }}
			out:slide={{ duration: searching || reducedMotion.current ? 0 : 180 }}>
			{@render taskRow(family, depth)}
			{#if !requestAttention && coordinatorView?.coordinatorId && family.role === 'task'}
				{#each externalParts(family.row.task, tasks, shownIds) as part (part.id)}
					{@const owner = hasMultipleTaskCoordinators(coordinatorView) ? coordinatorView.roster.find(thread => thread.id === taskCoordinator(part)) : undefined}
					{@const waiting = waitingOn(board?.board?.questions ?? [], part.id)}
					{@const needsYou = taskSectionOf(part, waiting.filter(questionNeedsAnswer).length) === 'needs_you'}
					<a href={taskHref(part.id)} onclick={() => onopentask?.(part.id)} class="my-1 mr-1 ml-6 flex items-center gap-1.5 rounded-lg border border-dashed border-(--chat-border) px-2 py-1 text-xs hover:bg-(--chat-surface-2)">
						{@render taskRowIcon(part, needsYou, waiting.some(isWarning))}
						<span class="min-w-0 flex-1 truncate"><span class="sr-only">Part: </span>{part.title}</span>
						<span class="text-(--chat-fg-muted)"><TaskStateLabel task={part} {tasks} /></span>
						{#if owner}<CoordinatorMark thread={owner} compact /><span class="sr-only">Coordinator: {owner.title}</span>{/if}
						<TaskIdChip taskId={part.id} />
					</a>
				{/each}
			{/if}
			{#if family.children.length > 0 || family.doneParts}
				<ul class="family-children" class:family-depth-limit={depth >= 3} aria-label="Parts of {family.row.task.id}"
					transition:slide={{ duration: reducedMotion.current ? 0 : 160 }}>
					{@render taskRows(family.children, depth + 1)}
					{#if family.doneParts}<li class="flex items-center gap-2 px-3 py-2 text-xs text-(--chat-fg-muted)"><CheckIcon class="size-3.5 text-(--chat-success)" aria-hidden="true" />{family.doneParts} done {family.doneParts === 1 ? 'part' : 'parts'}</li>{/if}
				</ul>
			{/if}
		</li>
	{/each}
{/snippet}

{#snippet taskRow(family: TaskFamily, depth: number)}
	{@const row = family.row}
	{@const warned = row.waiting.some(isWarning)}
	{@const gist = rowGist(row, board?.activityEnabled === true)}
	{@const activity = taskRowActivity(row.task, board?.activityEnabled === true, tasks)}
	{@const refs = taskRefs(row.task)}
	{@const owner = taskCoordinatorInAllView(row.task, coordinatorView)}
	{@const needsYou = row.section === 'needs_you'}
	{@const attention = requestAttention && !searching && depth === 0 && !row.task.parent ? requestAttentionLink(row.task, board?.board?.questions ?? [], taskHref) : undefined}
	{#if family.role === 'parentHeader'}
		<a class="task-row family-compact family-header flex items-center gap-2.5 px-3 text-xs text-(--chat-fg-subtle)"
			data-parent-header={row.task.id} href={taskHref(row.task.id)} onclick={() => onopentask?.(row.task.id)}
			aria-label={`Parent ${row.task.id}: ${row.task.title}, ${SECTION_LABELS[row.section]}${owner ? ` · Coordinator: ${owner.title}` : ''}`}>
			<GitBranchIcon class="size-3.5 shrink-0" aria-hidden="true" />
			<span class="min-w-0 flex-1 truncate"><strong class="font-semibold text-(--chat-fg)">{row.task.title}</strong> · {SECTION_LABELS[row.section]}</span>
			{#if owner}<CoordinatorMark thread={owner} compact />{/if}
			<TaskIdChip taskId={row.task.id} />
		</a>
	{:else if family.role === 'pointer'}
		<div class="task-row family-compact {taskDisplayToneClass(row.task)} relative flex items-center gap-2.5 px-3 text-xs" data-task-pointer={row.task.id}>
			{@render taskRowIcon(row.task, false, false)}
			<a class="task-row-link flex min-w-0 flex-1 items-baseline gap-1 outline-none" href={taskHref(row.task.id)}
				onclick={() => onopentask?.(row.task.id)} onkeydown={event => foldWithArrow(event, family)}
				title={row.task.title}>
				<span class="min-w-0 truncate">{row.task.title}</span>
				<span class="shrink-0 whitespace-nowrap text-(--chat-fg-subtle)">· {#if row.task.state?.kind === 'steps_needed'}Your steps to do{:else}<TaskStateLabel task={row.task} {tasks} />{/if}</span>
				{#if owner}<span class="sr-only">Coordinator: {owner.title}</span>{/if}
			</a>
			{#if family.canToggle}
				<button type="button" class="family-pointer-button shrink-0" onclick={() => toggleFamily(row.task.id)}
					aria-label="{family.expanded ? 'Collapse' : 'Expand'} subtasks of {row.task.id}" aria-expanded={family.expanded}>
					<ChevronRightIcon class="size-3.5 {family.expanded ? 'rotate-90' : ''}" aria-hidden="true" />
				</button>
			{/if}
			<button type="button" class="family-pointer-button shrink-0 font-medium text-(--accent-2)" onclick={() => jumpToNeedsYou(row.task.id)}
				aria-label="In Needs you ↑: {row.task.title}">In Needs you ↑</button>
			<span class="flex shrink-0 items-center gap-1.5 text-(--chat-fg-subtle)">{#if owner}<CoordinatorMark thread={owner} compact />{/if}<TaskIdChip taskId={row.task.id} /></span>
		</div>
	{:else}
		<!-- The title's link covers the whole row; the ref chips sit above it, so neither link is inside the other. -->
		<div
			class="task-row {taskDisplayToneClass(row.task)} group relative flex min-w-0 items-start gap-2.5 py-2.5 pr-2 pl-3"
			class:task-row-warning={needsYou && warned}
			class:task-row-question={needsYou && !warned}
			class:search-context={searching && searchHitById.get(row.task.id)?.context}
			class:task-row-jump={jumpedTask === row.task.id}
			data-task={row.task.id}
		>
			{@render taskRowIcon(row.task, needsYou, warned)}
			<span class="flex min-w-0 flex-1 flex-col gap-0.5">
				<a
					href={attention?.href ?? taskHref(row.task.id)}
					onclick={() => onopentask?.(attention?.taskId ?? row.task.id)}
					onkeydown={event => foldWithArrow(event, family)}
					class="task-row-link line-clamp-2 text-[0.875rem] leading-5 font-semibold break-words outline-none {row.section === 'closed'
						? 'text-(--chat-fg-muted)'
						: 'text-(--chat-fg)'}"
					aria-label={`Open ${row.task.id}: ${row.task.title}${owner ? ` · Coordinator: ${owner.title}` : ''}`}>{#each row.task.title.split('') as letter, at}{#if searching && searchHitById.get(row.task.id)?.ranges.some(([start, end]) => at >= start && at < end)}<mark>{letter}</mark>{:else}{letter}{/if}{/each}</a
				>
				{#if searching && searchHitById.get(row.task.id)?.snippet}<p class="truncate text-xs text-(--chat-fg-muted)">{searchHitById.get(row.task.id)?.snippet}</p>{/if}
				{#if attention}
					<p class="text-xs leading-4 text-(--chat-fg-muted)" data-request-attention>
						{attention.text}{#if attention.partTitle}{` · asked while building “${attention.partTitle}”`}{/if}
					</p>
				{:else}
					<TaskFamilyMeta requestView={requestAttention} task={row.task} {tasks} archivedLinks={board?.archivedLinks} nested={depth > 0} {taskHref} onopen={onopentask}
						activity={row.task.state || !searching || !searchHitById.get(row.task.id)?.snippet ? activity : undefined}
						summary={searching && searchHitById.get(row.task.id)?.snippet ? '' : row.task.status === 'waiting' ? waitingSummary(row.task) : gist}
						canToggle={family.canToggle} expanded={family.expanded} foldedCount={family.foldedCount} ontoggle={() => toggleFamily(row.task.id)} />
				{/if}
				{#if (!row.task.state && needsYou) || row.waiting.length > 1 || refs.length > 0}
					<span class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[0.6875rem] leading-4 text-(--chat-fg-subtle)">
						{#if !row.task.state && needsYou}
							<span class="inline-flex min-w-0 items-center gap-1 break-words font-medium text-(--task-status)">
								<TaskStateLabel task={row.task} {tasks} />
							</span>
						{/if}
						{#if row.waiting.length > 1}<span class="shrink-0">+{row.waiting.length - 1} more</span>{/if}
						{@render refChips(refs)}
					</span>
				{/if}
			</span>
			<span class="flex shrink-0 items-center gap-1.5 pt-0.5 text-[0.6875rem] leading-4 text-(--chat-fg-subtle)">
				{#if owner}<CoordinatorMark thread={owner} compact />{/if}
				<TaskIdChip taskId={row.task.id} />
			</span>
			<ChevronRightIcon class="task-row-chevron mt-0.5 size-3.5 shrink-0 text-(--chat-fg-subtle)" aria-hidden="true" />
		</div>
	{/if}
{/snippet}

{#snippet taskRowIcon(task: TaskRow['task'], needsYou: boolean, warned: boolean)}
	<span class="flex h-5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
		{#if task.state && task.state.kind !== 'working'}
			{@const StateIcon = ({ failed: TriangleAlertIcon, answer_needed: CircleHelpIcon, steps_needed: ListChecksIcon, clarifying: CircleHelpIcon, review: EyeIcon, paused: PauseIcon, blocked_by_task: LockIcon, waiting_outside: ClockIcon, todo: CircleIcon, done: CheckIcon, dropped: BanIcon })[task.state.kind]}
			<StateIcon class="size-3.5 text-(--task-status)" />
		{:else if needsYou && warned}
			<TriangleAlertIcon class="size-3.5 text-(--chat-warning)" />
		{:else if needsYou && !task.state}
			<CircleHelpIcon class="size-3.5 text-(--accent-2)" />
		{:else}
			<span class="task-status-dot" class:task-row-pulse={task.state ? task.state.kind === 'working' : task.status === 'in_progress'}></span>
		{/if}
	</span>
{/snippet}

{#snippet rowSkeleton(titleWidth: string, gistWidth: string)}
	<div class="task-row-item flex items-start gap-2.5 py-2.5 pr-2 pl-3" aria-hidden="true">
		<span class="flex h-5 w-3.5 shrink-0 items-center justify-center"><span class="skeleton size-2 rounded-full"></span></span>
		<div class="flex min-w-0 flex-1 flex-col gap-2 pt-1">
			<div class="skeleton h-3.5 {titleWidth}"></div>
			<div class="skeleton h-3 {gistWidth}"></div>
		</div>
		<div class="flex shrink-0 flex-col items-end gap-1.5 pt-1">
			<div class="skeleton h-2.5 w-9"></div>
			<div class="skeleton h-2.5 w-5"></div>
		</div>
	</div>
{/snippet}

{#snippet listSkeleton()}
	<div class="task-group">
		{@render rowSkeleton('w-3/4', 'w-11/12')}
		{@render rowSkeleton('w-2/3', 'w-4/5')}
		{@render rowSkeleton('w-4/5', 'w-3/4')}
	</div>
{/snippet}

<div class="flex min-h-0 flex-1 flex-col">
	<div class="relative flex min-h-0 flex-1 flex-col">
	<div bind:this={tasksList} data-navigation-scroll="tasks-list" use:overlayScroll={'parent'} class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-3">
		<div class="mx-auto flex w-full max-w-3xl flex-col gap-4">
			{#if board === undefined}
				<div class="flex flex-col gap-1.5" role="status" aria-busy="true" aria-label="Loading the tasks">
					<div class="skeleton mx-1 h-3.5 w-24"></div>
					{@render listSkeleton()}
					<span class="sr-only">Loading the tasks…</span>
				</div>
			{:else if adding}
				<BoardTaskEditor
					task={undefined}
					{tasks}
					onsave={(input, options) => board.saveTask(input, options)}
					onback={() => (adding = false)}
				/>
			{:else}
				{#if board.error}
					<Banner tone="error">{board.error}</Banner>
				{/if}

				<div class="flex items-center gap-1 px-1">
					{#if toolbarStart}<div class="mr-1.5 shrink-0">{@render toolbarStart()}</div>{/if}
					<div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-(--chat-fg-subtle)">
						{#if !board.loaded}
							<span class="skeleton inline-block h-3 w-14 align-middle" aria-hidden="true"></span>
							<span class="sr-only">Loading the tasks…</span>
						{:else if empty}
							Nothing here yet.
						{:else}
							{openCount} open
						{/if}
						<TaskFilters />
					</div>
					<Button variant="ghost" size="sm" class="h-7 px-2 text-xs" onclick={() => (adding = true)}>
						<PlusIcon />Add task
					</Button>
				</div>

				<TaskSearchBox query={search.query} onchange={search.setQuery} />
				{#if searching}
					<label class="px-1 text-xs text-(--chat-fg-muted)"><input type="checkbox" checked={sectionOpen.closed === true} onchange={event => sectionOpen.closed = event.currentTarget.checked} /> Show closed</label>
					<section aria-label="Search results" aria-live="polite">
						<p class="mb-2 px-1 text-xs text-(--chat-fg-subtle)">{searchHits.filter(hit => !hit.context).length} matching tasks</p>
						{#if searchFamilies.length}<ul class="task-group">{@render taskRows(searchFamilies)}</ul>{:else}<p class="px-1 text-sm text-(--chat-fg-muted)">No tasks match your search.</p>{/if}
					</section>
				{/if}

				{#if !board.loaded}
					<div class="flex flex-col gap-1.5" aria-hidden="true">
						<div class="skeleton mx-1 h-3.5 w-24"></div>
						{@render listSkeleton()}
					</div>
				{:else if empty}
					<p class="px-1 text-sm text-(--chat-fg-subtle)">
						The coordinator adds a task for each thing you bring up. You can also add one yourself.
					</p>
				{/if}

				{#if board.loaded && !empty && (searching ? sections : familySections).length === 0 && loose.length === 0 && failures.length === 0}
					<p class="px-1 text-sm text-(--chat-fg-subtle)" data-filter-empty>No task matches the filter.</p>
				{/if}

				{#if loose.length > 0}
					<section class="flex flex-col gap-1.5" aria-label="Questions not about a task">
						{@render sectionTitle(loose.some(q => q.waitingOn === 'agent') ? 'Questions' : 'Waiting for you', loose.length, loose.some(q => q.waitingOn !== 'agent'))}
						{#each loose as question (question.id)}
							<BoardQuestionCard
								{question}
								taskLabel={taskLabelOf(question)}
								taskHref={question.taskId === null ? undefined : taskHref(question.taskId)}
								askedBy={questionAskedBy(question, threads)}
								onclarify={board?.clarifyEnabled ? (entry, text) => board.clarify(entry.id, entry.revision, text) : undefined}
								taskFieldsEnabled={board?.taskFieldsEnabled}
								onanswer={(entry, text) => board.answer(entry.id, entry.revision, text)}
							/>
						{/each}
					</section>
				{/if}

				{#if failures.length > 0 && (searching || !needsYouSection)}
					<section class="flex flex-col gap-1.5" aria-label="Needs you" data-section="needs_you">
						{@render sectionTitle('Needs you', failures.length, true)}
						<ul class="task-group">{@render failureRows()}</ul>
					</section>
				{/if}

				{#each searching ? [] : familySections as entry (entry.section.id)}
					{@const section = entry.section}
					<section class="flex flex-col gap-1.5" data-section={section.id} aria-label={section.label}>
						{#if section.collapsedByDefault}
							<button
								type="button"
								class="flex w-full items-center gap-1.5 rounded-lg px-1 py-0.5 text-[0.8125rem] font-semibold text-(--chat-fg-muted) hover:text-(--chat-fg)"
								aria-expanded={isOpen(section)}
								onclick={() => toggle(section)}
							>
								{section.label}
								{@render countPill(taskFamilyCount(section, requestAttention))}
								<ChevronRightIcon class="size-3.5 text-(--chat-fg-subtle) transition-transform {isOpen(section) ? 'rotate-90' : ''}" />
							</button>
						{:else}
							{@render sectionTitle(section.label, taskFamilyCount(section, requestAttention) + (section.id === 'needs_you' ? failures.length : 0), section.id === 'needs_you')}
						{/if}
						{#if isOpen(section)}
							<ul class="task-group">
								{@render taskRows(entry.families)}
								{#if section.id === 'needs_you'}{@render failureRows()}{/if}
							</ul>
						{/if}
					</section>
				{/each}

				<button
					type="button"
					class="flex items-center gap-1.5 self-start rounded-lg px-1 py-1 text-xs text-(--chat-fg-subtle) hover:text-(--chat-fg)"
					aria-pressed={board.showArchived}
					onclick={() => board.setShowArchived(!board.showArchived)}
				>
					<ArchiveIcon class="size-3.5" />
					{board.showArchived ? `Hide archived${archivedShown > 0 ? ` (${archivedShown})` : ''}` : 'Show archived'}
				</button>

				{#if answered.length > 0}
					<section class="flex flex-col gap-1.5" aria-label="Answered questions">
						<button
							type="button"
							class="flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-xs font-semibold text-(--chat-fg-muted) hover:text-(--chat-fg)"
							aria-expanded={answeredOpen}
							onclick={() => (answeredOpen = !answeredOpen)}
						>
							<ChevronRightIcon class="size-3.5 transition-transform {answeredOpen ? 'rotate-90' : ''}" />
							Answered
							{@render countPill(answered.length)}
						</button>
						{#if answeredOpen}
							<ul class="flex flex-col gap-1.5">
								{#each answered as question (question.id)}
									<li class="rounded-xl border border-(--chat-border)/60 px-2.5 py-2 text-task-sm">
										<span class="font-mono text-(--chat-fg-subtle)">{question.id}</span>
										<CardMarkdown source={question.text} />
										<CardMarkdown source={question.answer ?? ''} />
									</li>
								{/each}
							</ul>
						{/if}
					</section>
				{/if}

				{#if decisions.length > 0}
					<section class="flex flex-col gap-1.5" aria-label="Decisions">
						<button
							type="button"
							class="flex w-full items-center gap-1.5 rounded-lg px-1 py-1 text-xs font-semibold text-(--chat-fg-muted) hover:text-(--chat-fg)"
							aria-expanded={decisionsOpen}
							onclick={() => (decisionsOpen = !decisionsOpen)}
						>
							<ChevronRightIcon class="size-3.5 transition-transform {decisionsOpen ? 'rotate-90' : ''}" />
							Decisions
							{@render countPill(decisions.length)}
						</button>
						{#if decisionsOpen}
							<ul class="flex flex-col gap-1.5">
								{#each decisions as decision (decision.id)}
									<li class="rounded-xl border border-(--chat-border)/60 px-2.5 py-2 text-task-sm">
										<span class="font-mono text-(--chat-fg-subtle)">{decision.id}</span>
										<CardMarkdown source={decision.text} />
										{#if decision.why}
											<div class="mt-1 text-(--chat-fg-muted)"><CardMarkdown source={decision.why} /></div>
										{/if}
										<p class="mt-0.5 text-[0.6875rem] text-(--chat-fg-subtle)">
											{#if decision.taskId}{decision.taskId} · {/if}{ago(decision.at)}
										</p>
									</li>
								{/each}
							</ul>
						{/if}
					</section>
				{/if}

				{#if board.loaded && workerHref}
					<LooseWorkers {workers} {tasks} hrefOf={workerHref} />
				{/if}
			{/if}
		</div>
	</div>
	</div>
</div>

<style>
	.search-context { opacity: 0.5; }
	mark { background: color-mix(in oklab, var(--accent-2) 22%, transparent); color: inherit; border-radius: 2px; }
	.family-children { margin-left: 14px; border-left: 1px solid var(--chat-border); }
	.family-depth-limit { margin-left: 0; }
	/* A section's rows as one inset-grouped card, split by hairlines that start where the text does. */
	.task-group {
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border: 1px solid color-mix(in oklab, var(--chat-border) 80%, transparent);
		border-radius: 0.875rem;
		background: color-mix(in oklab, var(--chat-surface) 55%, transparent);
	}
	.task-row-item {
		position: relative;
	}
	.task-row-item + .task-row-item::before {
		content: '';
		position: absolute;
		top: 0;
		right: 0;
		left: 2.25rem;
		height: 1px;
		background: color-mix(in oklab, var(--chat-border) 85%, transparent);
	}
	.task-row {
		transition: background-color 120ms ease;
	}
	/* The title's link reaches over the whole row, so the row opens wherever it is tapped but on a chip. */
	.task-row-link::after {
		content: '';
		position: absolute;
		inset: 0;
	}
	.task-row:has(.task-row-link:focus-visible), .family-header:focus-visible {
		outline: none;
		box-shadow: inset 0 0 0 2px var(--accent-2);
	}
	.task-row.task-row-jump { box-shadow: inset 0 0 0 3px var(--accent-2); }
	.family-compact { min-height: 28px; }
	.family-pointer-button { position: relative; z-index: 1; align-self: stretch; }
	.family-pointer-button:hover { text-decoration: underline; }
	.family-pointer-button:focus-visible { outline: 2px solid var(--accent-2); outline-offset: -2px; border-radius: 4px; }
	@media (pointer: coarse), (max-width: 639px) {
		.family-compact { min-height: 44px; }
		.family-pointer-button::before { content: ''; position: absolute; inset: 0 -4px; }
	}
	.task-row:hover:not(:has(.ref-chip:hover, .relation-chip:hover)) {
		background: color-mix(in oklab, var(--chat-surface-2) 70%, transparent);
	}
	/* Only rows that need the user get a wash: amber for a warning, the accent for a question. */
	.task-row-warning {
		background: color-mix(in oklab, var(--chat-warning) 9%, transparent);
	}
	.task-row-warning:hover {
		background: color-mix(in oklab, var(--chat-warning) 14%, transparent);
	}
	.task-row-question {
		background: color-mix(in oklab, var(--accent-2) 8%, transparent);
	}
	.task-row-question:hover {
		background: color-mix(in oklab, var(--accent-2) 13%, transparent);
	}
	/* The chevron is a hint for a pointer that hovers; a touch screen never shows it. */
	:global(.task-row-chevron) {
		display: none;
	}
	@media (hover: hover) and (pointer: fine) {
		:global(.task-row-chevron) {
			display: block;
			opacity: 0;
			transition: opacity 120ms ease;
		}
		.task-row:hover :global(.task-row-chevron),
		.task-row:has(.task-row-link:focus-visible) :global(.task-row-chevron) {
			opacity: 1;
		}
	}
	/* A working task's dot breathes, softly. */
	.task-row-pulse {
		animation: task-row-pulse 2.4s ease-in-out infinite;
	}
	@keyframes task-row-pulse {
		0%,
		100% {
			box-shadow: 0 0 0 0 color-mix(in oklab, var(--task-status) 45%, transparent);
		}
		50% {
			box-shadow: 0 0 0 3.5px color-mix(in oklab, var(--task-status) 0%, transparent);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.task-row, :global(.task-row-chevron) { transition: none; }
		.task-row-pulse {
			animation: none;
		}
	}
</style>
