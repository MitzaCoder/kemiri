package io.github.mitzacoder.kemiri.navigation

import io.github.mitzacoder.kemiri.ui.rememberAppTime
import io.github.mitzacoder.kemiri.features.coordinators.*

import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.features.settings.ConnectionBadge
import io.github.mitzacoder.kemiri.features.status.ReleaseLine
import io.github.mitzacoder.kemiri.features.status.SERVER_STATUS_FEATURE
import io.github.mitzacoder.kemiri.features.status.StatusGlyphs
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.components.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

/**
 * The chat's top bar, the twin of the web's `ProjectChat` header: the project's name over a meta line (backend ·
 * coordinator model · running tool · release), a title conversation switcher, Tasks with its count always in the row, and
 * Info, Memory, the mute bell and Settings beside them on a wide screen or in a "⋯" menu on a phone. The menu carries a
 * dot in the connection's tone when it is not connected, the connection badge and the release.
 */

/**
 * The header's mute bell, provided by the notifications feature (track F) around the app. Null, or a null [muted] flow
 * for a backend, hides the bell.
 */
interface ProjectMute {
    /** Whether this device has [projectId] muted; null when [backend] cannot push to this device. */
    fun muted(backend: BackendSession, projectId: String): StateFlow<Boolean>?
    suspend fun toggle(backend: BackendSession, projectId: String)
}

val LocalProjectMute = staticCompositionLocalOf<ProjectMute?> { null }

/** One control in the header: a panel tab or a utility (mute, settings). */
private data class HeaderAction(
    val id: String,
    /** What it is called, count included, for accessibility. */
    val name: String,
    val label: String,
    val icon: LucideIcon,
    val count: String? = null,
    val workingCount: String? = null,
    val needsYouBadge: Boolean = false,
    /** Tasks stays in the row on a phone. */
    val primary: Boolean = false,
    val pressed: Boolean = false,
    val onClick: () -> Unit,
)

/** Where the header's row is wide enough for every control (a tablet, or a phone in landscape). */
private val INLINE_HEADER_WIDTH: Dp = 600.dp
/** Where Tasks also shows its label. */
private val PRIMARY_LABELS_HEADER_WIDTH: Dp = 720.dp
/** Where every panel button shows its label. */
private val LABELLED_HEADER_WIDTH: Dp = 960.dp

enum class ConnectionTone { Ok, Warn, Error, Muted }

fun connectionTone(status: ConnectionStatus): ConnectionTone = when (status) {
    ConnectionStatus.Ready -> ConnectionTone.Ok
    ConnectionStatus.Connecting, ConnectionStatus.Reconnecting -> ConnectionTone.Warn
    ConnectionStatus.Closed -> ConnectionTone.Error
    ConnectionStatus.Idle -> ConnectionTone.Muted
}

private fun threadOf(id: String?): String = id?.ifBlank { null } ?: MAIN_THREAD_ID

/** A model as it reads: its catalog name, else provider/id, "No model" when none is chosen (web `modelLabel`). */
fun modelLabel(model: ModelRef?, models: List<ModelInfo>): String {
    if (model == null) return "No model"
    return models.firstOrNull { it.provider == model.provider && it.modelId == model.modelId }?.name ?: "${model.provider}/${model.modelId}"
}

/**
 * The chat's title and the line under it (web `ProjectChat` / `WorkerTranscript` headers). Main: the project's name over
 * backend · coordinator model · running tool. A thread: a back arrow, its title (and status on a wide screen) over
 * "Background job of project · model · what it does now". A worker: a back arrow, its title over "id · project".
 * The line ends in amber with the connection's state while it is not connected.
 */
