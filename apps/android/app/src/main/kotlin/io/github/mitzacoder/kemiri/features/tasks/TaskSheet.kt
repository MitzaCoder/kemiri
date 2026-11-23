package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.features.coordinators.*

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.features.chat.ComposerQuotes
import io.github.mitzacoder.kemiri.features.chat.LocalQuoteHandler
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.ui.components.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.theme.Text as TextStyles
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * A task as a sheet over the chat it was opened from ([io.github.mitzacoder.kemiri.navigation.Destination.Task]; web
 * `TaskSheet.svelte`): the whole screen on a phone, a capped reading column in a side sheet on a tablet.
 * Actions for the reader come first, ahead of results, plans, notes, the record and task facts.
 * The fixed reply box sends to Main chat with the task ID even when opened from a thread.
 */
@Composable
fun TaskSheet(context: ProjectScreenContext, taskId: String, onDismiss: () -> Unit, bodyState: LazyListState, previousTaskId: String? = null, overlay: @Composable () -> Unit = {}) {
    val deviceSettings by context.repository.settings.collectAsStateWithLifecycle()
    val design = TaskViewDesigns.resolve(deviceSettings.taskViewDesignId)
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
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
        // Text selected in the sheet can be quoted into the chat under it (not a worker's transcript); the sheet closes so
        // the message can be written.
        val quote: ((String) -> Unit)? = if (context.route.workerId == null) { text -> ComposerQuotes.send(context.route, text); onDismiss() } else null
        CompositionLocalProvider(LocalQuoteHandler provides quote, LocalOpenTaskId provides taskId) {
            BoxWithConstraints(Modifier.fillMaxSize()) {
                // Classic keeps its side sheet; full-window designs use the whole available width.
                val sideSheet = maxWidth >= 600.dp && !design.fillsWindow
                if (sideSheet) Box(Modifier.fillMaxSize().clickable(interactionSource = remember { MutableInteractionSource() },
                    indication = null, onClickLabel = "Close the task", onClick = onDismiss))
                Surface(
                    if (sideSheet) Modifier.align(Alignment.CenterEnd).fillMaxHeight().width(minOf(1184.dp, maxWidth - 48.dp)) else Modifier.fillMaxSize(),
                    shape = if (sideSheet) RoundedCornerShape(topStart = 16.dp, bottomStart = 16.dp) else androidx.compose.ui.graphics.RectangleShape,
                    color = Jarvis.colors.bg,
                    shadowElevation = if (sideSheet) 12.dp else 0.dp,
                    border = if (sideSheet) BorderStroke(1.dp, Jarvis.colors.border) else null,
                ) {
                    key(taskId) { TaskSheetContent(context, taskId, sideSheet, onDismiss, previousTaskId, bodyState, deviceSettings, design) }
                }
                overlay()
            }
        }
    }
}

@Composable
private fun TaskSheetContent(context: ProjectScreenContext, taskId: String, wide: Boolean, onDismiss: () -> Unit, previousTaskId: String?, bodyState: LazyListState,
    deviceSettings: io.github.mitzacoder.kemiri.data.DeviceSettings, design: TaskViewDesign,
) {
    val board = context.board
    val view by board.view.collectAsStateWithLifecycle()
    val liveTask = view.task(taskId)
    // A task the live board does not list may be archived; read once to see.
    var archivedTask by remember { mutableStateOf<BoardTask?>(null) }
    var lookedUp by remember { mutableStateOf(false) }
    LaunchedEffect(view.loaded, liveTask == null) {
        if (!view.loaded || liveTask != null || lookedUp) return@LaunchedEffect
        try { archivedTask = board.findArchived(taskId) } catch (cause: CancellationException) { throw cause } catch (_: Exception) {}
        lookedUp = true
    }
    val task = liveTask ?: archivedTask
    val scope = rememberCoroutineScope()
    val selectDesign: (String) -> Unit = { id -> scope.launch { context.repository.setTaskViewDesign(id) } }
    val insets = Modifier.windowInsetsPadding(taskSheetInsets(wide))
    if (task == null) {
        val colors = Jarvis.colors
        Column(Modifier.fillMaxSize().then(insets)) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(taskId, Modifier.weight(1f), style = TextStyles.base.copy(fontWeight = FontWeight.SemiBold), color = colors.fg)
                TaskViewMenu(design.id, selectDesign)
                IconButton(onClick = onDismiss) { LucideGlyph(Lucide.X, size = 18.dp, contentDescription = "Close the task") }
            }
            HorizontalDivider(color = colors.border)
            if (!view.loaded || !lookedUp) Column(Modifier.padding(16.dp).semantics { contentDescription = "Loading $taskId" }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(.35f to 20, .25f to 12, .8f to 14, 1f to 14, .9f to 14, .66f to 12).forEach { (width, height) ->
                    Box(Modifier.fillMaxWidth(width).height(height.dp).background(colors.surface2, RoundedCornerShape(4.dp)))
                }
            }
            else Text("$taskId is not on the board any more.", Modifier.padding(16.dp), style = TextStyles.sm, color = colors.fgSubtle)
        }
        return
    }

    val sheet = rememberTaskSheetState(context, task, view, deviceSettings, wide, previousTaskId, bodyState,
        onDismiss, design.id, selectDesign, onTaskSaved = { if (archivedTask?.id == task.id) archivedTask = it })
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    if (connection.supports("task-coordinator") || connection.supports("coordinator-messages")) {
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f)) { key(design.id) { design.content(sheet) } }
            Column(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).padding(horizontal = 12.dp, vertical = 4.dp)) {
                TaskCoordinatorRow(context, task, view.tasks)
                if (connection.supports("coordinator-messages")) {
                    val threads = rememberCoordinatorThreads(context, connection.supports("coordinators"))
                    var showMessages by androidx.compose.runtime.saveable.rememberSaveable(task.id) { mutableStateOf(false) }
                    TextButton(onClick = { showMessages = true }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Coordinator messages") }
                    if (showMessages) androidx.compose.material3.AlertDialog(onDismissRequest = { showMessages = false },
                        title = { Text("Messages about ${task.id}") },
                        text = { Column(Modifier.heightIn(max = 400.dp).verticalScroll(rememberScrollState())) { CoordinatorMessageFeed(context, threads, task.id, initiallyExpanded = true) } },
                        confirmButton = { TextButton(onClick = { showMessages = false }) { Text("Close") } })
                }
            }
        }
    } else key(design.id) { design.content(sheet) }
}

@Composable
internal fun taskSheetInsets(wide: Boolean) = WindowInsets.safeDrawing.only(
    WindowInsetsSides.Vertical + if (wide) WindowInsetsSides.End else WindowInsetsSides.Horizontal,
)
