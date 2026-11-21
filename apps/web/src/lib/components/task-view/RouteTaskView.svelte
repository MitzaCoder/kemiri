<script lang="ts">
	import { tick } from 'svelte';
	import { formatMinutes } from '@kemiri/client';
	import type { BoardQuestion } from '@kemiri/protocol';
	import ArrowRightIcon from '@lucide/svelte/icons/arrow-right';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import CheckIcon from '@lucide/svelte/icons/check';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import HandIcon from '@lucide/svelte/icons/hand';
	import MessageCircleIcon from '@lucide/svelte/icons/message-circle';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import XIcon from '@lucide/svelte/icons/x';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import BoardQuestionCard from '#lib/components/BoardQuestionCard.svelte';
	import Markdown from '#lib/components/markdown/Markdown.svelte';
	import ReportStaleAction from '#lib/components/ReportStaleAction.svelte';
	import TaskActivity from '#lib/components/TaskActivity.svelte';
	import TaskDelivery from '#lib/components/TaskDelivery.svelte';
	import TaskDetailText from '#lib/components/TaskDetailText.svelte';
	import TaskFeedback from '#lib/components/TaskFeedback.svelte';
	import TaskFiles from '#lib/components/artifacts/TaskFiles.svelte';
	import TaskRecordFold from '#lib/components/TaskRecordFold.svelte';
	import TaskRefs from '#lib/components/TaskRefs.svelte';
	import TaskRelations from '#lib/components/TaskRelations.svelte';
	import TaskReply from '#lib/components/TaskReply.svelte';
	import TaskStatusMenu from '#lib/components/TaskStatusMenu.svelte';
	import TaskText from '#lib/components/chat/TaskText.svelte';
	import TaskUsage from '#lib/components/TaskUsage.svelte';
	import TaskWaitingForm from '#lib/components/TaskWaitingForm.svelte';
	import type { TaskViewDesignProps } from '#lib/task-view/designs.js';
	import { provideArtifactScope } from '#lib/artifacts.svelte.js';
	import { emptyFinishedResults } from '#lib/report-freshness.js';
	import { automaticReportProof, hasReportSection } from '#lib/report-sections.js';
	import { acceptanceMarkdown, taskNextPlacement } from '#lib/task-details.js';
	import { isWarning, taskDisplayWords, taskRefs, taskStatusWords } from '#lib/tasks.js';
	import { taskUsesPartsSentence } from '#lib/task-parts.js';
	import { waitingSummary } from '#lib/task-waiting.js';
	import { overlayScroll } from '#lib/scrollbars.js';
	import { openFeedbackCount } from '#lib/task-relations.js';
	import { splitRefMentions } from '#lib/refs.js';
	import { exactTime } from '#lib/relative-time.js';
	import { defaultRouteDoor, routeAttention, routeParts, routeStops, ROUTE_DOORS_MIN_WIDTH, type RouteDoor } from '#lib/task-view/route/route.js';
	import TaskViewDesignMenu from './TaskViewDesignMenu.svelte';
	import RouteProof from './route/RouteProof.svelte';
	import RouteRail from './route/RouteRail.svelte';
	import RouteReportGlance from './route/RouteReportGlance.svelte';
	import RouteReportSection from './route/RouteReportSection.svelte';
	import './route/route.css';

	let { model, editor }: TaskViewDesignProps = $props();
	const { task, projectId, backend, fields, needsYou, supportsLinks, requestedId, taskFieldsEnabled } = $derived(model);
	const hasResults = $derived(task && hasReportSection(task.report, 'results'));
	const nextPlacement = $derived(task && taskNextPlacement(task.report, needsYou?.review ?? false));
	const proof = $derived(task ? automaticReportProof(task.report, model.artifacts) : []);
	provideArtifactScope(() => ({ client: backend.client, projectId, available: backend.supports('artifacts'), reportSectionViews: backend.supports('task-report-section-views') }));
	const registerQuoteScope = $derived(model.registerQuoteScope);
	const id = $props.id();
	const doors = [
		{ id: 'you', label: 'Your stop', icon: HandIcon },
		{ id: 'got', label: 'Arrived', icon: CheckIcon },
		{ id: 'ahead', label: 'Ahead', icon: ArrowRightIcon },
	] as const;
	let width = $state(0);
	const wide = $derived(width >= ROUTE_DOORS_MIN_WIDTH);
	let chosenDoor = $state<{ task: string; door: RouteDoor }>();
	const attention = $derived(task && routeAttention(task, needsYou));
	const openDoor = $derived(chosenDoor && chosenDoor.task === model.viewTaskKey ? chosenDoor.door : defaultRouteDoor(attention?.count ?? 0));
	const questions = $derived(needsYou?.ownerQuestions.filter(question => !isWarning(question)) ?? []);
	const warnings = $derived(needsYou?.ownerQuestions.filter(isWarning) ?? []);
	const parts = $derived(task ? routeParts(task, model.tasks) : []);
	const parent = $derived(task && (model.tasks.find(candidate => candidate.id === task.parent) ?? model.archivedLinks?.find(candidate => candidate.id === task.parent)));
	const live = $derived(requestedId !== null && model.taskLiveEnabled ? task?.live : undefined);
	const liveNow = $derived.by(() => {
		if (task?.status !== 'in_progress' || !live) return undefined;
		const current = model.liveNow ?? model.activity;
		const phase = taskUsesPartsSentence(task) || current?.kind === 'question'
			? live.lines.findLast(line => line.kind === 'phase' && !line.wrong) : undefined;
		return phase ? { kind: 'working' as const, text: phase.text, since: phase.at, refs: [] } : current;
	});
	const stops = $derived(task && attention ? routeStops(task, parts, attention, liveNow?.since) : []);
	const haveNotes = $derived(task && supportsLinks && (model.feedbackEntries.length || openFeedbackCount(task) || model.feedbackProblem || model.timelineError));
	const haveConnections = $derived(task && (task.parent || task.foundWhile || task.ledTo?.length || task.related?.length || task.blockedBy.length || task.blocks?.length || parts.length || task.subtasks?.length || model.taskWorkers.length || model.owner));
	const deliveryLabel = $derived(model.delivery && (model.delivery.deployment === 'live' ? 'Live'
		: model.delivery.deployment === 'failed' ? 'Deploy failed' : model.delivery.deployment === 'pending' ? 'Deploy pending'
		: model.delivery.integration?.landed === model.delivery.commits.length ? 'Merged' : 'Built, not confirmed merged'));

	let reply = $state<{ focus(): void }>();
	let replyTrigger = $state<HTMLButtonElement>();
	let replyActiveFor = $state<string>();
	let restoringReplyFocus = false;
	const replyOpen = $derived(replyActiveFor === model.viewTaskKey);
	let attentionHeading = $state<HTMLHeadingElement>();

	async function openReply() {
		if (restoringReplyFocus) return;
		replyActiveFor = model.viewTaskKey;
		await tick();
		reply?.focus();
	}

	async function collapseReply() {
		replyActiveFor = undefined;
		await tick();
		restoringReplyFocus = true;
		replyTrigger?.focus();
		restoringReplyFocus = false;
	}

	$effect(() => model.registerReply({ focus: () => { void openReply(); } }));

	function pickDoor(door: RouteDoor): void {
		chosenDoor = { task: model.viewTaskKey, door };
	}

	async function showAttention() {
		pickDoor('you');
		await tick();
		attentionHeading?.focus();
	}
