<script lang="ts">
	import { afterNavigate, goto } from '$app/navigation';
	import type { Snippet } from 'svelte';
	import { provideCoordinatorCreation } from '#lib/coordinator-creation.js';
	import { coordinatorHref, coordinatorRoster } from '#lib/coordinators.js';
	import type { BackendConnection } from '#lib/harness.svelte.js';
	import type { ProjectBoard } from '#lib/board.svelte.js';
	import type { ProjectThreads } from '#lib/threads.svelte.js';
	import CoordinatorManager from './CoordinatorManager.svelte';

	let { children }: { children: Snippet } = $props();
	let project = $state.raw<{ backend: BackendConnection; id: string }>();
	let threads = $state.raw<ProjectThreads>();
	let board = $state.raw<ProjectBoard>();

	function close() { project = undefined; }
	provideCoordinatorCreation({
		open: (backend, id) => { project = { backend, id }; },
		isOpen: () => project !== undefined,
	});
	afterNavigate(({ from, to }) => { if (from?.url.pathname !== to?.url.pathname) close(); });

	$effect(() => {
		if (!project) return;
		const { backend, id } = project;
		const projectThreads = backend.watchThreads(id);
		const projectBoard = backend.supports('board') ? backend.watchBoard(id) : undefined;
		threads = projectThreads;
		board = projectBoard;
		void backend.ensureLoaded();
		return () => {
			projectThreads.stop();
			projectBoard?.stop();
			threads = undefined;
			board = undefined;
		};
	});

	function created(id: string) {
		if (!project) return;
		const href = coordinatorHref(project.backend.id, project.id, id);
		close();
		void goto(href);
	}
</script>

{@render children()}
{#if project && threads}
	<CoordinatorManager mode="new" store={threads} roster={coordinatorRoster(threads.threads)} tasks={board?.tasks ?? []}
		models={project.backend.models.filter(model => !model.workerOnly && model.configured)}
		supportsSchedules={project.backend.supports('coordinator-schedules')} onclose={close} oncreated={created} />
{/if}
