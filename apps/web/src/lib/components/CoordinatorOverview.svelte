<script lang="ts">
	import ArrowUpRightIcon from '@lucide/svelte/icons/arrow-up-right';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CircleHelpIcon from '@lucide/svelte/icons/circle-help';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import ListChecksIcon from '@lucide/svelte/icons/list-checks';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import type { Board, Overview, ThreadSummary } from '@kemiri/protocol';
	import { activityMinute } from '#lib/activity-minute.js';
	import { overviewAge, overviewFlightRows, overviewOpeningLine, overviewTime, overviewWaitHref, overviewWaitingRows, plural } from '#lib/coordinator-overview.js';
	import { overviewEstimateText } from '#lib/overview-time-left.js';
	import { readCoordinatorPreference, saveCoordinatorPreference } from '#lib/coordinators.js';
	import { taskPartProgress } from '#lib/task-parts.js';
	import { taskDisplayWords } from '#lib/tasks.js';
	import { usageMoney } from '#lib/usage-money.js';
	import { usageModal } from '#lib/usage-modal.svelte.js';
	import CoordinatorMark from './CoordinatorMark.svelte';
	import TaskActivityLine from './TaskActivityLine.svelte';
	import TaskPartsProgress from './TaskPartsProgress.svelte';

	let { snapshot, board, roster, error, taskHref, questionHref, coordinatorHref, oncoordinator }: {
		snapshot?: Overview; board?: Board;
		roster: readonly ThreadSummary[];
		error?: string;
		taskHref: (id: string) => string;
		questionHref: (id: string) => string;
		coordinatorHref: (id: string) => string;
		oncoordinator: (id: string, event: MouseEvent) => void;
	} = $props();

	const tasks = $derived(new Map(board?.tasks.map(task => [task.id, task])));
	const questions = $derived(new Map(board?.questions.filter(question => question.status === 'open').map(question => [question.id, question])));
	const now = $derived(Math.max($activityMinute, Date.parse(snapshot?.asOf ?? '') || 0));
	const waiting = $derived(overviewWaitingRows(snapshot?.waiting ?? []));
	const elapsedSinceSnapshot = $derived(Math.max(0, now - (Date.parse(snapshot?.asOf ?? '') || now)));
	const flying = $derived(overviewFlightRows(snapshot?.inFlight ?? [], board, elapsedSinceSnapshot));
	const dayMax = $derived(Math.max(1, ...(snapshot?.week.perDay.map(day => day.requests) ?? [])));
	const waitIcons = { question: CircleHelpIcon, warning: TriangleAlertIcon, review: CircleCheckIcon, steps: ListChecksIcon };
	const weekdays = new Intl.DateTimeFormat(undefined, { weekday: 'short', timeZone: 'UTC' });
	const statusLabels = { todo: 'To do', in_progress: 'In progress', review: 'Review', waiting: 'Waiting', blocked: 'Blocked', done: 'Done', dropped: 'Dropped' };
	const foldKey = 'kemiri.overview.more';
	let moreOpen = $state(readCoordinatorPreference(foldKey) === 'open');
	function rememberFold(event: Event & { currentTarget: HTMLDetailsElement }) {
		moreOpen = event.currentTarget.open;
		saveCoordinatorPreference(foldKey, moreOpen ? 'open' : 'closed');
	}
	function taskTitle(id: string | null) {
		return id ? tasks.get(id)?.title ?? board?.archivedLinks?.find(link => link.id === id)?.title : undefined;
	}
</script>

