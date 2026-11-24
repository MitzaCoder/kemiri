package io.github.mitzacoder.kemiri.features.coordinators

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.SaveOutcome
import io.github.mitzacoder.kemiri.data.supports
import io.github.mitzacoder.kemiri.features.panels.boardStatusLabel
import io.github.mitzacoder.kemiri.features.panels.input
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.launch

internal val LocalCoordinatorTaskScope = staticCompositionLocalOf<CoordinatorTaskScope?> { null }
internal val LocalCoordinatorBoardTasks = staticCompositionLocalOf<List<BoardTask>> { emptyList() }
internal val LocalShowAllCoordinators = staticCompositionLocalOf<(() -> Unit)?> { null }

@Composable internal fun CoordinatorTaskScopeLayout(context: ProjectScreenContext, modifier: Modifier, content: @Composable () -> Unit) {
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    val enabled = connection.supports("task-coordinator")
    val threads = rememberCoordinatorThreads(context, connection.supports("coordinators") && enabled)
    val landing = rememberLandingTurn(context, connection.supports("landing-turn"))
    val board by context.board.view.collectAsStateWithLifecycle()
    val android = LocalContext.current
    val chat = context.route
    var all by remember(chat.backendKey, chat.projectId, chat.threadId) { mutableStateOf(allCoordinators(android, chat)) }
    var hidden by rememberSaveable(chat.backendKey, chat.projectId, chat.threadId) { mutableStateOf(emptyList<String>()) }
    fun selectAll(value: Boolean) { all = value; setAllCoordinators(android, chat, value) }
    val selector = if (enabled) CoordinatorTaskScope(threads, (if (threads.isEmpty()) chat.threadId ?: MAIN_THREAD_ID else coordinatorOfThread(chat.threadId, threads)).takeUnless { all }, hidden.toSet()) else null
    Column(modifier) {
        if (selector != null) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                FilterChip(!all, { selectAll(false) }, { Text("This coordinator", maxLines = 2) }, modifier = Modifier.weight(1f).heightIn(min = 48.dp))
                FilterChip(all, { selectAll(true) }, { Text("All coordinators", maxLines = 2) }, modifier = Modifier.weight(1f).heightIn(min = 48.dp))
            }
            if (all && selector.roster.size > 1) Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                selector.roster.forEach { thread ->
                    FilterChip(thread.id !in hidden, { hidden = if (thread.id in hidden) hidden - thread.id else hidden + thread.id },
                        { Text(thread.title, maxLines = 1) }, modifier = Modifier.heightIn(min = 48.dp), leadingIcon = { CoordinatorMark(thread) })
                }
            }
        }
        if (all) landing?.turn?.let { LandingTurnLine(it) }
        Box(Modifier.weight(1f)) {
            CompositionLocalProvider(LocalCoordinatorTaskScope provides selector, LocalCoordinatorBoardTasks provides board.tasks,
                LocalShowAllCoordinators provides { selectAll(true) }, LocalLandingTurn provides landing) { content() }
        }
    }
}

@Composable internal fun CoordinatorTasksFooter(context: ProjectScreenContext) {
    val selector = LocalCoordinatorTaskScope.current ?: return
    val showAll = LocalShowAllCoordinators.current
    if (selector.coordinator != null) {
        val count = selector.roster.filter { it.id != selector.coordinator }.sumOf { coordinatorBadges(it).needsYou }
        if (count > 0 && showAll != null) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("$count need you in other coordinators", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted)
            TextButton(onClick = showAll, modifier = Modifier.heightIn(min = 48.dp)) { Text("Show all") }
        }
    } else if (context.backend.client.supports("coordinator-messages")) CoordinatorMessageFeed(context, selector.threads)
}

@Composable internal fun TaskCoordinatorMark(task: BoardTask) {
    val selector = LocalCoordinatorTaskScope.current ?: return
    if (selector.coordinator != null || selector.roster.size < 2) return
    val thread = selector.threads.find { it.id == task.coordinator }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        CoordinatorMark(thread, thread?.title ?: task.coordinator)
        Text(thread?.title ?: task.coordinator, style = MaterialTheme.typography.labelSmall, color = Jarvis.colors.fgMuted)
    }
}

