package io.github.mitzacoder.kemiri.features.answers

import io.github.mitzacoder.kemiri.data.ConnectionState
import io.github.mitzacoder.kemiri.data.HarnessFeature
import io.github.mitzacoder.kemiri.data.localizedTimeFormatter
import io.github.mitzacoder.kemiri.protocol.Answer
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

internal data class AnswerDayGroup(val label: String, val answers: List<Answer>)

internal fun groupAnswers(answers: List<Answer>, today: LocalDate, zone: ZoneId): List<AnswerDayGroup> = answers
    .sortedWith(compareByDescending<Answer> { it.pinned }.thenByDescending { Instant.parse(it.at) }
        .thenByDescending { it.id.removePrefix("A").toLongOrNull() })
    .groupBy { if (it.pinned) "Pinned" else answerDay(it.at, today, zone) }
    .map { (label, rows) -> AnswerDayGroup(label, rows) }

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

internal fun hasUnreadAnswers(answers: List<Answer>) = answers.any { !it.read }

/** Transcript entry IDs are matched only within the coordinator that wrote the reply. */
internal fun answersByReply(answers: List<Answer>, coordinatorId: String): Map<Long, String> = buildMap {
    for (answer in answers) {
        if (answer.coordinatorId == coordinatorId) answer.entryId?.let { put(it, answer.id) }
        for (exchange in answer.exchanges) {
            if (exchange.coordinatorId == coordinatorId) exchange.entryId?.let { put(it, answer.id) }
        }
    }
}