</script>

{#if task && attention}
	<div class="route-sheet" class:route-wide={wide} bind:clientWidth={width}>
		<header class="route-topbar">
			<div class="route-width route-topbar-content">
				<nav class="route-breadcrumb" aria-label="Task location">
					{#if model.previousTask}
						<button type="button" class="route-text-link" onclick={model.goBack} title="Back to {model.previousTask.id}">← <span class="route-parent">{model.previousTask.title}</span><span aria-hidden="true" class="route-back-id">{model.previousTask.id}</span></button>
					{:else}
						<span class="route-project">{model.projectName ?? 'Project'}</span>
						{#if task.parent}<span aria-hidden="true" class="route-parent">/</span><a class="route-parent route-text-link" href={model.taskHref(task.parent)}>{parent?.title || task.parent}</a>{/if}
					{/if}
					<span aria-hidden="true">/</span><span class="font-mono">{task.id}</span>
				</nav>
				<div class="route-header-actions">
					{#if !model.editing}<Button variant="ghost" size="icon-sm" class="size-11" onclick={model.showEditor} aria-label="Edit {task.id}" title="Edit the task"><PencilIcon /></Button>{/if}
					<TaskViewDesignMenu />
					<Button variant="ghost" size="icon-sm" class="size-11" onclick={model.close} aria-label="Close the task page" title="Close the task page"><XIcon /></Button>
				</div>
			</div>
		</header>
		<div class="route-scroll" data-navigation-scroll="task-body" use:registerQuoteScope use:overlayScroll={'parent'}>
			<div class="route-width route-content">
				<div class="route-hero">
					<div class="route-state">
						<TaskStatusMenu status={task.status} {task} label={attention.questions && task.status === 'in_progress' && liveNow?.kind === 'working' ? taskStatusWords(task.status) : taskDisplayWords(task, model.tasks)} disabled={model.closing} supportsWaiting={model.supportsWaiting} onpick={model.pickStatus} />
						{#if attention.label}<button class="route-attention-chip" type="button" onclick={showAttention}><HandIcon aria-hidden="true" /> {attention.label}</button>{/if}
					</div>
					<Dialog.Title class="route-title">
						{#each splitRefMentions(task.title, model.refLinks) as piece, index (index)}
							{#if piece.href}<a class="route-text-link" href={piece.href} target="_blank" rel="noopener noreferrer">{piece.text}</a>{:else}<TaskText text={piece.text} />{/if}
						{/each}
					</Dialog.Title>
					<div class="route-facts-line">
						{#if fields?.goal}<p class="route-goal">{fields.goal}</p>{/if}
						{#if task.inProgressMinutes || deliveryLabel || task.archived || (task.status === 'waiting' && task.waiting)}
							<p class="route-facts">
								{#if task.inProgressMinutes && task.inProgressMinutes > 0}<span>In progress <strong>{formatMinutes(task.inProgressMinutes)}</strong></span>{/if}
								{#if deliveryLabel}<strong>{deliveryLabel}</strong>{/if}
								{#if task.archived}<strong>Archived</strong>{/if}
								{#if task.status === 'waiting' && task.waiting}<span>{waitingSummary(task)}</span>{/if}
							</p>
						{/if}
					</div>
					{#key task.id}{#if taskRefs(task).length}<TaskRefs refs={taskRefs(task)} />{/if}{/key}
					{#if model.waitingForm}<TaskWaitingForm waiting={task.waiting} busy={model.closing} onsave={(note, until) => model.setStatus('waiting', note, until)} oncancel={model.cancelWaiting} />
					{:else if model.confirmDrop}
						<div class="flex flex-wrap items-center gap-2">
							<p>Drop {task.id}? It will not be done.</p>
							<Button variant="destructive" disabled={model.closing} onclick={() => model.setStatus('dropped')}>Drop it</Button>
							<Button variant="ghost" onclick={model.cancelDrop}>Keep</Button>
						</div>
					{/if}
					{#if model.problem}<p role="alert" class="text-(--chat-danger)"><TaskDetailText text={model.problem} /></p>{/if}
				</div>
				{#key model.viewTaskKey}
					{#if model.editing}
						{@render editor()}
					{:else}
						<RouteRail {stops} {wide} {model} {live} now={liveNow} onattention={showAttention} />
						<div class="route-platforms" data-open={openDoor}>
							{#each doors as door (door.id)}
								{@const open = !wide || openDoor === door.id}
								<section class="route-platform" class:route-raised={wide ? open : door.id === 'you'} data-door={door.id} aria-labelledby={`${id}-${door.id}-title`}>
									<div class="route-sign">
										<span class="route-roundel"><door.icon aria-hidden="true" /></span>
										{#if door.id === 'you'}<h2 id={`${id}-you-title`} tabindex="-1" bind:this={attentionHeading}>{door.label}</h2>
										{:else}<h2 id={`${id}-${door.id}-title`}>{door.label}</h2>{/if}
										{#if wide}<button type="button" class="route-small-button route-door-button" aria-label={`Open ${door.label}`} aria-expanded={open} aria-controls={`${id}-${door.id}-body`} onclick={() => pickDoor(door.id)}>{open ? 'Viewing' : 'Open ›'}</button>
										{:else if door.id === 'you' && attention.count}<span class="route-quiet route-stop-count">{attention.count} {attention.count === 1 ? 'thing waits' : 'things wait'}</span>{/if}
									</div>
									<div class="route-platform-body" id={`${id}-${door.id}-body`}>
										{#if door.id === 'you'}
											<div class="route-your-stop" class:route-your-stop-columns={open && wide && questions.length > 0 && (attention.count > questions.length || haveNotes)}>
												{#if questions.length}
													<div class="route-flow route-main-questions">
														{#each questions.slice(0, open ? questions.length : 1) as question (question.id)}{@render questionCard(question)}{/each}
													</div>
												{/if}
												{#if open}
													<div class="route-flow">
														{#if !attention.count}<p class="route-quiet">Nothing waits for you.</p>{/if}
														{#if warnings.length}{@render disclosure('Heads-up', wide, warningList)}{/if}
														{#if attention.steps}{@render disclosure('Your steps', wide, ownerSteps)}{/if}
														{#if attention.review}
															<div class="route-flow"><h3>Check the work</h3>
																{#if nextPlacement === 'review'}<RouteReportSection {task} section="next" />{/if}
																<div class="flex flex-wrap gap-2"><Button class="min-h-11" disabled={model.closing} onclick={model.completeReview}>It works: close the task</Button><Button class="min-h-11" variant="outline" onclick={model.focusReply}>Something is off…</Button></div>
															</div>
														{/if}
														{#if attention.blocked}
															<div class="route-flow"><h3>Blocked</h3>
																{#if task.blockedReason}<Markdown source={task.blockedReason} class="task-detail-markdown" />{/if}
																{#if model.blockers.length}<ul>{#each model.blockers as blocker (blocker.id)}<li><a class="task-fact-link" href={model.taskHref(blocker.id)}><TaskDetailText text={blocker.title} focusable={false} /> <span class="task-id-chip">{blocker.id}</span></a></li>{/each}</ul>{/if}
															</div>
														{/if}
														{#if haveNotes}{@render disclosure('Your notes', wide, taskNotes)}{/if}
													</div>
												{:else if attention.count > questions.slice(0, 1).length}
													<p class="route-quiet">{questions.length ? `${attention.count - 1} more waiting` : attention.label}</p>
												{:else if !attention.count}<p class="route-quiet">Nothing waits for you.</p>{/if}
											</div>
										{:else if door.id === 'got'}
											<div class="route-arrived" class:route-arrived-columns={wide && open && (fields?.checks.length || model.artifacts.length || model.delivery)}>
												<div class="route-flow route-story">
													{#if open}
														{#if fields?.hasSummary}<RouteReportSection {task} section="summary" />{/if}
														{#if model.staleReport}<p class="route-quiet route-stale">Report may be out of date. <ReportStaleAction {backend} {projectId} taskId={task.id} /></p>{/if}
														{#if hasResults}<RouteReportSection {task} section="results" />{/if}
													{:else}
														<RouteReportGlance {task} door="arrived" {taskFieldsEnabled} />
													{/if}
													{#if !hasResults && !fields?.hasSummary && !model.failedChecks}
														<p class="route-quiet">{emptyFinishedResults(task) ? 'No results yet · work finished' : 'Nothing written yet.'}</p>
													{/if}
													{#if !open && model.failedChecks}<p class="route-failed">{model.failedChecks}</p>{/if}
													{#if open && requestedId !== null && model.supportsUsage}<TaskUsage client={backend.client} {projectId} taskId={task.id} />{/if}
												</div>
												{#if open && (fields?.checks.length || model.artifacts.length || model.delivery)}
													<div class="route-flow route-evidence">
														{#if proof.length}<h3>Proof</h3><RouteProof media={proof} client={backend.client} />{/if}
														{#if fields?.checks.length}{@render checks(wide)}{/if}
														{#if model.artifacts.length}<h3>Files ({model.artifacts.length})</h3><TaskFiles artifacts={model.artifacts} client={backend.client} {projectId} onupdatetags={model.supportsArtifactTags ? model.updateArtifactTags : undefined} />{/if}
														{#if model.delivery}{@render disclosure('Delivery', wide, deliveryDetails)}{/if}
													</div>
												{/if}
											</div>
										{:else}
											<div class="route-flow">
												{#if open}
													{#if fields?.hasNotDone}<h3>Not done</h3><RouteReportSection {task} section="notDone" />{/if}
													{#if nextPlacement === 'next'}<h3>Next</h3><RouteReportSection {task} section="next" />{/if}
												{:else}
													<RouteReportGlance {task} door="ahead" {taskFieldsEnabled} showNext={nextPlacement === 'next'} />
												{/if}
												{#if nextPlacement === undefined && !fields?.hasNotDone && !haveConnections && !needsYou?.questionsForAgent.length}
													<p class="route-quiet">No next action written.</p>
												{/if}
												{#if open && needsYou?.questionsForAgent.length}
													<h3>Waiting for an agent reply</h3>
													{#each needsYou.questionsForAgent as question (question.id)}{@render questionCard(question)}{/each}
												{/if}
												{#if open && haveConnections}{@render disclosure('Parts, links and workers', wide, connections)}
												{:else if parts.length}<p class="route-quiet">{parts.filter(part => part.status === 'done').length} of {parts.length} parts done</p>{/if}
											</div>
										{/if}
									</div>
								</section>
							{/each}
						</div>
						{@render record()}
					{/if}
				{/key}
			</div>
		</div>
		{#if !model.editing}
			<div class="route-reply" class:route-reply-open={replyOpen}>
				{#if replyOpen}
					<div class="route-reply-heading"><strong>Reply</strong><Button variant="ghost" size="icon-sm" aria-label="Collapse reply" onclick={collapseReply}><XIcon /></Button></div>
					{#key model.viewTaskKey}<TaskReply bind:this={reply} {backend} {projectId} taskId={task.id} />{/key}
				{:else}
					<button bind:this={replyTrigger} class="route-reply-button" type="button" onfocus={openReply} onclick={openReply}><MessageCircleIcon aria-hidden="true" /> Reply</button>
				{/if}
			</div>
		{/if}
	</div>
{/if}

{#snippet disclosure(title: string, expanded: boolean, content: import('svelte').Snippet)}
	{#if expanded}<section class="route-flow"><h3>{title}</h3>{@render content()}</section>
	{:else}<details class="route-fold"><summary><ChevronRightIcon aria-hidden="true" /> {title}</summary><div class="route-flow route-fold-content">{@render content()}</div></details>{/if}
{/snippet}

{#snippet questionCard(question: BoardQuestion)}
	<BoardQuestionCard {question} {taskFieldsEnabled} plain askedBy={model.questionAskedBy(question)}
		onclarify={model.supportsClarify ? model.clarifyQuestion : undefined} onanswer={model.answerQuestion} />
{/snippet}

{#snippet warningList()}
	{#each warnings as warning (warning.id)}{@render questionCard(warning)}{/each}
{/snippet}

{#snippet ownerSteps()}
	{#if task}<RouteReportSection {task} section="steps" />{/if}
{/snippet}

{#snippet taskNotes()}
	{#if task}<TaskFeedback entries={model.feedbackEntries} openCount={openFeedbackCount(task)} busy={model.feedbackBusy}
		problem={model.feedbackProblem ?? model.timelineError} onset={model.setFeedback} threadName={model.threadName} />{/if}
{/snippet}

{#snippet deliveryDetails()}
	{#if model.delivery && task}{#key task.id}<TaskDelivery delivery={model.delivery} projectId={model.projectId} taskId={task.id} changesClient={model.changesClient} showHeading={false} />{/key}{/if}
{/snippet}

{#snippet connections()}
	{#if task}
		<TaskRelations {task} tasks={model.tasks} archivedLinks={model.archivedLinks} hrefOf={model.taskHref}
			blockersInNeedsYou={attention?.blocked ? model.blockers.map(blocker => blocker.id) : []} onshowlinked={model.showLinked} />
		{#if model.owner}<p class="route-quiet">Owner thread: {#if model.owner.threadId}<a class="route-text-link" href={model.threadHref(model.owner.threadId)}>{model.owner.label}</a>{:else}{model.owner.label}{/if}</p>{/if}
		{#if model.taskWorkers.length}
			<h3>Workers</h3>
			<ul class="route-worker-list">{#each model.taskWorkers as worker (worker.id)}
				{@const href = model.workerHref(worker.id)}
				<li>{#if href}<a class="route-text-link" {href}>{worker.id}</a>{:else}{worker.id}{/if}</li>
			{/each}</ul>
		{/if}
	{/if}
{/snippet}

{#snippet passedChecks()}
	<ul role="list" class="route-check-list">
		{#each fields?.checks.filter(check => check.result === 'passed') ?? [] as check}
			<li><CheckIcon aria-hidden="true" /><span>{check.name}{#if check.count !== undefined} · {check.count.toLocaleString()}{/if}{#if check.note?.trim()} · {check.note}{/if}</span></li>
		{/each}
	</ul>
{/snippet}

{#snippet checks(expanded: boolean)}
	{#if fields?.checks.length}
		{@const passed = fields.checks.filter(check => check.result === 'passed').length}
		<section class="route-flow" aria-label="Checks">
			<div class="route-check-pips"><h3>Checks</h3><span class="route-pips" aria-hidden="true">{#each fields.checks as check}<i class:failed={check.result === 'failed'}></i>{/each}</span><span class="route-quiet">{passed} of {fields.checks.length} passed</span></div>
			{#each fields.checks.filter(check => check.result === 'failed') as check}<p class="route-failed"><strong>{check.name} failed.</strong>{#if check.note}{' '}{check.note}{/if}</p>{/each}
			{#if passed}{#if expanded}{@render passedChecks()}{:else}{@render disclosure('Passed checks', false, passedChecks)}{/if}{/if}
		</section>
	{/if}
{/snippet}

{#snippet record()}
	{#if task}
		<details class="route-fold route-record">
			<summary><BookOpenIcon aria-hidden="true" /><strong>The record</strong><span class="route-quiet">· Request and activity</span><ChevronRightIcon aria-hidden="true" /></summary>
			<div class="route-flow route-fold-content">
				<TaskRecordFold row="request" title="The request">
					{#if task.description.trim()}<Markdown source={task.description} class="task-detail-markdown" />{:else if !task.acceptance?.trim()}<p>No request written.</p>{/if}
					{#if task.acceptance?.trim()}<h4 class="font-semibold">Done when</h4><Markdown source={acceptanceMarkdown(task.acceptance)} class="task-detail-markdown" />{/if}
				</TaskRecordFold>
				{#if fields?.checks.length}<TaskRecordFold row="checks" title="Checks">{@render checks(true)}</TaskRecordFold>{/if}
				{#if model.decided.length}
					<TaskRecordFold row="decided" title="Decided" count={model.decided.length}>
						{#each model.decided as row (row.id)}
							<details class="route-fold"><summary><ChevronRightIcon aria-hidden="true" /><TaskDetailText text={row.decision?.text ?? (row.question?.answer || 'Question answered')} focusable={false} /></summary>
								{#if row.question}<Markdown source={row.question.text} />{#if row.decision && row.question.answer}<Markdown source={row.question.answer} />{/if}{/if}
								{#if row.why}<Markdown source={row.why} />{/if}
								<time class="route-quiet" datetime={row.at}>{exactTime(row.at)}</time>
							</details>
						{/each}
					</TaskRecordFold>
				{/if}
				{#if supportsLinks || task.snapshots || model.taskWorkers.length || model.now}
					<TaskRecordFold row="activity" title="Activity">
						<TaskActivity board={model.board} {task} writerName={model.writerName} loading={supportsLinks && model.timelineEntries === undefined} error={model.timelineError} news={model.news}
							sources={{ entries: model.timelineEntries, groups: model.timelineGroups, questions: model.questions, decisions: model.decided, feedback: model.feedbackEntries, workers: model.taskWorkers, now: liveNow ? undefined : model.now, taskLiveEnabled: model.taskLiveEnabled, deliveryShown: !!model.delivery }}
							workerHref={model.workerHref} taskHref={model.taskHref} />
					</TaskRecordFold>
				{/if}
			</div>
		</details>
	{/if}
{/snippet}
