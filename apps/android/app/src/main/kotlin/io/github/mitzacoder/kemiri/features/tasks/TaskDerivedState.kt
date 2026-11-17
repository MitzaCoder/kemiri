package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.ui.theme.TaskStatusTone

/** The data boundary removes unadvertised state; a missing field retains the old UI. */
fun taskWithSupportedState(task: BoardTask, supported: Boolean, partsSupported: Boolean = false): BoardTask =
    task.copy(state = task.state.takeIf { supported }, subtaskStates = task.subtaskStates.takeIf { partsSupported })

fun derivedTaskSection(task: BoardTask, waiting: Int = 0): TaskSectionId = when (task.state?.group) {
    "needs_you" -> TaskSectionId.NeedsYou
    "in_progress" -> TaskSectionId.Working
    "waiting" -> TaskSectionId.Waiting
    "todo" -> TaskSectionId.Todo
    "closed" -> TaskSectionId.Closed
    else -> taskSectionOf(task.status, waiting)
}

fun taskStateLabel(task: BoardTask, title: (String) -> String? = { null }): String = when (task.state?.kind) {
    "failed" -> "Failed"
    "answer_needed" -> "Answer needed"
    "review" -> "Ready for review"
    "working" -> "Working"
    "clarifying" -> "Clarifying"
    "paused" -> "Paused"
    "blocked_by_task" -> "Blocked by " + task.state.refs.joinToString(", ") { id ->
        id + (title(id)?.let { " ${firstLine(it, 48)}" } ?: "")
    }
    "waiting_outside" -> task.waiting?.note?.let { if (it.startsWith("Waiting for", ignoreCase = true)) it else "Waiting for $it" } ?: "Waiting"
    "todo" -> "To do"
    "done" -> "Done"
    "dropped" -> "Dropped"
    else -> taskStatusWords(task.status)
}

/** Derived rows have one state sentence; only legacy rows need a separate label. */
fun taskRowStateLabel(task: BoardTask, title: (String) -> String? = { null }): String? =
    if (task.state != null) null else taskStateLabel(task, title)

fun taskStateTone(task: BoardTask): TaskStatusTone = when (task.state?.kind) {
    "failed" -> TaskStatusTone.Blocked
    "answer_needed", "review" -> TaskStatusTone.Review
    "working", "clarifying" -> TaskStatusTone.Working
    "paused" -> TaskStatusTone.Paused
    "blocked_by_task", "waiting_outside" -> TaskStatusTone.Waiting
    else -> taskStatusTone(task.status)
}

fun needsTaskOwner(task: BoardTask, waiting: Int): Boolean =
    task.state?.let { it.group == "needs_you" } ?: (!isSettled(task.status) && waiting > 0)

/** Oldest first within a kind; stable priority and natural ID ties. */
val derivedTaskOrder: Comparator<BoardTask> = compareBy<BoardTask> {
    when (it.state?.kind) { "failed", "working" -> 0; "answer_needed", "paused" -> 1; "review" -> 2; else -> 0 }
}.thenBy { isoMillis(it.state?.since) }.thenBy { it.order }.thenComparing({ it.id }, taskIdOrder)
