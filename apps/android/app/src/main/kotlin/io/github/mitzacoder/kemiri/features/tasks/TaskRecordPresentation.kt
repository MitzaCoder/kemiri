package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.features.chat.markdownText
import io.github.mitzacoder.kemiri.protocol.*
import java.time.Instant
import java.time.ZoneId

// Keep the projections in sync with the web's lib/task-record.ts.
private val questionIdsInText = Regex("""\bQ[1-9]\d*\b""", RegexOption.IGNORE_CASE)
private val questionCitation = Regex("""\b(?:answer|reply)\s+to\s+(?:question\s+)?[`*\[]*(Q[1-9]\d*)\b""", RegexOption.IGNORE_CASE)

private fun answeredQuestionId(text: String?): String? {
    if (text == null) return null
    if (questionIdsInText.findAll(text).map { it.value.uppercase() }.toSet().size != 1) return null
    return questionCitation.find(text)?.groupValues?.get(1)?.uppercase()
}

internal data class DecidedRow(
    val id: String, val at: String, val decision: BoardDecision? = null, val question: BoardQuestion? = null, val why: String? = null,
)

/** A bare mention, similar wording or nearby timestamps aren't evidence of a decision's origin. */
internal fun taskDecided(taskId: String, decisions: List<BoardDecision>, questions: List<BoardQuestion>): List<DecidedRow> {
    val answered = questions.filter { it.taskId == taskId && !isWarning(it) && it.status == "answered" }
    val answeredById = answered.associateBy { it.id }
    val taskDecisions = decisions.filter { it.taskId == taskId }
    val citations = mutableMapOf<String, MutableList<BoardDecision>>()
    for (decision in taskDecisions) {
        val inWhy = answeredQuestionId(decision.why)
        val inText = answeredQuestionId(decision.text)
        if (inWhy != null && inText != null && inWhy != inText) continue
        val question = answeredById[inWhy ?: inText] ?: continue
        val answerTime = question.answeredAt?.let(::activityInstant) ?: continue
        val decisionTime = activityInstant(decision.at) ?: continue
        if (decisionTime >= answerTime) citations.getOrPut(question.id) { mutableListOf() }.add(decision)
    }
    val paired = answered.mapNotNull { question -> citations[question.id]?.singleOrNull()?.let { it.id to question } }.toMap()
    val pairedIds = paired.values.mapTo(hashSetOf()) { it.id }
    return (taskDecisions.map { decision ->
        val question = paired[decision.id]
        val why = decision.why.takeUnless { question != null && answeredQuestionId(it) != null }
        DecidedRow(decision.id, decision.at, decision, question, why)
    } + answered.filterNot { it.id in pairedIds }.map { DecidedRow(it.id, it.answeredAt ?: it.askedAt, question = it) })
        .sortedByDescending { it.at }
}

internal data class ActivityRow(
    val id: String, val at: String?, val label: String, val detail: String? = null, val workerId: String? = null,
    val taskId: String? = null, val fact: BoardTimelineFact? = null, val snapshot: BoardTaskSnapshot? = null, val now: Boolean = false,
    /** `task-live`: the lines a finished run folded into this row. */
    val live: BoardTaskLive? = null,
)

internal data class ActivityNow(val text: String, val at: String, val activity: BoardTaskActivity? = null)

internal fun taskRecordNow(task: BoardTask, activity: BoardTaskActivity?, questions: List<BoardQuestion>, deliveryShown: Boolean): ActivityNow? {
    if (!showTaskNow(task, activity)) return null
    if (activity == null) return ActivityNow(task.report.now, task.report.updatedAt ?: task.updatedAt)
    if (questions.any { it.status == "open" && it.id in activity.refs }) return null
    if (deliveryShown && (activity.kind == "deploy" || activity.refs.any { it.startsWith("deploy:") })) return null
    return ActivityNow(activity.text, activity.since, activity)
}

