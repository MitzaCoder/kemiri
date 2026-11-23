<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { BoardTask, ModelInfo, ThreadSummary } from '@kemiri/protocol';
	import { Button } from './ui/button/index.js';
	import * as Dialog from './ui/dialog/index.js';
	import CoordinatorMark from './CoordinatorMark.svelte';
	import { COORDINATOR_COLORS, coordinatorBadges, coordinatorColor } from '#lib/coordinators.js';
	import { modelKey } from '#lib/models.js';
	import type { ProjectThreads } from '#lib/threads.svelte.js';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';

	let { mode, store, roster, tasks, models, onclose, oncreated, onarchived, messages, supportsSchedules }: {
		mode: 'new' | 'manage' | ThreadSummary; store: ProjectThreads; roster: readonly ThreadSummary[];
		tasks: readonly BoardTask[]; models: readonly ModelInfo[]; onclose: () => void;
		messages?: Snippet; supportsSchedules: boolean;
		oncreated: (id: string) => void; onarchived?: (id: string) => void;
	} = $props();

	let screen = $state<'new' | 'manage' | 'edit' | 'archive' | 'promote'>('manage');
	let editing = $state<ThreadSummary>();
	let title = $state('');
	let area = $state('');
	let paths = $state('');
	let color = $state<string>(COORDINATOR_COLORS.Blue);
	let model = $state('');
	let query = $state('');
	let taskIds = $state<string[]>([]);
	let moveTasksTo = $state('main');
	let schedules = $state<'move' | 'disable'>('move');
	let pending = $state(false);
	let error = $state('');
	const operationIds = new Map<string, string>();
	const taskChoices = $derived(tasks.filter(task => !task.archived && task.status !== 'done' && task.status !== 'dropped' && `${task.id} ${task.title}`.toLowerCase().includes(query.trim().toLowerCase())));
	const archived = $derived(store.archived.filter(thread => thread.kind === 'coordinator'));
	const heading = $derived(screen === 'new' ? 'New coordinator' : screen === 'manage' ? 'Manage coordinators' : screen === 'promote' ? 'Keep as coordinator' : screen === 'archive' ? `Archive ${editing?.title}` : `Edit ${editing?.title}`);

	function edit(thread: ThreadSummary) {
		editing = thread;
		title = thread.title; area = thread.area ?? ''; paths = thread.paths?.join('\n') ?? '';
		color = coordinatorColor(thread); model = thread.model ? modelKey(thread.model) : '';
		error = ''; screen = supportsSchedules && thread.kind !== 'coordinator' && !thread.main ? 'promote' : 'edit';
	}
	$effect(() => {
		if (typeof mode !== 'string') edit(mode);
		else screen = mode;
	});
	$effect(() => {
		if (screen !== 'manage') return;
		const currentStore = store;
		void currentStore.setShowArchived(true);
		return () => { void currentStore.setShowArchived(false); };
	});

	// A failed request may already have committed. Retrying the same fields uses the same durable ID.
	async function mutate(key: unknown, action: (operationId: string) => Promise<void>) {
		if (pending) return;
		const payload = JSON.stringify(key);
		const operationId = operationIds.get(payload) ?? crypto.randomUUID();
		operationIds.set(payload, operationId);
		pending = true; error = '';
		try { await action(operationId); operationIds.delete(payload); }
		catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
		finally { pending = false; }
	}
	function requireSuccess(ok: boolean) {
		if (!ok) throw new Error(store.actionError?.message ?? 'The change could not be saved.');
	}
	function save(event: SubmitEvent) {
		event.preventDefault();
		if (!title.trim() || !area.trim()) return;
		const chosen = models.find(entry => modelKey(entry) === model);
		const fields = { title: title.trim(), area: area.trim(), color,
			...(!editing?.main ? { paths: paths.split('\n').map(path => path.trim()).filter(Boolean), ...(chosen ? { model: { provider: chosen.provider, modelId: chosen.modelId } } : {}) } : {}) };
		if (screen === 'promote' && editing) {
			const id = editing.id;
			const fields = { promote: true, title: title.trim(), area: area.trim(), color };
			void mutate(['promote', id, fields], async operationId => {
				requireSuccess(await store.updateCoordinator(id, { ...fields, operationId }));
				oncreated(id);
			});
		} else if (screen === 'new') {
			const create = { ...fields, taskIds: [...taskIds].sort() };
			void mutate(['create', create], async operationId => oncreated((await store.createCoordinator({ ...create, operationId })).id));
		} else if (editing) {
			const id = editing.id;
			void mutate(['edit', id, fields], async operationId => {
				requireSuccess(await store.updateCoordinator(id, { ...fields, operationId }));
				if (mode === 'manage') screen = 'manage'; else onclose();
			});
		}
	}
	function archive(thread: ThreadSummary, archived: boolean) {
		const destination = archived ? moveTasksTo : undefined;
		const disposition = archived && supportsSchedules ? schedules : undefined;
		void mutate(['archive', thread.id, archived, destination, disposition], async operationId => {
			requireSuccess(await store.archiveCoordinator(thread.id, archived, operationId, destination, disposition));
			screen = 'manage';
			if (archived) onarchived?.(thread.id);
		});
	}
	function reorder(index: number, delta: number) {
		const next = [...roster];
		const other = index + delta;
		if (other < 1 || other >= next.length) return;
		[next[index], next[other]] = [next[other]!, next[index]!];
		void mutate(['order', next.map(thread => thread.id)], async operationId => {
			for (const [order, thread] of next.entries()) {
				if (thread.main || thread.order === order) continue;
				requireSuccess(await store.updateCoordinator(thread.id, { order, operationId: `${operationId}-${order}` }));
			}
		});
	}
