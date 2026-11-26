package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.protocol.BoardTaskState
import io.github.mitzacoder.kemiri.ui.theme.TaskStatusTone

/** The data boundary removes unadvertised state; a missing field retains the old UI. */
fun taskWithSupportedState(task: BoardTask, supported: Boolean, partsSupported: Boolean = false): BoardTask =
    task.copy(state = task.state.takeIf { supported }, subtaskStates = task.subtaskStates.takeIf { partsSupported })

fun derivedTaskSection(task: BoardTask, waiting: Int = 0): TaskSectionId = when (task.state?.group) {
    "needs_you" -> TaskSectionId.NeedsYou
    "in_progress" -> TaskSectionId.Working
    "waiting" -> TaskSectionId.Waiting
    "later" -> TaskSectionId.Later
    "todo" -> TaskSectionId.Todo
    "closed" -> TaskSectionId.Closed
    else -> taskSectionOf(task.status, waiting)
}

fun taskStateLabel(task: BoardTask, title: (String) -> String? = { null }): String =
    taskStateLabel(task.status, task.state, task.waiting?.note, title)

internal const val QUESTION_BEING_CHECKED = "Question being checked"

internal fun taskStateLabel(status: String, state: BoardTaskState?, waitingNote: String? = null, title: (String) -> String? = { null }): String = if (state?.group == "later") "Later" else when (state?.kind) {
    "failed" -> "Failed"
    "answer_needed" -> "Answer needed"
    "steps_needed" -> "Your steps"
    "review" -> "Ready for review"
    "working" -> "Working"
    "clarifying" -> if (state.checkingFeedbackId != null) QUESTION_BEING_CHECKED else "Clarifying"
    "paused" -> "Paused"
    "blocked_by_task" -> "Blocked by " + state.refs.joinToString(", ") { id ->
        id + (title(id)?.let { " ${firstLine(it, 48)}" } ?: "")
    }
    "waiting_outside" -> waitingNote?.let { if (it.startsWith("Waiting for", ignoreCase = true)) it else "Waiting for $it" } ?: "Waiting"
    "todo" -> "To do"
    "done" -> "Done"
    "dropped" -> "Dropped"
    else -> taskStatusWords(status)
}

/** The primary state already describes work when it is Working. */
internal fun BoardTaskState?.additionalRunningWork() = this?.runningWork?.takeIf { kind != "working" }

fun taskStateTone(task: BoardTask): TaskStatusTone = if (task.state?.group == "later") TaskStatusTone.Waiting else taskKindTone(task.state?.kind, taskStatusTone(task.status))

internal fun taskKindTone(kind: String?, fallback: TaskStatusTone = TaskStatusTone.Todo): TaskStatusTone = when (kind) {
    "failed" -> TaskStatusTone.Blocked
    "answer_needed", "steps_needed", "review" -> TaskStatusTone.Review
    "working", "clarifying" -> TaskStatusTone.Working
    "paused" -> TaskStatusTone.Paused
    "blocked_by_task", "waiting_outside" -> TaskStatusTone.Waiting
    "done" -> TaskStatusTone.Done
    "dropped" -> TaskStatusTone.Dropped
    else -> fallback
}

fun needsTaskOwner(task: BoardTask, waiting: Int): Boolean =
    task.state?.let { it.group == "needs_you" } ?: (!isSettled(task.status) && waiting > 0)

/** Oldest first within a kind; stable priority and natural ID ties. */
val derivedTaskOrder: Comparator<BoardTask> = compareBy<BoardTask> {
    when (it.state?.kind) { "failed", "working" -> 0; "answer_needed", "paused" -> 1; "steps_needed" -> 2; "review" -> 3; else -> 0 }
}.thenBy { isoMillis(it.state?.since) }.thenBy { it.order }.thenComparing({ it.id }, taskIdOrder)
