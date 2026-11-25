package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.data.collectSettings
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
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
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.data.BoardView
import io.github.mitzacoder.kemiri.ui.components.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.theme.Text as TextStyles
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * A task opened from chat or Tasks ([io.github.mitzacoder.kemiri.navigation.Destination.Task]; web
 * `TaskSheet.svelte`): an in-window route on a phone, a capped reading column in a side sheet on a tablet.
 * Actions for the reader come first, ahead of results, plans, notes, the record and task facts.
 * The fixed reply box sends to Main chat with the task ID even when opened from a thread.
 */
@Composable
fun TaskSheet(context: ProjectScreenContext, taskId: String, onDismiss: () -> Unit, bodyState: LazyListState, previousTaskId: String? = null, inWindow: Boolean = false, overlay: @Composable () -> Unit = {}) {
    val deviceSettings by context.repository.collectSettings {
        TaskSheetPreferences(it.taskViewDesignId, it.timelineNewestFirst, it.taskRecordFolds, it.workDayStart)
    }
    val design = TaskViewDesigns.resolve(deviceSettings.taskViewDesignId)
    val latestDismiss by rememberUpdatedState(onDismiss)
    val quoteToChat: (String) -> Unit = remember(context.route) {
        { text -> ComposerQuotes.send(context.route, text); latestDismiss() }
    }
    val quote = quoteToChat.takeIf { context.route.workerId == null }
    val content: @Composable () -> Unit = {
        CompositionLocalProvider(LocalQuoteHandler provides quote, LocalOpenTaskId provides taskId) {
            BoxWithConstraints(Modifier.fillMaxSize()) {
                // Classic keeps its side sheet; full-window designs use the whole available width.
                val sideSheet = !inWindow && maxWidth >= 600.dp && !design.fillsWindow
                if (sideSheet) Box(Modifier.fillMaxSize().clickable(interactionSource = remember { MutableInteractionSource() },
                    indication = null, onClickLabel = "Close the task", onClick = onDismiss))
                Surface(
                    if (sideSheet) Modifier.align(Alignment.CenterEnd).fillMaxHeight().width(minOf(1184.dp, maxWidth - 48.dp)) else Modifier.fillMaxSize(),
                    shape = if (sideSheet) RoundedCornerShape(topStart = 16.dp, bottomStart = 16.dp) else androidx.compose.ui.graphics.RectangleShape,
                    color = Jarvis.colors.bg,
                    shadowElevation = if (sideSheet) 12.dp else 0.dp,
                    border = if (sideSheet) BorderStroke(1.dp, Jarvis.colors.border) else null,
                ) {
                    // Safe drawing already includes the IME. Keep it at the sheet root so the reply and
                    // reading area share the same available height and consume the bottom inset once.
                    Box(Modifier.fillMaxSize().windowInsetsPadding(taskSheetInsets(sideSheet))) {
                        key(taskId) { TaskSheetContent(context, taskId, onDismiss, previousTaskId, bodyState, deviceSettings, design) }
                    }
                }
                overlay()
            }
        }
    }
    if (inWindow) content() else Dialog(onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
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
        content()
    }
}

internal data class TaskSheetPreferences(val taskViewDesignId: String, val timelineNewestFirst: Boolean,
    val taskRecordFolds: Map<String, Boolean>, val workDayStart: String)

internal data class TaskSheetBoard(
    val relatedTasks: List<BoardTask>, val archivedLinks: List<BoardTaskBrief>,
    val questions: List<BoardQuestion>, val decisions: List<BoardDecision>, val previousTaskTitle: String?,
)

internal fun BoardView.forTaskSheet(task: BoardTask, previousTaskId: String?): TaskSheetBoard {
    val relatedIds = linkGroups(task, emptyList()).flatMap { group -> group.items.map { it.id } }.toSet() + listOfNotNull(task.requestId)
    return TaskSheetBoard(
        relatedIds.mapNotNull { id -> this.task(id) }, board?.archivedLinks.orEmpty().filter { it.id in relatedIds },
        questions.filter { it.taskId == task.id || it.taskId != null && it.taskId == task.state?.fromPartId },
        board?.decisions.orEmpty().filter { it.taskId == task.id }, previousTaskId?.let { this.task(it)?.title },
    )
}

@Composable
private fun TaskSheetContent(context: ProjectScreenContext, taskId: String, onDismiss: () -> Unit, previousTaskId: String?, bodyState: LazyListState,
    deviceSettings: TaskSheetPreferences, design: TaskViewDesign,
) {
    val board = context.board
    val loaded by remember(board) { board.select { it.loaded } }
        .collectAsStateWithLifecycle(remember(board) { board.view.value.loaded })
    val liveTask by remember(board, taskId) { board.taskFlow(taskId) }
        .collectAsStateWithLifecycle(remember(board, taskId) { board.view.value.task(taskId) })
    // A task the live board does not list may be archived; read once to see.
    var archivedTask by remember { mutableStateOf<BoardTask?>(null) }
    var lookedUp by remember { mutableStateOf(false) }
    LaunchedEffect(loaded, liveTask == null) {
        if (!loaded || liveTask != null || lookedUp) return@LaunchedEffect
        try { archivedTask = board.findArchived(taskId) } catch (cause: CancellationException) { throw cause } catch (_: Exception) {}
        lookedUp = true
    }
    val task = liveTask ?: archivedTask
    val scope = rememberCoroutineScope()
    val selectDesign: (String) -> Unit = { id -> scope.launch { context.repository.setTaskViewDesign(id) } }
    if (task == null) {
        val colors = Jarvis.colors
        Column(Modifier.fillMaxSize()) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(taskId, Modifier.weight(1f), style = TextStyles.base.copy(fontWeight = FontWeight.SemiBold), color = colors.fg)
                TaskViewMenu(design.id, selectDesign)
                IconButton(onClick = onDismiss) { LucideGlyph(Lucide.X, size = 18.dp, contentDescription = "Close the task") }
            }
            HorizontalDivider(color = colors.border)
            if (!loaded || !lookedUp) Column(Modifier.padding(16.dp).semantics { contentDescription = "Loading $taskId" }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(.35f to 20, .25f to 12, .8f to 14, 1f to 14, .9f to 14, .66f to 12).forEach { (width, height) ->
                    Box(Modifier.fillMaxWidth(width).height(height.dp).background(colors.surface2, RoundedCornerShape(4.dp)))
                }
            }
            else Text("$taskId is not on the board any more.", Modifier.padding(16.dp), style = TextStyles.sm, color = colors.fgSubtle)
        }
        return
    }

    val relatedBoard by remember(board, task, previousTaskId) { board.select { it.forTaskSheet(task, previousTaskId) } }
        .collectAsStateWithLifecycle(remember(board, task, previousTaskId) { board.view.value.forTaskSheet(task, previousTaskId) })
    val sheet = rememberTaskSheetState(context, task, relatedBoard, deviceSettings, previousTaskId, bodyState,
        onDismiss, design.id, selectDesign, onTaskSaved = { if (archivedTask?.id == task.id) archivedTask = it })
    key(design.id) { design.content(sheet) }
}

@Composable
private fun taskSheetInsets(wide: Boolean) = WindowInsets.safeDrawing.only(
    WindowInsetsSides.Vertical + if (wide) WindowInsetsSides.End else WindowInsetsSides.Horizontal,
)