@Composable
fun ProjectHeaderTitle(context: ProjectScreenContext, width: Dp) {
    val backend = context.backend
    val route = context.route
    val client = backend.client
    val projects by backend.projects.collectAsStateWithLifecycle()
    val models by backend.models.collectAsStateWithLifecycle()
    val connection by client.state.collectAsStateWithLifecycle()
    val status by backend.serverStatus.status.collectAsStateWithLifecycle()
    val project = projects.firstOrNull { it.id == route.projectId }
    val now = rememberAppTime(15_000)
    val thread = threadOf(route.threadId) != MAIN_THREAD_ID
    val workers = projectWorkers(context, route.workerId != null && connection.supports("workers"))?.value?.workers.orEmpty()
    val threads = projectThreads(context, route.workerId == null && connection.supports("threads"))?.value?.threads.orEmpty()
    val worker = route.workerId?.let { id -> workers.firstOrNull { it.id == id && threadOf(it.threadId) == threadOf(route.threadId) } }
    val threadSummary = if (thread) threads.firstOrNull { it.id == route.threadId } else null
    val coordinator = threads.firstOrNull { connection.supports("coordinators") && route.workerId == null &&
        it.id == threadOf(route.threadId) && (it.main || it.kind == "coordinator") }
    val title = when {
        coordinator != null -> coordinator.title
        route.workerId != null -> worker?.title?.ifBlank { null } ?: route.workerId
        thread -> threadSummary?.title?.ifBlank { null } ?: route.threadId.orEmpty()
        else -> project?.name ?: "Project"
    }
    val meta = buildList {
        when {
            route.workerId != null -> { add(route.workerId); project?.let { add(it.name) } }
            thread -> {
                add("Background job of " + (project?.name ?: "project"))
                threadSummary?.model?.let { add(modelLabel(it, models)) }
                threadSummary?.let { add(io.github.mitzacoder.kemiri.features.panels.threadActivity(it)) }
            }
            else -> {
                add("Main chat"); add(backend.config.name)
                project?.let { add(modelLabel(it.coordinator.model, models)) }
                project?.activity?.runningTool?.let { tool ->
                    val elapsed = elapsedFor(tool.startedAt, now)
                    add("Running ${tool.name}${if (elapsed.isNotEmpty()) " · $elapsed" else ""}")
                }
            }
        }
    }
    val away = connectionAwayWord(connection.status)
    val canSwitch = route.workerId == null && connection.supports("threads")
    var switcher by rememberSaveable(route) { mutableStateOf(false) }
    var coordinatorPage by rememberSaveable(route) { mutableStateOf<String?>(null) }
    if (connection.supports("coordinators")) when (coordinatorPage) {
        "new" -> CoordinatorEditor(context, null, dismiss = { coordinatorPage = null })
        "manage" -> CoordinatorManager(context, threads, dismiss = { coordinatorPage = null })
    }
    val background = project?.activity?.backgroundJobs ?: io.github.mitzacoder.kemiri.features.chat.backgroundJobCounts(threads)
    if (switcher && canSwitch) ConversationSwitcher(context, threads, now, onCoordinatorPage = { coordinatorPage = it }) { switcher = false }
    Row(verticalAlignment = Alignment.CenterVertically) {
        if (route.workerId != null || thread) {
            val back = if (context.goBack != null) "Back" else if (route.workerId != null && thread) "Back to the background job" else "Back to Main chat"
            IconButton(onClick = { context.goBack?.invoke() ?: context.navigate(if (route.workerId != null) route.copy(workerId = null) else route.copy(threadId = null, workerId = null)) },
                modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).semantics { contentDescription = back }) { LucideGlyph(Lucide.ArrowLeft, size = 18.dp) }
        }
        Column(Modifier.weight(1f, fill = false).then(if (canSwitch) Modifier.heightIn(min = 48.dp)
            .clickable(role = Role.Button, onClickLabel = "Switch conversation") { switcher = true }
            .semantics(mergeDescendants = true) { stateDescription = "${background.needsYou} needs you, ${background.working} working" }
            else Modifier)) {
            if (coordinator != null) Text(project?.name ?: "Project", style = MaterialTheme.typography.labelSmall, color = Jarvis.colors.fgMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (coordinator != null) CoordinatorMark(coordinator)
                Text(title, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (canSwitch) LucideGlyph(Lucide.ChevronDown, size = 16.dp)
            }
            if (canSwitch && coordinator == null) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (threadSummary != null) StatusBadge(io.github.mitzacoder.kemiri.features.chat.threadState(threadSummary), domain = "thread")
                else Text(if (thread) "Background job" else "Main chat", style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgSubtle)
                HeaderBadge(background.needsYou.toString(), attention = true)
                Surface(shape = CircleShape, color = Jarvis.colors.surface2, contentColor = Jarvis.colors.fgMuted) {
                    Text(background.working.toString(), Modifier.padding(horizontal = 6.dp, vertical = 2.dp), style = MaterialTheme.typography.labelSmall)
                }
            }
            if (!canSwitch) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(meta.joinToString(" · "), Modifier.weight(1f, fill = false), style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgSubtle,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                // The release is in the menu on a phone, so the line stays one line; a tablet has room for it here.
                if (route.workerId == null && width >= INLINE_HEADER_WIDTH && connection.supports(SERVER_STATUS_FEATURE) && status != null) {
                    Text("·", style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgSubtle)
                    ReleaseLine(status, compact = true)
                }
                if (away != null) {
                    Text("·", style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgSubtle)
                    Text(away, style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.warning, maxLines = 1)
                }
            }
        }
    }
}

