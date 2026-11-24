package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.protocol.BoardQuestion
import io.github.mitzacoder.kemiri.protocol.BoardQuestionChoice
import io.github.mitzacoder.kemiri.protocol.BoardReportCheck
import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.protocol.BoardTaskActivity

// Presentation rules shared with the web's lib/task-details.ts.
internal data class TaskNeedsYou(
    val ownerQuestions: List<BoardQuestion>,
    val questionsForAgent: List<BoardQuestion>,
    val review: Boolean,
    val blocked: Boolean,
    val showSteps: Boolean = false,
    val failed: Boolean = false,
    val working: Boolean = false,
) {
    val show: Boolean get() = ownerQuestions.isNotEmpty() || review || blocked || showSteps || failed
}

internal fun taskNeedsYou(task: BoardTask, questions: List<BoardQuestion>, hasBlockers: Boolean, stepsSupported: Boolean, attentionQuestionId: String? = null, failed: Boolean = false): TaskNeedsYou {
    val (warnings, ordinary) = questions.filter { it.status == "open" && it.taskId == task.id }.partition(::isWarning)
    val (ownerQuestions, questionsForAgent) = (warnings + ordinary).partition { it.waitingOn != "agent" }
    val working = task.state?.liveWorkSince != null
    val stepsEnabled = !working && stepsSupported && !isSettled(task.status)
    val showSteps = stepsEnabled && readReportSection(task.report, ReportSectionKind.Steps).hasContent
    return TaskNeedsYou(ownerQuestions.sortedBy { it.id != attentionQuestionId }, questionsForAgent, !working && task.status == "review",
        task.status == "blocked" && (!task.blockedReason.isNullOrBlank() || hasBlockers), showSteps, failed, working)
}

internal fun taskDetailState(status: String, needsYou: TaskNeedsYou, kind: String? = null): String = when {
    needsYou.working || kind == "working" -> "Working"
    kind == "paused" -> "Paused"
    kind == "clarifying" -> "Clarifying"
    kind == "blocked_by_task" -> "Blocked by another task"
    needsYou.showSteps && kind == "steps_needed" -> "Your steps to do"
    kind == "failed" && status != "blocked" -> "Failed"
    needsYou.ownerQuestions.any { !isWarning(it) } -> "Needs your answer"
    kind == "answer_needed" -> "Needs attention"
    needsYou.showSteps && kind == null && !needsYou.blocked -> "Your steps to do"
    status == "review" -> "Ready for you to check"
    else -> taskStatusWords(status)
}

internal fun showTaskNow(task: BoardTask, activity: BoardTaskActivity?): Boolean = (task.status == "in_progress" || task.state?.liveWorkSince != null) &&
    if (activity == null) task.report.now.isNotBlank() else activity.kind in setOf("working", "deploy", "idle", "unknown")

internal data class TaskDetailFields(
    val goal: String? = null,
    val showSummary: Boolean = false,
    val showNotDone: Boolean = false,
    val checks: List<BoardReportCheck> = emptyList(),
)

internal fun taskDetailFields(task: BoardTask, taskFieldsEnabled: Boolean): TaskDetailFields {
    if (!taskFieldsEnabled) return TaskDetailFields()
    return TaskDetailFields(
        goal = task.goal?.trim()?.takeIf { it.isNotEmpty() },
        showSummary = readReportSection(task.report, ReportSectionKind.Summary).hasContent,
        showNotDone = readReportSection(task.report, ReportSectionKind.NotDone).hasContent,
        checks = task.report.checks.orEmpty(),
    )
}

internal fun failedCheckLine(checks: List<BoardReportCheck>): String? {
    val failed = checks.filter { it.result == "failed" }.map { it.name }
    return when (failed.size) {
        0 -> null
        1 -> "One check failed: ${failed.single()}"
        else -> "${failed.size} checks failed: ${failed.joinToString(", ")}"
    }
}

internal sealed interface QuestionAnswers {
    data class Choices(val choices: List<BoardQuestionChoice>) : QuestionAnswers
    data class Options(val options: List<String>) : QuestionAnswers
}

internal fun questionAnswers(question: BoardQuestion, taskFieldsEnabled: Boolean): QuestionAnswers {
    if (isWarning(question)) return QuestionAnswers.Options(emptyList())
    if (taskFieldsEnabled) question.choices?.takeIf { it.isNotEmpty() }?.let { return QuestionAnswers.Choices(it) }
    return QuestionAnswers.Options(question.options)
}

internal enum class TaskRecordRow(val storageKey: String, val title: String, val openByDefault: Boolean = false) {
    Request("request", "The request", true),
    Checks("checks", "Checks"),
    Decided("decided", "Decided"),
    Activity("activity", "Activity"),
}

internal fun readTaskRecordFold(row: TaskRecordRow, saved: Map<String, Boolean>): Boolean =
    saved[row.storageKey] ?: row.openByDefault

internal fun saveTaskRecordFold(row: TaskRecordRow, expanded: Boolean, saved: Map<String, Boolean>): Map<String, Boolean> =
    saved + (row.storageKey to expanded)

private val markdownBlock = Regex("""\n[ \t]*\n|^(?:\s*(?:[-+*]|\d+[.)])\s|\s*(?:#{1,6}\s|>|```|~~~|\||<)| {4}|\t)""", RegexOption.MULTILINE)
private val acceptanceToken = Regex("""(`+)[^\n]*?\1|\[[^\]\n]*\]\([^\n)]*\)|https?://[^\s]+?(?=;\s|\s|$)|\\.|&(?:#\d+|#x[\da-f]+|[a-z]+);|[;\n]""", RegexOption.IGNORE_CASE)

/** Use a list for flat criteria separated by semicolons or newlines; preserve existing Markdown blocks. */
internal fun acceptanceMarkdown(acceptance: String): String {
    val text = acceptance.trim()
    if (markdownBlock.containsMatchIn(text)) return text
    var start = 0
    val criteria = buildList {
        for (token in acceptanceToken.findAll(text)) {
            if (token.value != ";" && token.value != "\n") continue
            text.substring(start, token.range.first).trim().takeIf { it.isNotEmpty() }?.let(::add)
            start = token.range.last + 1
        }
        text.substring(start).trim().takeIf { it.isNotEmpty() }?.let(::add)
    }
    return if (criteria.size > 1) criteria.joinToString("\n") { "- $it" } else text
}
