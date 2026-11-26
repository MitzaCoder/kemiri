package io.github.mitzacoder.kemiri.features.panels

import io.github.mitzacoder.kemiri.ui.rememberAppTime
import io.github.mitzacoder.kemiri.features.coordinators.*

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.semantics.*
import androidx.compose.foundation.clickable
import androidx.compose.ui.draw.alpha
import kotlinx.coroutines.launch
import androidx.compose.runtime.saveable.rememberSaveable
import io.github.mitzacoder.kemiri.ui.components.*
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.features.tasks.board.TasksView
import io.github.mitzacoder.kemiri.features.tasks.board.TasksViewMode
import io.github.mitzacoder.kemiri.features.tasks.board.effectiveTasksViewMode
import io.github.mitzacoder.kemiri.navigation.*
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.features.tasks.QuestionCard
import io.github.mitzacoder.kemiri.features.tasks.TaskEditor
import io.github.mitzacoder.kemiri.features.tasks.TasksPanel
import io.github.mitzacoder.kemiri.features.tasks.questionAskedBy
import io.github.mitzacoder.kemiri.features.tasks.questionTaskLabel
import io.github.mitzacoder.kemiri.features.tasks.rememberTasksView

@Composable
fun PanelsScreen(context: ProjectScreenContext, initialTab: PanelTab = PanelTab.Info, modifier: Modifier = Modifier, allJobs: Boolean = false, projectTab: Boolean = false) {
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    // Keep the last hello through reconnect: a temporary offline state must not close an editor.
    val tabs = rememberPanelTabs(context.backend.client).filter { it != PanelTab.Threads || context.route.workerId == null }.sortedBy { panelTabOrder.indexOf(it) }
    val active = resolvedPanelTab(initialTab, tabs)
    val tasksView = rememberTasksView(context.backend.client)
    Column(modifier.padding(horizontal = 12.dp)) {
        if (connection.status != ConnectionStatus.Ready) Text("Offline · showing last loaded data", color = MaterialTheme.colorScheme.error)
        key(context.backend.client, context.route, active) {
            when (active) {
                // The Tasks view (list or board) on a backend with task reports; older backends keep the old board.
                PanelTab.Board -> if (tasksView) TasksTab(context, Modifier.weight(1f), projectTab) else BoardPanel(context)
                PanelTab.Threads -> ThreadsPanel(context, allJobs)
                PanelTab.Info -> InfoPanel(context)
                PanelTab.Memory -> MemoryPanel(context)
                PanelTab.Artifacts -> ArtifactsPanel(context)
                null -> Text("No panels advertised by this backend.")
            }
        }
    }
}

/** List, Board and Graph share the scope and task editor. */
@Composable
private fun TasksTab(context: ProjectScreenContext, modifier: Modifier, projectTab: Boolean) {
    val view by context.board.view.collectAsStateWithLifecycle()
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    val threads = projectThreads(context, connection.supports("threads"))?.value?.threads.orEmpty()
    val mode = effectiveTasksViewMode(context)
    WithCoordinatorTaskScope(context, overview = mode == TasksViewMode.Overview) { scopeChip, landingLine ->
        TasksView(
            context, modifier.fillMaxWidth(), mode, scopeChip, landingLine, projectTab,
            looseQuestion = { question ->
                QuestionCard(
                    context, question,
                    askedBy = questionAskedBy(question, threads),
                    taskLabel = questionTaskLabel(question, view::task),
                    onOpenTask = question.taskId?.let { id -> { context.openTask(id) } },
                )
            },
            addTask = { close ->
                Dialog(onDismissRequest = close, properties = DialogProperties(usePlatformDefaultWidth = false)) {
                    Surface(Modifier.fillMaxSize()) {
                        TaskEditor(context, task = null, tasks = view.tasks, onBack = close, modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp))
                    }
                }
            },
        )
    }
}

/** Relative times in a panel move on while it is open. */
@Composable private fun rememberPanelNow(): Long {
    val now = rememberAppTime(30_000)
    return now
}

/** The schedules' titles by ID, so a thread or worker a schedule started says which one. */
@Composable private fun scheduleNames(context: ProjectScreenContext, key: String): (String) -> String? {
    val project = context.route.projectId
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    val schedules = if (connection.supports("schedules")) panelData(context, key, { it is SchedulesStateEvent && it.projectId == project }) {
        context.backend.client.request(SchedulesListRequest(projectId = project)).schedules
    }.value.orEmpty() else emptyList()
    return { id -> schedules.firstOrNull { it.id == id }?.title?.takeIf { it.isNotEmpty() } }
}

