<script lang="ts">
	import { clearPairFragment } from '#lib/pair-inbox.js';
	import PairingApproval from '#lib/components/PairingApproval.svelte';
	import { onMount, untrack } from 'svelte';
	import { alerts } from '#lib/alerts.svelte.js';
	import LaterNotice from '#lib/components/LaterNotice.svelte';
	import AlertStack from '#lib/components/alerts/AlertStack.svelte';
	import AlertInbox from '#lib/components/alerts/AlertInbox.svelte';
	import AttentionBadge from '#lib/components/alerts/AttentionBadge.svelte';
	import { taskFromUrl } from '#lib/tasks.js';
	import { installSettingsNavigation } from '#lib/settings-navigation.svelte.js';
	import { page } from '$app/state';
	import { artifactLibrary } from '#lib/artifact-library.svelte.js';
	import { harness } from '#lib/harness.svelte.js';
	import { reportInteraction, startInteractionReporting } from '#lib/interaction.js';
	import { notifications } from '#lib/notifications.svelte.js';
	import { projectsNav } from '#lib/projects-nav.svelte.js';
	import { LAST_PROJECT_KEY } from '#lib/settings-scope.js';
	import { settingsLocation } from '#lib/settings.js';
	import { currentProject, projectSeenKey } from '#lib/projects.js';
	import { suggestedBackends } from '#lib/suggested-backends.svelte.js';
	import ProjectsSidebar from '#lib/components/ProjectsSidebar.svelte';
	import CoordinatorCreation from '#lib/components/CoordinatorCreation.svelte';
	import UsageModal from '#lib/components/usage/UsageModal.svelte';
	import { theme } from '#lib/themes/theme.svelte.js';
	import type { LayoutProps } from './$types';
	import '../app.css';

	let { children }: LayoutProps = $props();
	installSettingsNavigation();

	// Read the browser's backend list and sidebar state before children render; connected in onMount.
	clearPairFragment();
	harness.load();
	artifactLibrary.connect(() => page.route.id === '/artifacts');
	theme.load();
	projectsNav.load();

	/** The project this route shows, if any: its chat, settings or a worker's transcript. */
	const showing = $derived(currentProject(page.url.pathname));

	// A project on screen is read as it arrives: its latest reply is what this browser has seen.
	$effect(() => {
		const target = showing;
		if (target === undefined) return;
		const backend = harness.backend(target.backendId);
		const project = backend?.projects.find((entry) => entry.id === target.projectId);
		if (backend === undefined || project === undefined) return;
		projectsNav.markSeen(projectSeenKey(backend.id, project.id), project.activity);
		if (!settingsLocation(page.url.pathname) && !project.archived) {
			try { localStorage.setItem(LAST_PROJECT_KEY, JSON.stringify(target)); } catch { /* Optional device storage. */ }
		}
	});

	// The drawer is a transient menu: following a link in it closes it.
	$effect(() => {
		const path = page.url.pathname;
		void path;
		projectsNav.closeDrawer();
	});

	/**
	 * Notifications on every backend: ask each one what it offers and register this device where it is missing. The
	 * signature makes the effect run when a backend connects (or its features arrive), not on every render.
	 */
	$effect(() => {
		const backends = harness.backends;
		const signature = backends
			.map((backend) => `${backend.id}:${backend.authSessionId ?? "anonymous"}:${backend.connection.status}:${(backend.features ?? []).length}`)
			.join('|');
		void signature;
		void notifications.sync(backends);
	});

	/**
	 * Presence: whether this page is visible, on connect, on every route change and on `visibilitychange` (below). A
	 * visible page makes the backend hold pushes for 15 s; a closed socket is forgotten on its side.
	 */
	$effect(() => {
		const path = page.url.pathname;
		const signature = harness.backends
			.map((backend) => `${backend.id}:${backend.ready ? 'ready' : 'away'}`)
			.join('|');
		const registered = Object.values(notifications.backends)
			.map((entry) => (entry.device === null ? '' : entry.backendId))
			.join(',');
		void signature;
		void registered;
		for (const backend of harness.backends) {
			if (!backend.ready) notifications.forgetPresence(backend.id);
		}
		if (harness.backends.some((backend) => backend.ready)) {
			void notifications.reportPresence(harness.backends, path);
		}
	});

	$effect(() => {
		if (page.url.pathname === '/pair') return;
		const backends = harness.backends;
		untrack(() => alerts.observeBackends(backends));
	});

	$effect(() => {
		void notifications.settings;
		untrack(() => alerts.pruneMutedPopups());
	});

	onMount(() => {
		if (page.url.pathname === '/pair') return;
		const stopDeviceSettings = notifications.observeDeviceSettings(window);
		const stopAlerts = alerts.start(() => {
			const project = currentProject(page.url.pathname);
			if (!project) return undefined;
			const route = page.route.id;
			const inChat = route === '/b/[backend]/projects/[id]' || route === '/b/[backend]/projects/[id]/threads/[threadId]';
			return { ...project, coordinatorId: inChat ? page.params.threadId ?? 'main' : undefined,
				taskId: inChat ? taskFromUrl(page.url) : null };
		});
		alerts.observeBackends(harness.backends);
		harness.start();
		void harness.discoverLocal();
		// The worker is what makes the app installable and what shows a push; registering it early keeps it current.
		void notifications.start();
		// The published list of backends beside the app: offered as one-tap adds, empty when the host publishes none.
		suggestedBackends.load();
		const checkConnections = (): void => {
			if (document.visibilityState !== 'visible') return;
			for (const backend of harness.backends) void backend.client.checkConnection();
		};
		const onVisibility = (): void => {
			checkConnections();
			void notifications.reportPresence(harness.backends, page.url.pathname);
		};
		document.addEventListener('visibilitychange', onVisibility);
		window.addEventListener('pageshow', checkConnections);
		window.addEventListener('focus', checkConnections);
		// Using the app drops held notifications for the visible project (throttled, see lib/interaction.ts).
		const stopInteraction = startInteractionReporting(window, () =>
			reportInteraction(harness.backends, notifications.deviceId, page.url.pathname, document.visibilityState === 'visible'),
			{ onTrustedActivation: () => { void alerts.unlockSounds(); } },
		);
		return () => {
			document.removeEventListener('visibilitychange', onVisibility);
			window.removeEventListener('pageshow', checkConnections);
			window.removeEventListener('focus', checkConnections);
			stopInteraction();
			stopAlerts();
			stopDeviceSettings();
		};
	});
</script>

{#if page.url.pathname === '/pair'}
	{@render children()}
{:else}
<CoordinatorCreation>
	<div class="flex h-dvh w-full overflow-hidden">
		<ProjectsSidebar />
		<div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
			{@render children()}
		</div>
	</div>
</CoordinatorCreation>
<AlertStack />
<AlertInbox />
<LaterNotice />
<AttentionBadge />
<UsageModal />
<PairingApproval />
{/if}
