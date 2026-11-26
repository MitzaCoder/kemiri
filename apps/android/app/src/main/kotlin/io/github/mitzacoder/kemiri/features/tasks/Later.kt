package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.data.BoardView
import io.github.mitzacoder.kemiri.data.normalizeWorkDayStart
import io.github.mitzacoder.kemiri.protocol.BoardLater
import io.github.mitzacoder.kemiri.protocol.BoardLaterSetRequest
import io.github.mitzacoder.kemiri.protocol.BoardLaterSetRequestWorkDay
import io.github.mitzacoder.kemiri.protocol.BoardQuestion
import io.github.mitzacoder.kemiri.protocol.BoardTask
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

internal data class LaterTarget(
    val id: String, val revision: Long, val title: String, val question: Boolean, val urgent: Boolean, val record: BoardLater?,
) {
    fun request(projectId: String, until: String?, whenLast: Boolean, workDayStart: String, zone: ZoneId, revision: Long = this.revision) =
        BoardLaterSetRequest(projectId = projectId, target = buildJsonObject { put(if (question) "questionId" else "taskId", id) },
            expectedRevision = revision, until = until, whenLast = true.takeIf { whenLast },
            workDay = BoardLaterSetRequestWorkDay(normalizeWorkDayStart(workDayStart), zone.id))
}

/** An attached question always acts on the root request, even when shown on a part or in chat. */
internal fun BoardView.laterRequest(taskId: String): BoardTask? {
    var current = task(taskId) ?: return null
    val seen = hashSetOf<String>()
    while (seen.add(current.id)) {
        val parent = current.requestId ?: current.parent ?: return current
        current = task(parent) ?: return null
    }
    return null
}

private fun BoardQuestion.laterAllowed() = status == "open" && waitingOn != "agent" &&
    mcpApproval != true && outsideModelApproval != true && usageDrainIncident == null

internal fun BoardView.laterTarget(task: BoardTask): LaterTarget? {
    val request = laterRequest(task.id) ?: return null
    if (request.archived || isSettled(request.status)) return null
    val asks = questions.filter { question -> question.laterAllowed() && question.taskId?.let { laterRequest(it)?.id } == request.id }
    val failed = tasks.any { it.state?.kind == "failed" && !isSettled(it.status) && laterRequest(it.id)?.id == request.id }
    val kind = request.state?.kind
    if (request.later == null && asks.isEmpty() && !failed && kind != "steps_needed" && kind != "review") return null
    return LaterTarget(request.id, request.revision, request.title, question = false, urgent = failed || asks.any(::isWarning), record = request.later)
}

internal fun BoardView.laterTarget(question: BoardQuestion): LaterTarget? {
    if (!question.laterAllowed()) return null
    return question.taskId?.let { id -> task(id)?.let { laterTarget(it) } }
        ?: if (question.taskId == null) LaterTarget(question.id, question.revision, question.text, question = true,
            urgent = isWarning(question), record = question.later) else null
}

internal fun BoardView.laterQuestions(requestId: String): List<BoardQuestion> = questions.filter {
    it.postponed == true && it.status == "open" && it.taskId?.let { id -> laterRequest(id)?.id } == requestId
}

internal fun BoardView.laterWaitingParts(requestId: String): Int {
    val asks = laterQuestions(requestId).filter { it.blocksWork ?: !isWarning(it) }.mapNotNull { it.taskId }.toSet()
    return tasks.count { part ->
        part.parent != null && !part.archived && !isSettled(part.status) && laterRequest(part.id)?.id == requestId &&
            (part.id in asks || part.blockedBy.any { it == requestId || it in asks })
    }
}

internal fun laterNeedLabel(task: BoardTask, asks: List<BoardQuestion>): String = when {
    asks.any { !isWarning(it) } -> "Answer needed"
    asks.any(::isWarning) -> "Warning"
    task.state?.kind == "failed" -> "Failed"
    task.state?.kind == "steps_needed" -> "Your steps"
    task.status == "review" -> "Review"
    else -> "Put aside"
}

internal data class LaterChoice(val label: String, val until: Instant? = null, val whenLast: Boolean = false, val pickDate: Boolean = false)
private val laterLimit = Duration.ofDays(30)

internal fun laterChoices(now: Instant, zone: ZoneId, start: String, urgent: Boolean, question: Boolean): List<LaterChoice> {
    val today = now.atZone(zone).toLocalDate()
    val morning = LocalTime.parse(normalizeWorkDayStart(start))
    fun deadline(day: LocalDate, time: LocalTime = morning) = day.atTime(time).atZone(zone).toInstant()
    val tomorrow = deadline(today.plusDays(1))
    return buildList {
        if (urgent) now.plusSeconds(3600).takeIf { it <= tomorrow }?.let { add(LaterChoice("In 1 hour", it)) }
        deadline(today, LocalTime.of(18, 0)).takeIf { it > now && (!urgent || it <= tomorrow) }?.let {
            add(LaterChoice("This evening", it))
        }
        add(LaterChoice("Tomorrow morning", tomorrow))
        if (!urgent) {
            add(LaterChoice("Next week", deadline(today.plusDays(7))))
            add(LaterChoice("Pick a date…", pickDate = true))
            if (!question) add(LaterChoice("When it’s the last thing left", whenLast = true))
        }
    }
}

internal fun laterDateDeadline(date: LocalDate, now: Instant, zone: ZoneId, start: String): Instant? =
    date.atTime(LocalTime.parse(normalizeWorkDayStart(start))).atZone(zone).toInstant().takeIf { it > now && it <= now.plus(laterLimit) }

internal fun laterReturnLabel(record: BoardLater): String = if (record.whenLast == true) "Back when it’s the last thing left"
    else "Back ${runCatching { formatWaitingTime(record.until) }.getOrDefault(record.until)}"

internal fun laterPutAsideLabel(record: BoardLater): String = if (record.whenLast == true) "Put aside until it’s the last thing left"
    else "Put aside until ${runCatching { formatWaitingTime(record.until) }.getOrDefault(record.until)}"
