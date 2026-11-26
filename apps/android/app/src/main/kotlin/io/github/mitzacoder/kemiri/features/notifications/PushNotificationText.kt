package io.github.mitzacoder.kemiri.features.notifications

import io.github.mitzacoder.kemiri.features.chat.markdownText
import io.github.mitzacoder.kemiri.protocol.NotificationPayload

internal data class PushNotificationText(val title: String, val body: String, val context: String?)

/** Labels for the hidden form are fixed text, never copied from a push. */
internal fun hiddenNotificationTitle(kind: String) = when (kind) {
    "board_question" -> "A question is waiting"
    "reply" -> "A reply is ready"
    "task_review" -> "A task is ready for review"
    "task_steps" -> "Steps are waiting"
    "worker_failed" -> "A worker stopped"
    "schedule_problem" -> "A scheduled run had a problem"
    "deploy_problem" -> "A deploy had a problem"
    "login_prompt" -> "A sign-in needs attention"
    "usage_limit_reached" -> "A subscription limit was reached"
    "usage_drain_warning" -> "A subscription is running low"
    "usage_drain_paused" -> "Work paused at a subscription limit"
    "disk_low" -> "A disk is running low"
    "compaction_failed" -> "A chat summary failed"
    "maintenance_failed" -> "Nightly memory upkeep failed"
    "thread_failed" -> "A background job failed"
    "coordinator_failed" -> "A coordinator stopped"
    "worker_report" -> "A worker reported"
    "schedule_done" -> "A scheduled run finished"
    "thread_finished" -> "A background job finished"
    "work_finished" -> "Work finished"
    else -> "Test notification"
}

private val legacyQuestionLabel = Regex("(?:Question|Warning|Reply on Q[0-9]+|No reply yet on Q[0-9]+)")
private val leadingQuestion = Regex("^[^\\n?]{1,120}\\?")

/** Reuse project names that are identifiable in the current wire format. Never display a raw project ID. */
internal fun legacyNotificationProjectName(payload: NotificationPayload): String? {
    if (payload.projectId == null) return null
    val title = payload.title
    val parts = title.split(" · ", limit = 3)
    return when {
        payload.kind == "coordinator_failed" -> parts.getOrNull(1)
        payload.coordinatorId != null && payload.kind in setOf("reply", "worker_report", "worker_failed", "task_review") -> parts.firstOrNull().takeIf { parts.size > 1 }
        payload.kind == "reply" && title.endsWith(" replied") -> title.removeSuffix(" replied")
        payload.kind == "work_finished" && title.endsWith(" finished") -> title.removeSuffix(" finished")
        payload.kind == "board_question" && legacyQuestionLabel.matches(parts.first()) -> title.substringAfter(" · ", "")
        payload.kind in setOf("task_review", "worker_report", "worker_failed", "compaction_failed", "deploy_problem") -> title.substringAfter(" · ", "")
        else -> null
    }?.trim()?.takeIf { it.isNotEmpty() }
}

internal fun pushNotificationText(payload: NotificationPayload, projectName: String?, computerName: String?, showMessageText: Boolean): PushNotificationText {
    val kind = payload.kind
    if (!showMessageText) return PushNotificationText(hiddenNotificationTitle(kind), "", null)
    val title = payload.title
    var body = payload.body.trim()
    val heading = when (kind) {
        "board_question" -> {
            // The old server already flattens the body. Clean up any residual Markdown without folding line breaks.
            body = body.lineSequence().joinToString("\n", transform = ::markdownText)
            val prompt = leadingQuestion.find(body)?.value
            val label = title.substringBefore(" · ")
            when {
                label == "Warning" -> "A warning needs attention"
                prompt != null -> prompt.also { body = body.removePrefix(it).trim() }
                legacyQuestionLabel.matches(label) || payload.coordinatorId != null || label.isBlank() -> hiddenNotificationTitle(kind)
                projectName != null -> title.removeSuffix(" · $projectName")
                else -> hiddenNotificationTitle(kind)
            }
        }
        "task_review", "task_steps" -> {
            payload.taskId?.let { body = body.removePrefix("$it ") }
            if (kind == "task_review") "Ready for review" else "Steps to do"
        }
        "worker_failed", "worker_report", "coordinator_failed", "compaction_failed", "maintenance_failed" -> hiddenNotificationTitle(kind)
        "thread_finished" -> "Background job finished"
        "thread_failed" -> "Background job failed"
        "schedule_done", "schedule_problem" -> title.replaceFirst("Scheduled task", "Scheduled run").replaceFirst(" · ", ": ")
        "login_prompt" -> computerName?.let { "$it needs a sign-in" } ?: "Sign-in needs attention"
        "disk_low" -> computerName?.let { "$it: low disk space" } ?: "Low disk space"
        "deploy_problem" -> title.substringBefore(" · ")
        "reply" -> title.substringAfter(" · ", title).takeIf { payload.coordinatorId != null } ?: title
        else -> title
    }
    val namedComputer = computerName ?: "this computer"
    val computerEvent = isComputerNotification(payload)
    if (computerEvent && kind != "test") {
        body = if (kind == "login_prompt" && title.startsWith("Sign in · ")) {
            "${title.substringAfter(" · ")} on $namedComputer${if (body.isEmpty()) "" else ": $body"}"
        } else "On $namedComputer${if (body.isEmpty()) "." else ": $body"}"
    }
    val context = if (computerEvent) computerName else projectName?.takeUnless {
        (kind == "reply" && heading == "$it replied") || (kind == "work_finished" && heading == "$it finished")
    }
    return PushNotificationText(heading, body, context)
}

internal fun isComputerNotification(payload: NotificationPayload): Boolean =
    payload.projectId == null || payload.kind in NotificationAttention.SubscriptionLimits.legacyKinds

/** The old push already carries the exact question ID in its stable tag, but not the wording revision. */
internal fun notificationQuestionId(payload: NotificationPayload): String? {
    if (payload.kind != "board_question" || payload.projectId == null) return null
    return payload.tag.substringAfter("board-question:${payload.projectId}:", "").takeIf { it.isNotEmpty() }
}
