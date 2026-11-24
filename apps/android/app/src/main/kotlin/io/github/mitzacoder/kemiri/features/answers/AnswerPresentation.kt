package io.github.mitzacoder.kemiri.features.answers

import io.github.mitzacoder.kemiri.data.ConnectionState
import io.github.mitzacoder.kemiri.data.HarnessFeature
import io.github.mitzacoder.kemiri.data.localizedTimeFormatter
import io.github.mitzacoder.kemiri.protocol.Answer
import io.github.mitzacoder.kemiri.protocol.AnswerWork
import io.github.mitzacoder.kemiri.protocol.TaskAnswerQuestion
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

internal enum class AnswersProjectTab { Chat, Tasks, Answers }

internal fun answersProjectTabs(connection: ConnectionState, workerId: String?): List<AnswersProjectTab> =
    if (workerId == null && connection.supports(HarnessFeature.ANSWERS))
        AnswersProjectTab.entries.filter { it != AnswersProjectTab.Tasks || connection.supports("board") }
    else emptyList()

internal sealed interface AnswerListEntry {
    val key: String
    val at: String
    val pinned: Boolean

    data class SavedAnswer(val answer: Answer) : AnswerListEntry {
        override val key get() = answer.id
        override val at get() = answer.at
        override val pinned get() = answer.pinned
    }

    data class TaskQuestion(val question: TaskAnswerQuestion) : AnswerListEntry {
        override val key get() = "task-question:${question.taskId}:${question.feedbackId}"
        override val at get() = question.at
        override val pinned get() = false
        val title get() = question.question.trim().lineSequence().first()
    }
}

internal data class AnswerDayGroup(val label: String, val entries: List<AnswerListEntry>)

internal fun groupAnswers(
    answers: List<Answer>, today: LocalDate, zone: ZoneId, taskQuestions: List<TaskAnswerQuestion> = emptyList(),
): List<AnswerDayGroup> = (answers.map { AnswerListEntry.SavedAnswer(it) } + taskQuestions.map { AnswerListEntry.TaskQuestion(it) })
    .sortedWith(compareByDescending<AnswerListEntry> { it.pinned }.thenByDescending { Instant.parse(it.at) }
        .thenByDescending { (it as? AnswerListEntry.SavedAnswer)?.answer?.id?.removePrefix("A")?.toLongOrNull() })
    .groupBy { if (it.pinned) "Pinned" else answerDay(it.at, today, zone) }
    .map { (label, entries) -> AnswerDayGroup(label, entries) }

internal enum class AnswerWorkIndicator { Pulse, Waiting, Problem }

internal data class AnswerWorkStatus(val label: String, val indicator: AnswerWorkIndicator)

internal fun answerWorkStatus(work: AnswerWork, at: String, now: Instant): AnswerWorkStatus {
    val (state, indicator) = when (work.status) {
        "failed" -> "Worker failed" to AnswerWorkIndicator.Problem
        "stopped" -> "Worker stopped" to AnswerWorkIndicator.Problem
        "unavailable" -> "Worker unavailable" to AnswerWorkIndicator.Problem
        "awaiting_reply" -> "Awaiting reply" to AnswerWorkIndicator.Waiting
        else -> "Working" to AnswerWorkIndicator.Pulse
    }
    val elapsed = if (indicator == AnswerWorkIndicator.Pulse) {
        "${maxOf(work.elapsedMinutes ?: 0L, Duration.between(Instant.parse(at), now).toMinutes())} min"
    } else null
    return AnswerWorkStatus(listOfNotNull(state, work.workerId?.takeIf { it.isNotBlank() }, elapsed).joinToString(" · "), indicator)
}

internal fun canCopyToAnswers(supported: Boolean, parent: String?, status: String) =
    supported && parent == null && (status == "done" || status == "dropped")

private fun answerDay(at: String, today: LocalDate, zone: ZoneId): String =
    when (val day = Instant.parse(at).atZone(zone).toLocalDate()) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        else -> day.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))
    }

internal fun answerTime(at: String, zone: ZoneId): String = localizedTimeFormatter().format(Instant.parse(at).atZone(zone))

internal fun answerWhen(at: String, today: LocalDate, zone: ZoneId): String {
    val day = answerDay(at, today, zone)
    return "${if (day == "Today" || day == "Yesterday") day.lowercase() else day} ${answerTime(at, zone)}"
}

internal fun hasUnreadAnswers(answers: List<Answer>) = answers.any { it.working == null && !it.read }

/** Transcript entry IDs are matched only within the coordinator that wrote the reply. */
internal fun answersByReply(answers: List<Answer>, coordinatorId: String): Map<Long, String> = buildMap {
    for (answer in answers) {
        if (answer.coordinatorId == coordinatorId) answer.entryId?.let { put(it, answer.id) }
        for (exchange in answer.exchanges) {
            if (exchange.coordinatorId == coordinatorId) exchange.entryId?.let { put(it, answer.id) }
        }
    }
}