/** The word the header's line ends with while the backend is not connected (web: the transcript's state, in amber). */
fun connectionAwayWord(status: ConnectionStatus): String? = when (status) {
    ConnectionStatus.Ready -> null
    ConnectionStatus.Idle, ConnectionStatus.Connecting -> "connecting"
    ConnectionStatus.Reconnecting -> "reconnecting"
    ConnectionStatus.Closed -> "stopped"
}

/**
 * The header's controls for a project route. [panel] is the open panel (a toggle closes it on a tablet); [width] is the
 * chat column's width, which decides between the inline row and the phone's menu.
 */
@Composable
internal fun rememberTaskAttentionCount(context: ProjectScreenContext): Long {
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    val threads = rememberCoordinatorThreads(context, connection.supports("task-coordinator") && connection.supports("coordinators"))
    val coordinator = coordinatorRoster(threads).find { it.id == coordinatorOfThread(context.route.threadId, threads) }
    if (coordinator != null) return coordinatorBadges(coordinator).needsYou
    val board = context.board
    val taskState = connection.supports("task-state")
    val count by remember(board, taskState) {
        board.select { view ->
            if (taskState && view.tasks.any { it.state != null })
                io.github.mitzacoder.kemiri.features.tasks.board.needsYouCount(view.tasks, view.questions).toLong()
            else view.openQuestionCount.toLong()
        }
    }.collectAsStateWithLifecycle(remember(board) { board.view.value.openQuestionCount.toLong() })
    return count
}

