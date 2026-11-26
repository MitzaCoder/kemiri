package io.github.mitzacoder.kemiri.features.tasks.graph

import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.features.tasks.taskStateLabel
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Shared sheet labels, timestamps and the clock-free resting rule. */
data class GraphStatus(val key: String, val label: String, val mark: String)
val graphStatuses = listOf(
    GraphStatus("todo", "Planned", "○"), GraphStatus("in_progress", "Working", "▶"),
    GraphStatus("steps_needed", "Your steps", "☷"),
    GraphStatus("review", "Review", "◇"), GraphStatus("blocked", "Blocked", "⊣"),
    GraphStatus("paused", "Paused", "Ⅱ"), GraphStatus("failed", "Failed", "!"), GraphStatus("answer_needed", "Answer needed", "?"),
    GraphStatus("waiting", "Waiting", "◷"), GraphStatus("done", "Done", "✓"), GraphStatus("dropped", "Dropped", "−"),
)
val graphReasons = listOf(
    GraphStatus("review", "Review", "◇"), GraphStatus("blocked", "Blocked", "⊣"),
    GraphStatus("waiting", "Waiting", "◷"), GraphStatus("question", "Question / warning", "?"), GraphStatus("failed", "Worker failed", "!"),
)
fun graphReason(key: String, derived: Boolean): GraphStatus = graphReasons.first { it.key == key }.let {
    if (!derived) it else it.copy(label = when (key) { "failed" -> "Failed"; "question" -> "Answer needed"; "review" -> "Ready for review"; else -> it.label })
}
fun graphTaskStatus(task: BoardTask): String = if (task.state?.group == "later") "waiting" else when (task.state?.kind) {
    "working", "clarifying" -> "in_progress"
    "blocked_by_task", "waiting_outside" -> "waiting"
    null -> task.status
    else -> task.state.kind
}
fun graphTaskLabel(task: BoardTask): GraphStatus = graphStatus(graphTaskStatus(task)).let {
    if (task.state == null) it else it.copy(label = taskStateLabel(task))
}
fun graphStatus(status: String) = graphStatuses.find { it.key == status } ?: GraphStatus(status, status, "○")
fun graphClosed(status: String) = status == "done" || status == "dropped"
fun graphTimestamp(at: String): Long? = runCatching { Instant.parse(at).toEpochMilli() }.getOrNull()
fun graphQuietAge(at: String, now: Long) = "quiet ${((now - (graphTimestamp(at) ?: now)).coerceAtLeast(0) / 86_400_000)} d"
fun graphWaitingDate(until: String?, now: Long): String {
    val at = until?.let(::graphTimestamp) ?: return ""
    return if (at < now) "overdue" else "until " + DateTimeFormatter.ofPattern("MMM d").withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(at))
}

/** No clock: closed, archived, hidden and absent tasks cannot keep idle/failed workers on the graph. */
fun graphWorkerRests(status: String, task: BoardTask?, visibleTaskIds: Set<String>): Boolean =
    status in listOf("idle", "failed") && (task == null || task.archived || graphClosed(task.status) || task.id !in visibleTaskIds)
