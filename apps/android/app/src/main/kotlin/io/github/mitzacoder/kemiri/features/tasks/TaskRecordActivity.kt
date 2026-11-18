package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.data.timeFormatter
import io.github.mitzacoder.kemiri.features.status.exactTime
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.components.JarvisIconButton
import io.github.mitzacoder.kemiri.ui.components.LucideIcon
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.CancellationException
import java.time.Instant
import java.time.ZoneId

private const val ACTIVITY_PAGE_SIZE = 6

@Composable
internal fun TaskRecordActivity(
    context: ProjectScreenContext, task: BoardTask, sources: ActivitySources, workersById: Map<String, WorkerSummary>, timelineLoading: Boolean,
    timelineError: String?, newestFirst: Boolean, onToggleOrder: () -> Unit, now: Long, writerName: (BoardWriter) -> String,
) {
    val colors = Jarvis.colors
    var snapshots by remember(task.id) { mutableStateOf<List<BoardTaskSnapshot>?>(null) }
    var historyError by remember(task.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(task.id, task.snapshots) {
        if (task.snapshots <= 0) {
            snapshots = emptyList()
            historyError = null
            return@LaunchedEffect
        }
        try {
            snapshots = context.board.history(task.id)
            historyError = null
        } catch (cause: CancellationException) { throw cause }
        catch (cause: Exception) { historyError = cause.message ?: "Could not read history" }
    }
    var limit by rememberSaveable(task.id, newestFirst) { mutableIntStateOf(ACTIVITY_PAGE_SIZE) }
    val rows = remember(sources, snapshots) { taskActivityRows(sources.copy(snapshots = snapshots.orEmpty())) }
    val days = remember(rows, newestFirst, limit, now) { activityDays(rows, newestFirst, limit, now) }
    val before = remember(snapshots) { snapshots.orEmpty().mapIndexed { i, snap -> snap.seq to snapshots.orEmpty().getOrNull(i - 1) }.toMap() }
    val problem = timelineError ?: historyError
    problem?.let { Text(it, style = TaskType.xs, color = colors.danger) }
    if (rows.isEmpty()) {
        if (timelineLoading || (task.snapshots > 0 && snapshots == null && historyError == null)) Text("Loading activity…", style = TaskType.xs, color = colors.fgMuted)
        else if (problem == null) Text("No activity recorded yet.", style = TaskType.xs, color = colors.fgMuted)
        return
    }
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text("${rows.size} ${if (rows.size == 1) "event" else "events"}", Modifier.weight(1f), style = TaskType.xs, color = colors.fgMuted)
        val direction = if (newestFirst) "Newest first; show oldest first" else "Oldest first; show newest first"
        JarvisIconButton(LucideIcon("activity-order", if (newestFirst) "M4 3v18m-3-3 3 3 3-3" else "M4 21V3m-3 3 3-3 3 3", "M10 5h11", "M10 12h7", "M10 19h3"), direction, onToggleOrder)
    }
    days.forEach { day -> key(day.day) {
        Column {
            TaskHeading(day.day, Modifier.padding(bottom = 4.dp))
            day.entries.forEach { row -> key(row.id) {
                val worker = workersById[row.workerId]
                val openWorker: (() -> Unit)? = worker?.let { { context.navigate(context.route.copy(threadId = it.threadId, workerId = it.id)) } }
                val openTask: (() -> Unit)? = row.taskId?.let { { context.openTask(it) } }
                RecordActivityRow(row, task, before[row.snapshot?.seq], writerName, openTask ?: openWorker,
                    if (openTask != null) "Open linked task" else "Open worker")
            } }
        }
    } }
    if (limit < rows.size) TextButton(onClick = { limit += ACTIVITY_PAGE_SIZE }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Show more activity") }
}

@Composable
private fun RecordActivityRow(row: ActivityRow, task: BoardTask, before: BoardTaskSnapshot?, writerName: (BoardWriter) -> String, openRelated: (() -> Unit)?, linkTitle: String) {
    val colors = Jarvis.colors
    val label = remember(row.label) { activityText(row.label) }
    val clock = row.at?.let { at -> runCatching { timeFormatter("HH:mm").withZone(ZoneId.systemDefault()).format(Instant.parse(at)) }.getOrDefault("—") } ?: "—"
    val canExpand = row.snapshot != null || row.detail != null || (row.fact != null && row.fact.at != row.fact.endAt) || label.length > 42
    val heading: @Composable RowScope.() -> Unit = {
        Text(clock, style = TaskType.meta, color = colors.fgMuted)
        TaskDetailText((if (row.now) "Now · " else "") + label, Modifier.weight(1f), style = TaskType.sectionTitle,
            color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
    if (canExpand) {
        var expanded by rememberSaveable { mutableStateOf(false) }
        TaskFold(expanded, { expanded = !expanded }, heading) {
            if (row.snapshot != null) {
                Text("${writerName(row.snapshot.by)} · ${exactTime(row.snapshot.at)}", style = TaskType.xs, color = colors.fgMuted)
                TaskSnapshotDetail(task, row.snapshot, before)
            } else {
                if (row.fact != null && row.fact.at != row.fact.endAt) Text("Started ${exactTime(row.fact.at)}", style = TaskType.xs, color = colors.fgMuted)
                TaskDetailText(activityText(row.detail ?: row.label), style = TaskType.sectionTitle, color = colors.fgMuted)
            }
            if (openRelated != null) TextButton(onClick = openRelated, modifier = Modifier.heightIn(min = 48.dp)) { Text(linkTitle) }
        }
    } else {
        HorizontalDivider(color = colors.border)
        if (openRelated != null) TextButton(onClick = openRelated, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
            contentPadding = PaddingValues(0.dp), content = heading)
        else Row(Modifier.fillMaxWidth().heightIn(min = 36.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp), content = heading)
    }
}
