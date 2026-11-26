<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import type { BackendConnection, ProjectMemory, ProjectSchedules } from '#lib/harness.svelte.js';
	import type { ProjectThreads } from '#lib/threads.svelte.js';
	import type { ProjectBoard } from '#lib/board.svelte.js';
	import { ProjectRefStatus } from '#lib/ref-links.svelte.js';
	import { ProjectOverview } from '#lib/coordinator-overview.svelte.js';
	import { ProjectThreadMessages } from '#lib/thread-messages.svelte.js';
	import { SERVER_STATUS_REFRESH_MS } from '#lib/server-status.js';
	import { taskRefs } from '#lib/tasks.js';
	import { retainCoordinator } from '#lib/coordinator-recents.js';
	import ProjectChat from './ProjectChat.svelte';
	import { answersSupported } from '#lib/answers.js';
	import { ProjectAnswers } from '#lib/answers.svelte.js';

	let { backend, projectId, threadId }: { backend: BackendConnection; projectId: string; threadId?: string } = $props();
	const shownId = $derived(threadId || 'main');
	const limit = 4;
	let recents = $state.raw<readonly string[]>([]);
	const projectReads = $state<{ board?: ProjectBoard; threads?: ProjectThreads; memory?: ProjectMemory; schedules?: ProjectSchedules; refStatus?: ProjectRefStatus; peerLog?: ProjectThreadMessages; overview?: ProjectOverview }>({});
	let answers = $state<ProjectAnswers>();
	$effect(() => {
		if (!answersSupported(backend.features)) { answers = undefined; return; }
		const client = backend.client;
		const id = projectId;
		const catalogue = untrack(() => new ProjectAnswers(client, id));
		answers = catalogue;
		return () => catalogue.stop();
	});
	const supportsCoordinators = $derived(backend.supports('coordinators'));
	function canRetain(id: string) {
		if (!supportsCoordinators) return false;
		if (id === 'main') return true;
		const thread = projectReads.threads?.thread(id);
		return thread?.kind === 'coordinator' && !thread.archived;
	}

	// A current URL (including Back/Forward) always shows its chat in the same update.
	// Sort by stable key so updating recency never moves mounted scroll containers.
	const visiting = $derived(canRetain(shownId) ? retainCoordinator(recents, shownId, limit) : recents);
	const rendered = $derived([...new Set([...visiting, shownId])].sort());
	$effect(() => { recents = visiting; });
	function prefetchCoordinator(id: string) {
		if (canRetain(id) && id !== shownId) recents = retainCoordinator(recents, id, limit, true);
	}

	function projectRead<Key extends keyof typeof projectReads>(key: Key, feature: string, open: () => NonNullable<typeof projectReads[Key]>) {
		const available = $derived(backend.supports(feature));
		$effect(() => {
			if (!available) { projectReads[key] = undefined; return; }
			const read = open();
			projectReads[key] = read;
			return () => read.stop();
		});
	}
	projectRead('board', 'board', () => backend.watchBoard(projectId));
	projectRead('threads', 'threads', () => backend.watchThreads(projectId));
	projectRead('memory', 'memory', () => backend.watchMemory(projectId, { maintenance: backend.supports('memory-maintenance') }));
	projectRead('schedules', 'schedules', () => backend.watchSchedules(projectId));
	projectRead('refStatus', 'ref-status', () => new ProjectRefStatus(backend.client, projectId));
	projectRead('overview', 'coordinator-overview', () => new ProjectOverview(backend.client, projectId));
	projectRead('peerLog', 'coordinator-messages', () => new ProjectThreadMessages(backend.client, projectId));
	$effect(() => projectReads.refStatus?.want((projectReads.board?.tasks ?? []).flatMap(task => taskRefs(task))));

	onMount(() => {
		void backend.ensureLoaded();
		const statusTimer = setInterval(() => {
			if (backend.ready && backend.supports('server-status')) void backend.refreshServerStatus();
		}, SERVER_STATUS_REFRESH_MS);
		return () => clearInterval(statusTimer);
	});
</script>

<div class="relative h-full min-w-0 flex-1 overflow-hidden">
	{#each rendered as id (id)}
		{@const shown = id === shownId}
		<div class="absolute inset-0" class:invisible={!shown} inert={!shown} aria-hidden={!shown || undefined}>
			<ProjectChat {backend} {projectId} threadId={id} {shown} {projectReads} {prefetchCoordinator} {answers} />
		</div>
	{/each}
</div>
