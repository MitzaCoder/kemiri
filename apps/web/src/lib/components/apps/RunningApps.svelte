<script lang="ts">
	import type { BoardTask, ProjectApp, ThreadSummary, WorkerSummary } from '@kemiri/protocol';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { APP_LINK_WARNING, appLink, visibleApps } from '#lib/agent-apps.js';
	import { projectApps } from '#lib/agent-apps.svelte.js';
	import DetectedAppRow from './DetectedAppRow.svelte';
	import PublishedAppRow from './PublishedAppRow.svelte';

	let { open = $bindable(false), restoreFocus, tasks = [], threads = [], workers = [], now }: {
		open?: boolean;
		restoreFocus: () => void;
		tasks?: readonly Pick<BoardTask, 'id' | 'title'>[];
		threads?: readonly ThreadSummary[];
		workers?: readonly WorkerSummary[];
		now: number;
	} = $props();
	const apps = projectApps();
	const detected = $derived(apps?.current?.detected ?? []);
	const rows = $derived(visibleApps(apps?.current?.apps ?? []));

	function publisher(app: ProjectApp): string {
		if (app.ownerPublished) return 'the owner';
		const { id, kind, threadId, conversationId } = app.publishedBy;
		const title = kind === 'worker' ? workers.find(worker => worker.conversationId === conversationId)?.title : threads.find(thread => thread.id === threadId)?.title;
		return `${kind} ${title ?? (id === 'main' ? 'General' : id)}`;
	}

	function age(createdAt: string): string {
		const minutes = Math.max(0, Math.floor((now - Date.parse(createdAt)) / 60_000));
		if (!Number.isFinite(minutes) || minutes < 1) return 'just now';
		if (minutes < 60) return `${minutes} min ago`;
		if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
		return `${Math.floor(minutes / 1440)} d ago`;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="max-h-[85dvh] gap-3 overflow-y-auto sm:max-w-3xl" onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }}>
		<Dialog.Title>Running apps</Dialog.Title>
		<Dialog.Description>Stop app ends a process started by Kemiri and removes its link. Unpublish only removes the link.</Dialog.Description>
		{#if rows.some(app => app.state === 'pending')}
			<p class="text-sm text-(--chat-fg-muted)">Allow publishes that app and lets agents publish future apps in this project.</p>
		{/if}
		{#if rows.some(appLink) || detected.length}
			<p class="rounded-lg bg-(--chat-warning)/10 px-3 py-2 text-sm text-(--chat-warning)">{APP_LINK_WARNING}</p>
		{/if}
		{#if apps?.current?.error}
			<p role="alert" class="text-(--chat-danger)">{apps.current.error}</p>
		{:else if !apps?.current?.loaded}
			<p class="text-(--chat-fg-muted)">Loading apps…</p>
		{:else if !rows.length && !detected.length}
			<p class="text-(--chat-fg-muted)">No apps published in this project.</p>
		{:else}
			<ul class="divide-y divide-(--chat-border) overflow-hidden rounded-xl border border-(--chat-border)">
				{#each rows as app (app.appId)}
					{@const title = tasks.find(task => task.id === app.taskId)?.title}
					{@const task = app.taskId ? `${app.taskId}${title ? ` ${title}` : ''}` : 'No task'}
					<li class="bg-(--chat-surface) p-3">
						<PublishedAppRow {app} showDetails warning={false} detail={`${task} · published by ${publisher(app)} · ${age(app.createdAt)} · port ${app.port}`} readLog={() => apps!.current!.client.readAppLog(app.projectId, app.appId)} update={action => apps!.current!.update(app.appId, action)} />
					</li>
				{/each}
				{#each detected as { port } (port)}
					<li class="bg-(--chat-surface) p-3"><DetectedAppRow {port} update={action => apps!.current!.updateDetected(port, action)} /></li>
				{/each}
			</ul>
		{/if}
		{#if apps?.current?.loaded && apps.current.listenerChecksAvailable === false}
			<p class="text-sm text-(--chat-fg-muted)">Listener checks and port suggestions are unavailable on this backend.</p>
		{/if}
	</Dialog.Content>
</Dialog.Root>
