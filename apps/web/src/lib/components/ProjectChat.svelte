<script lang="ts">
	import { rememberConversationView, conversationBack } from "#lib/conversation-navigation.svelte.js";
	import { agentWaitingForUser } from '#lib/agent-activity.js';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import BellIcon from '@lucide/svelte/icons/bell';
	import BellOffIcon from '@lucide/svelte/icons/bell-off';
	import ClipboardListIcon from '@lucide/svelte/icons/clipboard-list';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import InfoIcon from '@lucide/svelte/icons/info';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import { onMount, untrack, type Component } from 'svelte';
	import { page } from '$app/state';
	import { projectsNav } from '#lib/projects-nav.svelte.js';
	import { goto } from '$app/navigation';
	import CoordinatorMark from './CoordinatorMark.svelte';
	import CoordinatorBadges from './CoordinatorBadges.svelte';
	import { ProjectThreadMessages } from '#lib/thread-messages.svelte.js';
	import { threadMessageHref, threadMessageAnchor, type ThreadMessageLinks } from '#lib/thread-messages.js';
	import ThreadMessagesFeed from './ThreadMessagesFeed.svelte';
	import CoordinatorManager from './CoordinatorManager.svelte';
	import { coordinatorBadges, coordinatorColor, coordinatorHref, coordinatorOfThread, coordinatorRoster, coordinatorShortcut, coordinatorStorageKey, readCoordinatorPreference, saveCoordinatorPreference, scopedQuestions, scopedTasks } from '#lib/coordinators.js';
	import { provideCoordinatorTaskView } from '#lib/coordinator-task-view.js';
	import type { ThreadSummary } from '@kemiri/protocol';
	import FolderIcon from '@lucide/svelte/icons/folder';
	import FilesHost from './files/FilesHost.svelte';
	import { provideFilesNavigation } from '#lib/code/files-navigation.svelte.js';
	import ChangesHost from './changes/ChangesHost.svelte';
	import { openWorkingChanges } from '#lib/code/working-changes-navigation.js';
	import { PROJECT_ROOT } from '#lib/code/file-location.js';
	import ArchivedBanner from '#lib/components/ArchivedBanner.svelte';
	import Banner from '#lib/components/Banner.svelte';
	import ConnectionBadge from '#lib/components/ConnectionBadge.svelte';
	import ContextPanel from '#lib/components/ContextPanel.svelte';
	import BoardPanel from '#lib/components/BoardPanel.svelte';
	import BackgroundPanel from '#lib/components/BackgroundPanel.svelte';
	import ArtifactStrip from '#lib/components/artifacts/ArtifactStrip.svelte';
	import ConversationSwitcher from './ConversationSwitcher.svelte';
	import BackgroundJobBand from './BackgroundJobBand.svelte';
	import BoardQuestionPin from '#lib/components/BoardQuestionPin.svelte';
	import TaskCloseDialog from '#lib/components/TaskCloseDialog.svelte';
	import TaskSheet from '#lib/components/TaskSheet.svelte';
	import RefCardHost from '#lib/components/RefCardHost.svelte';
	import TasksPanel from '#lib/components/TasksPanel.svelte';
	import TasksView from '#lib/components/TasksView.svelte';
	import { taskFilter, tasksView } from '#lib/tasks-view.svelte.js';
	import ConversationSidebar from '#lib/components/ConversationSidebar.svelte';
	import DeployBanner from '#lib/components/DeployBanner.svelte';
	import DiskBanner from '#lib/components/DiskBanner.svelte';
	import { SERVER_STATUS_REFRESH_MS } from '#lib/server-status.js';
	import MemoryPanel from '#lib/components/MemoryPanel.svelte';
	import ProjectsMenuButton from '#lib/components/ProjectsMenuButton.svelte';
	import ReleaseLine from '#lib/components/ReleaseLine.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Popover from '#lib/components/ui/popover/index.js';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import Composer from '#lib/components/chat/Composer.svelte';
	import { provideFileDownload } from '#lib/chat/file-scope.js';
	import type { ChatFile } from '@kemiri/protocol';
	import { draftKey } from '#lib/drafts.js';
	import { draftChannel } from '#lib/draft-channel.js';
	import EmptyState from '#lib/components/chat/EmptyState.svelte';
	import TranscriptColumn from '#lib/components/chat/TranscriptColumn.svelte';
	import { setContext, tick as afterRender } from 'svelte';
	import { artifactLibrary } from '#lib/artifact-library.svelte.js';
	import { claimDiscussionNavigation, discussionNavigation } from '#lib/artifact-discuss.svelte.js';
	import { settledDiscussionTask } from '#lib/artifact-discuss.js';
	import { DISCUSSION_CHAT, type DiscussionChat } from '#lib/discussion-chat.js';
	import { provideArtifactScope } from '#lib/artifacts.svelte.js';
	import { taskOptions } from '#lib/task-chat.js';
	import { boardTaskLinks, provideTaskLinks } from '#lib/task-links.svelte.js';
	import { ProjectRefStatus, provideRefLinks } from '#lib/ref-links.svelte.js';
	import { projectHref, threadHref, workerHref } from '#lib/backends.js';
	import { projectAdvancedHref, projectSettingsHref } from '#lib/settings.js';
	import { terminalHref } from '#lib/terminal.js';
	import {
		harness,
		modelLabel,
		ProjectMemory,
		ProjectSchedules,
		ProjectWorkers,
		type BackendConnection,
		type ChatSession,
		type ProjectContext
	} from '#lib/harness.svelte.js';
	import { visibleSidebarTabs, type SidebarTab } from '#lib/sidebar.js';
	import { questionBadgeText, questionsWaitingLabel } from '#lib/board.js';
	import type { ProjectBoard } from '#lib/board.svelte.js';
	import { taskFromUrl, taskRefs, withTask } from '#lib/tasks.js';
	import { notifications } from '#lib/notifications.svelte.js';
	import { connectionDotClass, connectionView } from '#lib/connection.js';
	import { headerActionShowsLabel, headerLayout, visibleHeaderActions } from '#lib/chat/header.js';
	import { memoryExtractionFor, type MemoryExtraction } from '#lib/memory.js';
	import { elapsedFor } from '#lib/relative-time.js';
	import { CHAT_COLUMN_CLASS } from '#lib/chat/layout.js';
	import { buildTranscript, liveState } from '#lib/transcript.js';
	import { inputContent, type HeldImage } from '#lib/chat/images.js';
	import { WaitingMessages } from '#lib/waiting.svelte.js';
	import { withWaiting } from '#lib/waiting.js';
	import { threadActivityLine, type ThreadCards } from '#lib/threads.js';
	import type { ProjectThreads } from '#lib/threads.svelte.js';
	import { backgroundJobCounts } from '@kemiri/protocol';
	import { isMainThread, shouldSendWorkerDefaults, threadFromAnchor } from '@kemiri/client';
	import type { MemoryScope, ModelInfo, ThinkingLevel } from '@kemiri/protocol';

	/**
	 * One project's coordinator conversation: the transcript, the composer, the
	 * model and thinking level the composer changes, the workers it delegates to,
	 * the conversation's context and the project's memory. All three live in one
	 * resizable right sidebar (a full-screen sheet below 72rem).
	 *
	 * With `threadId` this is a background job's chat instead: the same transcript and composer, typed into
	 * directly, under a header that says it is a background job of main and leads back to main. It has its own
	 * Workers and Info tabs, and shares the project's Board, Memory and Background jobs panels.
	 */
	let {
		backend,
		projectId,
		threadId: threadParam
	}: { backend: BackendConnection; projectId: string; threadId?: string } = $props();

	/** The background job this chat is; undefined for main ("main" in the route reads as main too). */
	const threadId = $derived(isMainThread(threadParam) ? undefined : threadParam);
	const isThread = $derived(threadId !== undefined);
	$effect(() => tasksView.useProject(`${backend.id}:${projectId}`));

	/** The parts of the transcript column the chat drives: following new output. */
	type TranscriptHandle = {
		scrollToBottom(behavior?: ScrollBehavior): void;
		follow(): void;
	};

	const project = $derived(backend.projects.find((entry) => entry.id === projectId));
	const filesNavigation = provideFilesNavigation(() => backend.features?.includes('project-files') === true,
		() => threadId ? { kind: 'thread', threadId } : PROJECT_ROOT, () => threadId ? undefined : project?.path);

	provideFileDownload(async file => {
		const response = await backend.attachmentRequest(file.url);
		const url = URL.createObjectURL(await response.blob());
		const link = document.createElement('a'); link.href = url; link.download = file.name; link.click();
		setTimeout(() => URL.revokeObjectURL(url), 60_000);
	});
	async function uploadFile(file: File): Promise<ChatFile> {
		const query = new URLSearchParams({ name: file.name, ...(threadId ? { threadId } : {}) });
		return (await backend.attachmentRequest(`/attachments/${projectId}?${query}`, { method: 'POST', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file })).json();
	}
	provideArtifactScope(() => ({ client: backend.client, projectId, available: backend.supports('artifacts') }));

	let session = $state<ChatSession | undefined>(undefined);
	let workers = $state<ProjectWorkers | undefined>(undefined);
	let projectContext = $state<ProjectContext | undefined>(undefined);
	let memory = $state<ProjectMemory | undefined>(undefined);
	let schedules = $state<ProjectSchedules | undefined>(undefined);
	let board = $state<ProjectBoard | undefined>(undefined);
	let threads = $state<ProjectThreads | undefined>(undefined);
	let aborting = $state(false);
	let sendError = $state<string | undefined>(undefined);
	let modelError = $state<string | undefined>(undefined);
	let transcript = $state<TranscriptHandle | undefined>(undefined);
	let composer = $state<{ focus(): void; addQuote(quote: string): void; restore(text: string, taskId?: string, images?: HeldImage[], files?: ChatFile[]): void } | undefined>(undefined);
	setContext<() => DiscussionChat | undefined>(DISCUSSION_CHAT, () => isThread ? undefined : {
		backend, projectId,
		relevant(taskId, at) {
			const task = board?.tasks.find(task => task.id === taskId) ?? artifactLibrary.entries.find(entry => entry.backendId === backend.id && entry.project.id === projectId && entry.task?.id === taskId)?.task;
			return settledDiscussionTask(task) && (!task?.settledAt || Date.parse(task.settledAt) <= at);
		}
	});
	let discussionNotice = $state<string>();
	$effect(() => {
		if (discussionNavigation.path !== page.url.pathname || isThread || !claimDiscussionNavigation(discussionNavigation.sequence)) return;
		const name = discussionNavigation.projectName;
		discussionNotice = name ? `Opened main chat in ${name}.` : undefined;
		sidebarOpen = false;
		void afterRender().then(() => composer?.focus());
		const timeout = setTimeout(() => { discussionNotice = undefined; }, 4500);
		return () => clearTimeout(timeout);
	});

	/** The right sidebar: open, which tab, and whether it fills the chat area. */
	let sidebarOpen = $state(false);
	let sidebarTab = $state<SidebarTab>('info');
	let sidebarExpanded = $state(false);
	rememberConversationView(() => ({ open: sidebarOpen, tab: sidebarTab, expanded: sidebarExpanded, tasksMode: tasksView.mode, taskFocus: taskFilter.focus }), saved => {
		sidebarOpen = saved.open; sidebarTab = saved.tab; sidebarExpanded = saved.expanded;
		if (saved.tasksMode) tasksView.set(saved.tasksMode);
		if (saved.taskFocus) taskFilter.focusOn(saved.taskFocus); else taskFilter.clearFocus();
	});

	const supportsWorkers = $derived(backend.supports('workers'));
	const supportsMemory = $derived(backend.supports('memory'));
	const supportsBoard = $derived(backend.supports('board'));
	// With task reports the Board tab is the Tasks view, and `?task=<id>` opens a task's sheet over the chat.
	const supportsTasks = $derived(supportsBoard && backend.supports('task-reports'));
	const boardTabName = $derived(supportsTasks ? 'Tasks' : 'Board');
	/** Task links in the chat, and the composer's task reference, need the board and the server's task reports. */
	const supportsTaskReports = $derived(backend.supports('task-reports'));
	const taskLinks = $derived(supportsTaskReports && board !== undefined ? boardTaskLinks(() => board?.board?.tasks ?? []) : undefined);
	provideTaskLinks(() => taskLinks);
	/** Keys and PR numbers link through the project's settings; the board's refs show the state the backend reads. */
	let refStatus = $state<ProjectRefStatus | undefined>(undefined);
	const supportsRefStatus = $derived(backend.supports('ref-status'));
	provideRefLinks(() => ({ links: project?.links, status: (ref) => refStatus?.status(ref) }));
	const hasOpenQuestions = $derived(board?.board?.questions.some(question => question.status === 'open') ?? false);
	/** A mute toggle belongs in the header when this backend can push to this device at all. */
	const supportsNotifications = $derived(backend.supports('notifications'));
	const muted = $derived(notifications.isMuted(backend.id, projectId));
	/** A worker a schedule started says which schedule; the names come from the project's schedule list. */
	const supportsSchedules = $derived(backend.supports('schedules'));
	/** Info needs the `context` feature, Workers the `workers` one, Memory the `memory` one. */
	const supportsThreads = $derived(backend.supports('threads'));
	const sidebarTabs = $derived(visibleSidebarTabs((feature) => backend.supports(feature), { background: true }));
	/** This thread as the list has it; undefined on main's chat and while the list loads. */
	let archivedThread = $state<ThreadSummary>();
	const thread = $derived(threadId === undefined ? undefined : threads?.thread(threadId) ?? (archivedThread?.id === threadId ? archivedThread : undefined));
	const threadList = $derived(threads?.threads ?? []);
	const supportsCoordinators = $derived(backend.supports('coordinators'));
	const supportsAssignment = $derived(backend.supports('task-coordinator'));
	const roster = $derived(coordinatorRoster(threadList, supportsCoordinators));
	let peerLog = $state<ProjectThreadMessages>();
	const supportsPeerMessages = $derived(backend.supports('coordinator-messages'));
	$effect(() => {
		if (!supportsPeerMessages) { peerLog = undefined; return; }
		const log = new ProjectThreadMessages(backend.client, projectId);
		peerLog = log;
		return () => log.stop();
	});
	const peerMessages = $derived(peerLog ? new Map(peerLog.messages.map(message => [message.id, message])) : undefined);
	const peerLinks: ThreadMessageLinks = {
		thread: id => threads?.thread(id) ?? (archivedThread?.id === id ? archivedThread : undefined),
		chat: (id, message) => threadMessageHref(backend.id, projectId, id, message),
		task: id => taskLink(id),
	};
	let peerPanel = $state(false);
	const peerAnchor = $derived.by(() => {
		if (!page.url.hash.startsWith('#peer-')) return undefined;
		try { return decodeURIComponent(page.url.hash.slice(6)); } catch { return undefined; }
	});

	const coordinatorId = $derived(thread?.kind === 'coordinator' ? thread.id : coordinatorOfThread(threadId, threadList));
	const viewingCoordinator = $derived(roster.find(row => row.id === coordinatorId));
	const coordinatorChat = $derived(supportsCoordinators && (!isThread || thread?.kind === 'coordinator'));
	const archivedCoordinator = $derived(coordinatorChat && thread?.archived === true);
	const jobs = $derived(supportsCoordinators ? threadList.filter(row => row.kind !== 'coordinator' && (row.parentThreadId ?? 'main') === coordinatorId) : threadList);
	let manager = $state<'new' | 'manage' | ThreadSummary>();
	let taskScope = $state<'coordinator' | 'all'>('coordinator');
	let hiddenCoordinators = $state<Set<string>>(new Set());
	const scopeKey = $derived(coordinatorStorageKey(backend.id, projectId, 'scope'));
	const otherAttention = $derived(roster.filter(row => row.id !== coordinatorId).reduce((sum, row) => sum + coordinatorBadges(row).needsYou, 0));
	const questionCounts = $derived(roster.filter(row => row.id !== coordinatorId).map(row => ({ row, count: scopedQuestions((board?.board?.questions ?? []).filter(q => q.status === 'open'), threadList, row.id).length })).filter(row => row.count));
	provideCoordinatorTaskView(() => supportsAssignment && roster.length ? { roster: [...roster, ...(threads?.archived ?? []).filter(row => row.kind === 'coordinator')], threads: threadList, coordinatorId: taskScope === 'coordinator' ? coordinatorId : undefined, hidden: hiddenCoordinators } : undefined);
	$effect(() => {
		taskScope = readCoordinatorPreference(scopeKey) === 'all' ? 'all' : 'coordinator';
		hiddenCoordinators = new Set();
	});
	function setTaskScope(scope: 'coordinator' | 'all') {
		taskScope = scope;
		if (scope === 'all') hiddenCoordinators = new Set();
		saveCoordinatorPreference(scopeKey, scope);
	}
	function showAllTasks() { setTaskScope('all'); openBoard(); }
	function seen(id: string): string | null {
		return projectsNav.coordinatorSeen(coordinatorStorageKey(backend.id, projectId, `seen:${id}`));
	}
	$effect(() => {
		if (!coordinatorChat || viewingCoordinator?.id !== (threadId ?? 'main') || !viewingCoordinator) return;
		projectsNav.rememberCoordinator(coordinatorStorageKey(backend.id, projectId, 'last'), viewingCoordinator.id);
		if (viewingCoordinator.lastReplyAt) projectsNav.markCoordinatorSeen(coordinatorStorageKey(backend.id, projectId, `seen:${viewingCoordinator.id}`), viewingCoordinator.lastReplyAt);
	});
	function switchCoordinator(id: string) {
		const href = coordinatorHref(backend.id, projectId, id);
		if (href !== page.url.pathname) void goto(href);
	}
	function coordinatorKeys(event: KeyboardEvent) {
		if (event.defaultPrevented || manager || roster.length < 2) return;
		const index = coordinatorShortcut(event);
		const target = index === undefined ? undefined : roster[index];
		if (target) { event.preventDefault(); switchCoordinator(target.id); }
	}
	const panelWorkers = $derived(supportsAssignment && taskScope === 'coordinator'
		? (workers?.allWorkers ?? []).filter(worker => coordinatorOfThread(worker.threadId, threadList) === coordinatorId)
		: supportsAssignment ? (workers?.allWorkers ?? []).filter(worker => !hiddenCoordinators.has(coordinatorOfThread(worker.threadId, threadList))) : workers?.workers ?? []);
	const taskChoices = $derived((!isThread || coordinatorChat) && supportsTaskReports && board !== undefined ? taskOptions(supportsAssignment ? scopedTasks(board.tasks, coordinatorId) : board.tasks) : undefined);
	const questionsWaiting = $derived(supportsAssignment && roster.length ? (viewingCoordinator ? coordinatorBadges(viewingCoordinator).needsYou : 0) : board?.openQuestionCount ?? 0);
	$effect(() => {
		const id = threadId;
		const project = projectId;
		const backendId = backend.id;
		if (!supportsCoordinators || !id || !threads?.loaded || threadList.some(row => row.id === id) || !backend.ready) return;
		let keep = true;
		void backend.client.listThreads(project, { includeArchived: true }).then(snapshot => {
			if (!keep) return;
			archivedThread = snapshot.threads.find(row => row.id === id && row.archived);
			const key = coordinatorStorageKey(backendId, project, 'last');
			if (readCoordinatorPreference(key) === id) projectsNav.rememberCoordinator(key, 'main');
			if (!archivedThread && !snapshot.threads.some(row => row.id === id)) void goto(projectHref(backendId, project), { replaceState: true });
		}).catch(() => { /* A reconnect refreshes the roster and retries. */ });
		return () => { keep = false; };
	});
	const jobCounts = $derived(project?.activity?.backgroundJobs ?? backgroundJobCounts(threadList));
	const threadCards = $derived<ThreadCards | undefined>(
		supportsThreads
			? {
					threads: jobs,
					questions: board?.board?.questions ?? [],
					href: (id) => threadHref(backend.id, projectId, id),
					scheduleName: scheduleTitle,
					artifacts: threadArtifacts
				}
			: undefined
	);
	const supportsSidebar = $derived(sidebarTabs.length > 0);
	const canPickModel = $derived(
		project !== undefined && backend.ready && backend.supports('projects') && backend.supports('models')
	);
	const currentModel = $derived(
		project?.coordinator.model === null || project?.coordinator.model === undefined
			? undefined
			: backend.models.find(
					(model) =>
						model.provider === project?.coordinator.model?.provider &&
						model.modelId === project?.coordinator.model?.modelId
				)
	);
	const thinkingLevels = $derived<readonly ThinkingLevel[]>(currentModel?.thinkingLevels ?? []);

	const workerList = $derived(workers?.workers ?? []);
	const usesProjectWorkerDefault = $derived(backend.supports('worker-picker-project-default'));
	const firstWorkerModel = $derived(project?.workerModels[0]);
	const workerDefaults = $derived(usesProjectWorkerDefault
		? { model: firstWorkerModel ?? null, thinkingLevel: firstWorkerModel?.thinkingLevel ?? null }
		: workers?.defaults ?? { model: null, thinkingLevel: null });

	const live = $derived(liveState(session?.view));
	const busy = $derived(live?.run !== undefined);
	/** Messages sent while a run was busy, drawn at the end of the transcript until the run places them. */
	let waiting = $state<WaitingMessages | undefined>(undefined);
	const waitingList = $derived(waiting?.supported === true ? waiting.messages(session?.view?.queued) : []);
	const replyAnchor = $derived(/^#entry-(\d+)$/.exec(page.url.hash)?.[1]);
	const items = $derived(
		withWaiting(
			buildTranscript(session?.entries ?? [], live, { inputKeys: waiting?.inputKeys, keepWarm: session?.view?.keepWarm, showCoordinatorNotes: backend.supports('memory-notes'), threadMessages: peerMessages, entryAnchor: replyAnchor ? Number(replyAnchor) : undefined }),
			waitingList,
			waiting?.pending
		)
	);
	/** A turn is being written, so its own orb and shimmer already say so. */
	const waitingForUser = $derived(agentWaitingForUser(board?.board?.questions ?? [], threadId));
	const working = $derived(busy && !items.some((item) => item.kind === 'turn' && item.live === true));
	const empty = $derived(session !== undefined && session.status === 'live' && items.length === 0);
	const canChat = $derived(project !== undefined && (isThread || project.coordinator.model !== null));
	const canSend = $derived(canChat && !archivedCoordinator && backend.ready && backend.supports('conversation'));

	/** The coordinator's current tool call, for the header's "Running bash · 3m"; ticks with `now`. */
	let now = $state(Date.now());
	const runningTool = $derived(project?.activity?.runningTool ?? null);
	const runningToolLabel = $derived(
		isThread
			? thread === undefined
				? undefined
				: threadActivityLine(thread, board?.board?.questions ?? [], now)
			: runningTool === null ? undefined : `Running ${runningTool.name}${elapsedFor(runningTool.startedAt, now) ? ` \u00b7 ${elapsedFor(runningTool.startedAt, now)}` : ''}`
	);

	function errorText(error: unknown): string {
		return error instanceof Error ? error.message : String(error);
	}

	/** Mute this project for this device, or unmute it; stored in this browser's preferences on this backend. */
	async function toggleProjectMute(): Promise<void> {
		if (project === undefined) return;
		await notifications.toggleProject(harness.backends, backend.id, project.id);
	}

	/** One control in the chat header: a tab of the right sidebar, or the mute and settings buttons. */
	type HeaderAction = {
		id: string;
		/** A sidebar tab (it has a label where the row shows labels) or one of the icons after the connection badge. */
		kind: 'tab' | 'utility';
		/** What the button is called, count included: its aria-label. */
		name: string;
		/** Its tooltip, when saying what the button does is not the same thing; the name stands in for it. */
		title?: string;
		/** The text beside its icon where the row has room for labels; a control without one stays an icon. */
		label?: string;
		/** What the overflow menu calls it, when that reads better than the header's label. */
		menuLabel?: string;
		icon: Component;
		/** The count on the button: beside its label on a wide row, over its icon's corner without one. */
		count?: string;
		tone?: 'primary' | 'accent';
		/** Tasks and Workers stay in the row when the rest fold into the menu. */
		primary?: boolean;
		pressed?: boolean;
		href?: string;
		onclick?: () => void;
	};

	/** The header row, measured: the chat column narrows when the sidebar opens, so the row, not the window, decides. */
	let headerRow = $state<HTMLDivElement | null>(null);
	let headerWidth = $state(0);
	let headerMenuOpen = $state(false);

	$effect(() => {
		if (headerRow == null) return;
		const element = headerRow;
		headerWidth = element.clientWidth;
		const observer = new ResizeObserver(() => (headerWidth = element.clientWidth));
		observer.observe(element);
		return () => observer.disconnect();
	});

	/** The right sidebar's tabs as header buttons; the board and the workers are the two a phone keeps in the row. */
	const tabActions = $derived.by((): HeaderAction[] => {
		const actions: HeaderAction[] = [];
		if (supportsBoard) {
			actions.push({
				id: 'board',
				kind: 'tab',
				name: `${boardTabName}${questionsWaiting > 0 ? ` (${supportsAssignment ? `${questionsWaiting} need attention` : questionsWaitingLabel(questionsWaiting)})` : ''}`,
				label: boardTabName,
				icon: ClipboardListIcon,
				count: questionBadgeText(questionsWaiting),
				tone: 'primary',
				primary: true,
				pressed: sidebarOpen && sidebarTab === 'board',
				onclick: () => toggleSidebar('board')
			});
		}
		if (backend.supports('context')) {
			actions.push({
				id: 'info',
				kind: 'tab',
				name: 'Conversation info',
				label: 'Info',
				icon: InfoIcon,
				pressed: sidebarOpen && sidebarTab === 'info',
				onclick: () => toggleSidebar('info')
			});
		}
		if (supportsMemory) {
			actions.push({
				id: 'memory',
				kind: 'tab',
				name: 'Memory',
				label: 'Memory',
				icon: BookOpenIcon,
				pressed: sidebarOpen && sidebarTab === 'memory',
				onclick: () => toggleSidebar('memory')
			});
		}
		if (filesNavigation.available()) actions.push({ id: 'files', kind: 'tab', name: 'Files', label: 'Files', icon: FolderIcon, onclick: () => { headerMenuOpen = false; void filesNavigation.open(); } });
		if (threadId && thread && !thread.archived && backend.features?.includes('project-changes-working')) actions.push({
			id: 'working-changes', kind: 'tab', name: 'Uncommitted changes', label: 'Uncommitted changes', icon: FolderIcon,
			onclick: () => { headerMenuOpen = false; void openWorkingChanges({ kind: 'thread', threadId: threadId! }); }
		});
		// A shell on this backend in the project's folder, on a page of its own (zellij sessions, tabs, a phone key bar).
		if (project && backend.supports('terminal')) {
			actions.push({
				id: 'terminal',
				kind: 'tab',
				name: 'Terminal',
				title: 'A terminal on this backend, in the project folder',
				label: 'Terminal',
				icon: TerminalIcon,
				href: terminalHref(backend.id, { projectId: project.id })
			});
		}
		return actions;
	});

	/** The mute bell and the settings gear: icons at every width, and the first things the menu takes over. */
	const utilityActions = $derived.by((): HeaderAction[] => {
		const actions: HeaderAction[] = [];
		if (project && supportsNotifications) {
			actions.push({
				id: 'mute',
				kind: 'utility',
				name: muted ? 'Unmute notifications for this project' : 'Mute notifications for this project',
				title: muted ? 'Notifications muted for this project' : 'Notifications are on for this project',
				menuLabel: muted ? 'Unmute notifications' : 'Mute notifications',
				icon: muted ? BellOffIcon : BellIcon,
				pressed: muted,
				onclick: () => void toggleProjectMute()
			});
		}
		if (project && (backend.supports('models') || backend.supports('credentials') || backend.supports('logins'))) {
			actions.push({
				id: 'settings',
				kind: 'utility',
				name: 'Project settings',
				menuLabel: 'Project settings',
				icon: SettingsIcon,
				href: projectSettingsHref(backend.id, project.id),
				onclick: () => (headerMenuOpen = false)
			});
		}
		return actions;
	});

	const headerActions = $derived([...tabActions, ...utilityActions]);
	/** Labels where they fit beside the project's name, icons where they do not, and a menu when even those are too many. */
	const headerRowLayout = $derived(headerLayout(headerWidth, headerActions));
	const shownHeaderActions = $derived(visibleHeaderActions(headerRowLayout, headerActions));
	const shownTabActions = $derived(shownHeaderActions.inline.filter((action) => action.kind === 'tab'));
	const shownUtilityActions = $derived(shownHeaderActions.inline.filter((action) => action.kind === 'utility'));
	/** A dropped connection is worth a mark on the menu, which is the only place it shows on a phone. */
	const connectionTone = $derived(connectionView(backend.connection).tone);

	function pickHeaderAction(action: HeaderAction): void {
		headerMenuOpen = false;
		action.onclick?.();
	}

	onMount(() => {
		void backend.ensureLoaded();
		const timer = setInterval(() => (now = Date.now()), 15_000);
		// The server does not push its status, and a disk fills during a long run: read it again now and then.
		const statusTimer = setInterval(() => {
			if (backend.ready && backend.supports('server-status')) void backend.refreshServerStatus();
		}, SERVER_STATUS_REFRESH_MS);
		return () => {
			clearInterval(timer);
			clearInterval(statusTimer);
		};
	});

	$effect(() => {
		const id = projectId;
		if (id.length === 0 || !backend.supports('conversation')) {
			session = undefined;
			return;
		}
		const created = backend.watchProject(id, { min: 50, max: 100 }, threadId);
		session = created;
		const held = new WaitingMessages({
			client: backend.client,
			projectId: id,
			...(threadId === undefined ? {} : { threadId }),
			supported: () => backend.supports('queued-inputs'),
			busy: () => busy,
			restore: (text, task, images, files) => composer?.restore(text, task, images, files),
			notify: (message) => (sendError = message)
		});
		waiting = held;
		return () => {
			created.stop();
			held.stop();
			if (session === created) session = undefined;
			if (waiting === held) waiting = undefined;
		};
	});

	// What the run placed and what left the queue unplaced, from each new view.
	$effect(() => {
		const current = session;
		const held = waiting;
		if (current === undefined || held === undefined) return;
		const view = current.view;
		const entries = current.entries;
		const live = current.status === 'live';
		untrack(() => held.observe(view, entries, live));
	});

	function onWaiting(key: string, action: 'edit' | 'cancel' | 'retry'): void {
		if (action === 'retry') void waiting?.retry(key);
		else void waiting?.withdraw(key, action === 'edit');
	}

	$effect(() => {
		const id = projectId;
		if (id.length === 0 || !backend.supports('workers')) {
			workers = undefined;
			return;
		}
		const created = backend.watchWorkers(id, threadId);
		workers = created;
		return () => {
			created.stop();
			if (workers === created) workers = undefined;
		};
	});

	$effect(() => {
		const id = projectId;
		if (id.length === 0 || !backend.supports('context')) {
			projectContext = undefined;
			return;
		}
		const created = backend.watchContext(id, undefined, threadId);
		projectContext = created;
		return () => {
			created.stop();
			if (projectContext === created) projectContext = undefined;
		};
	});

	// `supportsMemory` is derived, so a reconnect's identical feature list does not recreate the panel and drop the
	// open file and the archived toggle.
	$effect(() => {
		const id = projectId;
		if (id.length === 0 || !supportsMemory) {
			memory = undefined;
			return;
		}
		const created = backend.watchMemory(id, { maintenance: backend.supports('memory-maintenance') });
		memory = created;
		return () => {
			created.stop();
			if (memory === created) memory = undefined;
		};
	});

	// `supportsBoard` is derived, so a reconnect's identical feature list does not recreate the board.
	$effect(() => {
		const id = projectId;
		if (id.length === 0 || !supportsBoard) {
			board = undefined;
			return;
		}
		const created = backend.watchBoard(id);
		board = created;
		return () => {
			created.stop();
			if (board === created) board = undefined;
		};
	});

	$effect(() => {
		const id = projectId;
		if (id.length === 0 || !supportsRefStatus) {
			refStatus = undefined;
			return;
		}
		const created = new ProjectRefStatus(backend.client, id);
		refStatus = created;
		return () => {
			created.stop();
			if (refStatus === created) refStatus = undefined;
		};
	});

	$effect(() => {
		refStatus?.want((board?.tasks ?? []).flatMap((task) => taskRefs(task)));
	});

	// `supportsThreads` is derived, so a reconnect's identical feature list does not recreate the list.
	$effect(() => {
		const id = projectId;
		if (id.length === 0 || !supportsThreads) {
			threads = undefined;
			return;
		}
		const created = backend.watchThreads(id);
		threads = created;
		return () => {
			created.stop();
			if (threads === created) threads = undefined;
		};
	});

	function openBoard(): void {
		sidebarTab = 'board';
		sidebarOpen = true;
		sidebarExpanded = false;
	}

	// `supportsSchedules` is derived, so a reconnect's identical feature list does not recreate the list.
	$effect(() => {
		const id = projectId;
		if (id.length === 0 || !supportsSchedules) {
			schedules = undefined;
			return;
		}
		const created = backend.watchSchedules(id);
		schedules = created;
		return () => {
			created.stop();
			if (schedules === created) schedules = undefined;
		};
	});

	function scheduleTitle(scheduleId: string): string | undefined {
		return schedules?.title(scheduleId);
	}

	/** The memories a compaction saved: read from the scope histories the Memory tab already holds, never a request. */
	function extractionFor(entryId: number): MemoryExtraction | undefined {
		if (memory === undefined || !memory.maintenanceEnabled) return undefined;
		// Only the shown scope's files are loaded, so a topic in the other scope shows its file ID until it is opened.
		const filesOf = (scope: MemoryScope) => (memory?.scope === scope ? memory.files : []);
		return memoryExtractionFor(
			[
				{ scope: 'global', changes: memory.history.global, files: filesOf('global') },
				{ scope: 'project', changes: memory.history.project, files: filesOf('project') }
			],
			entryId
		);
	}

	/** A topic a compaction saved opens in the Memory tab, in the scope it was written in. */
	function openMemoryTopic(fileId: string, scope: MemoryScope): void {
		sidebarTab = 'memory';
		sidebarOpen = true;
		sidebarExpanded = false;
		void memory?.open(fileId, scope);
	}

	/** Undo takes the whole extraction commit; the row or the marker says why when it is refused. */
	function undoMemory(scope: MemoryScope, commit: string): void {
		void memory?.undo(scope, commit);
	}

	function undoErrorFor(commit: string): string | undefined {
		return memory?.undoError?.commit === commit ? memory.undoError.message : undefined;
	}

	// A reply push and a compaction history link both name a transcript entry.
	$effect(() => {
		const current = session;
		const id = replyAnchor;
		if (!id || !current || !items.length) return;
		const frame = requestAnimationFrame(() => document.getElementById(`entry-${id}`)?.scrollIntoView({ block: 'center' }));
		return () => cancelAnimationFrame(frame);
	});

	$effect(() => {
		const id = peerAnchor;
		const current = session;
		if (!id || !current || current.status !== 'live' || !peerMessages?.has(id)) return;
		let cancelled = false;
		void (async () => {
			while (!cancelled) {
				await new Promise(requestAnimationFrame);
				if (cancelled) return;
				const card = document.getElementById(threadMessageAnchor(id));
				if (card) { card.scrollIntoView({ block: 'center' }); return; }
				if (!current.canLoadEarlier || current.loadingEarlier) return;
				const count = current.entries.length;
				try { await loadEarlier(); } catch { return; }
				if (current.entries.length <= count) return;
			}
		})();
		return () => { cancelled = true; };
	});

	/**
	 * A notification about a background job opens main at `#thread-<id>`: scroll its newest card into view and make
	 * it glow. A card older than the loaded window is paged in, a few pages at most.
	 */
	let highlightedThread = $state<string | undefined>(undefined);
	$effect(() => {
		if (isThread) return;
		const jump = (): void => {
			const target = threadFromAnchor(window.location.hash);
			if (target !== undefined) highlightedThread = target;
		};
		jump();
		window.addEventListener('hashchange', jump);
		return () => window.removeEventListener('hashchange', jump);
	});
	$effect(() => {
		const target = highlightedThread;
		const current = session;
		if (target === undefined || current === undefined || current.status !== 'live') return;
		let cancelled = false;
		let pages = 0;
		const find = async (): Promise<void> => {
			while (!cancelled) {
				await new Promise((resolve) => requestAnimationFrame(resolve));
				const cards = document.querySelectorAll<HTMLElement>(`[data-thread-card="${CSS.escape(target)}"]`);
				const card = cards[cards.length - 1];
				if (card !== undefined) {
					card.scrollIntoView({ block: 'center', behavior: 'smooth' });
					card.classList.remove('thread-glow');
					void card.offsetWidth;
					card.classList.add('thread-glow');
					setTimeout(() => card.classList.remove('thread-glow'), 2600);
					break;
				}
				if (!current.canLoadEarlier || pages >= 4) break;
				pages += 1;
				await current.loadEarlier();
			}
			if (!cancelled) highlightedThread = undefined;
		};
		void find();
		return () => {
			cancelled = true;
		};
	});

	function toggleSidebar(target: SidebarTab): void {
		if (sidebarOpen && sidebarTab === target) {
			sidebarOpen = false;
			sidebarExpanded = false;
			return;
		}
		sidebarTab = target;
		sidebarOpen = true;
		// Tasks open the way this device last looked at them: the list beside the chat, or the board full width.
		sidebarExpanded = target === 'board' && supportsTasks && tasksView.mode !== 'list';
	}

	/** The task sheet's "Show with linked": the task list, filtered to that task and everything linked to it. */
	function showLinkedTasks(taskId: string): void {
		taskFilter.focusOn(taskId);
		sidebarTab = 'board';
		sidebarOpen = true;
		sidebarExpanded = supportsTasks && tasksView.mode !== 'list';
	}

	/** A reason for a move on a backend whose saves carry no note: it goes to main as a message about the task. */
	async function sendTaskReason(taskId: string, text: string): Promise<void> {
		await backend.client.submit(projectId, text, { whenBusy: 'steer', taskId });
	}

	function workerLink(worker: { id: string; threadId?: string }): string {
		return workerHref(backend.id, projectId, worker.id, worker.threadId === 'main' ? undefined : worker.threadId ?? threadId);
	}

	function taskLink(taskId: string): string {
		return withTask(page.url, taskId);
	}

	/** Text selected in the transcript or a task, quoted in the message being written. */
	function quote(text: string): void {
		composer?.addQuote(text);
	}

	async function send(text: string, taskId?: string, images: HeldImage[] = [], files: ChatFile[] = []): Promise<boolean> {
		const body = text.trim();
		if (body.length === 0 && images.length === 0 && files.length === 0) return true;
		if (!canChat) {
			sendError = 'Choose a main chat model in the composer before sending.';
			return false;
		}
		if (!canSend) {
			sendError = 'The backend connection is not ready; waiting to reconnect.';
			return false;
		}
		sendError = undefined;
		transcript?.follow();
		// The pick rides on the message until the backend confirms it stores one; without a loaded list it would clear the
		// choice another device made.
		const defaults =
			!isThread && !usesProjectWorkerDefault && workers !== undefined && shouldSendWorkerDefaults(workers.loaded, workers.defaultsSupport)
				? workers.defaults
				: undefined;
		try {
			// Reaches a busy coordinator at its next tool boundary instead of waiting for the whole turn to end, so the
			// user is never stuck behind a long-running tool call.
			const options = {
				whenBusy: 'steer' as const,
				...(threadId === undefined ? {} : { threadId }),
				...(defaults === undefined
					? {}
					: { workerModel: defaults.model, workerThinkingLevel: defaults.thinkingLevel }),
			};
			if (waiting?.supported === true) {
				// A failure stays on the message's own bubble with its text and a Retry, not in the composer.
				await waiting.send(body, taskId, { ...options, fileIds: files.map(file => file.id) }, images, files);
				return true;
			}
			await backend.client.submit(projectId, inputContent(body, images), { ...options, fileIds: files.map(file => file.id), ...(taskId === undefined ? {} : { taskId }) });
			return true;
		} catch (error) {
			sendError = errorText(error);
			return false;
		}
	}

	async function stop(): Promise<void> {
		aborting = true;
		sendError = undefined;
		try {
			await backend.client.abort(projectId, threadId === undefined ? {} : { threadId });
		} catch (error) {
			sendError = errorText(error);
		} finally {
			aborting = false;
		}
	}

	async function loadEarlier(): Promise<void> {
		const current = session;
		await current?.loadEarlier();
		if (current?.watch.earlierError) throw new Error(current.watch.earlierError);
	}

	/** Changing the model drops a thinking level the new model does not offer. */
	async function changeModel(model: ModelInfo): Promise<void> {
		if (project === undefined) return;
		modelError = undefined;
		const level = project.coordinator.thinkingLevel;
		const keep = level !== null && model.thinkingLevels.includes(level);
		try {
			await backend.configureProject(projectId, {
				coordinatorModel: { provider: model.provider, modelId: model.modelId },
				...(keep ? {} : { coordinatorThinkingLevel: null }),
			});
		} catch (error) {
			modelError = errorText(error);
		}
	}

	async function changeThinkingLevel(level: ThinkingLevel | null): Promise<void> {
		modelError = undefined;
		try {
			await backend.configureProject(projectId, { coordinatorThinkingLevel: level });
		} catch (error) {
			modelError = errorText(error);
		}
	}

	/**
	 * The worker picker is optimistic and saves at once (`workers.defaults.set`); a backend from before that request
	 * keeps the choice on the next message instead. The server pushes the stored choice back to every device.
	 */
	function changeWorkerModel(model: ModelInfo | null): void {
		if (workers === undefined) return;
		const level = workerDefaults.thinkingLevel;
		const keep = model !== null && level !== null && model.thinkingLevels.includes(level);
		void workers.pick(
			model === null ? null : { provider: model.provider, modelId: model.modelId },
			keep ? level : null
		);
	}

	function changeWorkerThinking(level: ThinkingLevel | null): void {
		if (usesProjectWorkerDefault && workerDefaults.model === null) return;
		void workers?.pick(workerDefaults.model, level);
	}
</script>

{#snippet emptyState()}
	{#if coordinatorChat}
		<EmptyState title={(archivedCoordinator ? thread : viewingCoordinator)?.title ?? 'General'}
			subtitle={archivedCoordinator ? 'This coordinator is archived.' : 'Send a message to start this chat.'} />
	{:else if isThread}
		<EmptyState
			title={thread?.title || 'Background job'}
			subtitle={supportsCoordinators ? `A background job. It reports to ${viewingCoordinator?.title ?? 'General'} when it finishes.` : 'A background job. It reports to Main chat when it finishes; type here to steer it directly.'}
		/>
	{:else}
		<EmptyState
			title={project?.name ?? 'Ready'}
			subtitle="Send a message to start the coordinator. It plans, delegates and reviews."
		/>
	{/if}
{/snippet}

{#snippet threadArtifacts(id: string, finishedAt: number | undefined)}
	{#if backend.supports('artifacts')}
		<ArtifactStrip {backend} {projectId} filters={{ threadId: id }} savedUntil={finishedAt} class="mt-2" />
	{/if}
{/snippet}

{#snippet headerButton(action: HeaderAction)}
	{@const labelled = headerActionShowsLabel(headerRowLayout, action)}
	{@const badgeClass =
		'header-panel-badge grid min-w-4 place-items-center rounded-full px-1 text-[0.625rem] font-semibold'}
	<Button
		variant="ghost"
		size={labelled ? 'sm' : 'icon-sm'}
		class={`${action.kind === 'tab' ? 'header-panel-action' : 'aria-pressed:bg-muted aria-pressed:text-foreground'} ${labelled ? 'shrink-0' : 'relative shrink-0'}`}
		href={action.href}
		onclick={action.onclick}
		aria-label={action.name}
		title={action.title ?? action.name}
		aria-pressed={action.pressed}
	>
		<action.icon class="size-4" />
		{#if action.id === 'background'}
			<span class="inline-flex gap-1 text-[0.625rem] font-semibold" aria-hidden="true">
				<span class="rounded-full bg-(--chat-warning)/10 px-1 text-(--chat-warning)">{jobCounts.needsYou}</span>
				<span class="rounded-full bg-(--chat-surface-2) px-1 text-(--chat-fg-muted)">{jobCounts.working}</span>
			</span>
		{:else if action.count !== undefined}
			<span
				class={labelled ? `h-4 ${badgeClass}` : `absolute -top-0.5 -right-0.5 ${badgeClass}`}
			>
				{action.count}
			</span>
		{/if}
		{#if labelled && action.label}{action.label}{/if}
	</Button>
{/snippet}

{#snippet headerMenuRow(action: HeaderAction)}
	<Button
		variant="ghost"
		size="sm"
		class={`h-8 w-full justify-start gap-2 px-2 font-normal ${action.kind === 'tab' ? 'header-panel-action' : 'aria-pressed:bg-muted aria-pressed:text-foreground'}`}
		href={action.href}
		onclick={() => pickHeaderAction(action)}
		aria-label={action.name}
		aria-pressed={action.pressed}
	>
		<action.icon class="size-4 shrink-0" />
		<span class="min-w-0 flex-1 truncate text-left">{action.menuLabel ?? action.label ?? action.name}</span>
		{#if action.id === 'background'}
			<span class="inline-flex gap-1 text-[0.625rem] font-semibold" aria-hidden="true">
				<span class="rounded-full bg-(--chat-warning)/10 px-1 text-(--chat-warning)">{jobCounts.needsYou}</span>
				<span class="rounded-full bg-(--chat-surface-2) px-1 text-(--chat-fg-muted)">{jobCounts.working}</span>
			</span>
		{:else if action.count !== undefined}
			<span
				class="header-panel-badge grid min-w-4 place-items-center rounded-full px-1 text-[0.625rem] font-semibold"
			>
				{action.count}
			</span>
		{/if}
	</Button>
{/snippet}

<div class="flex h-full w-full overflow-hidden">
	<div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
			<header
				class="relative z-10 flex {CHAT_COLUMN_CLASS} shrink-0 flex-col gap-0.5 px-2 pt-[max(0.5rem,env(safe-area-inset-top))] pb-1 sm:px-3"
			>
				<div class="flex min-h-12 min-w-0 items-center gap-1 sm:h-12" bind:this={headerRow}>
					<ProjectsMenuButton />
					{#if isThread}
						<Button
							href={projectHref(backend.id, projectId)}
							variant="ghost"
							size="icon-sm"
							onclick={(event) => conversationBack(event, projectHref(backend.id, projectId))}
							aria-label={supportsCoordinators ? `Back to ${roster[0]?.title ?? 'General'}` : 'Back to Main chat'}
							title={supportsCoordinators ? `Back to ${roster[0]?.title ?? 'General'}` : 'Back to Main chat'}
						>
							<ArrowLeftIcon />
						</Button>
					{/if}
					{#if supportsThreads}
						<ConversationSwitcher roster={supportsCoordinators ? roster : undefined} {seen} onnew={() => manager = 'new'} onalltasks={showAllTasks} onmanage={() => manager = 'manage'} projectName={project?.name ?? 'Project'} backendId={backend.id} {projectId} {threadId} threads={threadList} questions={board?.board?.questions ?? []} {now} counts={jobCounts} onshowall={() => { sidebarTab = 'background'; sidebarOpen = true; }} />
					{:else}
						<h1 class="min-w-0 flex-1 truncate px-1.5 text-[0.9375rem] font-semibold">{isThread ? thread?.title || threadId : project?.name ?? 'Project'}</h1>
					{/if}
					{#each shownTabActions as action (action.id)}
						{@render headerButton(action)}
					{/each}
					{#if headerRowLayout !== 'menu'}
						<ConnectionBadge {backend} />
					{:else}
						<!-- The rest of the row, one tap away: every tab but the board and the workers, the bell and the gear. -->
						<Popover.Root bind:open={headerMenuOpen}>
							<Popover.Trigger
								class="relative inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-muted aria-expanded:text-foreground"
								aria-label="More actions"
								title="More actions"
							>
								<EllipsisIcon class="size-4" />
								{#if connectionTone !== 'ok'}
									<span class="absolute top-1 right-1 size-1.5 rounded-full {connectionDotClass(connectionTone)}"></span>
								{/if}
							</Popover.Trigger>
							<Popover.Content side="bottom" align="end" class="w-60 gap-1 p-1">
								{#each shownHeaderActions.menu as action (action.id)}
									{@render headerMenuRow(action)}
								{/each}
								<Separator class="my-1" />
								<div class="flex flex-col items-start gap-1 px-2 py-1 text-xs text-(--chat-fg-subtle)">
									<ConnectionBadge {backend} />
									{#if backend.supports('server-status') && backend.status?.release !== undefined}
										<ReleaseLine release={backend.status.release} deploy={backend.status.deploy} compact />
									{/if}
								</div>
							</Popover.Content>
						</Popover.Root>
					{/if}
					{#each shownUtilityActions as action (action.id)}
						{@render headerButton(action)}
					{/each}
				</div>
				{#if !isThread && !supportsCoordinators}
					<div class="flex min-w-0 items-center gap-x-2 overflow-hidden px-2 text-xs text-(--chat-fg-subtle)">
						<span class="min-w-0 truncate">Main chat · {backend.name}</span>
						{#if project}
							<span class="shrink-0">·</span>
							<span class="min-w-0 truncate">{modelLabel(project.coordinator.model, backend.models)}</span>
						{/if}
						{#if runningToolLabel !== undefined}
							<span class="shrink-0">·</span>
							<span class="min-w-0 truncate text-(--chat-fg-muted)" title="The coordinator's current tool call"
								>{runningToolLabel}</span
							>
						{/if}
						<!-- The release is in the menu on a phone: the line stays one line, and its commit is still one tap away. -->
						{#if headerRowLayout !== 'menu' && backend.supports('server-status') && backend.status?.release !== undefined}
							<span class="shrink-0">·</span>
							<ReleaseLine release={backend.status.release} deploy={backend.status.deploy} compact class="shrink-0" />
						{/if}
						{#if session && session.status !== 'live'}
							<span class="shrink-0">·</span>
							<span class="text-(--chat-warning)">{session.status}</span>
						{/if}
					</div>
				{/if}
				{#if coordinatorChat && (viewingCoordinator || archivedCoordinator)}
					{@const chatCoordinator = archivedCoordinator ? thread : viewingCoordinator}
					<div class="flex min-w-0 items-center gap-2 rounded-lg border border-(--chat-border) px-2.5 py-1 text-xs" style:background={`color-mix(in srgb, ${coordinatorColor(chatCoordinator)} 8%, var(--chat-bg))`}>
						<span class="min-w-0 flex-1 truncate text-(--chat-fg-muted)" title={chatCoordinator?.area}>{chatCoordinator?.area || 'No area set'}</span>
						{#if chatCoordinator && !archivedCoordinator}<button class="shrink-0 rounded px-1 py-1 font-medium text-(--accent-2) hover:underline" onclick={() => manager = chatCoordinator}>Edit area</button>{:else}<span>Archived</span>{/if}
					</div>
				{/if}
				{#if roster.length > 1}
					<nav aria-label="Coordinators" class="flex min-w-0 gap-1.5 overflow-x-auto overscroll-x-contain px-0.5 py-1.5 [scrollbar-width:thin]">
						{#each roster as row, index (row.id)}
							{@const here = row.id === (threadId ?? 'main')}
							<a href={coordinatorHref(backend.id, projectId, row.id)} aria-current={here ? 'page' : undefined} aria-keyshortcuts={index < 9 ? `Alt+${index + 1}` : undefined}
								class="flex shrink-0 items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-semibold hover:bg-(--chat-surface-2)" style:border-color={here ? coordinatorColor(row) : 'var(--chat-border)'}>
								<CoordinatorMark thread={row} />{row.title}<CoordinatorBadges thread={row} seen={seen(row.id)} />
							</a>
						{/each}
						<button class="shrink-0 rounded-lg border border-dashed border-(--chat-border) px-2 text-xs font-semibold text-(--chat-fg-muted) hover:bg-(--chat-surface-2)" aria-label="New coordinator" onclick={() => manager = 'new'}>+ New</button>
					</nav>
				{/if}
			</header>
			{#if isThread && thread && threads && !coordinatorChat}
				<BackgroundJobBand {thread} {threads} {board} {now} projectName={project?.name ?? 'Project'} mainHref={supportsCoordinators ? coordinatorHref(backend.id, projectId, coordinatorId) : projectHref(backend.id, projectId)}
					parentTitle={supportsCoordinators ? viewingCoordinator?.title ?? 'General' : undefined} scheduleName={thread.scheduleId ? scheduleTitle(thread.scheduleId) : undefined} />
			{/if}

				{#key session}
				<TranscriptColumn
					bind:this={transcript}
					{items}
					messageLinks={peerLinks} viewingThread={threadId ?? 'main'} messageAnchor={peerAnchor}
					cwd={project?.path}
					workers={workerList}
					workerHref={(worker) => workerLink(worker)}
					scheduleName={scheduleTitle}
					reportHref={(workerId) => workerHref(backend.id, projectId, workerId, threadId)}
					{threadCards}
					canLoadEarlier={session?.canLoadEarlier ?? false}
					loadingEarlier={session?.loadingEarlier ?? false}
					onLoadEarlier={loadEarlier}
					{working}
					running={busy}
					{waitingForUser}
					connected={session?.status === 'live'}
				runFailed={live?.runFailure !== undefined}
					{extractionFor}
					onopentopic={openMemoryTopic}
					onopenboard={supportsBoard ? openBoard : undefined}
					onundo={undoMemory}
					{undoErrorFor}
					empty={empty ? emptyState : undefined}
					onquote={backend.supports('conversation') ? quote : undefined}
					onwaiting={onWaiting}
					waitingTarget={isThread ? 'thread' : 'coordinator'}
				/>
				{/key}

				<div class="{CHAT_COLUMN_CLASS} shrink-0 px-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] sm:px-4 sm:pb-4">
					<div class="mb-2 flex flex-col gap-2">
						{#if backend.supports('server-status')}
							<DeployBanner
								status={backend.status}
								dismissed={harness.dismissedDeploys}
								ondismiss={(deploy) => harness.dismissDeploy(deploy)}
							/>
							<DiskBanner
								status={backend.status}
								settingsHref={backend.supports('storage') ? projectAdvancedHref(backend.id, projectId, 'storage') : undefined}
							/>
						{/if}

						{#if backend.lastError}
							<Banner tone="error">{backend.lastError}</Banner>
						{/if}

						{#if !backend.supports('conversation')}
							<Banner tone="warning">This backend does not advertise conversations.</Banner>
						{/if}

						{#if project?.archived === true}
							<ArchivedBanner {backend} {projectId} />
						{/if}

						{#if project?.state === 'failed'}
							<Banner tone="error">{project.failure ?? 'The project failed to open.'}</Banner>
						{/if}

						{#if !isThread && project !== undefined && project.coordinator.model === null && backend.supports('models')}
							<Banner tone="warning">
								This project has no model for the main chat. Pick one in the composer, or
								<a class="underline" href={projectSettingsHref(backend.id, project.id, 'coordinator')}>choose one in settings</a>, before sending
								a message.
							</Banner>
						{/if}

						{#if session && session.status !== 'live'}
							<Banner tone="warning">
								{#if session.status === 'connecting'}
									Connecting to the transcript…
								{:else if session.status === 'reconnecting'}
									Reconnecting to the transcript…{session.error ? ` ${session.error}` : ''}
								{:else if session.status === 'ended'}
									The transcript view stopped.{session.error ? ` ${session.error}` : ''}
								{:else}
									The transcript view is stopped.
								{/if}
							</Banner>
						{/if}

						{#if modelError}
							<Banner tone="error">{modelError}</Banner>
						{/if}
						{#if workers?.defaultsError}
							<Banner tone="error">{workers.defaultsError}</Banner>
						{/if}
						{#if sendError}
							<Banner tone="error">{sendError}</Banner>
						{/if}
						{#if (!isThread || coordinatorChat) && board !== undefined && hasOpenQuestions && !(sidebarOpen && sidebarTab === 'board')}
							<BoardQuestionPin
								{board}
								threads={threadList}
								{threadId}
								coordinatorId={coordinatorChat ? coordinatorId : undefined}
								tasksView={supportsTasks}
								taskHref={supportsTasks ? taskLink : undefined}
								onopenboard={openBoard}
							/>
						{/if}
						{#if coordinatorChat && questionCounts.length}
							<div class="flex flex-wrap gap-x-3 px-2 pt-1 text-xs text-(--chat-fg-muted)">
								{#each questionCounts as { row, count } (row.id)}<a class="hover:underline" href={coordinatorHref(backend.id, projectId, row.id)}>{count} more {count === 1 ? 'question' : 'questions'} in {row.title} →</a>{/each}
							</div>
						{/if}
					</div>

					{#if backend.supports('conversation')}
						<!-- Keyed by chat: the page stays mounted when the route changes to another project or thread. -->
						{#key draftKey(backend.id, projectId, threadId)}
						{#if discussionNotice}<p role="status" class="px-3 pb-2 text-xs text-(--chat-fg-muted)">{discussionNotice}</p>{/if}
						<Composer
							bind:this={composer}
							draftKey={draftKey(backend.id, projectId, threadId)}
							draftChannel={draftChannel(backend, projectId, threadId)}
							discussionChat={isThread ? undefined : { backend, projectId }}
							models={backend.models}
							providers={backend.providers}
							model={project?.coordinator.model ?? null}
							thinkingLevel={project?.coordinator.thinkingLevel ?? null}
							{thinkingLevels}
							workerModels={backend.models}
							workerProviders={backend.providers}
							projectWorkerModels={project?.workerModels ?? []}
							{usesProjectWorkerDefault}
							workerSettingsHref={projectSettingsHref(backend.id, projectId, 'workers')}
							workerModel={workerDefaults.model}
							workerThinkingLevel={workerDefaults.thinkingLevel}
							showWorkerPicker={supportsWorkers && canPickModel && !isThread}
							showModelPicker={!isThread}
							modelNote={isThread && thread?.model ? `Runs on ${modelLabel(thread.model, backend.models)}` : undefined}
							workerPickerDisabled={workers?.loaded !== true}
							tasks={taskChoices}
							busy={busy || aborting}
							disabled={!canSend}
							placeholder={!canChat
								? 'Choose a main chat model first'
								: !backend.ready
									? 'Reconnecting…'
									: archivedCoordinator ? 'This coordinator is archived'
									: coordinatorChat ? `Message ${viewingCoordinator?.title ?? 'General'}…`
									: isThread
										? 'Message this background job…'
										: undefined}
							onModelChange={changeModel}
							onThinkingChange={changeThinkingLevel}
							onWorkerModelChange={changeWorkerModel}
							onWorkerThinkingChange={changeWorkerThinking}
							uploadFile={backend.supports('chat-files-v1') ? uploadFile : undefined}
							onsend={send}
							onstop={stop}
						/>
						{/key}
						{#if isThread && !coordinatorChat}<p class="px-3 pb-1 text-xs text-(--chat-fg-subtle)" data-job-steering-note>{supportsCoordinators ? `${viewingCoordinator?.title ?? 'General'} sees only the job’s report.` : "The main chat does not see what you write here, only the job's report."}</p>{/if}
					{/if}
				</div>
			</div>

			{#if supportsSidebar}
				<ConversationSidebar
					bind:open={sidebarOpen}
					bind:tab={sidebarTab}
					bind:expanded={sidebarExpanded}
					tabs={sidebarTabs}
					labels={{ board: boardTabName }}
					label="Project sidebar"
				>
					{#snippet boardPanel(fullWidth: boolean)}
						<div class="@container/peer-panel flex min-h-0 flex-1 flex-col">
						{#if supportsAssignment && roster.length > 1}
							<div class="shrink-0 space-y-2 border-b border-(--chat-border) px-3 py-2">
								<div class="flex gap-1 rounded-lg bg-(--chat-surface-2) p-1" role="group" aria-label="Task scope">
									{#each [{ id: 'coordinator', label: 'This coordinator' }, { id: 'all', label: 'All coordinators' }] as option (option.id)}
										<button class="flex-1 rounded-md px-2 py-1.5 text-xs font-semibold {taskScope === option.id ? 'bg-(--chat-bg) shadow-sm' : 'text-(--chat-fg-muted)'}" aria-pressed={taskScope === option.id} onclick={() => setTaskScope(option.id === 'all' ? 'all' : 'coordinator')}>{option.label}</button>
									{/each}
								</div>
								{#if taskScope === 'all'}<div class="flex flex-wrap gap-1" role="group" aria-label="Filter by coordinator">
									{#each roster as row (row.id)}<button aria-pressed={!hiddenCoordinators.has(row.id)} class="flex items-center gap-1 rounded-lg border border-(--chat-border) px-1.5 py-0.5 text-xs aria-pressed:bg-(--chat-surface-2) aria-pressed:text-(--chat-fg) text-(--chat-fg-subtle)" onclick={() => { const next = new Set(hiddenCoordinators); if (!next.delete(row.id)) next.add(row.id); hiddenCoordinators = next; }}><CoordinatorMark thread={row} />{row.title}</button>{/each}
								</div>{/if}
							</div>
						{/if}
						{#if taskScope === 'all' && supportsPeerMessages}
							<div class="flex shrink-0 gap-2 border-b border-(--chat-border) px-3 py-2 text-xs @min-[54rem]/peer-panel:hidden" role="group" aria-label="All coordinators view">
								<button class="rounded-md px-2 py-1 aria-pressed:bg-(--chat-surface-2) aria-pressed:font-semibold" aria-pressed={!peerPanel} onclick={() => peerPanel = false}>Tasks</button>
								<button class="rounded-md px-2 py-1 aria-pressed:bg-(--chat-surface-2) aria-pressed:font-semibold" aria-pressed={peerPanel} onclick={() => peerPanel = true}>Between coordinators</button>
							</div>
						{/if}
						<div class="flex min-h-0 flex-1">
						<div class="min-w-0 flex-1 flex-col {taskScope === 'all' && supportsPeerMessages && peerPanel ? 'hidden @min-[54rem]/peer-panel:flex' : 'flex'}">
						{#if supportsTasks && fullWidth}
							<TasksView
								{board}
								workers={panelWorkers}
								graphWorkers={supportsAssignment ? panelWorkers : workers?.allWorkers ?? []}
								selectedTaskId={taskFromUrl(page.url)}
								scope={`${backend.id}:${projectId}`}
								backendId={backend.id}
								{projectId}
								threads={threadList}
								workerHref={(worker) => workerLink(worker)}
								taskHref={taskLink}
								canNote={backend.supports('board-moves')}
								onsendreason={backend.supports('conversation') ? sendTaskReason : undefined}
							/>
						{:else if supportsTasks}
							<TasksPanel {board} threads={threadList} workers={panelWorkers} workerHref={(worker) => workerLink(worker)} taskHref={taskLink} />
						{:else}
							<BoardPanel {board} workers={workerList} threads={threadList} hrefOf={(worker) => workerLink(worker)} />
						{/if}
						</div>
						{#if taskScope === 'all' && peerLog}
							<aside class="min-w-0 flex-1 overflow-y-auto @min-[54rem]/peer-panel:block @min-[54rem]/peer-panel:w-72 @min-[54rem]/peer-panel:flex-none @min-[54rem]/peer-panel:border-l @min-[54rem]/peer-panel:border-(--chat-border) {peerPanel ? 'block' : 'hidden'}">
								{@render peerFeed()}
							</aside>
						{/if}
						</div>
						{#if supportsAssignment && taskScope === 'coordinator' && otherAttention}
							<p class="shrink-0 border-t border-(--chat-border) px-3 py-2 text-xs text-(--chat-fg-muted)">{otherAttention} need attention in other coordinators · <button class="font-semibold text-(--accent-2) hover:underline" onclick={showAllTasks}>Show all</button></p>
						{/if}
						</div>
					{/snippet}
					{#snippet backgroundPanel()}
						<BackgroundPanel
							{threads}
							currentThreadId={threadId}
							parentCoordinatorId={supportsCoordinators ? coordinatorId : undefined}
							questions={board?.board?.questions ?? []}
							hrefOf={(id) => threadHref(backend.id, projectId, id)}
							scheduleName={scheduleTitle}
							{now}
						/>
					{/snippet}
					{#snippet infoPanel()}
						<ContextPanel
							context={projectContext?.context}
							loaded={projectContext?.loaded ?? false}
							error={projectContext?.error}
							canCompact={project !== undefined &&
								project.coordinator.model !== null &&
								backend.supports('conversation')}
							compacting={projectContext?.compacting ?? false}
							compactError={projectContext?.compactError}
							oncompact={(instructions) => projectContext?.compact(instructions)}
						/>
					{/snippet}
					{#snippet memoryPanel()}
						<MemoryPanel {memory} sharedByCoordinators={backend.supports('coordinators')} showCoordinatorWriters={backend.supports('memory-notes')} hrefForProject={(id) => projectHref(backend.id, id)} />
					{/snippet}
			</ConversationSidebar>
		{/if}
	</div>

	<RefCardHost
		readDetails={backend.supports('ref-details') ? (ref) => backend.client.readRefDetails(projectId, ref) : undefined}
		tasks={() => board?.tasks ?? []}
	/>

	{#if supportsTasks}
		<TaskCloseDialog {board} />
		<TaskSheet peerMessages={peerLog} {peerLinks} {backend} {projectId} projectName={project?.name} {board} workers={workerList} threads={threadList} workerHref={(worker) => workerLink(worker)} onquote={backend.supports('conversation') ? quote : undefined} onshowlinked={showLinkedTasks} />
	{/if}

<FilesHost {backend} {projectId} projectName={project?.name ?? 'Project'} navigation={filesNavigation} repository={project?.repository} workers={workerList} threads={threadList} {threadId} onquote={backend.supports('conversation') ? quote : undefined} />

<ChangesHost {backend} {projectId} projectName={project?.name ?? 'Project'} repository={project?.repository} {board} navigation={filesNavigation} {threadId} workers={workerList} threads={threadList} />

<style>
	/* Scoped to panel actions: utility toggles retain their own pressed state. */
	:global(.header-panel-action) {
		color: var(--chat-fg-muted);
		border-radius: 999px;
	}
	:global(.header-panel-action[aria-pressed='true']) {
		color: light-dark(#4338ca, #c7d2fe);
		background: light-dark(#e0e7ff, #312e81);
	}
	:global(.header-panel-action[aria-pressed='true']:hover) {
		background: light-dark(#c7d2fe, #3730a3);
	}
	:global(.header-panel-badge) {
		color: light-dark(#ffffff, #0b0b14);
		background: light-dark(#4f46e5, #818cf8);
	}
	:global([data-theme='neutral'] .header-panel-action[aria-pressed='true']) {
		color: light-dark(#171717, #fafafa);
		background: light-dark(#d4d4d4, #404040);
	}
	:global([data-theme='neutral'] .header-panel-action[aria-pressed='true']:hover) {
		background: light-dark(#bfbfbf, #525252);
	}
	:global([data-theme='neutral'] .header-panel-badge) {
		color: var(--primary-foreground);
		background: var(--primary);
	}
</style>

<svelte:window onkeydown={coordinatorKeys} />
{#if manager && threads && supportsCoordinators}
	{#key manager}
		<CoordinatorManager messages={peerLog ? peerFeed : undefined} mode={manager} store={threads} {roster} tasks={board?.tasks ?? []} models={backend.models.filter(model => !model.workerOnly && model.configured)}
			onclose={() => manager = undefined} oncreated={id => { manager = undefined; switchCoordinator(id); }}
			onarchived={id => { const key = coordinatorStorageKey(backend.id, projectId, 'last'); if (readCoordinatorPreference(key) === id) projectsNav.rememberCoordinator(key, 'main'); if (threadId === id) { manager = undefined; switchCoordinator('main'); } }} />
	{/key}
{/if}

{#snippet peerFeed()}
	{#if peerLog}<ThreadMessagesFeed messages={peerLog.messages} links={peerLinks} loaded={peerLog.loaded} error={peerLog.error} />{/if}
{/snippet}
