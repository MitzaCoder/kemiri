package io.github.mitzacoder.kemiri.features.tasks.board

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.HarnessFeature
import io.github.mitzacoder.kemiri.data.collectSettings
import io.github.mitzacoder.kemiri.features.coordinators.LocalCoordinatorTaskScope
import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.features.tasks.graph.TaskGraph
import io.github.mitzacoder.kemiri.navigation.NestedBackHandler
import io.github.mitzacoder.kemiri.navigation.PanelTab
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.BoardQuestion
import io.github.mitzacoder.kemiri.ui.components.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.launch

/** List, Board and Graph share the toolbar and search query, but keep their own scroll and folds. */
@Composable
internal fun TasksView(
    context: ProjectScreenContext,
    modifier: Modifier,
    scopeChip: (@Composable (Modifier) -> Unit)?,
    landingLine: @Composable () -> Unit,
    projectTab: Boolean,
    looseQuestion: @Composable (BoardQuestion) -> Unit,
    addTask: @Composable (close: () -> Unit) -> Unit,
) {
    val mode by rememberTasksViewMode(context)
    val scope = rememberCoroutineScope()
    val backend = context.backend.config.key
    val project = context.route.projectId
    fun selectView(next: TasksViewMode) { scope.launch { context.repository.setProjectTasksView(backend, project, next.stored) } }
    val search = taskSearchState(context)
    var searchOpened by rememberSaveable { mutableStateOf(false) }
    var focusSearch by remember { mutableStateOf(false) }
    val searching = searchOpened || search.query.isNotBlank()
    fun closeSearch() { search.change(""); searchOpened = false; focusSearch = false }
    // The keyboard gets Back first. An empty search is transient; a query survives going back to Chat.
    NestedBackHandler(enabled = searching && search.query.isBlank(), depth = 60, onBack = ::closeSearch)
    var adding by rememberSaveable { mutableStateOf(false) }
    val savedViews = rememberSaveableStateHolder()
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    val view by context.board.view.collectAsStateWithLifecycle()
    val coordinatorScope = LocalCoordinatorTaskScope.current
    val scopedTasks = coordinatorScope?.tasks(view.tasks) ?: view.tasks
    val openCount = requestRows(scopedTasks, connection.supports(HarnessFeature.REQUEST_ATTENTION)).count { !it.archived && !isSettled(it.status) }
    CompositionLocalProvider(LocalTaskActivityEnabled provides connection.supports("task-activity")) {
        Column(modifier) {
            if (searching) TaskSearchBox(search, focusSearch, onFocused = { focusSearch = false }, onClose = ::closeSearch)
            else TasksToolbar(scopeChip, openCount.takeIf { view.loaded }, mode, ::selectView, onSearch = {
                searchOpened = true; focusSearch = true
            }, onAdd = { adding = true })
            HorizontalDivider(color = Jarvis.colors.border)
            landingLine()
            if (mode != TasksViewMode.Graph) LinkedTaskFilter(context)
            Box(Modifier.weight(1f)) {
                savedViews.SaveableStateProvider(mode.name) {
                    when (mode) {
                        TasksViewMode.List -> TasksPanel(context, search)
                        TasksViewMode.Board -> TaskBoard(context, search, looseQuestion = looseQuestion)
                        TasksViewMode.Graph -> TaskGraph(context, search, onLeave = if (projectTab) null else ({ selectView(TasksViewMode.List) }))
                    }
                }
            }
        }
        if (adding) addTask { adding = false }
    }
}

@Composable
private fun TasksToolbar(
    scopeChip: (@Composable (Modifier) -> Unit)?,
    openCount: Int?,
    mode: TasksViewMode,
    selectView: (TasksViewMode) -> Unit,
    onSearch: () -> Unit,
    onAdd: () -> Unit,
) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            // Measure the count first; the scope label can ellipsize at narrow widths or large text sizes.
            scopeChip?.invoke(Modifier.weight(1f, fill = false))
            if (openCount != null) Text("$openCount open", Modifier.widthIn(max = 90.dp), style = TaskType.xs,
                color = Jarvis.colors.fgMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        IconButton(onClick = onSearch, modifier = Modifier.size(48.dp)) { LucideGlyph(Lucide.Search, contentDescription = "Search tasks") }
        TasksViewMenu(mode, selectView)
        IconButton(onClick = onAdd, modifier = Modifier.size(48.dp)) { LucideGlyph(Lucide.Plus, contentDescription = "Add task", tint = Jarvis.colors.accent2) }
    }
}

private val TasksViewMode.icon: LucideIcon get() = when (this) {
    TasksViewMode.List -> BoardGlyphs.List
    TasksViewMode.Board -> Lucide.Kanban
    TasksViewMode.Graph -> Lucide.Network
}

@Composable
private fun TasksViewMenu(mode: TasksViewMode, onChange: (TasksViewMode) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { expanded = true }, modifier = Modifier.size(48.dp)) {
            LucideGlyph(mode.icon, contentDescription = "Task view: ${mode.name}")
        }
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            TasksViewMode.entries.forEach { option ->
                DropdownMenuItem(text = { Text(option.name) }, leadingIcon = { LucideGlyph(option.icon) },
                    trailingIcon = if (mode == option) ({ LucideGlyph(Lucide.Check) }) else null,
                    modifier = Modifier.semantics { selected = mode == option },
                    onClick = { expanded = false; onChange(option) })
            }
        }
    }
}

/**
 * Whether a project panel on [tab] shows the Tasks board, which on a tablet takes the full width rather than the side
 * panel's (the web expands its sidebar over the chat for it).
 */
@Composable
fun showsTasksBoard(context: ProjectScreenContext, tab: PanelTab?): Boolean {
    val mode by rememberTasksViewMode(context)
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    return tab == PanelTab.Board && connection.supports(HarnessFeature.TASK_REPORTS) && mode != TasksViewMode.List
}

@Composable
private fun rememberTasksViewMode(context: ProjectScreenContext): State<TasksViewMode> {
    val backend = context.backend.config.key
    val project = context.route.projectId
    return context.repository.collectSettings(backend, project) { settings ->
        tasksViewMode(settings.projectTasksView[backend]?.get(project) ?: settings.tasksView)
    }
}