@Composable internal fun ExternalTaskFamily(task: BoardTask, shown: Set<String>, open: (String) -> Unit, showParts: Boolean = true) {
    val selector = LocalCoordinatorTaskScope.current ?: return
    val tasks = LocalCoordinatorBoardTasks.current
    fun owner(row: BoardTask) = selector.threads.find { it.id == row.coordinator }
    val parent = tasks.find { it.id == task.parent && it.coordinator != task.coordinator && it.id !in shown }
    val blockers = tasks.filter { it.id in task.blockedBy && it.coordinator != task.coordinator }
    @Composable fun Related(row: BoardTask, label: String, dashed: Boolean) {
        Box(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, bottom = 4.dp)) {
            val tone = coordinatorColor(owner(row))
            if (dashed) Canvas(Modifier.matchParentSize()) {
                drawRoundRect(tone.copy(alpha = .65f), cornerRadius = androidx.compose.ui.geometry.CornerRadius(8.dp.toPx()),
                    style = Stroke(1.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(5.dp.toPx(), 3.dp.toPx()))))
            }
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(role = Role.Button) { open(row.id) }.padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                val coordinator = owner(row)
                CoordinatorMark(coordinator, coordinator?.title ?: row.coordinator)
                Column {
                    Text(label, style = MaterialTheme.typography.labelMedium)
                    Text(listOfNotNull(coordinator?.title, boardStatusLabel(row.status)).joinToString(" · "), style = MaterialTheme.typography.labelSmall, color = Jarvis.colors.fgMuted)
                }
            }
        }
    }
    if (parent != null) Related(parent, "Part of ${parent.id}", false)
    blockers.forEach { Related(it, "Waits for ${it.id}", false) }
    if (showParts) selector.externalParts(task, tasks, shown).forEach { Related(it, "${it.id} · ${it.title}", true) }
}

@Composable
internal fun TaskCoordinatorMoveDialog(
    context: ProjectScreenContext,
    task: BoardTask,
    allTasks: List<BoardTask>,
    roster: List<ThreadSummary>,
    onClose: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val remembered = remember(task.id) { task }
    val parts = remember(task.id) { allTasks.filter { it.parent == remembered.id && !it.archived && it.coordinator == remembered.coordinator } }
    var destination by rememberSaveable(task.id) { mutableStateOf(remembered.coordinator) }
    var includeParts by rememberSaveable(task.id) { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var partial by remember { mutableStateOf(false) }
    AlertDialog(onDismissRequest = { if (!busy) onClose() }, title = { Text("Move ${task.id} to coordinator") }, text = {
        Column(Modifier.heightIn(max = 380.dp).verticalScroll(rememberScrollState())) {
            roster.forEach { row ->
                Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).selectable(destination == row.id, !busy, Role.RadioButton) { destination = row.id },
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    RadioButton(destination == row.id, onClick = null)
                    CoordinatorMark(row)
                    Text(row.title)
                }
            }
            if (parts.isNotEmpty()) Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(enabled = !busy) { includeParts = !includeParts }, verticalAlignment = Alignment.CenterVertically) {
                Checkbox(includeParts, onCheckedChange = null); Spacer(Modifier.width(8.dp)); Text("Also move its ${parts.size} parts in the same coordinator")
            }
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }, confirmButton = {
        TextButton(enabled = !busy && !partial && roster.any { it.id == destination } && destination != remembered.coordinator, onClick = {
            busy = true
            scope.launch {
                val to = destination
                for (row in listOf(remembered) + if (includeParts) parts else emptyList()) {
                    val outcome = context.board.saveTask(row.input().copy(refs = null), row.id, row.revision, coordinator = to)
                    if (outcome !is SaveOutcome.Saved) {
                        val reason = when (outcome) {
                            is SaveOutcome.Conflict -> "changed while the picker was open"
                            is SaveOutcome.Failed -> outcome.message
                            else -> "the save was cancelled"
                        }
                        error = if (row.id == remembered.id) "${row.id} was not moved: $reason. Close and reopen the picker to retry."
                            else "${remembered.id} moved, but ${row.id} was not moved: $reason."
                        partial = true
                        busy = false
                        return@launch
                    }
                }
                busy = false
                onClose()
            }
        }) { Text(if (busy) "Moving…" else "Move task") }
    }, dismissButton = { TextButton(onClick = { onClose() }, enabled = !busy) { Text(if (partial) "Close" else "Cancel") } })
}
