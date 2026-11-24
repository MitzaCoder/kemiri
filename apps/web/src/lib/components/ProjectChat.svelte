<script lang="ts">
	import { provideProjectApps, useProjectApps } from '#lib/agent-apps.svelte.js';
	import { appCountLabel, appCounts } from '#lib/agent-apps.js';
	import RunningApps from '#lib/components/apps/RunningApps.svelte';
	import { rememberConversationView, conversationBack } from "#lib/conversation-navigation.svelte.js";
	import { agentWaitingForUser } from '#lib/agent-activity.js';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import BellOffIcon from '@lucide/svelte/icons/bell-off';
	import PanelsTopLeftIcon from '@lucide/svelte/icons/panels-top-left';
	import GitCompareArrowsIcon from '@lucide/svelte/icons/git-compare-arrows';
	import BookOpenIcon from '@lucide/svelte/icons/book-open';
	import ProjectMuteMenu from '#lib/components/alerts/ProjectMuteMenu.svelte';
	import LayersIcon from '@lucide/svelte/icons/layers';
	import PanelRightIcon from '@lucide/svelte/icons/panel-right';
	import ClipboardListIcon from '@lucide/svelte/icons/clipboard-list';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import PaperclipIcon from '@lucide/svelte/icons/paperclip';
	import ProjectArtifactsPanel from '#lib/components/artifacts/ProjectArtifactsPanel.svelte';
	import InfoIcon from '@lucide/svelte/icons/info';
	import SettingsIcon from '@lucide/svelte/icons/settings';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import { onMount, untrack, type Component } from 'svelte';
	import { countWorkersOutsideModels, PROJECT_WORKER_MODELS } from '#lib/workers.js';
	import { page } from '$app/state';
	import { projectsNav } from '#lib/projects-nav.svelte.js';
	import { getCoordinatorCreation } from '#lib/coordinator-creation.js';
	import { goto } from '$app/navigation';
	import CoordinatorMark from './CoordinatorMark.svelte';
	import type { ProjectThreadMessages } from '#lib/thread-messages.svelte.js';
	import { threadMessageHref, threadMessageAnchor, type ThreadMessageLinks } from '#lib/thread-messages.js';
	import ThreadMessagesFeed from './ThreadMessagesFeed.svelte';
	import LandingTurn from './LandingTurn.svelte';
	import { landingTurnPresentation, provideLandingTurn } from '#lib/landing-turn.js';
	import CoordinatorManager from './CoordinatorManager.svelte';
	import { coordinatorBadges, coordinatorHref, coordinatorOfThread, coordinatorRoster, coordinatorShortcut, coordinatorStorageKey, readCoordinatorPreference, saveCoordinatorPreference, scopedQuestions, scopedTasks } from '#lib/coordinators.js';
	import { provideCoordinatorTaskView } from '#lib/coordinator-task-view.js';
	import type { ThreadSummary, ThreadsUpdateRequest } from '@kemiri/protocol';
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
	import BookmarkIcon from '@lucide/svelte/icons/bookmark';
	import AnswersPanel from '#lib/components/answers/AnswersPanel.svelte';
	import { answerFromUrl, answersByReply, answersSupported } from '#lib/answers.js';
	import type { ProjectAnswers } from '#lib/answers.svelte.js';
	import type { Answer } from '@kemiri/protocol';
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
	import { provideTaskFilter, tasksView } from '#lib/tasks-view.svelte.js';
	import ConversationSidebar from '#lib/components/ConversationSidebar.svelte';
	import DeployBanner from '#lib/components/DeployBanner.svelte';
	import UsagePauseBanner from '#lib/components/usage/UsagePauseBanner.svelte';
	import DiskBanner from '#lib/components/DiskBanner.svelte';
	import MemoryPanel from '#lib/components/MemoryPanel.svelte';
	import ProjectsMenuButton from '#lib/components/ProjectsMenuButton.svelte';
	import { MediaQuery } from 'svelte/reactivity';
	import { PROJECTS_NAV_WIDE_QUERY } from '#lib/projects.js';
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
	import { type ProjectRefStatus, provideRefLinks } from '#lib/ref-links.svelte.js';
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
	import { DEFAULT_SIDEBAR_TAB, SIDEBAR_DOCKED_QUERY, sidebarTabLabel, visibleSidebarTabs, type SidebarTab } from '#lib/sidebar.js';
	import { questionBadgeText, questionsWaitingLabel } from '#lib/board.js';
	import type { ProjectBoard } from '#lib/board.svelte.js';
	import { alerts } from '#lib/alerts.svelte.js';
	import { projectMuteMenuState } from '#lib/alert-quiet.js';
	import { notifications } from '#lib/notifications.svelte.js';
	import { taskFromUrl, withTask } from '#lib/tasks.js';
	import { connectionView } from '#lib/connection.js';
	import { headerHasRoomForApps, headerLayout, visibleHeaderActions } from '#lib/chat/header.js';
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
	 * the conversation's context and the project's memory. Panels share one
	 * resizable right sidebar (a full-screen sheet below 72rem).
	 *
	 * With `threadId` this is a background job's chat instead: the same transcript and composer, typed into
	 * directly, under a header that says it is a background job of main and leads back to main. It has its own
	 * Workers and Info tabs, and shares the project's Board, Memory and Background jobs panels.
	 */
	let {
		backend,
		projectId,
		threadId: threadParam, shown, projectReads, prefetchCoordinator, answers
	}: { backend: BackendConnection; projectId: string; threadId?: string; shown: boolean; projectReads: { board?: ProjectBoard; threads?: ProjectThreads; memory?: ProjectMemory; schedules?: ProjectSchedules; refStatus?: ProjectRefStatus; peerLog?: ProjectThreadMessages }; prefetchCoordinator: (id: string) => void; answers?: ProjectAnswers } = $props();

	/** The background job this chat is; undefined for main ("main" in the route reads as main too). */
	const threadId = $derived(isMainThread(threadParam) ? undefined : threadParam);
	const isThread = $derived(threadId !== undefined);
	const taskFilter = provideTaskFilter();
	$effect(() => tasksView.useProject(`${backend.id}:${projectId}`));

	/** The parts of the transcript column the chat drives: following new output. */
	type TranscriptHandle = {
		scrollToBottom(behavior?: ScrollBehavior): void;
		follow(): void;
	};

	const project = $derived(backend.projects.find((entry) => entry.id === projectId));
	setContext(PROJECT_WORKER_MODELS, () => project?.workerModels);
	const filesNavigation = provideFilesNavigation(() => shown && backend.features?.includes('project-files') === true,
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
	const apps = useProjectApps(() => backend.supports('apps') ? { client: backend.client, projectId } : undefined);
	provideProjectApps(apps);
	const runningAppCounts = $derived(appCounts(apps.current?.apps ?? []));
	provideArtifactScope(() => ({ client: backend.client, projectId, available: backend.supports('artifacts') }));

	let session = $state<ChatSession | undefined>(undefined);
	let workers = $state<ProjectWorkers | undefined>(undefined);
	let projectContext = $state<ProjectContext | undefined>(undefined);
	const memory = $derived(projectReads.memory);
	const schedules = $derived(projectReads.schedules);
	const board = $derived(projectReads.board);
	const threads = $derived(projectReads.threads);
	let aborting = $state(false);
	let sendError = $state<string | undefined>(undefined);
	let modelError = $state<string | undefined>(undefined);
	let savingThreadModelSettings = $state(false);
	let transcript = $state<TranscriptHandle | undefined>(undefined);
	let composerHeight = $state(0);
	let chatBannerHost = $state<HTMLElement>();
	$effect(() => {
		const host = chatBannerHost;
		if (!shown || !host) return;
		alerts.chatBannerHost = host;
		return () => { if (alerts.chatBannerHost === host) alerts.chatBannerHost = undefined; };
	});
	const composerOwner = {};
	$effect(() => {
		if (!shown) return;
		alerts.setComposerHeight(composerOwner, composerHeight);
		return () => alerts.clearComposerHeight(composerOwner);
	});

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
		if (!shown || discussionNavigation.path !== page.url.pathname || isThread || !claimDiscussionNavigation(discussionNavigation.sequence)) return;
		const name = discussionNavigation.projectName;
		discussionNotice = name ? `Opened main chat in ${name}.` : undefined;
		sidebarOpen = false;
		void afterRender().then(() => composer?.focus());
		const timeout = setTimeout(() => { discussionNotice = undefined; }, 4500);
		return () => clearTimeout(timeout);
	});

	/** The right sidebar: open, which tab, and whether it fills the chat area. */
	let sidebarOpen = $state(false);
	let sidebarTab = $state<SidebarTab>(DEFAULT_SIDEBAR_TAB);
	const dockedSidebar = new MediaQuery(SIDEBAR_DOCKED_QUERY);
	let sidebarToggle = $state<HTMLElement | null>(null);
	let sidebarNavigation = $state<HTMLElement>();
	let sidebarExpanded = $state(false);
	let questionPin: ReturnType<typeof BoardQuestionPin> | undefined = $state();
	const supportsAnswers = $derived(answersSupported(backend.features));
	const answerId = $derived(shown && supportsAnswers ? answerFromUrl(page.url) : undefined);
	const answerReplies = $derived(answers && supportsAnswers ? answersByReply(answers.answers, threadId ?? 'main') : undefined);
	$effect(() => {
		if (answerId) {
			sidebarTab = 'answers';
			sidebarOpen = true;
			sidebarExpanded = false;
		}
	});
	const linkedQuestion = $derived(shown ? page.url.searchParams.get('question') ?? undefined : undefined);
	$effect(() => { if (linkedQuestion) sidebarOpen = false; });
	rememberConversationView(() => ({ open: sidebarOpen, tab: sidebarTab, expanded: sidebarExpanded, tasksMode: tasksView.mode, taskFocus: taskFilter.focus }), saved => {
		sidebarOpen = saved.open; sidebarTab = saved.tab; sidebarExpanded = saved.expanded;
		if (saved.tasksMode) tasksView.set(saved.tasksMode);
		if (saved.taskFocus) taskFilter.focusOn(saved.taskFocus); else taskFilter.clearFocus();
	}, () => shown);

	const supportsWorkers = $derived(backend.supports('workers'));
	const supportsBoard = $derived(backend.supports('board'));
	// With task reports the Board tab is the Tasks view, and `?task=<id>` opens a task's sheet over the chat.
	const supportsTasks = $derived(supportsBoard && backend.supports('task-reports'));
	const boardTabName = $derived(supportsTasks ? 'Tasks' : 'Board');
	/** Task links in the chat, and the composer's task reference, need the board and the server's task reports. */
	const supportsTaskReports = $derived(backend.supports('task-reports'));
	const taskLinks = $derived(supportsTaskReports && board !== undefined ? boardTaskLinks(() => board?.board?.tasks ?? []) : undefined);
	provideTaskLinks(() => taskLinks);
	/** Keys and PR numbers link through the project's settings; the board's refs show the state the backend reads. */
	const refStatus = $derived(projectReads.refStatus);
	provideRefLinks(() => ({ links: project?.links, status: (ref) => refStatus?.status(ref) }));
	const hasOpenQuestions = $derived(board?.board?.questions.some(question => question.status === 'open') ?? false);
	const showProjectMuteMenu = $derived(project !== undefined && (backend.supports('notifications') || backend.supports('in-app-alerts')));
	/** A worker a schedule started says which schedule; the names come from the project's schedule list. */
	/** Info needs the `context` feature, Workers the `workers` one, Memory the `memory` one. */
	const projectMute = $derived(projectMuteMenuState(notifications.settings, backend.id, projectId, notifications.muteClock));
	const supportsThreads = $derived(backend.supports('threads'));
	const sidebarTabs = $derived(visibleSidebarTabs((feature) => backend.supports(feature), { background: true, answers: supportsAnswers }));
	/** This thread as the list has it; undefined on main's chat and while the list loads. */
	let archivedThread = $state<ThreadSummary>();
	const thread = $derived(threadId === undefined ? undefined : threads?.thread(threadId) ?? (archivedThread?.id === threadId ? archivedThread : undefined));
	const threadList = $derived(threads?.threads ?? []);
	const supportsCoordinators = $derived(backend.supports('coordinators'));
	const supportsAssignment = $derived(backend.supports('task-coordinator'));
	const supportsPeerMessages = $derived(backend.supports('coordinator-messages'));
	const roster = $derived(coordinatorRoster(threadList, supportsCoordinators));
	const peerLog = $derived(projectReads.peerLog);
	const peerMessages = $derived(peerLog ? new Map(peerLog.messages.map(message => [message.id, message])) : undefined);
	const peerLinks: ThreadMessageLinks = {
		thread: id => threads?.thread(id) ?? (archivedThread?.id === id ? archivedThread : undefined),
		chat: (id, message) => threadMessageHref(backend.id, projectId, id, message),
		task: id => taskLink(id),
	};
	let peerPanel = $state(false);
	const peerAnchor = $derived.by(() => {
		if (!shown || !page.url.hash.startsWith('#peer-')) return undefined;
		try { return decodeURIComponent(page.url.hash.slice(6)); } catch { return undefined; }
	});

	const coordinatorId = $derived(thread?.kind === 'coordinator' ? thread.id : coordinatorOfThread(threadId, threadList));
	const viewingCoordinator = $derived(roster.find(row => row.id === coordinatorId));
	const coordinatorChat = $derived(supportsCoordinators && (!isThread || thread?.kind === 'coordinator'));
	const archivedCoordinator = $derived(coordinatorChat && thread?.archived === true);
	const chatCoordinator = $derived(coordinatorChat ? (archivedCoordinator ? thread : viewingCoordinator) : undefined);
	const showBackToProject = $derived(isThread && !coordinatorChat);
	const jobs = $derived(supportsCoordinators ? threadList.filter(row => row.kind !== 'coordinator' && (row.parentThreadId ?? 'main') === coordinatorId) : threadList);
	let manager = $state<'manage' | ThreadSummary>();
	const coordinatorCreation = getCoordinatorCreation();
	function openCoordinatorCreation() { coordinatorCreation.open(backend, projectId); }
	let taskScope = $state<'coordinator' | 'all'>('coordinator');
	let hiddenCoordinators = $state<Set<string>>(new Set());
	const scopeKey = $derived(coordinatorStorageKey(backend.id, projectId, `scope:${threadId ?? 'main'}`));
	const otherAttention = $derived(roster.filter(row => row.id !== coordinatorId).reduce((sum, row) => sum + coordinatorBadges(row).needsYou, 0));
	const questionCounts = $derived(roster.filter(row => row.id !== coordinatorId).map(row => ({ row, count: scopedQuestions((board?.board?.questions ?? []).filter(q => q.status === 'open'), threadList, row.id).length })).filter(row => row.count));
	const landingTurn = $derived(landingTurnPresentation(backend.supports('landing-turn') ? threads?.landingTurn : undefined, roster));
	provideLandingTurn(() => ({ turn: landingTurn, threads: threadList }));
	provideCoordinatorTaskView(() => supportsAssignment && roster.length ? { roster: [...roster, ...(threads?.archived ?? []).filter(row => row.kind === 'coordinator')], threads: threadList, coordinatorId: taskScope === 'coordinator' ? coordinatorId : undefined, hidden: hiddenCoordinators } : undefined);
	$effect(() => {
		taskScope = (readCoordinatorPreference(scopeKey) ?? readCoordinatorPreference(coordinatorStorageKey(backend.id, projectId, 'scope'))) === 'all' ? 'all' : 'coordinator';
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
		if (!shown || !coordinatorChat || viewingCoordinator?.id !== (threadId ?? 'main') || !viewingCoordinator) return;
		projectsNav.rememberCoordinator(coordinatorStorageKey(backend.id, projectId, 'last'), viewingCoordinator.id);
		if (viewingCoordinator.lastReplyAt) projectsNav.markCoordinatorSeen(coordinatorStorageKey(backend.id, projectId, `seen:${viewingCoordinator.id}`), viewingCoordinator.lastReplyAt);
	});
	function switchCoordinator(id: string) {
		const href = coordinatorHref(backend.id, projectId, id);
		if (href !== page.url.pathname) void goto(href);
	}
	function coordinatorKeys(event: KeyboardEvent) {
		if (!shown || event.defaultPrevented || manager || coordinatorCreation.isOpen() || roster.length < 2) return;
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
		if (!shown || !supportsCoordinators || !id || !threads?.loaded || threadList.some(row => row.id === id) || !backend.ready) return;
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
	const showsThreadModelSettings = $derived(isThread && thread !== undefined && !thread.archived &&
		backend.supports('coordinators') && backend.supports('thread-model-settings'));
	const chatModel = $derived((isThread ? thread?.model : project?.coordinator.model) ?? null);
	const chatThinkingLevel = $derived((isThread ? thread?.thinkingLevel : project?.coordinator.thinkingLevel) ?? null);
	const currentModel = $derived(backend.models.find(model =>
		model.provider === chatModel?.provider && model.modelId === chatModel?.modelId));
	const thinkingLevels = $derived<readonly ThinkingLevel[]>(currentModel?.thinkingLevels ?? []);

	const workerList = $derived(workers?.workers ?? []);
	const outsideWorkerCount = $derived(countWorkersOutsideModels(workerList, project?.workerModels));
	const usesProjectWorkerDefault = $derived(backend.supports('worker-picker-project-default'));
	const firstWorkerModel = $derived(project?.workerModels[0]);
	const workerDefaults = $derived(isThread
		? { model: thread?.workerModel ?? null, thinkingLevel: thread?.workerModel?.thinkingLevel ?? null }
		: usesProjectWorkerDefault
		? { model: firstWorkerModel ?? null, thinkingLevel: firstWorkerModel?.thinkingLevel ?? null }
		: workers?.defaults ?? { model: null, thinkingLevel: null });

	const live = $derived(liveState(session?.view));
	const busy = $derived(live?.run !== undefined);
	/** Messages sent while a run was busy, drawn at the end of the transcript until the run places them. */
	let waiting = $state<WaitingMessages | undefined>(undefined);
	const waitingList = $derived(waiting?.supported === true ? waiting.messages(session?.view?.queued) : []);
	const replyAnchor = $derived(shown ? /^#entry-(\d+)$/.exec(page.url.hash)?.[1] : undefined);
	const items = $derived(
		withWaiting(
			buildTranscript(session?.entries ?? [], live, { inputKeys: waiting?.inputKeys, keepWarm: session?.view?.keepWarm, showCoordinatorNotes: backend.supports('memory-notes'), threadMessages: peerMessages, entryAnchor: replyAnchor ? Number(replyAnchor) : undefined, answerReplies }),
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

	const sidebarTabIcons: Record<SidebarTab, Component> = {
		board: ClipboardListIcon,
		answers: BookmarkIcon,
		background: LayersIcon,
		info: InfoIcon,
		artifacts: PaperclipIcon,
		memory: BookOpenIcon
	};
	const taskAttentionLabel = $derived(questionsWaiting > 0
		? supportsAssignment ? `${questionsWaiting} need attention` : questionsWaitingLabel(questionsWaiting)
		: undefined);
	const taskAttentionBadge = $derived(questionBadgeText(questionsWaiting));
	const sidebarLabels = $derived({ board: boardTabName, background: 'Background' });
	const sidebarToggleName = $derived([
		sidebarOpen ? 'Close project panel' : 'Open project panel',
		!sidebarOpen ? taskAttentionLabel : undefined,
		!sidebarOpen && answers?.unread ? 'Unread answers' : undefined
	].filter(Boolean).join(' · '));

	/** The panel opener and the chat's routes and overlays, not tabs of the project panel. */
	type HeaderAction = {
		id: string;
		kind: 'panel' | 'navigation' | 'apps';
		name: string;
		title?: string;
		label?: string;
		icon: Component;
		badge?: boolean;
		placement?: 'persistent' | 'more';
		href?: string;
		onclick?: () => void;
	};

	/** The header row, measured: the chat pane narrows when the sidebar opens, so the row, not the window, decides. */
	let chatRoot: HTMLDivElement;
	let headerRow = $state<HTMLDivElement | null>(null);
	let headerWidth = $state(0);
	let headerMenuOpen = $state(false);
	let moreTrigger = $state<HTMLButtonElement | null>(null);
	let appsDialogOpen = $state(false);
	let appsTrigger = $state<HTMLElement>();
	let connectionBadgeWidth = $state(0);
	$effect(() => {
		if (!shown) { headerMenuOpen = false; appsDialogOpen = false; }
	});
	const connectionProblem = $derived(connectionView(backend.connection).tone !== 'ok');
	const projectMuted = $derived(showProjectMuteMenu && projectMute.kind !== 'none');

	function openRunningApps(trigger?: HTMLElement) {
		appsTrigger = trigger;
		headerMenuOpen = false;
		appsDialogOpen = true;
	}

	function restoreAppsFocus() {
		(appsTrigger?.isConnected ? appsTrigger : moreTrigger)?.focus();
	}

	$effect(() => {
		if (headerRow == null) return;
		const element = headerRow;
		headerWidth = element.clientWidth;
		const observer = new ResizeObserver(() => (headerWidth = element.clientWidth));
		observer.observe(element);
		return () => observer.disconnect();
	});

	const wideProjectsSidebar = new MediaQuery(PROJECTS_NAV_WIDE_QUERY);
	// Projects and Inbox take 32px + 44px, with two gaps. The status chip reserves only what it uses.
	const headerFixedWidth = $derived((wideProjectsSidebar.current ? 0 : 84) + (showBackToProject ? 36 : 0)
		+ (projectMuted ? 20 : 0) + (connectionProblem ? connectionBadgeWidth + 4 : 0));

	const headerActions = $derived.by((): HeaderAction[] => {
		const actions: HeaderAction[] = [];
		if (filesNavigation.available()) actions.push({
			id: 'files', kind: 'navigation', name: 'Files', label: 'Files', icon: FolderIcon,
			onclick: () => { headerMenuOpen = false; void filesNavigation.open(); }
		});
		if (backend.supports('project-changes-working') && (threadId ? thread && !thread.archived : project)) actions.push({
			id: 'working-changes', kind: 'navigation', name: 'Changes', label: 'Changes', icon: GitCompareArrowsIcon,
			onclick: () => { headerMenuOpen = false; void openWorkingChanges(threadId ? { kind: 'thread', threadId } : PROJECT_ROOT); }
		});
		if (project && backend.supports('terminal')) actions.push({
			id: 'terminal', kind: 'navigation', name: 'Terminal', title: 'A terminal on this backend, in the project folder',
			label: 'Terminal', icon: TerminalIcon, href: terminalHref(backend.id, { projectId: project.id })
		});
		// Keep the apps shortcut in More if drawer or connection chrome would squeeze out the title.
		if (runningAppCounts.active && headerHasRoomForApps(headerWidth, headerFixedWidth)) actions.push({
			id: 'running-apps', kind: 'apps', name: `Running apps: ${appCountLabel(runningAppCounts)}`, icon: PanelsTopLeftIcon, placement: 'persistent'
		});
		if (project && (backend.supports('models') || backend.supports('credentials') || backend.supports('logins'))) actions.push({
			id: 'settings', kind: 'navigation', name: 'Project settings', icon: SettingsIcon, placement: 'more',
			href: projectSettingsHref(backend.id, project.id), onclick: () => (headerMenuOpen = false)
		});
		if (supportsSidebar && !(sidebarOpen && dockedSidebar.current)) actions.push({
			id: 'panel', kind: 'panel', name: sidebarToggleName, label: 'Panel', icon: PanelRightIcon,
			badge: !sidebarOpen && taskAttentionBadge !== undefined, placement: 'persistent', onclick: toggleSidebar
		});
		return actions;
	});

	/** Labels where they fit, icons where they do not, and More when even those are too wide. */
	const headerRowLayout = $derived(headerLayout(headerWidth, headerActions, headerFixedWidth));
	const shownHeaderActions = $derived(visibleHeaderActions(headerRowLayout, headerActions));
	const chatToolActions = $derived(shownHeaderActions.inline.filter(action => action.kind !== 'panel'));
	const panelAction = $derived(shownHeaderActions.inline.find(action => action.kind === 'panel'));

	function pickHeaderAction(action: HeaderAction): void {
		headerMenuOpen = false;
		action.onclick?.();
	}

	onMount(() => {
		const timer = setInterval(() => (now = Date.now()), 15_000);
		return () => clearInterval(timer);
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



	function openBoard(): void {
		sidebarTab = 'board';
		sidebarOpen = true;
		sidebarExpanded = false;
	}


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

	// A reply, including Show in chat from an old answer, can predate the loaded transcript.
	$effect(() => {
		const current = session;
		const id = replyAnchor;
		if (!id || !current || current.status !== 'live') return;
		let cancelled = false;
		void (async () => {
			while (!cancelled) {
				await new Promise(requestAnimationFrame);
				if (cancelled) return;
				const entry = chatRoot?.querySelector(`#entry-${id}`);
				if (entry) { entry.scrollIntoView({ block: 'center' }); return; }
				if (!current.canLoadEarlier || !current.entries.length || Number(id) >= current.entries[0]!.id) return;
				if (!current.loadingEarlier) {
					const count = current.entries.length;
					try { await loadEarlier(); } catch { return; }
					if (current.entries.length <= count) return;
				}
			}
		})();
		return () => { cancelled = true; };
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
				const card = chatRoot?.querySelector(`#${CSS.escape(threadMessageAnchor(id))}`);
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
		if (!shown || isThread) return;
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
		if (!shown || target === undefined || current === undefined || current.status !== 'live') return;
		let cancelled = false;
		let pages = 0;
		const find = async (): Promise<void> => {
			while (!cancelled) {
				await new Promise((resolve) => requestAnimationFrame(resolve));
				const cards = chatRoot?.querySelectorAll<HTMLElement>(`[data-thread-card="${CSS.escape(target)}"]`);
				const card = cards?.[cards.length - 1];
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

	function toggleSidebar(): void {
		if (sidebarOpen) setSidebarOpen(false);
		else {
			selectSidebar(sidebarTab);
			if (dockedSidebar.current) void afterRender().then(() => {
				sidebarNavigation?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus();
			});
		}
	}

	function selectSidebar(target: SidebarTab): void {
		if (sidebarOpen && sidebarTab === target) return;
		if (target !== 'answers' && answerId) returnToAnswersList();
		// Keep an expanded panel expanded when switching tabs. Tasks also expand for Board and Graph.
		sidebarExpanded = (sidebarOpen && sidebarExpanded) || (target === 'board' && supportsTasks && tasksView.mode !== 'list');
		sidebarTab = target;
		sidebarOpen = true;
	}

	function focusSidebarToggle(): void {
		if (shown) void afterRender().then(() => sidebarToggle?.focus());
	}

	function returnToAnswersList(): void {
		void goto(page.url.pathname, { reset: false, replace: true });
	}

	function setSidebarOpen(open: boolean): void {
		sidebarOpen = open;
		if (!open) {
			sidebarExpanded = false;
			if (answerId) returnToAnswersList();
		}
	}

	function answerHref(id: string): string {
		return `${page.url.pathname}?answer=${id}`;
	}

	function answerChatHref(answer: Answer): string | undefined {
		if (answer.entryId === undefined) return undefined;
		return `${coordinatorHref(backend.id, projectId, answer.coordinatorId)}#entry-${answer.entryId}`;
	}

	function answerTaskHref(id: string): string {
		return withTask({ pathname: page.url.pathname, search: '' }, id);
	}

	function navigateAnswerLink(event: MouseEvent, leaveSidebar = false): void {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey ||
			!(event.currentTarget instanceof HTMLAnchorElement)) return;
		event.preventDefault();
		if (leaveSidebar) {
			sidebarOpen = false;
			sidebarExpanded = false;
		}
		void goto(event.currentTarget.href, { reset: leaveSidebar });
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
		if (savingThreadModelSettings) return false;
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

	async function saveThreadModelSettings(fields: Pick<ThreadsUpdateRequest, 'model' | 'thinkingLevel' | 'workerModel'>): Promise<void> {
		const id = threadId;
		const roster = threads;
		if (!id || !roster || !showsThreadModelSettings || !canPickModel || savingThreadModelSettings) return;
		modelError = undefined;
		savingThreadModelSettings = true;
		try {
			if (!await roster.updateCoordinator(id, fields)) {
				modelError = roster.actionError?.message ?? 'Could not save the model settings.';
			}
		} finally {
			savingThreadModelSettings = false;
		}
	}

	/** Changing the model drops a thinking level the new model does not offer. */
	async function changeModel(model: ModelInfo): Promise<void> {
		if (project === undefined) return;
		modelError = undefined;
		const level = chatThinkingLevel;
		const keep = level !== null && model.thinkingLevels.includes(level);
		const modelRef = { provider: model.provider, modelId: model.modelId };
		if (isThread) return saveThreadModelSettings({ model: modelRef, ...(keep ? {} : { thinkingLevel: null }) });
		try {
			await backend.configureProject(projectId, {
				coordinatorModel: modelRef,
				...(keep ? {} : { coordinatorThinkingLevel: null }),
			});
		} catch (error) {
			modelError = errorText(error);
		}
	}

	async function changeThinkingLevel(level: ThinkingLevel | null): Promise<void> {
		if (isThread) return saveThreadModelSettings({ thinkingLevel: level });
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
		const level = workerDefaults.thinkingLevel;
		const thinkingLevel = model !== null && level !== null && model.thinkingLevels.includes(level) ? level : null;
		const ref = model === null ? null : { provider: model.provider, modelId: model.modelId };
		if (isThread) {
			void saveThreadModelSettings({ workerModel: ref === null ? null : { ...ref, thinkingLevel } });
			return;
		}
		void workers?.pick(ref, thinkingLevel);
	}

	function changeWorkerThinking(level: ThinkingLevel | null): void {
		const model = workerDefaults.model;
		if (isThread) {
			if (model !== null) void saveThreadModelSettings({ workerModel: { ...model, thinkingLevel: level } });
			return;
		}
		if (usesProjectWorkerDefault && model === null) return;
		void workers?.pick(model, level);
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
	{@const labelled = headerRowLayout === 'labels' && action.label !== undefined}
	{#if action.kind === 'panel'}
		<Button variant="ghost" size={labelled ? 'sm' : 'icon-sm'} class="chat-panel-toggle relative"
			bind:ref={sidebarToggle} onclick={action.onclick} aria-label={action.name} title={action.name}
			aria-expanded={sidebarOpen}>
			<action.icon class="size-4" />
			{#if labelled}{action.label}{/if}
			{#if !sidebarOpen && taskAttentionBadge}
				<span class="header-panel-badge {labelled ? '' : 'absolute -top-0.5 -right-0.5'}" aria-hidden="true">{taskAttentionBadge}</span>
			{/if}
		</Button>
	{:else if action.kind === 'apps'}
		<Button variant="ghost" size="icon-sm" class="relative text-(--chat-fg-muted)" aria-label={action.name}
			title={action.name} aria-haspopup="dialog" onclick={event => openRunningApps(event.currentTarget as HTMLElement)}>
			<action.icon class="size-4" />
			<span class="apps-count absolute -right-0.5 -top-0.5" class:pending={runningAppCounts.pending > 0} aria-hidden="true">{questionBadgeText(runningAppCounts.active)}</span>
		</Button>
	{:else}
		<Button variant="ghost" size={labelled ? 'sm' : 'icon-sm'} class="header-panel-action"
			href={action.href} onclick={action.onclick} aria-label={action.name} title={action.title ?? action.name}>
			<action.icon class="size-4" />
			{#if labelled}{action.label}{/if}
		</Button>
	{/if}
{/snippet}

{#snippet headerMenuRow(action: HeaderAction)}
	<Button variant="ghost" size="sm" class="h-8 w-full justify-start gap-2 px-2 font-normal"
		href={action.href} onclick={() => pickHeaderAction(action)} aria-label={action.name}>
		<action.icon class="size-4" />
		<span class="min-w-0 flex-1 truncate text-left">{action.label ?? action.name}</span>
	</Button>
{/snippet}

{#snippet sidebarPanelTabs()}
	<nav bind:this={sidebarNavigation} aria-label="Project panel views"
		class="-ml-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overscroll-x-contain p-1 [scrollbar-width:none]">
		{#each sidebarTabs as tab (tab)}
			{@const TabIcon = sidebarTabIcons[tab]}
			{@const label = sidebarTabLabel(tab, sidebarLabels)}
			{@const details = tab === 'board' ? taskAttentionLabel : tab === 'answers' && answers?.unread ? 'Unread' : undefined}
			{@const showCompactLabel = tab === 'board' || tab === 'answers' || tab === 'background'}
			<Button variant="ghost" size="sm" class="header-panel-action project-panel-tab relative gap-1.5"
				data-compact-label={showCompactLabel ? '' : undefined}
				aria-pressed={sidebarTab === tab} aria-label={details ? `${label} (${details})` : label}
				title={details ? `${label} (${details})` : label} onclick={() => selectSidebar(tab)}>
				<span class="project-panel-tab-icon"><TabIcon class="size-4" /></span>
				<span class="project-panel-tab-label">{label}</span>
				{#if tab === 'board' && taskAttentionBadge}
					<span class="header-panel-badge project-panel-task-badge absolute -top-0.5 right-0" aria-hidden="true">{taskAttentionBadge}</span>
				{:else if tab === 'answers' && answers?.unread}
					<span class="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-(--accent-2)" aria-hidden="true"></span>
				{/if}
			</Button>
		{/each}
	</nav>
{/snippet}

<div class="flex h-full w-full overflow-hidden" bind:this={chatRoot}>
	<div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" inert={sidebarOpen && sidebarExpanded && dockedSidebar.current}>
			<header class="project-topbar relative z-10" aria-label="Project chat">
				<div class="flex h-full min-w-0 flex-1 items-center gap-1" bind:this={headerRow}>
					<ProjectsMenuButton />
					{#if showBackToProject}
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
						<ConversationSwitcher {shown} roster={supportsCoordinators ? roster : undefined} {seen} archivedCoordinator={archivedCoordinator ? thread : undefined}
							onprefetch={prefetchCoordinator} onedit={coordinator => manager = coordinator} onnew={openCoordinatorCreation} onalltasks={showAllTasks} onmanage={() => manager = 'manage'} projectName={project?.name ?? 'Project'} backendId={backend.id} {projectId} {threadId} threads={threadList} questions={board?.board?.questions ?? []} {now} counts={jobCounts} onshowall={() => selectSidebar('background')} />
					{:else}
						<h1 class="min-w-0 flex-1 truncate px-1.5 text-[0.9375rem] font-semibold">{isThread ? thread?.title || threadId : project?.name ?? 'Project'}</h1>
					{/if}
					{#each chatToolActions as action (action.id)}
						{@render headerButton(action)}
					{/each}
					{#if showProjectMuteMenu && projectMute.kind !== 'none'}
						<span class="shrink-0 text-(--chat-fg-muted)" role="img" aria-label={projectMute.status} title={projectMute.status}><BellOffIcon class="size-4" /></span>
					{/if}
					{#if connectionProblem}
						<div class="connection-problem flex shrink-0" role="status" bind:clientWidth={connectionBadgeWidth}>
							<ConnectionBadge {backend} />
						</div>
					{/if}
					<Popover.Root bind:open={headerMenuOpen}>
						<Popover.Trigger bind:ref={moreTrigger}
							class="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-(--chat-fg-muted) transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 aria-expanded:bg-muted aria-expanded:text-foreground"
							aria-label="More actions" title="More actions">
							<EllipsisIcon class="size-4" />
						</Popover.Trigger>
						<Popover.Content side="bottom" align="end" class="w-64 gap-1 p-1" onCloseAutoFocus={event => { if (appsDialogOpen) event.preventDefault(); }}>
							{#each shownHeaderActions.menu.filter(action => action.placement !== 'more') as action (action.id)}
								{@render headerMenuRow(action)}
							{/each}
							{#if backend.supports('apps')}
								<Button variant="ghost" size="sm" class="h-8 w-full justify-start gap-2 px-2 font-normal" aria-haspopup="dialog" onclick={() => openRunningApps()}>
									<PanelsTopLeftIcon class="size-4" /> Running apps
									{#if runningAppCounts.active}<span class="apps-count ml-auto" class:pending={runningAppCounts.pending > 0} title={appCountLabel(runningAppCounts)}>{questionBadgeText(runningAppCounts.active)}</span>{/if}
								</Button>
							{/if}
							{#if showProjectMuteMenu}
								<ProjectMuteMenu backendId={backend.id} {projectId} mute={projectMute} onpick={() => headerMenuOpen = false} />
							{/if}
							{#each shownHeaderActions.menu.filter(action => action.placement === 'more') as action (action.id)}
								{@render headerMenuRow(action)}
							{/each}
							<Separator class="my-1" />
							<div class="flex flex-col items-start gap-1 px-2 py-1 text-xs text-(--chat-fg-subtle)">
								<div class="flex flex-wrap items-center gap-1"><ConnectionBadge {backend} /><span>· {backend.name}</span></div>
								{#if backend.supports('server-status') && backend.status?.release !== undefined}
									<ReleaseLine release={backend.status.release} deploy={backend.status.deploy} compact />
								{/if}
							</div>
						</Popover.Content>
					</Popover.Root>
					{#if panelAction}{@render headerButton(panelAction)}{/if}
				</div>
			</header>
			<div class="relative z-10 flex shrink-0 flex-col gap-0.5 px-2 sm:px-3">
				<div class="py-1 empty:hidden sm:hidden" bind:this={chatBannerHost}></div>
				{#if !isThread && !supportsCoordinators}
					<div class="flex min-w-0 items-center gap-x-2 overflow-hidden px-2 py-1 text-xs text-(--chat-fg-subtle)">
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
				{#if outsideWorkerCount > 0}
					<p class="py-1 text-xs text-muted-foreground">{outsideWorkerCount} on other models</p>
				{/if}
			</div>
			{#if isThread && thread && threads && !coordinatorChat}
				<BackgroundJobBand {thread} {threads} {board} {now} projectName={project?.name ?? 'Project'} mainHref={supportsCoordinators ? coordinatorHref(backend.id, projectId, coordinatorId) : projectHref(backend.id, projectId)}
					onpromote={backend.supports('coordinator-schedules') ? () => manager = thread : undefined}
					parentTitle={supportsCoordinators ? viewingCoordinator?.title ?? 'General' : undefined} scheduleName={thread.scheduleId ? scheduleTitle(thread.scheduleId) : undefined} />
			{/if}

				{#key session}
				<TranscriptColumn
					bind:this={transcript}
					fadeTop
					{items}
					answerHref={supportsAnswers ? answerHref : undefined}
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

				<div class="{CHAT_COLUMN_CLASS} shrink-0 px-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] sm:px-4 sm:pb-4" bind:clientHeight={composerHeight}>
					<div class="mb-2 flex flex-col gap-2">
						<UsagePauseBanner {backend} onreopenquestion={(id) => { sidebarOpen = false; questionPin?.openQuestion(id); }} />
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
								bind:this={questionPin}
								{board}
								questionId={linkedQuestion}
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
							model={chatModel}
							thinkingLevel={chatThinkingLevel}
							{thinkingLevels}
							workerModels={backend.models}
							workerProviders={backend.providers}
							projectWorkerModels={project?.workerModels ?? []}
							usesProjectWorkerDefault={!isThread && usesProjectWorkerDefault}
							usesThreadWorkerDefault={showsThreadModelSettings}
							workerSettingsHref={projectSettingsHref(backend.id, projectId, 'workers')}
							workerModel={workerDefaults.model}
							workerThinkingLevel={workerDefaults.thinkingLevel}
							showWorkerPicker={supportsWorkers && (isThread ? showsThreadModelSettings : canPickModel)}
							showModelPicker={!isThread || showsThreadModelSettings}
							modelPickersDisabled={isThread && (!canPickModel || savingThreadModelSettings)}
							modelNote={isThread && thread?.model ? `Runs on ${modelLabel(thread.model, backend.models)}` : undefined}
							workerPickerDisabled={isThread ? !canPickModel || savingThreadModelSettings : workers?.loaded !== true}
							tasks={taskChoices}
							busy={busy || aborting}
							disabled={!canSend || savingThreadModelSettings}
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
					bind:open={() => sidebarOpen, setSidebarOpen}
					preferredTab={answerId ? 'answers' : undefined}
					panelTabs={sidebarPanelTabs}
					restoreFocus={focusSidebarToggle}
					bind:tab={sidebarTab}
					bind:expanded={sidebarExpanded}
					tabs={sidebarTabs}
					labels={sidebarLabels}
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
						{#if taskScope === 'all' && landingTurn}
							<div class="shrink-0 border-b border-(--chat-border) px-3 py-2 @min-[54rem]/peer-panel:hidden"><LandingTurn turn={landingTurn} /></div>
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
								selectedTaskId={shown ? taskFromUrl(page.url) : null}
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
						{#if taskScope === 'all' && (peerLog || landingTurn)}
							<aside class="min-w-0 flex-1 overflow-y-auto @min-[54rem]/peer-panel:block @min-[54rem]/peer-panel:w-72 @min-[54rem]/peer-panel:flex-none @min-[54rem]/peer-panel:border-l @min-[54rem]/peer-panel:border-(--chat-border) {peerPanel && peerLog ? 'block' : 'hidden'}">
								{#if landingTurn}<div class="hidden border-b border-(--chat-border) p-3 @min-[54rem]/peer-panel:block"><LandingTurn turn={landingTurn} /></div>{/if}
								{@render peerFeed()}
							</aside>
						{/if}
						</div>
						{#if supportsAssignment && taskScope === 'coordinator' && otherAttention}
							<p class="shrink-0 border-t border-(--chat-border) px-3 py-2 text-xs text-(--chat-fg-muted)">{otherAttention} need attention in other coordinators · <button class="font-semibold text-(--accent-2) hover:underline" onclick={showAllTasks}>Show all</button></p>
						{/if}
						</div>
					{/snippet}
					{#snippet answersPanel()}
						{#if answers && shown}
							<AnswersPanel catalogue={answers} {board} {answerId} {now} pathname={page.url.pathname}
								taskHref={answerTaskHref} chatHref={answerChatHref} onnavigate={navigateAnswerLink}
								onleave={event => navigateAnswerLink(event, true)} onlist={returnToAnswersList}
								onopenTask={id => { sidebarOpen = false; void goto(answerTaskHref(id), { reset: false }); }} />
						{/if}
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
					{#snippet artifactsPanel()}
						{#key `${backend.id}:${projectId}`}
							<ProjectArtifactsPanel client={backend.client} {projectId} tasks={board?.tasks ?? []} ondiscuss={() => sidebarOpen = false} />
						{/key}
					{/snippet}
					{#snippet infoPanel()}
						<ContextPanel
							coordinatorArea={chatCoordinator ? chatCoordinator.area ?? '' : undefined}
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

{#if shown}
	<RefCardHost
		readDetails={backend.supports('ref-details') ? (ref) => backend.client.readRefDetails(projectId, ref) : undefined}
		tasks={() => board?.tasks ?? []}
	/>

	{#if supportsTasks}
		<TaskCloseDialog {board} />
		<TaskSheet peerMessages={peerLog} {peerLinks} {backend} {projectId} projectName={project?.name} {board} workers={workers?.allWorkers ?? []} threads={threadList} workerHref={(worker) => workerLink(worker)} onquote={backend.supports('conversation') ? quote : undefined} onshowlinked={showLinkedTasks} />
	{/if}

	<FilesHost {backend} {projectId} projectName={project?.name ?? 'Project'} navigation={filesNavigation} repository={project?.repository} workers={workerList} threads={threadList} {threadId} onquote={backend.supports('conversation') ? quote : undefined} />

<ChangesHost {backend} {projectId} projectName={project?.name ?? 'Project'} repository={project?.repository} {board} navigation={filesNavigation} {threadId} workers={workerList} threads={threadList} />
{/if}

<style>
	/* Shared by the chat navigation and the docked or sheet panel navigation. */
	:global(.project-topbar) {
		display: flex;
		align-items: center;
		flex-shrink: 0;
		min-width: 0;
		height: calc(3.5rem + env(safe-area-inset-top));
		gap: 0.25rem;
		padding: env(safe-area-inset-top) 0.75rem 0;
		border-bottom: 1px solid var(--chat-border);
		background: var(--chat-bg);
	}
	@media (width < 40rem) {
		:global(.project-topbar) { padding-inline: 0.5rem; }
	}
	.connection-problem :global([data-slot='badge']) { display: block; max-width: 7rem; overflow: hidden; text-overflow: ellipsis; }
	@media (width < 22.5rem) {
		.connection-problem :global([data-slot='badge']) { max-width: 5rem; }
	}
	:global(.chat-panel-toggle) { border: 1px solid var(--chat-border); color: var(--chat-fg-muted); }
	.apps-count {
		min-width: 0.875rem;
		border-radius: 1rem;
		padding-inline: 0.2rem;
		background: var(--chat-surface-2);
		color: var(--chat-fg-muted);
		font-size: 0.625rem;
		font-weight: 600;
		text-align: center;
	}
	.apps-count.pending { color: var(--chat-warning); }
	:global(.project-panel-nav) { container: project-panel-nav / inline-size; }
	:global(.project-panel-tab) { width: 2rem; padding-inline: 0; }
	.project-panel-tab-label { display: none; }
	@container project-panel-nav (width < 19rem) {
		:global(.project-panel-tab) { width: 1.6875rem; }
	}
	@container project-panel-nav (width >= 19rem) and (width < 23rem) {
		:global(.project-panel-tab[aria-pressed='true']) { width: auto; padding-inline: 0.625rem; }
		:global(.project-panel-tab[aria-pressed='true']) .project-panel-tab-label { display: inline; }
	}
	@container project-panel-nav (width >= 23rem) and (width < 42rem) {
		:global(.project-panel-tab) { width: 1.75rem; }
		:global(.project-panel-tab[data-compact-label]) { width: auto; padding-inline: 0.3125rem; font-size: 0.8125rem; }
		:global(.project-panel-tab[data-compact-label]) .project-panel-tab-label { display: inline; }
		:global(.project-panel-tab[data-compact-label]) .project-panel-tab-icon { display: none; }
		.project-panel-task-badge { position: static; }
	}
	@container project-panel-nav (width >= 42rem) {
		:global(.project-panel-tab) { width: auto; padding-inline: 0.625rem; }
		.project-panel-tab-label { display: inline; }
		.project-panel-task-badge { position: static; }
	}
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
		min-width: 1rem;
		border-radius: 999px;
		padding-inline: 0.25rem;
		text-align: center;
		font-size: 0.625rem;
		font-weight: 600;
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

{#if shown && backend.supports('apps')}
	<RunningApps bind:open={appsDialogOpen} restoreFocus={restoreAppsFocus} tasks={board?.tasks ?? []} threads={threadList} workers={workerList} {now} />
{/if}

<svelte:window onkeydown={coordinatorKeys} />
{#if shown && manager && threads && supportsCoordinators}
	{#key manager}
		<CoordinatorManager supportsSchedules={backend.supports('coordinator-schedules')} messages={peerLog ? peerFeed : undefined} mode={manager} store={threads} {roster} tasks={board?.tasks ?? []} models={backend.models.filter(model => !model.workerOnly && model.configured)}
			onclose={() => manager = undefined} oncreated={id => { manager = undefined; switchCoordinator(id); }}
			onarchived={id => { const key = coordinatorStorageKey(backend.id, projectId, 'last'); if (readCoordinatorPreference(key) === id) projectsNav.rememberCoordinator(key, 'main'); if (threadId === id) { manager = undefined; switchCoordinator('main'); } }} />
	{/key}
{/if}

{#snippet peerFeed()}
	{#if peerLog}<ThreadMessagesFeed messages={peerLog.messages} links={peerLinks} loaded={peerLog.loaded} error={peerLog.error} />{/if}
{/snippet}