@Composable
fun RowScope.ProjectHeaderActions(context: ProjectScreenContext, panel: Destination.Panel?, width: Dp, close: () -> Unit, tasksInTabs: Boolean, questions: Long) {
    val backend = context.backend
    val route = context.route
    val client = backend.client
    val connection by client.state.collectAsStateWithLifecycle()
    val tabs = rememberPanelTabs(client)
    val board = context.board
    val workers = projectWorkers(context, route.workerId != null && connection.supports("workers"))?.value?.workers.orEmpty()
    val mute = LocalProjectMute.current
    // Asked again on every connection: whether the bell shows depends on what the backend supports.
    val mutedFlow = remember(mute, backend, route.projectId, connection.hello) { mute?.muted(backend, route.projectId) }
    val muted = mutedFlow?.collectAsStateWithLifecycle()?.value
    val scope = rememberCoroutineScope()
    val status by backend.serverStatus.status.collectAsStateWithLifecycle()

    fun toggle(tab: PanelTab) { if (panel?.tab == tab) close() else context.navigate(Destination.Panel(route, tab)) }
    val hasTaskStates by remember(board) { board.select { it.tasks.any { task -> task.state != null } } }
        .collectAsStateWithLifecycle(false)
    val derivedCounts = connection.supports("task-state") && hasTaskStates
    val tasksName = if (connection.supports(HarnessFeature.TASK_REPORTS)) "Tasks" else "Board"
    // A worker's page offers what reads its transcript: its context and memory (web `WorkerTranscript`).
    val worker = route.workerId != null
    val actions = buildList {
        if (PanelTab.Board in tabs && !worker && !tasksInTabs) add(HeaderAction("board", tasksName + if (questions > 0) " (${if (derivedCounts) "$questions need you" else questionsWaitingLabel(questions)})" else "", tasksName,
            StatusGlyphs.ClipboardList, questionBadgeText(questions), primary = true, pressed = panel?.tab == PanelTab.Board) { toggle(PanelTab.Board) })
        if (PanelTab.Info in tabs) add(HeaderAction("info", if (worker) "This worker's context" else "Conversation info", "Info", Lucide.Info, pressed = panel?.tab == PanelTab.Info) { toggle(PanelTab.Info) })
        if (PanelTab.Artifacts in tabs) add(HeaderAction("artifacts", "Artifacts", "Artifacts", Lucide.Paperclip, pressed = panel?.tab == PanelTab.Artifacts) { toggle(PanelTab.Artifacts) })
        if (PanelTab.Memory in tabs) add(HeaderAction("memory", "Memory", "Memory", StatusGlyphs.BookOpen, pressed = panel?.tab == PanelTab.Memory) { toggle(PanelTab.Memory) })
        // The old panel tabs were the only route to Artifacts. Keep it reachable from the header too.
        val checkoutWorker = workers.firstOrNull { it.id == route.workerId }
        val checkout = io.github.mitzacoder.kemiri.features.files.preferredCheckout(checkoutWorker, checkoutWorker?.threadId ?: route.threadId)
        if (connection.supports("project-files")) {
            add(HeaderAction("files", "Browse files in this checkout", "Files", Lucide.FileText) {
                context.navigate(Destination.Files(route, root = checkout, taskId = context.taskOrigin))
            })
            if ((worker || route.threadId != null) && connection.supports("project-changes-working") && connection.supports("project-changes")) {
                val title = checkoutWorker?.title?.takeIf { it.isNotBlank() }?.let { "Workspace · $it" }
                    ?: if (route.threadId != null) "Background job checkout" else "Project folder"
                add(HeaderAction("working-changes", "Uncommitted changes", "Uncommitted changes", Lucide.Code) {
                    context.navigate(Destination.WorkingChanges(route, checkout, title, taskId = checkoutWorker?.taskId))
                })
            }
        }
        // A shell on this backend in the project's folder (a worker's page: in its workspace), on a screen of its own.
        if (connection.supports(HarnessFeature.TERMINAL)) {
            val workspace = route.workerId?.let { id -> workers.firstOrNull { it.id == id }?.workspacePath }
            add(HeaderAction("terminal", if (worker && workspace != null) "Open a terminal in this worker's workspace" else if (worker) "Open a terminal in the project folder" else "A terminal on this backend, in the project folder",
                "Terminal", Lucide.Terminal) { context.navigate(Destination.Terminal(backend.config.key, route.projectId, route.workerId)) })
        }
        if (mute != null && muted != null && !worker) add(HeaderAction("mute", if (muted) "Unmute notifications for this project" else "Mute notifications for this project",
            if (muted) "Unmute notifications" else "Mute notifications", if (muted) StatusGlyphs.BellOff else StatusGlyphs.Bell, pressed = muted) {
            scope.launch { mute.toggle(backend, route.projectId) }
        })
        if (!worker) add(HeaderAction("settings", "Project settings", "Project settings", Lucide.Settings2) { context.navigate(Destination.ProjectSettings(route)) })
    }
    val inline = width >= INLINE_HEADER_WIDTH
    val labelled = width >= LABELLED_HEADER_WIDTH
    val primaryLabelled = width >= PRIMARY_LABELS_HEADER_WIDTH
    val tone = connectionTone(connection.status)
    if (inline) {
        // The mute bell and the gear stay icons at every width, as on the web.
        actions.forEach { HeaderButton(it, showLabel = it.id !in setOf("mute", "settings") && (labelled || (primaryLabelled && it.primary))) }
        Box(Modifier.padding(horizontal = 4.dp)) { ConnectionBadge(connection.status, connection.attempt) }
        return
    }
    actions.filter { it.primary }.forEach { HeaderButton(it, showLabel = false) }
    var menu by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { menu = true }, modifier = Modifier.semantics { contentDescription = "More actions" + if (tone != ConnectionTone.Ok) ", ${connection.status.name.lowercase()}" else "" }) {
            Box {
                LucideGlyph(Lucide.MoreHorizontal, size = 20.dp)
                if (tone != ConnectionTone.Ok) Box(Modifier.align(Alignment.TopEnd).offset(x = 3.dp, y = (-3).dp).size(7.dp).background(toneColor(tone), CircleShape))
            }
        }
        DropdownMenu(menu, { menu = false }) {
            val palette = headerPanelPalette(Jarvis.colors.dark, Jarvis.colors.neutral)
            actions.filterNot { it.primary }.forEach { action ->
                val panelSelected = action.pressed && action.id != "mute"
                DropdownMenuItem(
                    text = { Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(action.label)
                        action.count?.let { Spacer(Modifier.width(6.dp)); HeaderBadge(it, action.needsYouBadge) }
            action.workingCount?.let { Spacer(Modifier.width(6.dp)); Text(it, style = MaterialTheme.typography.labelSmall, color = Jarvis.colors.fgMuted) }
                    } },
                    leadingIcon = { LucideGlyph(action.icon, size = 18.dp) },
                    trailingIcon = if (action.pressed && action.id != "mute") ({ LucideGlyph(Lucide.Check, size = 16.dp) }) else null,
                    onClick = { menu = false; action.onClick() },
                    modifier = Modifier.padding(horizontal = 8.dp)
                        .background(if (panelSelected) palette.background else Color.Transparent, CircleShape)
                        .semantics { contentDescription = action.name; selected = action.pressed },
                    colors = MenuDefaults.itemColors(
                        textColor = if (panelSelected) palette.foreground else Jarvis.colors.fgMuted,
                        leadingIconColor = if (panelSelected) palette.foreground else Jarvis.colors.fgMuted,
                        trailingIconColor = palette.foreground,
                    ),
                )
            }
            HorizontalDivider(Modifier.padding(vertical = 4.dp))
            Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                ConnectionBadge(connection.status, connection.attempt)
                if (connection.supports(SERVER_STATUS_FEATURE)) ReleaseLine(status, compact = true)
            }
        }
    }
}

