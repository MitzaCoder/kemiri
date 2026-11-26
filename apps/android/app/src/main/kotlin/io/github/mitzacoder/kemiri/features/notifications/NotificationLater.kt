package io.github.mitzacoder.kemiri.features.notifications

import io.github.mitzacoder.kemiri.data.BoardView
import io.github.mitzacoder.kemiri.features.tasks.LaterTarget
import io.github.mitzacoder.kemiri.features.tasks.isSettled
import io.github.mitzacoder.kemiri.features.tasks.isWarning
import io.github.mitzacoder.kemiri.features.tasks.laterTarget
import io.github.mitzacoder.kemiri.features.tasks.laterTomorrowMorning
import io.github.mitzacoder.kemiri.protocol.NotificationPayload
import java.time.Instant
import java.time.ZoneId

/** A push can advertise a shortcut, but cannot supply the revision for the write to its root request. */
internal fun NotificationPayload.offersLater(): Boolean = laterAllowed == true && projectId != null && when (kind) {
    "board_question" -> question?.let { it.id.isNotBlank() && it.revision > 0 && it.approval != true } == true
    "task_steps", "task_review" -> !taskId.isNullOrBlank() && (taskRevision ?: 0) > 0
    else -> false
}

/** Reject old or settled cards rather than postponing a different need on the same request. */
internal fun BoardView.notificationLaterTarget(payload: NotificationPayload): LaterTarget? {
    if (!payload.offersLater()) return null
    return when (payload.kind) {
        "board_question" -> {
            val notice = requireNotNull(payload.question)
            val question = question(notice.id)?.takeIf { it.revision == notice.revision && it.postponed != true } ?: return null
            // A new warning may break through an existing Later record. It is still open until covered.
            laterTarget(question)?.takeIf { it.record == null || isWarning(question) }
        }
        "task_steps", "task_review" -> {
            val task = task(requireNotNull(payload.taskId))?.takeIf { it.revision == payload.taskRevision } ?: return null
            val stillNeedsAttention = if (payload.kind == "task_steps") !task.report.steps.isNullOrBlank()
                else task.parent == null && task.status == "review"
            if (task.archived || isSettled(task.status) || !stillNeedsAttention) return null
            laterTarget(task)?.takeIf { it.record == null }
        }
        else -> null
    }
}

internal fun LaterTarget.notificationLaterRequest(projectId: String, start: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()) =
    request(projectId, laterTomorrowMorning(now, zone, start).toString(), whenLast = false, workDayStart = start, zone = zone)