/**
 * Main's background jobs (web `BackgroundPanel.svelte`): what each does now, its workers, tasks and questions, who
 * started it and when, with Stop (behind a confirmation), Archive or Restore, and Open; archived ones behind a toggle.
 */
@Composable internal fun ThreadsPanel(context: ProjectScreenContext, allJobs: Boolean) {
    var showArchived by rememberSaveable(context.route) { mutableStateOf(false) }
    var showFinished by rememberSaveable(context.route) { mutableStateOf(false) }
    val client = context.backend.client
    val connection by client.state.collectAsStateWithLifecycle()
    val project = context.route.projectId
    val store = context.backend.threads(project)
    val data by store.snapshot.collectAsStateWithLifecycle()
    val now = rememberPanelNow()
    val scheduleName = scheduleNames(context, "thread-schedules")
    val colors = io.github.mitzacoder.kemiri.ui.theme.Jarvis.colors
    var stopping by remember { mutableStateOf<ThreadSummary?>(null) }
    var busy by remember { mutableStateOf<String?>(null) }
    var problem by remember { mutableStateOf<Pair<String, String>?>(null) }
    val scope = rememberCoroutineScope()
    fun act(thread: ThreadSummary, done: () -> Unit = {}, request: suspend () -> Unit) {
        busy = thread.id
        problem = null
        scope.launch {
            try { request(); done(); store.refresh() }
            catch (e: kotlinx.coroutines.CancellationException) { throw e }
            catch (e: Exception) { problem = thread.id to panelError(e) }
            finally { busy = null }
        }
    }
    Column {
        Text(if (allJobs) "Background jobs from every coordinator. Each job reports back to its coordinator."
            else "Big jobs Main chat handed off. They report back to Main chat; ask Main chat to start, steer or stop one.",
            Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.bodySmall, color = colors.fgSubtle)
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        PanelBody(data.value?.threads?.filter { showArchived || !it.archived }, data.error, data.loading, store::refresh) { threads ->
            val jobThreads = if (connection.supports("coordinators")) {
                val owner = coordinatorOfThread(context.route.threadId, threads)
                threads.filter { it.kind != "coordinator" && (allJobs || (it.parentThreadId ?: MAIN_THREAD_ID) == owner) }
            } else threads
            val ordered = io.github.mitzacoder.kemiri.features.chat.orderedBackgroundJobs(jobThreads)
            val live = ordered.filter { !it.archived }
            val archived = ordered.filter { it.archived }
            @Composable fun Row(thread: ThreadSummary) = key(thread.id) {
                ThreadRow(context, thread, now, scheduleName, busy == thread.id, problem?.takeIf { it.first == thread.id }?.second,
                    stop = { stopping = thread },
                    archive = { act(thread) { client.request(ThreadsArchiveRequest(projectId = project, threadId = thread.id, archived = !thread.archived)) } })
            }
            if (live.isEmpty()) Text(if (allJobs) "No background jobs in this project."
                else "Nothing runs in the background. Main chat starts a background job when a job is big enough, or a schedule does.",
                style = MaterialTheme.typography.bodyMedium, color = colors.fgSubtle)
            val finished = live.filter { io.github.mitzacoder.kemiri.features.chat.foldFinishedJob(it, now) }
            live.filterNot { it in finished }.forEach { Row(it) }
            if (finished.isNotEmpty()) {
                TextButton(onClick = { showFinished = !showFinished }, modifier = Modifier.semantics { stateDescription = if (showFinished) "Expanded" else "Collapsed" }) { Text("Finished (${finished.size})") }
                if (showFinished) finished.forEach { Row(it) }
            }
            TextButton(onClick = { showArchived = !showArchived }, modifier = Modifier.semantics { selected = showArchived }) {
                LucideGlyph(Lucide.Archive, size = 14.dp)
                Spacer(Modifier.width(6.dp))
                Text(if (showArchived) "Hide archived${if (archived.isNotEmpty()) " (${archived.size})" else ""}" else "Show archived", style = MaterialTheme.typography.labelMedium)
            }
            if (showArchived) {
                if (archived.isEmpty()) Text("No archived background jobs.", style = MaterialTheme.typography.bodySmall, color = colors.fgSubtle)
                archived.forEach { Row(it) }
            }
        }
    }
    stopping?.let { thread ->
        io.github.mitzacoder.kemiri.features.chat.ThreadStopConfirmation(context, thread,
            onDismiss = { stopping = null }, onPending = { busy = if (it) thread.id else null },
            onStopped = { stopping = null; store.refresh() })
    }
}