@Composable
private fun toneColor(tone: ConnectionTone): Color = when (tone) {
    ConnectionTone.Ok -> Jarvis.colors.success
    ConnectionTone.Warn -> Jarvis.colors.warning
    ConnectionTone.Error -> Jarvis.colors.danger
    ConnectionTone.Muted -> Jarvis.colors.fgSubtle
}

@Composable
private fun HeaderButton(action: HeaderAction, showLabel: Boolean) {
    val colors = Jarvis.colors
    val palette = headerPanelPalette(colors.dark, colors.neutral)
    val panelSelected = action.pressed && action.id != "mute"
    val tint = if (panelSelected) palette.foreground else if (action.pressed) colors.fg else colors.fgMuted
    val background = if (panelSelected) palette.background else if (action.pressed) colors.surface2 else Color.Transparent
    val badge: @Composable BoxScope.() -> Unit = {
        Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            action.count?.let { HeaderBadge(it, action.needsYouBadge) }
            action.workingCount?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = colors.fgMuted) }
        }
    }
    if (showLabel) {
        TextButton(onClick = action.onClick, modifier = Modifier.semantics { contentDescription = action.name; selected = action.pressed },
            colors = ButtonDefaults.textButtonColors(contentColor = tint, containerColor = background)) {
            LucideGlyph(action.icon, size = 18.dp)
            Spacer(Modifier.width(6.dp))
            Text(action.label)
            action.count?.let { Spacer(Modifier.width(6.dp)); HeaderBadge(it, action.needsYouBadge) }
            action.workingCount?.let { Spacer(Modifier.width(6.dp)); Text(it, style = MaterialTheme.typography.labelSmall, color = Jarvis.colors.fgMuted) }
        }
    } else {
        IconButton(onClick = action.onClick, modifier = Modifier.semantics { contentDescription = action.name; selected = action.pressed },
            colors = IconButtonDefaults.iconButtonColors(containerColor = background)) {
            BadgedBox(badge = badge) { LucideGlyph(action.icon, size = 20.dp, tint = tint) }
        }
    }
}

/** Same AA accent pairs as the web header, independent of Material's filled-button primary. */
internal data class HeaderPanelPalette(val foreground: Color, val background: Color)
internal fun headerPanelPalette(dark: Boolean, neutral: Boolean = false) = if (neutral) {
    if (dark) HeaderPanelPalette(Color(0xFFFAFAFA), Color(0xFF404040))
    else HeaderPanelPalette(Color(0xFF171717), Color(0xFFD4D4D4))
} else if (dark)
    HeaderPanelPalette(Color(0xFFC7D2FE), Color(0xFF312E81))
else HeaderPanelPalette(Color(0xFF4338CA), Color(0xFFE0E7FF))

@Composable
private fun HeaderBadge(count: String, attention: Boolean = false) {
    val dark = Jarvis.colors.dark
    Badge(containerColor = if (attention) Jarvis.colors.warning else if (Jarvis.colors.neutral) MaterialTheme.colorScheme.primary else if (dark) Color(0xFF818CF8) else Color(0xFF4F46E5),
        contentColor = if (attention) Jarvis.colors.surface else if (Jarvis.colors.neutral) MaterialTheme.colorScheme.onPrimary else if (dark) Color(0xFF0B0B14) else Color.White) { Text(count) }
}
