package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.protocol.BoardQuestion
import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.protocol.BoardTaskActivity

// Presentation rules shared with the web's lib/task-details.ts.
internal data class TaskNeedsYou(
    val ownerQuestions: List<BoardQuestion>,
    val questionsForAgent: List<BoardQuestion>,
    val review: Boolean,
    val blocked: Boolean,
    val stepsMarkdown: String? = null,
) {
    val show: Boolean get() = ownerQuestions.isNotEmpty() || review || blocked || stepsMarkdown != null
}

internal fun taskNeedsYou(task: BoardTask, questions: List<BoardQuestion>, hasBlockers: Boolean, stepsSupported: Boolean): TaskNeedsYou {
    val (warnings, ordinary) = questions.filter { it.status == "open" && it.taskId == task.id }.partition(::isWarning)
    val (ownerQuestions, questionsForAgent) = (warnings + ordinary).partition { it.waitingOn != "agent" }
    val stepsMarkdown = if (stepsSupported && !isSettled(task.status)) task.report.steps?.takeIf { it.isNotBlank() } else null
    return TaskNeedsYou(ownerQuestions, questionsForAgent, task.status == "review",
        task.status == "blocked" && (!task.blockedReason.isNullOrBlank() || hasBlockers), stepsMarkdown)
}

internal fun taskDetailState(status: String, needsYou: TaskNeedsYou, kind: String? = null): String = when {
    needsYou.stepsMarkdown != null && kind == "steps_needed" -> "Your steps to do"
    needsYou.ownerQuestions.any { !isWarning(it) } -> "Needs your answer"
    needsYou.stepsMarkdown != null && kind == "failed" && status != "blocked" -> "Failed"
    needsYou.stepsMarkdown != null && kind == null && !needsYou.blocked -> "Your steps to do"
    status == "review" -> "Ready for you to check"
    else -> taskStatusWords(status)
}

internal fun showTaskNow(task: BoardTask, activity: BoardTaskActivity?): Boolean = task.status == "in_progress" &&
    if (activity == null) task.report.now.isNotBlank() else activity.kind in setOf("working", "deploy", "idle", "unknown")

internal enum class TaskRecordRow(val storageKey: String, val title: String, val openByDefault: Boolean = false) {
    Request("request", "The request", true),
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
