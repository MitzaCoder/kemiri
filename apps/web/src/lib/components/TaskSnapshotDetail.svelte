<script lang="ts">
	import ReportSection from './ReportSection.svelte';
	import { hasReportSection } from '#lib/report-sections.js';
	import TaskDetailText from './TaskDetailText.svelte';
	import Markdown from '#lib/components/markdown/Markdown.svelte';
	import TaskStatusBadge from '#lib/components/TaskStatusBadge.svelte';
	import { exactTime } from '#lib/relative-time.js';
	import { hasChanges, REPORT_SECTIONS, taskChanges, type TaskState } from '#lib/tasks.js';
	import type { BoardTask, BoardTaskSnapshot, BoardWriter } from '@kemiri/protocol';

	let { task, snapshot, before, writerName }: {
		task: BoardTask;
		snapshot: BoardTaskSnapshot;
		before?: BoardTaskSnapshot;
		writerName: (writer: BoardWriter) => string;
	} = $props();

	let against = $state<'previous' | 'now'>('previous');
	let view = $state<'changes' | 'as-it-was'>('changes');
	const now = $derived<TaskState>({ title: task.title, status: task.status, report: task.report });
	const changes = $derived(against === 'now' ? taskChanges(snapshot, now) : taskChanges(before, snapshot));
</script>

<div class="flex flex-col gap-3" data-task-history>
	<p class="text-xs text-(--chat-fg-muted)">{writerName(snapshot.by)} · {exactTime(snapshot.at)}</p>

	<div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
		<div class="inline-flex rounded-lg border border-(--chat-border) p-0.5" role="group" aria-label="What to show">
			{#each [{ id: 'changes', label: 'What changed' }, { id: 'as-it-was', label: 'As it was' }] as const as option (option.id)}
				<button
					type="button"
					class="rounded-md px-2 py-0.5 transition-colors {view === option.id
						? 'bg-(--chat-surface-2) font-medium text-(--chat-fg)'
						: 'text-(--chat-fg-subtle) hover:text-(--chat-fg)'}"
					aria-pressed={view === option.id}
					onclick={() => (view = option.id)}
				>
					{option.label}
				</button>
			{/each}
		</div>
		{#if view === 'changes'}
			<label class="flex items-center gap-1.5 text-(--chat-fg-subtle)">
				Compared with
				<select
					bind:value={against}
					class="rounded-md border border-(--chat-border) bg-transparent px-1.5 py-0.5 text-xs text-(--chat-fg)"
				>
					<option value="previous">{before === undefined ? 'nothing before it' : 'the snapshot before'}</option>
					<option value="now">the task now</option>
				</select>
			</label>
		{/if}
	</div>

	{#if view === 'changes'}
		{#if !hasChanges(changes)}
			<p class="text-xs text-(--chat-fg-subtle)" data-no-changes>
				{against === 'now' ? 'The task says the same as it did then.' : 'Nothing differs from the snapshot before.'}
			</p>
		{:else}
			<div class="flex flex-col gap-2.5" data-changes>
				{#if changes.title}
					<div class="text-xs break-words text-(--chat-fg-muted)">
						<span class="font-semibold text-(--chat-fg)">Title</span>
						<div class="text-(--chat-fg-subtle) line-through"><Markdown source={changes.title.from} /></div> → <Markdown source={changes.title.to} />
					</div>
				{/if}
				{#if changes.status}
					<p class="flex flex-wrap items-center gap-1.5 text-xs text-(--chat-fg-muted)">
						<span class="font-semibold text-(--chat-fg)">Status</span>
						<TaskStatusBadge status={changes.status.from} />
						→
						<TaskStatusBadge status={changes.status.to} />
					</p>
				{/if}
				{#each changes.sections as section (section.key)}
					<div>
						<p class="mb-1 text-xs font-semibold text-(--chat-fg)">{section.label}</p>
						{#if section.structure}
							<p class="mb-1 text-xs text-(--chat-fg-muted)">
								Report blocks: {[
									section.structure.added && `${section.structure.added} added`,
									section.structure.removed && `${section.structure.removed} removed`,
									section.structure.reordered && 'reordered',
								].filter(Boolean).join(' · ')}
							</p>
						{/if}
						{#if section.lines.length > 0}
							<ul class="overflow-hidden rounded-lg border border-(--chat-border) text-xs leading-5">
								{#each section.lines as line, position (position)}
									{#if line.kind === 'unchanged'}
										<li class="px-2 py-0.5 text-(--chat-fg-subtle) italic">{line.count} unchanged {line.count === 1 ? 'line' : 'lines'}</li>
									{:else}
										<li
											class="flex gap-2 px-2 py-0.5 break-words {line.kind === 'added'
												? 'diff-added text-(--chat-fg)'
												: 'diff-removed text-(--chat-fg-muted)'}"
											data-diff={line.kind}
										>
											<span class="w-3 shrink-0 text-center select-none" aria-hidden="true">{line.kind === 'added' ? '+' : '−'}</span>
											<span class="min-w-0 flex-1 whitespace-pre-wrap"><TaskDetailText text={line.text} /></span>
											<span class="sr-only">{line.kind === 'added' ? 'added' : 'removed'}</span>
										</li>
									{/if}
								{/each}
							</ul>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	{:else if view === 'as-it-was'}
		<div class="flex flex-col gap-3 rounded-xl border border-(--chat-border) px-3 py-2.5" data-as-it-was>
			<div class="flex flex-wrap items-center gap-1.5 text-[0.8125rem] font-medium">
				<Markdown source={snapshot.title} />
				<TaskStatusBadge status={snapshot.status} />
			</div>
			{#each REPORT_SECTIONS as section (section.key)}
				{#if section.key === 'now' ? snapshot.report.now.trim() : hasReportSection(snapshot.report, section.key)}
					<div>
						<p class="mb-0.5 text-xs font-semibold text-(--chat-fg-muted)">{section.label}</p>
						{#if section.key === 'now'}<Markdown source={snapshot.report.now} class="report-md" />
						{:else}<ReportSection task={{ id: task.id, report: snapshot.report }} section={section.key} class="text-(length:--text-task)" />{/if}
					</div>
				{/if}
			{/each}
		</div>
	{/if}
</div>

<style>
	.diff-added {
		background: color-mix(in oklab, var(--chat-success) 12%, transparent);
	}
	.diff-removed {
		background: color-mix(in oklab, var(--chat-danger) 10%, transparent);
	}
	:global(.report-md.md) {
		font-size: var(--text-task);
		line-height: 1.6;
	}
</style>
