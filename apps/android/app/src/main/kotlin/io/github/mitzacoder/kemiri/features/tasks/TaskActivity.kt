package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.protocol.BoardTaskActivity

internal fun taskActivity(task: BoardTask, enabled: Boolean): BoardTaskActivity? = task.activity.takeIf { enabled }
internal fun taskNowText(task: BoardTask, enabled: Boolean): String = taskActivity(task, enabled)?.text ?: task.report.now

internal enum class ActivityTone { Error, Attention, Active, Review, Muted }
internal fun activityTone(kind: String): ActivityTone = when (kind) {
    "failure" -> ActivityTone.Error
    "question", "feedback", "blocked", "waiting" -> ActivityTone.Attention
    "working", "deploy" -> ActivityTone.Active
    "review" -> ActivityTone.Review
    else -> ActivityTone.Muted
}

internal fun activityAge(activity: BoardTaskActivity, now: Long): String =
    if (Regex("\\bsince\\b", RegexOption.IGNORE_CASE).containsMatchIn(activity.text)) ""
    else if (runCatching { java.time.Instant.parse(activity.since) }.isFailure) ""
    else relativeTime(activity.since, now)

internal fun activityDescription(activity: BoardTaskActivity, now: Long): String =
    listOf(activity.text, activityAge(activity, now)).filter { it.isNotBlank() }.joinToString(" · ")

/** Compact rows use typed kinds to keep state and activity in one sentence. */
internal fun taskRowActivity(task: BoardTask, enabled: Boolean, title: (String) -> String? = { null }): BoardTaskActivity? {
    val activity = taskActivity(task, enabled)
    val state = task.state ?: return activity
    val conveysState = when (state.kind) {
        "failed" -> activity?.kind == "failure"
        "answer_needed" -> activity?.kind == "question"
        "review" -> activity?.kind == "review"
        "working" -> activity?.kind in listOf("working", "deploy")
        "blocked_by_task" -> activity?.kind == "blocked"
        "waiting_outside" -> activity?.kind == "waiting"
        "done" -> activity?.kind == "done"
        "dropped" -> activity?.kind == "dropped"
        else -> false
    }
    if (conveysState) return activity
    val text = if (state.kind == "failed" && !task.blockedReason.isNullOrEmpty()) "Failed: ${task.blockedReason}" else taskStateLabel(task, title)
    return BoardTaskActivity(if (state.kind == "todo") "not_started" else "idle", text, state.since, state.refs)
}
