package io.github.mitzacoder.kemiri.navigation

import io.github.mitzacoder.kemiri.features.artifacts.ArtifactLibraryScreen
import io.github.mitzacoder.kemiri.features.artifacts.ArtifactStudioScreen
import io.github.mitzacoder.kemiri.features.artifacts.LibraryRead
import androidx.activity.compose.PredictiveBackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.style.TextOverflow
import io.github.mitzacoder.kemiri.ui.components.*
import android.content.Context
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.content.edit
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.features.chat.*
import io.github.mitzacoder.kemiri.features.answers.*
import io.github.mitzacoder.kemiri.features.panels.PanelsScreen
import io.github.mitzacoder.kemiri.features.coordinators.coordinatorForChat
import io.github.mitzacoder.kemiri.features.settings.*
import io.github.mitzacoder.kemiri.features.notifications.HandleAppLink
import io.github.mitzacoder.kemiri.features.notifications.PendingAppLink
import io.github.mitzacoder.kemiri.features.notifications.ReportScreenPresence
import io.github.mitzacoder.kemiri.features.notifications.AppLink
import io.github.mitzacoder.kemiri.features.notifications.InAppAlert
import io.github.mitzacoder.kemiri.features.notifications.InAppBannerHost
import io.github.mitzacoder.kemiri.features.notifications.notificationLink
import io.github.mitzacoder.kemiri.features.notifications.pushPayload
import io.github.mitzacoder.kemiri.features.refs.ProvideRefLinks
import io.github.mitzacoder.kemiri.features.tasks.ProvideTaskLinks
import io.github.mitzacoder.kemiri.features.tasks.TaskSheet
import io.github.mitzacoder.kemiri.features.tasks.board.showsTasksBoard
import io.github.mitzacoder.kemiri.features.tasks.rememberTasksView
import io.github.mitzacoder.kemiri.features.terminal.TerminalScreen
import io.github.mitzacoder.kemiri.features.usage.UsageScreen
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import io.github.mitzacoder.kemiri.protocol.Artifact
import kotlinx.coroutines.flow.collect

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HarnessApp(
    repository: HarnessRepository,
    connectPayload: String? = null,
    onConnectHandled: () -> Unit = {},
    pendingLink: PendingAppLink? = null,
    onLinkHandled: () -> Unit = {},
) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        // Even with the expanded projects sidebar (264dp at 1024dp and up), settings still
        // has at least SETTINGS_SPLIT_WIDTH. Read width when opening, never from an effect.
        HarnessNavigation(repository, connectPayload, onConnectHandled, pendingLink, onLinkHandled,
            splitSettings = maxWidth >= SETTINGS_SPLIT_WIDTH, wide = maxWidth >= 1024.dp, phoneWidth = maxWidth < 600.dp)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun HarnessNavigation(
    repository: HarnessRepository,
    connectPayload: String?,
    onConnectHandled: () -> Unit,
    pendingLink: PendingAppLink?,
    onLinkHandled: () -> Unit,
    splitSettings: Boolean,
    wide: Boolean,
    phoneWidth: Boolean,
) {
    var savedBackStack by rememberSaveable { mutableStateOf(wireJson.encodeToString(BackStack.serializer(), BackStack())) }
    fun readBackStack() = wireJson.decodeFromString(BackStack.serializer(), savedBackStack)
    fun updateBackStack(update: (BackStack) -> BackStack) {
        savedBackStack = wireJson.encodeToString(BackStack.serializer(), update(readBackStack()))
    }
    val backStack = remember(savedBackStack) { readBackStack() }
    val stack = backStack.entries
    val current = backStack.current
    val phoneTask = phoneWidth && current is Destination.Task
    val nestedBackTargets = remember { mutableStateListOf<NestedBackTarget>() }
    val scope = rememberCoroutineScope()
    val screenState = rememberSaveableStateHolder()
    // Panel content moves between a Dialog and the tablet Row. An explicit registry key
    // preserves editors across Activity recreation even though those call sites differ.
    val panelState = rememberSaveableStateHolder()
    val drawerSaveableState = rememberSaveableStateHolder()
    val drawer = rememberDrawerState(DrawerValue.Closed)
    val sessions by repository.sessions.collectAsStateWithLifecycle()
    val loaded by repository.loaded.collectAsStateWithLifecycle()
    val artifactLibraryReads = remember(repository) { mutableStateMapOf<String, LibraryRead>() }
    LaunchedEffect(sessions) { artifactLibraryReads.keys.retainAll(sessions.map { it.config.key }.toSet()) }
    // Wide screens keep the projects sidebar open beside the chat (web: 64rem and up); its rail state is remembered.
    val navPreferences = LocalContext.current.let { remember(it) { it.getSharedPreferences(PROJECTS_NAV_PREFERENCES, Context.MODE_PRIVATE) } }
    var sidebarCollapsed by remember { mutableStateOf(navPreferences.getBoolean("collapsed", false)) }
    // The ID a link named that no backend here has (web: the "Unknown backend" page), shown atop the drawer until it
    // closes, the user dismisses it or goes somewhere.
    var unknownBackend by remember { mutableStateOf<String?>(null) }
    var expandedPanels by rememberSaveable { mutableStateOf(emptyList<String>()) }
    fun pop() {
        (readBackStack().current as? Destination.Panel)?.let { panel -> expandedPanels = expandedPanels - panel.screenStateKey() }
        updateBackStack { it.back() }
    }
    fun closeDrawer() { scope.launch { drawer.close() } }
    fun resolvedBack(): (() -> Unit)? = resolveBackTarget(
        if (drawer.isOpen) ::closeDrawer else null,
        nestedBackTargets,
        if (readBackStack().canGoBack) ::pop else null,
    )
    val navigate: (Destination) -> Unit = { next ->
        updateBackStack { previous ->
            if (previous.current is Destination.Panel && next is Destination.Panel) previous.replaceSibling(next)
            else if (next != previous.current) previous.push(next).withSettingsDefault(splitSettings)
            else previous
        }
        unknownBackend = null
        scope.launch { drawer.close() }
    }
    val android = LocalContext.current
    var discussionProblem by remember { mutableStateOf(false) }
    fun discuss(source: Destination.Chat, artifact: Artifact) {
        val session = sessions.find { it.config.key == source.backendKey } ?: return
        val mainChat = Destination.Chat(source.backendKey, artifact.projectId)
        scope.launch {
            try {
                val discussionContext = ProjectScreenContext(repository, session, mainChat, navigate)
                appendArtifactReviewDraft(android, discussionContext, mainChat, discussHeader(artifact), artifact.taskId, discussion = true)
                navigate(mainChat)
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { discussionProblem = true }
        }
    }
    if (discussionProblem) AlertDialog(onDismissRequest = { discussionProblem = false },
        title = { Text("Could not attach the artifact") }, text = { Text("The chat draft could not be saved. Try again.") },
        confirmButton = { TextButton(onClick = { discussionProblem = false }) { Text("Close") } })
    val settingsNavigator = SettingsNavigator(
        navigate,
        { next -> updateBackStack { it.replaceSibling(next) } },
        { parent -> updateBackStack { it.up(parent) } },
        { updateBackStack { it.close() } },
        { next -> updateBackStack { it.switchSettingsScope(next, splitSettings) } },
    )
    val projectMcpParent = (stack.getOrNull(stack.lastIndex - 1) as? Destination.ProjectSettings)?.takeIf { it.section == ProjectSection.Mcp }
    val settingsScopes = if (current.isSettings()) {
        val latestLocations by repository.collectSettings { it.lastOpenedProject to it.lastUsedComputerKey }
        SettingsScopes(rememberScopeComputers(sessions), backStack.settingsProjectContext(), latestLocations.first, latestLocations.second, settingsNavigator, projectMcpParent)
    } else null
    val openedProject = (current as? Destination.Chat)?.let { ProjectLocation(it.backendKey, it.projectId) }
    val usedComputer = (current as? Destination.Settings)?.page?.backendKey?.takeIf { key -> sessions.any { it.config.key == key } }
    LaunchedEffect(openedProject, loaded) { if (loaded && openedProject != null) repository.rememberOpenedProject(openedProject) }
    LaunchedEffect(usedComputer) { if (usedComputer != null) repository.rememberUsedComputer(usedComputer) }
    io.github.mitzacoder.kemiri.features.chat.ShareConversationDialog(repository, navigate)
    LaunchedEffect(connectPayload) { if (connectPayload != null) navigate(Destination.Settings(GeneralPage(GeneralSection.Backends))) }
    HandleAppLink(pendingLink, loaded, sessions.map { it.config }, navigate, openSettingsLink = { destination ->
        updateBackStack { settingsLinkStack(destination).withSettingsDefault(splitSettings) }
    }, onUnknownBackend = { id ->
        // A phone's panel or a task sheet would cover the drawer: back to their chat first.
        updateBackStack { previous ->
            var uncovered = previous
            while (uncovered.canGoBack && (uncovered.current is Destination.Panel || uncovered.current is Destination.Task)) uncovered = uncovered.back()
            uncovered
        }
        unknownBackend = id
        if (wide) sidebarCollapsed = false else scope.launch { drawer.open() }
    }, onLinkHandled)
    LaunchedEffect(drawer.targetValue) { if (drawer.targetValue == DrawerValue.Closed && !wide) unknownBackend = null }
    PredictiveBackHandler(enabled = drawer.isOpen || nestedBackTargets.isNotEmpty() || backStack.canGoBack) { progress ->
        // Resolve once at gesture start; the app bar uses the same resolver.
        commitCompletedBack(resolvedBack()) { progress.collect { } }
    }

    val chat = current.chatRoute()
    val coordinatorOnScreen = (current as? Destination.Chat)?.takeIf { it.workerId == null }
        ?.let { it.threadId ?: io.github.mitzacoder.kemiri.protocol.MAIN_THREAD_ID }
    ReportScreenPresence(chat?.backendKey, chat?.projectId, coordinatorOnScreen, (current as? Destination.Task)?.taskId)
    val openAlert: (InAppAlert) -> Unit = { item ->
        (notificationLink(item.pushPayload(), sessions.map { it.config }) as? AppLink.Open)?.destinations?.forEach(navigate)
    }
    val openAlertNeedsYou: () -> Unit = {
        updateBackStack { previous ->
            var uncovered = previous
            while (uncovered.canGoBack && (uncovered.current is Destination.Panel || uncovered.current is Destination.Task)) uncovered = uncovered.back()
            uncovered
        }
        if (wide) sidebarCollapsed = false else scope.launch { drawer.open() }
    }
    val backend = sessions.firstOrNull { it.config.key == chat?.backendKey }
    val terminal = current as? Destination.Terminal
    val codeView = current is Destination.Changes || current is Destination.WorkingChanges || current is Destination.Files
    val highlight = (current as? Destination.Chat)?.highlight
    val context = if (backend != null && chat != null) ProjectScreenContext(repository, backend, chat, navigate, highlight = highlight, goBack = if (backStack.canGoBack) ::pop else null, taskOrigin = (current as? Destination.Task)?.taskId, attentionQuestionId = (current as? Destination.Task)?.attentionQuestionId) else null
    // Only a tablet keeps the panel composed behind the task. Its saveable state survives the phone route.
    val panelUnderTask = (current as? Destination.Task)?.takeUnless { phoneTask }?.let { task ->
        panelBehindTask(stack.dropLast(1), task)
    }
    val panel = current as? Destination.Panel ?: panelUnderTask
    val answersRoute = current as? Destination.Answers
    val answerId = answersRoute?.answerId
    val connection = backend?.client?.state?.collectAsStateWithLifecycle()?.value
    val answerTabs = connection?.let { answersProjectTabs(it, chat?.workerId) }.orEmpty()
    // Report-capable phones get Chat and Tasks even when their backend does not advertise Answers.
    val projectTabs = if (phoneWidth && chat != null && chat.workerId == null && answerTabs.isEmpty() &&
        connection?.supports("board") == true && connection.supports(HarnessFeature.TASK_REPORTS)) {
        listOf(AnswersProjectTab.Chat, AnswersProjectTab.Tasks)
    } else answerTabs
    val phoneTasksTab = phoneWidth && current is Destination.Panel && current.tab == PanelTab.Board && AnswersProjectTab.Tasks in projectTabs
    val coordinatorThreads = if (phoneTasksTab && context != null) projectThreads(context, connection?.supports("threads") == true)?.value?.threads.orEmpty() else emptyList()
    val headerContext = if (phoneTasksTab && context != null) context.copy(navigate = { next ->
        when {
            next is Destination.Chat && next.backendKey == context.route.backendKey && next.projectId == context.route.projectId &&
                next.highlight == null && coordinatorForChat(next, coordinatorThreads) != null -> {
                // Back from Tasks must return to the coordinator whose tasks are now on screen.
                updateBackStack { previous -> previous.back().push(next).push(Destination.Panel(next, PanelTab.Board)) }
            }
            next is Destination.Panel && next.tab != PanelTab.Board -> updateBackStack { it.push(next) }
            else -> navigate(next)
        }
    }) else context
    // Recent notices can outlive a server rollback. Keep their original chat target in the stack.
    LaunchedEffect(answersRoute, connection?.hello, projectTabs) {
        if (answersRoute != null && connection?.hello != null && AnswersProjectTab.Answers !in projectTabs) pop()
    }
    val catalogue = if (AnswersProjectTab.Answers in projectTabs && chat != null) backend!!.answers(chat.projectId) else null
    val answerCatalogue = catalogue?.catalogue?.collectAsStateWithLifecycle()?.value
    val unreadAnswers = hasUnreadAnswers(answerCatalogue?.answers.orEmpty())
    val taskAttention = if (!phoneTask && context != null && chat?.workerId == null) rememberTaskAttentionCount(context) else 0L
    val selectProjectTab: (AnswersProjectTab) -> Unit = select@{ tab ->
        val origin = chat ?: return@select
        val target = when (tab) {
            AnswersProjectTab.Chat -> origin
            AnswersProjectTab.Tasks -> Destination.Panel(origin, PanelTab.Board)
            AnswersProjectTab.Answers -> Destination.Answers(origin)
        }
        updateBackStack { previous ->
            val active = previous.current
            if (active == target || active is Destination.Chat && target is Destination.Chat) previous
            else if (target is Destination.Chat && previous.entries.getOrNull(previous.entries.lastIndex - 1)?.let {
                it is Destination.Chat && it.chatRoute() == target
            } == true) previous.back()
            else if (active is Destination.Panel || active is Destination.Answers) previous.replaceSibling(target)
            else previous.push(target)
        }
    }
    val openAnswerList: () -> Unit = open@{
        val origin = chat ?: return@open
        val list = Destination.Answers(origin)
        updateBackStack { previous ->
            if (previous.entries.getOrNull(previous.entries.lastIndex - 1) == list) previous.back()
            else previous.replaceSibling(list)
        }
    }
    val latestPanelTabs by rememberUpdatedState(projectTabs)
    val latestUnreadAnswers by rememberUpdatedState(unreadAnswers)
    val latestTaskAttention by rememberUpdatedState(taskAttention)
    val latestSelectProjectTab by rememberUpdatedState(selectProjectTab)
    val latestPanelContext by rememberUpdatedState(context)
    val latestPhoneTasksTab by rememberUpdatedState(phoneTasksTab)
    val latestPanelTab by rememberUpdatedState(panel?.tab ?: PanelTab.Info)
    val latestAllJobs by rememberUpdatedState(panel?.allJobs == true)
    // Expansion belongs to the originating conversation and survives unrelated detours.
    val panelKey = panel?.screenStateKey()
    val panelExpanded = panelKey != null && panelKey in expandedPanels
    fun togglePanelExpanded() {
        panelKey?.let { key -> expandedPanels = if (key in expandedPanels) expandedPanels - key else expandedPanels + key }
    }
    val latestPanelExpanded by rememberUpdatedState(panelExpanded)
    val latestToggleExpanded by rememberUpdatedState(::togglePanelExpanded)
    val latestClosePanel by rememberUpdatedState<() -> Unit>({
        panelKey?.let { key -> expandedPanels = expandedPanels - key }; pop()
    })
    var panelExpandable by remember { mutableStateOf(false) }
    // One stable composition identity regardless of which adaptive parent hosts it.
    val panelBody = remember {
        movableContentOf<Modifier> { panelModifier ->
            latestPanelContext?.let { currentContext ->
                panelState.SaveableStateProvider(currentContext.route.screenStateKey()) {
                    PanelSurface(
                        currentContext, latestPanelTab, { latestClosePanel() }, panelModifier, allJobs = latestAllJobs,
                        expanded = latestPanelExpanded, toggleExpanded = if (panelExpandable) ({ latestToggleExpanded() }) else null,
                        projectTabs = if (latestPanelTab == PanelTab.Board && AnswersProjectTab.Tasks in latestPanelTabs) latestPanelTabs else emptyList(),
                        unreadAnswers = latestUnreadAnswers, taskAttention = latestTaskAttention, selectProjectTab = { latestSelectProjectTab(it) },
                        projectTab = latestPhoneTasksTab,
                    )
                }
            }
        }
    }
    var htmlArtifactViewport by remember(current) { mutableStateOf(false) }
    val apps = io.github.mitzacoder.kemiri.features.apps.rememberProjectApps(backend?.client, chat?.projectId)
    val tabs = if (backend != null) rememberPanelTabs(backend.client) else emptyList()
    CompositionLocalProvider(LocalNestedBackTargets provides nestedBackTargets, io.github.mitzacoder.kemiri.features.apps.LocalProjectApps provides apps) {
    LaunchedEffect(wide) { if (wide) drawer.snapTo(DrawerValue.Closed) }
    ModalNavigationDrawer(
        drawerState = drawer,
        gesturesEnabled = (!phoneTask && current !is Destination.ArtifactStudio && !codeView && !wide) || drawer.isOpen,
        drawerContent = {
            if (!wide) {
                var drawerWidth by remember { mutableIntStateOf(0) }
                val revealed by remember(drawer) { derivedStateOf {
                    drawer.currentValue != DrawerValue.Closed || drawer.targetValue != DrawerValue.Closed ||
                        drawerWidth > 0 && drawer.currentOffset > -drawerWidth + 1f
                } }
                ModalDrawerSheet(Modifier.width(DrawerDefaults.MaximumDrawerWidth).onSizeChanged { drawerWidth = it.width }) {
                    if (revealed) {
                        drawerSaveableState.SaveableStateProvider("projects-drawer") {
                            ProjectsDrawer(repository, current, navigate, unknownBackend) { unknownBackend = null }
                        }
                    }
                }
            }
        },
    ) {
        Row(Modifier.fillMaxSize()) {
        if (wide && !htmlArtifactViewport && current !is Destination.ArtifactStudio && !codeView) ProjectsSidebar(repository, current, navigate, sidebarCollapsed, toggleCollapsed = {
            sidebarCollapsed = !sidebarCollapsed
            navPreferences.edit { putBoolean("collapsed", sidebarCollapsed) }
        }, unknownBackend = unknownBackend, dismissUnknownBackend = { unknownBackend = null })
        // Task and ref links reach the chat, the panels and the task sheet, which all sit inside.
        ProvideTaskLinks(context) { ProvideRefLinks(context) {
        BoxWithConstraints(Modifier.weight(1f).fillMaxHeight()) {
            val sideBySide = panel != null && !phoneTasksTab && maxWidth >= 840.dp && context != null
            val visibleContext = context?.copy(activePanel = if (sideBySide) resolvedPanelTab(panel.tab, tabs) else null)
            // The Tasks board takes the full width over the chat, not the side panel's.
            val boardWide = sideBySide && (showsTasksBoard(visibleContext!!, visibleContext.activePanel) ||
                (panel.tab == PanelTab.Board && projectTabs.isNotEmpty()))
            val panelWide = boardWide || (sideBySide && panelExpanded)
            SideEffect { panelExpandable = sideBySide && !boardWide }
            // The header's row follows the chat column, which narrows while a panel sits beside it.
            val chatWidth = if (sideBySide && !panelWide) maxWidth - 401.dp else maxWidth
            if (!phoneTask || context == null) Row(Modifier.fillMaxSize()) {
                Scaffold(
                    modifier = Modifier.weight(1f),
                    topBar = { Column {
                        val projectHeader = current is Destination.Chat || current is Destination.Panel || current is Destination.Task ||
                            (answersRoute != null && answerId == null)
                        // The terminal screen draws its own header: Sessions, the connection and the tabs belong to it.
                        if (terminal == null && !htmlArtifactViewport && current !is Destination.ArtifactStudio && !codeView) TopAppBar(
                            expandedHeight = (if (projectHeader && context != null) 56.dp else 64.dp) *
                                (if (context != null) LocalDensity.current.fontScale.coerceAtLeast(1f) else 1f),
                            title = {
                                if (answerId != null) Text("Answers")
                                else if (current.isSettings()) Text("Settings")
                                else if (headerContext != null) ProjectHeaderTitle(headerContext, chatWidth)
                                else Text(when (current) {
                                    Destination.Usage -> "Usage"
                                    Destination.ArtifactLibrary -> "Artifacts"
                                    else -> "Kemiri"
                                })
                            },
                            navigationIcon = {
                                if (answerId != null) JarvisIconButton(Lucide.ArrowLeft, "Back to Answers", onClick = openAnswerList)
                                else if (!wide) JarvisIconButton(Lucide.Menu, "Open projects", onClick = { scope.launch { drawer.open() } })
                            },
                            actions = {
                                if (resolvedBack() != null && !projectHeader && answerId == null) JarvisIconButton(Lucide.ArrowLeft, "Back", onClick = { resolvedBack()?.invoke() })
                                if (current.isSettings()) JarvisIconButton(Lucide.X, "Close settings", onClick = settingsNavigator.close)
                                if (headerContext != null && projectHeader) ProjectHeaderActions(headerContext, panel, chatWidth, ::pop,
                                    tasksInTabs = AnswersProjectTab.Tasks in projectTabs && (current !is Destination.Panel || phoneTasksTab), questions = taskAttention)
                            },
                        )
                        if (projectTabs.isNotEmpty() && (phoneTasksTab || current is Destination.Chat || (answersRoute != null && answerId == null))) {
                            val selectedTab = when {
                                phoneTasksTab -> AnswersProjectTab.Tasks
                                answersRoute != null -> AnswersProjectTab.Answers
                                else -> AnswersProjectTab.Chat
                            }
                            AnswersProjectTabRow(projectTabs, selectedTab, unreadAnswers, taskAttention, selectProjectTab)
                        }
                    } },
                ) { padding ->
                    val modifier = if (current is Destination.ArtifactStudio) Modifier.fillMaxSize() else Modifier.fillMaxSize().padding(padding)
                    if (!loaded) Box(modifier) { CircularProgressIndicator() }
                    else if (phoneTasksTab && context != null) panelBody(modifier.consumeWindowInsets(padding))
                    else screenState.SaveableStateProvider(
                        // Switching chats changes the coordinator state, not the project screen.
                        if (context != null && (current is Destination.Chat || current is Destination.Panel || current is Destination.Task))
                            "chats:${Destination.Chat(context.route.backendKey, context.route.projectId).screenStateKey()}"
                        else current.screenStateKey()
                    ) {
                        when (current) {
                            Destination.Home -> ProjectsHome(repository, navigate, modifier)
                            Destination.Usage -> UsageScreen(repository, modifier, navigate)
                            Destination.ArtifactLibrary -> ArtifactLibraryScreen(repository, sessions, artifactLibraryReads, modifier, navigate, onDiscuss = ::discuss)
                            is Destination.ArtifactStudio -> if (context != null) ArtifactStudioScreen(context, current.artifactId, ::pop, modifier, onDiscuss = { discuss(context.route, it) }) else MissingBackend(modifier)
                            is Destination.Settings -> GeneralSettingsScreen(repository, current.page, settingsNavigator, requireNotNull(settingsScopes), navigate, connectPayload, onConnectHandled, modifier)
                            is Destination.ProjectSettings -> if (context != null) ProjectSettingsScreen(context, current.section, current.scheduleId, settingsNavigator, requireNotNull(settingsScopes), modifier, current.unavailableSection, current.advancedGroup) else MissingProjectSettings(settingsNavigator, requireNotNull(settingsScopes), modifier)
                            is Destination.Chat, is Destination.Panel, is Destination.Task -> if (context != null) ChatScreen(visibleContext!!, modifier) else MissingBackend(modifier)
                            is Destination.Answers -> if (context == null) MissingBackend(modifier)
                                else if (AnswersProjectTab.Answers !in projectTabs) Box(modifier) { CircularProgressIndicator() }
                                else if (current.answerId == null) AnswersTab(context, { navigate(current.copy(answerId = it)) }, modifier)
                                else AnswerPage(context, current.answerId, openAnswerList, modifier.consumeWindowInsets(padding))
                            is Destination.Artifact -> if (context != null) ArtifactScreen(context, current.artifactId, modifier, onBack = ::pop, onFullHeightChange = { htmlArtifactViewport = it }, onDiscuss = { discuss(context.route, it) }) else MissingBackend(modifier)
                            is Destination.Changes -> if (context != null) io.github.mitzacoder.kemiri.features.changes.ChangesScreen(context, current, modifier.consumeWindowInsets(padding), ::pop) else MissingBackend(modifier)
                            is Destination.Files -> if (context != null) io.github.mitzacoder.kemiri.features.files.FilesScreen(context, current, modifier.consumeWindowInsets(padding), ::pop) else MissingBackend(modifier)
                            is Destination.WorkingChanges -> if (context != null) io.github.mitzacoder.kemiri.features.changes.WorkingChangesScreen(context, current, modifier.consumeWindowInsets(padding), ::pop) else MissingBackend(modifier)
                            is Destination.Terminal -> sessions.firstOrNull { it.config.key == current.backendKey }
                                ?.let { TerminalScreen(it, current, onBack = ::pop, modifier = modifier) } ?: MissingBackend(modifier)
                        }
                    }
                }
                if (sideBySide && !panelWide) {
                    VerticalDivider(Modifier.fillMaxHeight())
                    panelBody(Modifier.width(400.dp).fillMaxHeight())
                }
            }
            if (panelWide) Surface(Modifier.fillMaxSize()) { panelBody(Modifier.fillMaxSize()) }
            if (panel != null && !phoneTasksTab && !sideBySide && context != null) {
                // Fullscreen phone sheet: explicit opening only, back/dismiss returns to the same chat/watch.
                Dialog(onDismissRequest = { resolvedBack()?.invoke() }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
                    val view = LocalView.current
                    val dark = Jarvis.colors.dark
                    SideEffect {
                        (view.parent as? DialogWindowProvider)?.window?.let { window ->
                            WindowCompat.getInsetsController(window, view).apply {
                                isAppearanceLightStatusBars = !dark
                                isAppearanceLightNavigationBars = !dark
                            }
                        }
                    }
                    Box(Modifier.fillMaxSize()) {
                        panelBody(Modifier.fillMaxSize())
                        if (current !is Destination.Task) InAppBannerHost(repository, openAlert, openAlertNeedsYou)
                    }
                }
            }
            // After the panel's dialog, so the sheet opens over it.
            if (current is Destination.Task && context != null) {
                val previousTask = (stack.getOrNull(stack.lastIndex - 1) as? Destination.Task)?.takeIf { it.chat == current.chat && it.taskId == current.fromTaskId }
                screenState.SaveableStateProvider("task-sheet:" + current.screenStateKey() + ":" + current.taskId) {
                    // Dialog recreates its registry on return; keep the reading position outside it.
                    TaskSheet(context, current.taskId, onDismiss = ::pop, inWindow = phoneTask, bodyState = androidx.compose.foundation.lazy.rememberLazyListState(), previousTaskId = previousTask?.taskId, overlay = { InAppBannerHost(repository, openAlert, openAlertNeedsYou) })
                }
            }
            if (context != null) io.github.mitzacoder.kemiri.features.tasks.CloseTaskPartsDialog(context.board)
            if (current !is Destination.Task && (panel == null || sideBySide || phoneTasksTab) && drawer.isClosed) {
                InAppBannerHost(repository, openAlert, openAlertNeedsYou)
            }
        }
        } }
        }
    }
    }
}

/** SharedPreferences holding the projects sidebar's rail state (web `aiki.projects-nav.v1`). */
private const val PROJECTS_NAV_PREFERENCES = io.github.mitzacoder.kemiri.BuildConfig.PREFERENCES_PREFIX + ".projects-nav.v1"

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PanelSurface(
    context: ProjectScreenContext,
    initialTab: PanelTab,
    close: () -> Unit,
    modifier: Modifier,
    allJobs: Boolean = false,
    expanded: Boolean = false,
    toggleExpanded: (() -> Unit)? = null,
    projectTabs: List<AnswersProjectTab> = emptyList(),
    unreadAnswers: Boolean = false,
    taskAttention: Long = 0,
    selectProjectTab: (AnswersProjectTab) -> Unit = {},
    projectTab: Boolean = false,
) {
    val title = io.github.mitzacoder.kemiri.features.panels.panelTabLabel(initialTab, rememberTasksView(context.backend.client))
    Scaffold(modifier.semantics { contentDescription = title }, topBar = { if (!projectTab) Column {
        TopAppBar(title = { Text(title, Modifier.semantics { heading() }) }, navigationIcon = {
            JarvisIconButton(Lucide.X, "Close panels", onClick = close)
        }, actions = {
            // Beside the chat only: a phone's panel and the Tasks board already take the whole width.
            toggleExpanded?.let {
                JarvisIconButton(
                    if (expanded) NavGlyphs.Minimize2 else NavGlyphs.Maximize2,
                    if (expanded) "Collapse the sidebar" else "Expand the sidebar",
                    onClick = it,
                )
            }
        })
        if (projectTabs.isNotEmpty()) AnswersProjectTabRow(projectTabs, AnswersProjectTab.Tasks, unreadAnswers, taskAttention, selectProjectTab)
    } }) { padding -> PanelsScreen(context, initialTab, Modifier.fillMaxSize().padding(padding), allJobs = allJobs, projectTab = projectTab) }
}

@Composable private fun MissingBackend(modifier: Modifier) { Text("This backend was removed. Choose a project from the drawer.", modifier) }
