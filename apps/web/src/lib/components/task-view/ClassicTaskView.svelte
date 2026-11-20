<script lang="ts">
	import TaskActivity from '#lib/components/TaskActivity.svelte';
	import TaskLive from '#lib/components/TaskLive.svelte';
	import TaskDelivery from '#lib/components/TaskDelivery.svelte';
	import TaskDetailText from '#lib/components/TaskDetailText.svelte';
	import TaskText from '#lib/components/chat/TaskText.svelte';
	import ReportStaleAction from '#lib/components/ReportStaleAction.svelte';
	import TaskRecordFold from '#lib/components/TaskRecordFold.svelte';
	import TaskProof from '#lib/components/artifacts/TaskProof.svelte';
	import TaskReply from '#lib/components/TaskReply.svelte';
	import TaskUsage from '#lib/components/TaskUsage.svelte';
	import TaskFiles from '#lib/components/artifacts/TaskFiles.svelte';
	import TaskStatusMenu from '#lib/components/TaskStatusMenu.svelte';
	import TaskWaitingForm from '#lib/components/TaskWaitingForm.svelte';
	import BoardQuestionCard from '#lib/components/BoardQuestionCard.svelte';
	import Markdown from '#lib/components/markdown/Markdown.svelte';
	import TaskFeedback from '#lib/components/TaskFeedback.svelte';
	import TaskRelations from '#lib/components/TaskRelations.svelte';
	import TaskRefs from '#lib/components/TaskRefs.svelte';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import { emptyFinishedResults } from '#lib/report-freshness.js';
	import { overlayScroll } from '#lib/scrollbars.js';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import XIcon from '@lucide/svelte/icons/x';
	import CheckIcon from '@lucide/svelte/icons/check';
	import { openFeedbackCount } from '#lib/task-relations.js';
	import { acceptanceMarkdown, taskDetailState } from '#lib/task-details.js';
	import { waitingSummary } from '#lib/task-waiting.js';
	import { formatMinutes } from '@kemiri/client';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';

	import { splitRefMentions } from '#lib/refs.js';
	import { exactTime } from '#lib/relative-time.js';
	import { taskRefs } from '#lib/tasks.js';

	import TaskViewDesignMenu from './TaskViewDesignMenu.svelte';
	import type { TaskViewDesignProps } from '#lib/task-view/designs.js';

	let { model, editor }: TaskViewDesignProps = $props();
	const {
		task, backend, projectId, board, tasks, previousTask, requestedId, editing, waitingForm, confirmDrop, closing, problem,
		needsYou, taskFieldsEnabled, fields, blockers, liveNow, news, staleReport, failedChecks, proof, artifacts,
		supportsLinks, feedbackEntries, feedbackBusy, feedbackProblem, timelineError, timelineEntries, timelineGroups,
		decided, questions, taskWorkers, now, taskLiveEnabled, delivery, owner, archivedLinks,
	} = $derived(model);
	const registerQuoteScope = $derived(model.registerQuoteScope);
	let reply = $state<{ focus(): void }>();
	$effect(() => reply && model.registerReply(reply));
</script>

