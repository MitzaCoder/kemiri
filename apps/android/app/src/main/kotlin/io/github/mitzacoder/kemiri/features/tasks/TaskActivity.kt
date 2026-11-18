package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.protocol.BoardTaskActivity
import kotlin.math.roundToLong

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
    if (activity.ageFormat == "none") ""
    else if (activity.ageFormat == "duration") activityDuration(activity.since, now)
    else if (Regex("\\bsince\\b", RegexOption.IGNORE_CASE).containsMatchIn(activity.text)) ""
    else if (runCatching { java.time.Instant.parse(activity.since) }.isFailure) ""
    else relativeTime(activity.since, now)

internal fun activityDescription(activity: BoardTaskActivity, now: Long): String =
    activity.text + activityAge(activity, now).takeIf { it.isNotBlank() }?.let { (activity.agePrefix ?: " · ") + it }.orEmpty()

internal fun activityDuration(since: String, now: Long): String {
    val at = runCatching { java.time.Instant.parse(since).toEpochMilli() }.getOrNull() ?: return ""
    val minutes = kotlin.math.max(0L, ((now - at) / 60_000.0).roundToLong())
    if (minutes < 60) return "$minutes min"
    val hours = (minutes / 60.0).roundToLong()
    return if (hours < 24) "$hours h" else "${(hours / 24.0).roundToLong()} d"
}

/** Compact rows use typed kinds to keep state and activity in one sentence. */
internal fun taskRowActivity(task: BoardTask, enabled: Boolean, title: (String) -> String? = { null }): BoardTaskActivity? {
    val activity = taskActivity(task, enabled)
    val state = task.state ?: return activity
    if (activity != null && taskUsesPartsSentence(task)) return activity
    state.sentence?.let { return it }
    // Stored review activity can describe a separate check, not the manual steps.
    if (state.kind == "steps_needed") return BoardTaskActivity("review", taskStateLabel(task), state.since, state.refs, ageFormat = "none")
    val conveysState = when (state.kind) {
        "failed" -> activity?.kind == "failure"
        "answer_needed" -> activity?.kind == "question"
        "review" -> activity?.kind == "review"
        "working" -> activity?.kind in listOf("working", "deploy")
        "clarifying" -> activity?.kind == "working" && activity.text.contains("clarifying", ignoreCase = true)
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