<div class="overview @container/overview min-h-0 flex-1 overflow-y-auto overscroll-contain" data-navigation-scroll="tasks-overview" data-no-task-preview aria-label="Coordinator overview">
	<div class="overview-page mx-auto w-full max-w-5xl px-4 pt-5 pb-10 @min-[46rem]/overview:px-8 @min-[46rem]/overview:pt-8">
		{#if snapshot}
			<p class="opening">{overviewOpeningLine(snapshot.counts, now, snapshot.coordinators?.length)}</p>
			{#if snapshot.coordinators}
				<section class="summary-panel" aria-label="Project roll-up">
					<table>
						<thead><tr><th scope="col">Coordinator</th><th scope="col">Open</th><th scope="col">Waiting on you</th><th scope="col">Finished</th></tr></thead>
						<tbody>
							{#each snapshot.coordinators as row (row.coordinatorId)}
								{@const coordinator = roster.find(thread => thread.id === row.coordinatorId)}
								<tr>
									<th scope="row"><a class="coordinator-link" href={coordinatorHref(row.coordinatorId)} onclick={event => oncoordinator(row.coordinatorId, event)}>{#if coordinator}<CoordinatorMark thread={coordinator} />{/if}<span>{coordinator?.title ?? (row.coordinatorId === 'main' ? 'General' : row.coordinatorId)}</span><ArrowUpRightIcon class="size-3 shrink-0 text-(--chat-fg-subtle)" aria-hidden="true" /></a></th>
									<td>{row.counts.open}</td>
									<td class:has-wait={row.counts.waitingOnOwner > 0}>{row.counts.waitingOnOwner}{#if row.counts.oldestWaitSince}<small>Oldest {overviewAge(row.counts.oldestWaitSince, now)}</small>{/if}</td>
									<td>{row.week.requests}{#if row.week.taskUsage}<small>{usageMoney(row.week.taskUsage.apiValue)}</small>{/if}</td>
								</tr>
							{/each}
						</tbody>
						<tfoot><tr><th scope="row">Project</th><td>{snapshot.counts.open}</td><td>{snapshot.counts.waitingOnOwner}</td><td>{snapshot.week.requests}{#if snapshot.week.taskUsage}<small>{usageMoney(snapshot.week.taskUsage.apiValue)}</small>{/if}</td></tr></tfoot>
					</table>
					<p class="table-note">Finished counts requests in the last 7 days. Open a coordinator to see its work.</p>
				</section>
			{:else}
				<div class="overview-columns grid gap-4 @min-[46rem]/overview:grid-cols-[minmax(0,4fr)_minmax(0,5fr)]">
					<section class="summary-panel waiting-panel" aria-label="Waiting on you">
						<header><h3>Waiting on you</h3><span>{plural(waiting.length, 'thing')}</span></header>
						{#if waiting.length}
							<ul class="rows">
								{#each waiting as wait (`${wait.kind}:${wait.questionId ?? wait.taskId}`)}
									{@const href = overviewWaitHref(wait, taskHref, questionHref)}
									{@const Icon = waitIcons[wait.kind]}
									{@const label = taskTitle(wait.taskId)}
									{@const request = taskTitle(wait.requestId) ?? label}
									{@const question = wait.questionId ? questions.get(wait.questionId) : undefined}
									{@const title = wait.kind === 'review' ? (label ? `${label} is ready for review` : 'Ready for review') : wait.kind === 'steps' ? (label ? `Your steps for ${label}` : 'Your steps') : question?.text ?? (wait.kind === 'warning' ? 'Warning' : 'Open question')}
									<li class="waiting-row">
										<span class="wait-mark"><Icon class="size-4" aria-hidden="true" /></span>
										<div class="min-w-0">
											{#if href}<a class="row-link" {href}>{title}</a>{:else}<strong>{title}</strong>{/if}
											<p class="line-meta">{#if question && request}{request}{' · '}{/if}{overviewAge(wait.since, now)}{#if wait.holdsParts}{' · holds '}{plural(wait.holdsParts, 'part')}{:else if question && wait.requestId && wait.taskId === wait.requestId && (question.blocksWork ?? wait.kind !== 'warning')}{' · holds the request'}{/if}</p>
										</div>
									</li>
								{/each}
							</ul>
						{:else}<p class="empty">Nothing needs an answer or review.</p>{/if}
						{#if snapshot.more.heldUpTodayMs > 0}<p class="panel-note">Requests spent {overviewTime(snapshot.more.heldUpTodayMs)} waiting today when no work was running.</p>{/if}
					</section>
					<section class="summary-panel flight-panel" aria-label="In flight">
						<header><h3>In flight</h3><span>{plural(flying.length, 'request')}{#if snapshot.counts.running} · {snapshot.counts.running} running{/if}</span></header>
						{#if flying.length}
							<ul class="rows">
								{#each flying as row (row.requestId)}
									{@const task = tasks.get(row.requestId)}
									{@const sentence = task?.state?.sentence}
									{@const estimate = row.left ? overviewEstimateText(row.left, elapsedSinceSnapshot) : undefined}
									<li class="flight-row" class:has-estimate={!!estimate}>
										<div class="min-w-0">
											<a class="row-link" href={taskHref(row.requestId)}>{task?.title ?? row.requestId}</a>
											{#if task && row.parts?.total}<div class="line-meta flex flex-wrap items-center gap-x-2"><TaskPartsProgress {task} /></div>{/if}
											{#if sentence && sentence.text !== (task && row.parts?.total ? taskPartProgress(task)?.text : undefined)}<p class="line-meta" class:failed={task?.state?.kind === 'failed'}><TaskActivityLine activity={sentence} compact /></p>
											{:else if !sentence && task}<p class="line-meta">{taskDisplayWords(task)}</p>{/if}
											{#if row.planStep}<p class="line-meta">Step {row.planStep.number} of {row.planStep.total}: {row.planStep.text}</p>{/if}
										</div>
										{#if estimate}
											<div class="flight-estimate" class:stopped={row.left?.kind === 'stopped'} title={estimate.basis}>
												<p class="estimate-heading">{estimate.heading}</p>
												<p class="line-meta">{estimate.detail}</p>
												{#if row.left && 'basis' in row.left && row.left.basis === 'project'}<span class="sr-only">{estimate.basis}</span>{/if}
											</div>
										{/if}
									</li>
								{/each}
							</ul>
						{:else}<p class="empty">No open requests.</p>{/if}
						{#if flying.some(row => row.left)}<p class="panel-note">Estimates count agent work, not time waiting on you.</p>{/if}
					</section>
				</div>
			{/if}

			<section class="summary-panel week-panel" aria-label="Last 7 days">
				<header><h3>Last 7 days</h3></header>
				<div class="week-summary">
					<div>
						<p>{plural(snapshot.week.requests, 'request')} finished, with {plural(snapshot.week.parts, 'part')}.{#if snapshot.week.usualWeek} A usual week is {Math.floor(snapshot.week.usualWeek.low)} to {Math.ceil(snapshot.week.usualWeek.high)} requests.{/if}</p>
						{#if snapshot.week.startToDoneMs !== undefined}<p>The usual request took {overviewTime(snapshot.week.startToDoneMs)} from first work to done.</p>{/if}
						{#if snapshot.week.sentBack > 0}<p>{plural(snapshot.week.sentBack, 'request')} went back to work after review.</p>{/if}
						{#if snapshot.week.taskUsage}<p>Work was worth {usageMoney(snapshot.week.taskUsage.apiValue)} at API prices. <button class="usage-link" onclick={() => usageModal.open = true}>Usage</button></p>{/if}
					</div>
					{#if snapshot.week.requests || snapshot.week.parts}
						<ul class="week-bars" aria-label="Finished requests by UTC day">
							{#each snapshot.week.perDay as day (day.day)}
								<li title={`${day.day}: ${plural(day.requests, 'request')}, ${plural(day.parts, 'part')}`}>
									<span class="sr-only">{day.day}: {plural(day.requests, 'request')}, {plural(day.parts, 'part')}</span>
									<span class="day-bar-slot" aria-hidden="true"><span class="day-bar" style:height={`${(day.requests / dayMax) * 100}%`}></span></span>
									<span aria-hidden="true">{weekdays.format(new Date(day.day))}</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
				{#if snapshot.week.split && snapshot.week.startToDoneMs}
					{@const split = snapshot.week.split}
					<div class="time-split">
						<div class="time-bar" aria-hidden="true"><span class="agent-time" style:flex-grow={split.agentsMs}></span><span class="owner-time" style:flex-grow={split.waitingMs}></span><span class="other-time" style:flex-grow={split.otherMs}></span></div>
						<p>Agents {overviewTime(split.agentsMs)} · Waiting on you {overviewTime(split.waitingMs)} · Other {overviewTime(split.otherMs)}</p>
					</div>
				{/if}
			</section>

			<details class="summary-panel more-panel" open={moreOpen} ontoggle={rememberFold}>
				<summary><ChevronRightIcon class="fold-chevron size-4" aria-hidden="true" /> More numbers</summary>
				<dl>
					{#if snapshot.more.estimates || snapshot.more.estimateReplay}
						<div><dt>How the estimates did</dt>
							{#if snapshot.more.estimates}<dd>The first range held for {snapshot.more.estimates.held} of {plural(snapshot.more.estimates.scored, 'finished request')}.</dd>{/if}
							{#if snapshot.more.estimateReplay}<dd>In the historical replay, the first range held for {snapshot.more.estimateReplay.held} of {plural(snapshot.more.estimateReplay.scored, 'request')}.</dd>{/if}
						</div>
					{/if}
					{#if snapshot.more.reviews}<div><dt>Reviews</dt><dd>Three in four ended within {overviewTime(snapshot.more.reviews.p75Ms)} in the last 30 days.</dd></div>{/if}
					<div><dt>Questions</dt><dd>{snapshot.more.questions.asked} asked and {snapshot.more.questions.answered} answered in the last 30 days.{#if snapshot.more.questions.answerTime} Three in four answers came within {overviewTime(snapshot.more.questions.answerTime.p75Ms)}.{/if}</dd></div>
					<div><dt>Worker runs</dt><dd>{snapshot.more.runs.started} started, {snapshot.more.runs.failed} failed, and {snapshot.more.runs.stopped} stopped.{#if snapshot.more.runs.medianMs !== undefined} A typical run took {overviewTime(snapshot.more.runs.medianMs)}.{/if}{#if snapshot.more.runs.tasksWithMultipleRuns} {plural(snapshot.more.runs.tasksWithMultipleRuns, 'task')} had more than one run.{/if}</dd></div>
					{#if snapshot.more.statusTimes.length}<div><dt>Typical time in each status</dt><dd>{snapshot.more.statusTimes.map(row => `${statusLabels[row.status]} ${overviewTime(row.medianMs)}`).join(' · ')}</dd></div>{/if}
					{#if snapshot.week.reopened}<div><dt>Reopened</dt><dd>{plural(snapshot.week.reopened, 'finished request')} reopened after being marked done.</dd></div>{/if}
					{#if snapshot.more.checks.passed || snapshot.more.checks.failed}<div><dt>Checks on open work</dt><dd>{snapshot.more.checks.passed} passed and {snapshot.more.checks.failed} failed.</dd></div>{/if}
					{#if snapshot.more.modelRequests}<div><dt>Model requests</dt><dd>{plural(snapshot.more.modelRequests.errors, 'error')} and {plural(snapshot.more.modelRequests.aborted, 'abort')}.</dd></div>{/if}
					{#if snapshot.more.runningJobs.length || snapshot.more.nextSchedule}<div><dt>Jobs and schedules</dt><dd>{plural(snapshot.more.runningJobs.length, 'job')} running.{#if snapshot.more.nextSchedule} Next scheduled run: {new Date(snapshot.more.nextSchedule.at).toLocaleString()}.{/if}</dd></div>{/if}
					{#if snapshot.more.deploys}<div><dt>Deploys</dt><dd>{snapshot.more.deploys.landed} landed, {snapshot.more.deploys.failed} failed, and {snapshot.more.deploys.rolledBack} rolled back.</dd></div>{/if}
					{#if snapshot.week.coordinatorUsage}<div><dt>Coordinator chat</dt><dd>{usageMoney(snapshot.week.coordinatorUsage.apiValue)} at API prices, counted separately.</dd></div>{/if}
				</dl>
			</details>
		{:else if error}<p class="opening" role="status">Could not load the overview. {error}</p>
		{:else}<p class="opening" role="status">Loading overview…</p>{/if}
	</div>
</div>

<style>
	.overview { background: var(--chat-bg); }
	.opening { margin: 0 0 1.35rem; font-size: clamp(1.15rem, 3.3cqi, 1.7rem); line-height: 1.28; font-weight: 650; letter-spacing: -.025em; text-wrap: pretty; }
	.summary-panel { min-width: 0; border: 1px solid var(--chat-border); border-radius: .85rem; background: var(--chat-surface); }
	.summary-panel header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: .2rem .5rem; padding: .8rem .9rem .7rem; }
	h3 { margin: 0; font-size: .94rem; font-weight: 650; }
	header span, .line-meta, .panel-note, .table-note, .empty, td small { color: var(--chat-fg-muted); font-size: .75rem; line-height: 1.4; }
	.rows { list-style: none; margin: 0; padding: 0; }
	.rows li { border-top: 1px solid var(--chat-border); padding: .68rem .9rem; }
	.waiting-row { display: flex; align-items: start; gap: .68rem; }
	.wait-mark { display: inline-grid; place-items: center; width: 1.65rem; height: 1.65rem; margin-top: .1rem; flex: 0 0 auto; border-radius: .45rem; color: var(--chat-warning); background: color-mix(in srgb, var(--chat-warning) 10%, transparent); }
	.row-link { display: block; color: var(--chat-fg); font-size: .875rem; font-weight: 620; line-height: 1.4; overflow-wrap: anywhere; }
	.row-link:hover, .coordinator-link:hover, .usage-link:hover { text-decoration: underline; text-underline-offset: .16em; }
	.flight-row.has-estimate { display: grid; gap: .4rem .85rem; }
	.flight-estimate { color: var(--chat-fg-muted); }
	.estimate-heading { font-size: .8rem; font-weight: 650; line-height: 1.35; }
	.flight-estimate.stopped .estimate-heading { color: var(--chat-warning); }
	@container overview (min-width: 46rem) {
		.flight-row.has-estimate { grid-template-columns: minmax(0, 1fr) minmax(7.5rem, 32%); }
		.flight-estimate { text-align: right; }
	}
	.line-meta { margin-top: .19rem; }
	.panel-note { border-top: 1px solid var(--chat-border); }
	.panel-note, .table-note, .empty { padding: .7rem .9rem; }
	.week-panel, .more-panel { margin-top: 1rem; }
	.week-summary { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: flex-end; gap: .75rem 1.5rem; padding: 0 .9rem .8rem; }
	.week-summary p { color: var(--chat-fg-muted); font-size: .84rem; line-height: 1.6; }
	.week-summary p:first-child { color: var(--chat-fg); font-weight: 580; }
	.usage-link { color: var(--accent-2); font-weight: 600; }
	.week-bars { display: flex; align-items: flex-end; gap: .35rem; margin: 0; padding: 0; list-style: none; }
	.week-bars li { display: grid; justify-items: center; min-width: 1.8rem; font-size: .66rem; color: var(--chat-fg-muted); }
	.day-bar-slot { display: flex; align-items: end; height: 2rem; width: .85rem; padding-bottom: 1px; border-bottom: 1px solid var(--chat-border); }
	.day-bar { width: 100%; border-radius: .18rem .18rem 0 0; background: var(--chat-fg-subtle); }
	.time-split { max-width: 30rem; margin: 0 .9rem .9rem; color: var(--chat-fg-muted); font-size: .75rem; }
	.time-bar { display: flex; overflow: hidden; border-radius: .25rem; height: .42rem; margin-bottom: .4rem; background: var(--chat-surface-2); }
	.time-bar span { flex-basis: 0; }
	.agent-time { background: var(--chat-fg-muted); }
	.owner-time { background: color-mix(in srgb, var(--chat-warning) 70%, var(--chat-bg)); }
	.other-time { background: var(--chat-border); }
	.more-panel summary { display: flex; align-items: center; gap: .4rem; cursor: pointer; list-style: none; padding: .75rem .9rem; font-size: .83rem; font-weight: 600; }
	.more-panel summary::-webkit-details-marker { display: none; }
	.more-panel[open] :global(.fold-chevron) { rotate: 90deg; }
	dl { display: grid; gap: .55rem; padding: 0 .9rem .9rem; font-size: .8rem; }
	dt { font-weight: 600; }
	dd { color: var(--chat-fg-muted); }
	table { width: 100%; border-collapse: collapse; font-size: .83rem; font-variant-numeric: tabular-nums; }
	th, td { padding: .65rem .55rem; text-align: left; border-bottom: 1px solid var(--chat-border); }
	th:first-child { padding-left: .8rem; }
	thead th { color: var(--chat-fg-muted); font-weight: 550; font-size: .72rem; }
	td:last-child, thead th:last-child { padding-right: .8rem; }
	td small { display: block; }
	.coordinator-link { display: flex; gap: .4rem; align-items: center; min-height: 1.6rem; }
	.has-wait { color: var(--chat-warning); }
	.failed :global(.activity-line > span) { color: var(--destructive); }
</style>