{#if task}
	<header
		class="task-header flex max-h-[35%] shrink-0 flex-col overflow-y-auto overscroll-contain gap-2 border-b border-(--chat-border) px-4 pt-[max(0.75rem,env(safe-area-inset-top))] pb-3"
	>
		{#if previousTask}
			<Button variant="ghost" class="min-h-11 max-w-full justify-start" title={`Back to ${previousTask.id}`} onclick={model.goBack}>
				<span class="truncate">← {previousTask.id} · <TaskDetailText text={previousTask.title} focusable={false} /></span>
			</Button>
		{/if}
		<div class="flex items-center gap-2">
			<span class="font-mono text-xs text-(--chat-fg-subtle)">{task.id}</span>
			<TaskStatusMenu status={task.status} {task} label={taskDetailState(task.status, needsYou!, task.state?.kind)} disabled={closing} supportsWaiting={model.supportsWaiting} onpick={model.pickStatus} />
			<div class="ml-auto flex shrink-0 items-center sm:gap-2">
				{#if !editing}
					<Button variant="ghost" size="icon-sm" class="size-11" onclick={model.showEditor} aria-label="Edit {task.id}" title="Edit the task"><PencilIcon /></Button>
				{/if}
				<TaskViewDesignMenu />
				<Button variant="ghost" size="icon-sm" class="size-11" onclick={model.close} aria-label="Close the task page" title="Close the task page"><XIcon /></Button>
			</div>
		</div>
		<Dialog.Title class="text-lg leading-snug font-semibold break-words"
			>{#each splitRefMentions(task.title, model.refLinks) as piece, index (index)}{#if piece.href}<a
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
			<TaskWaitingForm waiting={task.waiting} busy={closing} onsave={(note, until)=>model.setStatus('waiting',note,until)} oncancel={model.cancelWaiting}/>
		{:else if confirmDrop}
			<div class="flex flex-wrap items-center gap-2"><span class="text-xs"><TaskDetailText text={`Drop ${task.id}? It will not be done.`} /></span><Button variant="destructive" size="sm" disabled={closing} onclick={()=>model.setStatus('dropped')}>Drop it</Button><Button variant="ghost" size="sm" onclick={model.cancelDrop}>Keep</Button></div>
		{/if}
		{#if problem}
			<p class="text-xs text-(--chat-danger)" role="alert"><TaskDetailText text={problem} /></p>
		{/if}
	</header>

	<div class="relative flex min-h-0 flex-1 flex-col">
		<div use:registerQuoteScope data-navigation-scroll="task-body" use:overlayScroll={'parent'}
			class="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-task-body>
			{#key model.viewTaskKey}
				{#if editing}
					{@render editor()}
				{:else}
					<div class="task-details-layout">
						<div class="task-reading">
							{#snippet questionCard(question: NonNullable<typeof needsYou>['ownerQuestions'][number])}
								<BoardQuestionCard {question} {taskFieldsEnabled} plain askedBy={model.questionAskedBy(question)}
									onclarify={model.supportsClarify ? model.clarifyQuestion : undefined}
									onanswer={model.answerQuestion} />
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
												<Button class="min-h-11" disabled={closing} onclick={model.completeReview}>It works: close the task</Button>
												<Button class="min-h-11" variant="outline" onclick={model.focusReply}>Something is off…</Button>
											</div>
										</div>
									{/if}
									{#if needsYou.blocked}
										<div class="flex flex-col gap-1">
											{#if task.blockedReason}<Markdown source={task.blockedReason} class="task-detail-markdown" />{/if}
											{#if blockers.length > 0}
												<h3 class="task-detail-heading">Blocked by</h3>
												<ul>{#each blockers as blocker (blocker.id)}
													<li><a class="task-fact-link" href={model.taskHref(blocker.id)}><TaskDetailText text={blocker.title || 'Not on the board'} focusable={false} /> <span class="task-id-chip">{blocker.id}</span></a></li>
												{/each}</ul>
											{/if}
										</div>
									{/if}
									</section>
							{/if}

							{#if requestedId !== null && task.live && liveNow}
								{#key JSON.stringify([backend.id, projectId, task.id])}
									<TaskLive live={task.live} now={liveNow} backendId={backend.id} {projectId} taskId={task.id} {news} />
								{/key}
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
								{#if requestedId !== null && model.supportsUsage}<TaskUsage client={backend.client} {projectId} taskId={task.id} />{/if}
							</section>

							{#if artifacts.length > 0}
								<section class="task-reading-section" aria-label="Files">
									<h2 class="task-detail-heading">Files ({artifacts.length})</h2>
									<TaskFiles {artifacts} client={backend.client} {projectId} onupdatetags={model.supportsArtifactTags ? model.updateArtifactTags : undefined} />
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
										problem={feedbackProblem ?? timelineError} onset={model.setFeedback} threadName={model.threadName} />
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
																<p class="text-xs">{model.writerName({ author: 'user', threadId: null, workerId: null })} {#if row.question.answeredAt}· <time datetime={row.question.answeredAt}>{exactTime(row.question.answeredAt)}</time>{/if}</p>
															{:else}<p class="text-xs">{model.threadName(row.decision?.threadId ?? 'main')} · <time datetime={row.at}>{exactTime(row.at)}</time></p>{/if}
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
										<TaskActivity {board} {task} writerName={model.writerName} loading={supportsLinks && timelineEntries === undefined} error={timelineError}
											{news}
											sources={{ entries: timelineEntries, groups: timelineGroups, questions, decisions: decided, feedback: feedbackEntries, workers: taskWorkers, now: liveNow ? undefined : now, taskLiveEnabled, deliveryShown: !!delivery }}
											workerHref={model.workerHref}
											taskHref={model.taskHref} />
									</TaskRecordFold>
								{/if}
							</section>
						</div>

						<aside class="task-about" aria-label="About this task">
							<h2 class="task-detail-heading">About this task</h2>
							{#if delivery}<TaskDelivery {delivery} />{/if}
							<dl class="task-facts">
								{#if owner}<div><dt>Owner thread</dt><dd>{#if owner.threadId}<a class="task-fact-link underline" href={model.threadHref(owner.threadId)}>{owner.label}</a>{:else}{owner.label}{/if}</dd></div>{/if}
								{#if task.status === 'waiting' && task.waiting}<div><dt>Waiting details</dt><dd><TaskDetailText text={waitingSummary(task)} /></dd></div>{/if}
								{#if task.archived}<div><dt>Status</dt><dd>Archived</dd></div>{/if}
							</dl>
							<TaskRelations {task} {tasks} {archivedLinks} hrefOf={model.taskHref}
								blockersInNeedsYou={needsYou?.blocked ? blockers.map(blocker => blocker.id) : []}
								onshowlinked={model.showLinked} />
							<dl class="task-facts">
								<div><dt>Created</dt><dd><time datetime={task.createdAt} title={exactTime(task.createdAt)}>{model.ago(task.createdAt)}</time></dd></div>
								<div><dt>Updated</dt><dd><time datetime={task.updatedAt} title={exactTime(task.updatedAt)}>{model.ago(task.updatedAt)}</time></dd></div>
								{#if task.settledAt}<div><dt>Closed</dt><dd><time datetime={task.settledAt} title={exactTime(task.settledAt)}>{model.ago(task.settledAt)}</time></dd></div>{/if}
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
				{#key model.viewTaskKey}
					<TaskReply bind:this={reply} {backend} {projectId} taskId={task.id} />
				{/key}
			</div>
		</footer>
	{/if}
{/if}