/** One background job: title and status, what it does now, its facts, who started it and when; then its actions. */
@Composable private fun ThreadRow(context: ProjectScreenContext, thread: ThreadSummary, now: Long, scheduleName: (String) -> String?, busy: Boolean, problem: String?, stop: () -> Unit, archive: () -> Unit) {
    val colors = io.github.mitzacoder.kemiri.ui.theme.Jarvis.colors
    val open = { context.navigate(threadRoute(context.route, thread)) }
    val (time, timeTitle) = threadTimeText(thread, now)
    OutlinedCard(Modifier.fillMaxWidth().alpha(if (thread.archived) 0.75f else 1f), shape = MaterialTheme.shapes.medium,
        colors = CardDefaults.outlinedCardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow)) {
        Column(Modifier.fillMaxWidth().clickable(onClickLabel = "Open ${thread.title}", onClick = open).padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(thread.title.ifEmpty { thread.id }, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                StatusBadge(io.github.mitzacoder.kemiri.features.chat.threadState(thread), domain = "thread")
                LucideGlyph(Lucide.ChevronRight, size = 14.dp, tint = colors.fgSubtle)
            }
            if (normalizedThread(context.route.threadId) == thread.id) Text("You are here", style = MaterialTheme.typography.labelSmall, color = colors.accent2)
            val board by context.board.view.collectAsStateWithLifecycle()
            Text(io.github.mitzacoder.kemiri.features.chat.threadStateLine(thread, board.questions, now), style = MaterialTheme.typography.bodySmall, maxLines = 2, overflow = TextOverflow.Ellipsis,
                color = if (thread.status == "failed") MaterialTheme.colorScheme.error else colors.fgMuted)
            val facts = listOfNotNull(
                openQuestionsText(thread.openQuestions)?.let { Triple(it, PanelIcons.CircleHelp, true) },
                runningWorkersText(thread.runningWorkers)?.let { Triple(it, PanelIcons.Bot, false) },
                ownedTasksText(thread.ownedTasks)?.let { Triple(it, PanelIcons.ClipboardList, false) },
            )
            if (facts.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                facts.forEach { (text, icon, needsYou) ->
                    Surface(shape = MaterialTheme.shapes.small, color = if (needsYou) colors.accent2.copy(alpha = 0.12f) else colors.surface2, contentColor = if (needsYou) colors.accent2 else colors.fgSubtle) {
                        Row(Modifier.padding(horizontal = 6.dp, vertical = 1.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            LucideGlyph(icon, size = 12.dp)
                            Text(text, style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
            }
            Row(Modifier.semantics(mergeDescendants = true) { contentDescription = "${threadStartedByText(thread, scheduleName)} · $time. $timeTitle" },
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (thread.startedBy == "schedule") LucideGlyph(io.github.mitzacoder.kemiri.features.status.StatusGlyphs.CalendarClock, size = 12.dp, tint = colors.fgSubtle)
                Text("${threadStartedByText(thread, scheduleName)} · $time", style = MaterialTheme.typography.labelSmall, color = colors.fgSubtle, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            thread.summary?.takeIf { it.isNotBlank() && thread.status == "done" }?.let { Detail("Report", it, markdown = true) }
        }
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.6f))
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            @Composable fun Small(label: String, icon: LucideIcon, enabled: Boolean = true, onClick: () -> Unit) =
                TextButton(onClick = onClick, enabled = enabled, contentPadding = PaddingValues(horizontal = 8.dp)) {
                    LucideGlyph(icon, size = 14.dp); Spacer(Modifier.width(6.dp)); Text(label, style = MaterialTheme.typography.labelMedium)
                }
            if (threadActive(thread)) Small("Stop", PanelIcons.CircleStop, onClick = stop)
            if (thread.archived) Small("Restore", PanelIcons.ArchiveRestore, enabled = !busy, onClick = archive)
            else if (!threadActive(thread)) Small("Archive", Lucide.Archive, enabled = !busy, onClick = archive)
            Spacer(Modifier.weight(1f))
            TextButton(onClick = open, contentPadding = PaddingValues(horizontal = 8.dp)) { Text("Open", style = MaterialTheme.typography.labelMedium, color = colors.fgMuted) }
        }
        problem?.let { Text(it, Modifier.padding(start = 12.dp, end = 12.dp, bottom = 6.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
    }
}