internal data class ActivitySources(
    val entries: List<BoardTimelineEntry> = emptyList(), val groups: List<BoardTimelineGroup>? = null,
    val snapshots: List<BoardTaskSnapshot> = emptyList(), val questions: List<BoardQuestion> = emptyList(),
    val decisions: List<DecidedRow> = emptyList(), val feedback: List<BoardFeedback> = emptyList(),
    val workers: Map<String, WorkerSummary?> = emptyMap(), val now: ActivityNow? = null, val deliveryShown: Boolean = false,
    val taskLiveEnabled: Boolean = false,
)

private val questionRef = Regex("""^(?:(?:Question|Warning) )?(Q[1-9]\d*)\b""", RegexOption.IGNORE_CASE)
private val decisionRef = Regex("""^Decision (D\d+)\b""", RegexOption.IGNORE_CASE)
private val feedbackRef = Regex("""^(?:Feedback )?(F\d+)\b""", RegexOption.IGNORE_CASE)
private val workerLabel = Regex("""^Worker (\S+) (?:started|resumed|reported|failed|stopped)\b""", RegexOption.IGNORE_CASE)
private val workerStart = Regex("""\b(?:started|resumed)\b""", RegexOption.IGNORE_CASE)
private val workerEnd = Regex("""\b(?:reported|stopped|failed)\b""", RegexOption.IGNORE_CASE)
private val landedLabel = Regex("""^\d+ changes? (?:landed on|removed from|reverted on) """)
private val landedDetail = Regex("""^(?:Landed|Removed|Reverted) [a-f0-9]{12} """, RegexOption.IGNORE_CASE)

/** Recognize only milestones produced by delivery observers, not arbitrary prose about code. */
internal fun isDeliveryMilestone(entry: BoardTimelineEntry, fact: BoardTimelineFact? = null): Boolean = entry.kind == "milestone" &&
    (fact?.source in listOf("change", "deploy") || entry.ref?.startsWith("deploy:") == true ||
        (landedLabel.containsMatchIn(entry.label) && landedDetail.containsMatchIn(entry.detail.orEmpty())))

private data class ActivityEntryKey(val kind: String, val ref: String?, val at: String, val label: String) {
    fun rowId(): String = listOf(kind, ref.orEmpty(), at, label).joinToString(separator = "", prefix = "event:") { "${it.length}:$it" }
}