</script>

<Dialog.Root open onOpenChange={open => { if (!open && !pending) onclose(); }}>
	<Dialog.Content class="max-h-[calc(100dvh-1.5rem)] overflow-y-auto sm:max-w-xl" onEscapeKeydown={event => { if (pending) event.preventDefault(); }} onInteractOutside={event => { if (pending) event.preventDefault(); }}>
		<Dialog.Header>
			<Dialog.Title>{heading}</Dialog.Title>
			<Dialog.Description>{screen === 'new' ? 'Give this coordinator a clear area of work. It will have its own chat and share this project’s board.' : screen === 'archive' ? 'The chat and closed tasks stay in the project history.' : screen === 'promote' ? 'The job keeps its chat, workspace, and assigned tasks.' : 'Set who does what in this project.'}</Dialog.Description>
		</Dialog.Header>
		{#if screen === 'manage'}
			{@render messages?.()}
			<ul class="grid gap-2">
				{#each roster as coordinator, index (coordinator.id)}
					<li class="rounded-lg border border-(--chat-border) p-2.5">
						<div class="flex items-center gap-2"><CoordinatorMark thread={coordinator} /><strong class="flex-1 truncate text-sm">{coordinator.title}</strong><small class="text-(--chat-fg-muted)">{coordinatorBadges(coordinator).state}</small></div>
						<div class="mt-1 flex flex-wrap items-center gap-1">
							<Button size="sm" variant="ghost" disabled={pending} onclick={() => edit(coordinator)}>Edit</Button>
							{#if !coordinator.main}
								<Button size="sm" variant="ghost" disabled={pending} onclick={() => void mutate(['held', coordinator.id, !coordinator.held], async id => requireSuccess(await store.holdCoordinator(coordinator.id, !coordinator.held, id)))}>{coordinator.held ? 'Resume' : 'Pause'}</Button>
								<Button size="sm" variant="ghost" disabled={pending || coordinatorBadges(coordinator).working} onclick={() => { editing = coordinator; moveTasksTo = 'main'; schedules = 'move'; error = ''; screen = 'archive'; }}>Archive</Button>
								<Button size="icon-sm" variant="ghost" aria-label="Move {coordinator.title} up" disabled={pending || index <= 1} onclick={() => reorder(index, -1)}><ArrowUp /></Button>
								<Button size="icon-sm" variant="ghost" aria-label="Move {coordinator.title} down" disabled={pending || index === roster.length - 1} onclick={() => reorder(index, 1)}><ArrowDown /></Button>
							{/if}
						</div>
					</li>
				{/each}
			</ul>
			{#if archived.length}<h3 class="text-sm font-semibold">Archived coordinators</h3>
				<ul>{#each archived as coordinator (coordinator.id)}<li class="flex items-center gap-2"><CoordinatorMark thread={coordinator} /><span class="min-w-0 flex-1 truncate">{coordinator.title}</span><Button size="sm" variant="outline" disabled={pending} onclick={() => archive(coordinator, false)}>Restore</Button></li>{/each}</ul>
			{/if}
			{#if store.error}<p class="text-sm text-(--chat-danger)" role="alert">{store.error}</p>{/if}
		{:else if screen === 'archive' && editing}
			{@const coordinator = editing}
			<label>Move open tasks to<select bind:value={moveTasksTo} disabled={pending}>{#each roster.filter(thread => thread.id !== coordinator.id) as row (row.id)}<option value={row.id}>{row.title}</option>{/each}</select></label>
			{#if supportsSchedules}<label>Schedules<select bind:value={schedules} disabled={pending}><option value="move">Move to {roster.find(thread => thread.main)?.title ?? 'General'}</option><option value="disable">Turn off schedules</option></select></label>{/if}
			<div class="flex justify-end gap-2"><Button variant="outline" disabled={pending} onclick={() => { error = ''; screen = 'manage'; }}>Back</Button><Button variant="destructive" disabled={pending} onclick={() => archive(coordinator, true)}>Archive coordinator</Button></div>
		{:else}
			<form class="grid gap-4" onsubmit={save}>
				<fieldset disabled={pending} class="grid min-w-0 gap-3">
					<label>Name<input bind:value={title} placeholder="e.g. Web shop" required maxlength="120" /></label>
					<div role="group" aria-label="Colour" class="flex flex-wrap items-center gap-2"><span class="mr-1 text-sm font-medium">Colour</span>
						{#each Object.entries(COORDINATOR_COLORS) as [label, tint] (label)}<button type="button" class="swatch" style:--swatch={tint} aria-label={label} title={label} aria-pressed={color === tint} onclick={() => color = tint}></button>{/each}
					</div>
					<label>Area<textarea bind:value={area} placeholder="What work belongs here?" rows="2" required maxlength="2000"></textarea></label>
					{#if !editing?.main && screen !== 'promote'}
						<label>Paths <span class="font-normal text-(--chat-fg-muted)">· optional, one per line</span><textarea bind:value={paths} placeholder="apps/shop/**" rows="2"></textarea></label>
						<label>Model<select bind:value={model}><option value="">{editing ? 'Keep current model' : 'Project default'}</option>{#each models as entry (modelKey(entry))}<option value={modelKey(entry)}>{entry.name}</option>{/each}</select></label>
					{/if}
					{#if screen === 'new'}
						<label>Move tasks here <span class="font-normal text-(--chat-fg-muted)">· optional{taskIds.length ? ` · ${taskIds.length} selected` : ''}</span><input type="search" bind:value={query} placeholder="Search open tasks" /></label>
						<div class="max-h-28 overflow-auto rounded-lg border border-(--chat-border) p-1.5">
							{#each taskChoices as task (task.id)}<label class="flex items-center gap-2 rounded px-1.5 py-1 font-normal hover:bg-(--chat-surface-2)"><input type="checkbox" bind:group={taskIds} value={task.id} /><span class="truncate">{task.id} · {task.title}</span></label>
							{:else}<p class="px-1.5 py-1 text-xs text-(--chat-fg-muted)">No matching open tasks</p>{/each}
						</div>
					{/if}
				</fieldset>
				<div class="flex justify-end gap-2">
					<Button variant="outline" disabled={pending} onclick={() => { if (mode === 'manage') { error = ''; screen = 'manage'; } else onclose(); }}>Cancel</Button>
					<Button type="submit" disabled={pending || !title.trim() || !area.trim()}>{pending ? 'Saving…' : screen === 'new' ? 'Create coordinator' : screen === 'promote' ? 'Keep as coordinator' : 'Save changes'}</Button>
				</div>
			</form>
		{/if}
		{#if error}<p class="text-sm text-(--chat-danger)" role="alert">{error}</p>{/if}
	</Dialog.Content>
</Dialog.Root>

<style>
	label { display:block; font-size:.8125rem; font-weight:550; }
	label.flex { display:flex; }
	input:not([type='checkbox']), select, textarea { display:block; width:100%; margin-top:.25rem; border:1px solid var(--chat-border); border-radius:.5rem; background:var(--chat-bg); color:var(--chat-fg); padding:.45rem .6rem; font-weight:400; }
	.swatch { width:1.6rem; height:1.6rem; border-radius:50%; background:var(--swatch); }
	.swatch[aria-pressed='true'] { outline:2px solid var(--chat-fg); outline-offset:2px; }
</style>