internal fun taskActivityRows(sources: ActivitySources): List<ActivityRow> {
    val questionIds = sources.questions.filter { it.status == "open" || (it.status == "answered" && !isWarning(it)) }.mapTo(hashSetOf()) { it.id }
    val decisionIds = sources.decisions.mapNotNull { it.decision?.id }.toSet()
    val feedbackIds = sources.feedback.mapTo(hashSetOf()) { it.id }
    val snapshotKeys = sources.snapshots.mapTo(hashSetOf()) { Triple(it.seq.toString(), it.at, it.label) }
    val rows = sources.snapshots.map { ActivityRow("snapshot:${it.seq}", it.at, activityStatus(it.label), snapshot = it) }.toMutableList()
    val representedWorkers = hashSetOf<String>()
    val workerStarts = mutableMapOf<Pair<String, String>, Int>()
    val seen = hashSetOf<String>()
    val entries = sources.groups?.flatMap { it.entries }?.map { fact ->
        BoardTimelineEntry(
            at = fact.at, kind = fact.kind, label = fact.label, detail = fact.detail,
            ref = fact.ref, state = fact.state, by = fact.by, live = fact.live,
        ) to fact
    } ?: sources.entries.map { it to null }
    for ((entry, fact) in entries) {
        if (entry.kind == "question" && (entry.ref ?: questionRef.find(entry.label)?.groupValues?.get(1)?.uppercase()) in questionIds) continue
        if (entry.kind == "decision" && (entry.ref ?: decisionRef.find(entry.label)?.groupValues?.get(1)) in decisionIds) continue
        if (entry.kind == "feedback" && (entry.ref ?: feedbackRef.find(entry.label)?.groupValues?.get(1)) in feedbackIds) continue
        if (Triple(entry.ref, entry.at, entry.label) in snapshotKeys) continue
        if (sources.deliveryShown && isDeliveryMilestone(entry, fact)) continue
        val run = entry.live?.lines?.firstOrNull()?.takeIf { sources.taskLiveEnabled }
        val key = fact?.id ?: run?.let { "live-run:${it.id}" } ?: ActivityEntryKey(entry.kind, entry.ref, entry.at, entry.label).rowId()
        if (!seen.add(key)) continue

        val worker = if (entry.kind != "worker") null else fact?.actor?.takeIf { it.kind == "worker" }?.name
            ?: entry.ref ?: entry.by?.workerId ?: workerLabel.find(entry.label)?.groupValues?.get(1)
        val row = ActivityRow(key, fact?.endAt ?: entry.at,
            if (entry.kind == "status") activityStatus(entry.label) else entry.label, entry.detail, worker,
            taskId = entry.ref.takeIf { entry.kind == "link" }, fact = fact, live = entry.live.takeIf { sources.taskLiveEnabled })
        if (worker != null) {
            representedWorkers += worker
            if (fact == null) {
                val episode = (entry.by?.threadId ?: "main") to worker
                if (workerStart.containsMatchIn(entry.label)) workerStarts[episode] = rows.size
                else if (workerEnd.containsMatchIn(entry.label)) {
                    val index = workerStarts.remove(episode)
                    if (index != null) { rows[index] = row.copy(id = rows[index].id); continue }
                }
            }
        }
        rows += row
    }
    sources.now?.let { current ->
        val actor = current.activity?.takeIf { it.kind == "working" }?.actor?.id
        val index = if (actor == null) -1 else rows.indexOfFirst { it.fact?.actor?.id == actor && it.fact.outcome == "running" }
        if (index >= 0) rows[index] = rows[index].copy(label = current.text, at = current.at, now = true)
        else if (rows.none { it.label == current.text || it.detail == current.text }) rows += ActivityRow("now", current.at, current.text, now = true)
    }
    for ((id, worker) in sources.workers) if (id !in representedWorkers) {
        val label = if (worker != null) "${worker.title.ifBlank { id }} · ${worker.status}" else "$id · worker no longer available"
        rows += ActivityRow("worker:$id", worker?.updatedAt, label, workerId = id)
    }
    return rows
}

internal data class ActivityDay(val day: String, val entries: List<ActivityRow>)

internal fun activityDays(rows: List<ActivityRow>, newestFirst: Boolean, limit: Int, now: Long, zone: ZoneId = ZoneId.systemDefault()): List<ActivityDay> {
    val withDates = rows.partition { it.at != null }
    val dated = if (newestFirst) withDates.first.sortedByDescending { activityInstant(it.at.orEmpty()) }
        else withDates.first.sortedBy { activityInstant(it.at.orEmpty()) }
    return (dated + withDates.second).take(limit).groupBy { row -> row.at?.let { timelineDay(it, now, zone) } ?: "Date not recorded" }
        .map { (day, entries) -> ActivityDay(day, entries) }
}

private fun activityInstant(at: String): Instant? = runCatching { Instant.parse(at) }.getOrNull()
private val statusWords = Regex("""\b(in_progress|todo)\b""")
private fun activityStatus(label: String): String = label.replace(statusWords) { if (it.value == "todo") "To do" else "Working" }
private val commitIdInText = Regex("""\b(?=[a-f0-9]{7,64}\b)(?=[a-f0-9]*[0-9])(?=[a-f0-9]*[a-f])[a-f0-9]+\b""", RegexOption.IGNORE_CASE)
private val whitespace = Regex("""\s+""")
internal fun activityText(text: String): String = markdownText(text).replace(commitIdInText, "the commit").replace(whitespace, " ").trim()
