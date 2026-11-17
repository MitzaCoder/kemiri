package io.github.mitzacoder.kemiri.features.tasks.graph

import io.github.mitzacoder.kemiri.features.tasks.taskActivity
import io.github.mitzacoder.kemiri.features.chat.markdownText
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.protocol.*

internal data class GraphPeekParts(val listed: List<BoardTask>, val done: Long)
internal fun graphPeekParts(task: BoardTask, tasks: List<BoardTask>, questions: List<BoardQuestion>): GraphPeekParts {
    val direct = tasks.filter { it.parent == task.id || it.id in task.subtasks.orEmpty() }
    val listed = direct.filter { part ->
        part.state?.let { it.kind in listOf("working", "clarifying") || it.group == "needs_you" }
            ?: (part.status in listOf("in_progress", "review", "blocked") ||
                (!graphClosed(part.status) && questions.any { it.taskId == part.id && it.status == "open" }))
    }.sortedBy { it.order }
    val done = task.subtaskCount?.done ?: task.subtaskStates?.count { it == "done" }?.toLong()
        ?: direct.count { (it.state?.kind ?: it.status) == "done" }.toLong()
    return GraphPeekParts(listed, done)
}

/** Never attribute another conversation's phase to a worker that happens to share its name. */
internal fun graphWorkerActivity(worker: WorkerSummary, task: BoardTask?, enabled: Boolean): BoardTaskActivity? {
    val activity = if (enabled && task != null && task.id == worker.taskId) taskActivity(task, true) else null
    val actor = activity?.actor
    return activity?.takeIf { it.text.isNotBlank() && actor?.kind == "worker" && actor.name == worker.id &&
        actor.conversationId == worker.conversationId && actor.threadId == (worker.threadId ?: "main") }
}
internal fun graphWorkerDoingNow(worker: WorkerSummary, task: BoardTask?, enabled: Boolean): String? =
    graphWorkerActivity(worker, task, enabled)?.text ?: worker.lastReport?.trim()?.takeIf { it.isNotEmpty() }

internal fun graphPeekResults(source: String): List<String> {
    val bullets = mutableListOf<String>()
    var paragraph = ""
    fun flush() { markdownText(paragraph).trim().takeIf { it.isNotEmpty() }?.let(bullets::add); paragraph = "" }
    source.lines().forEach { line ->
        val bullet = Regex("^\\s*(?:[-*+] |\\d+[.)] )\\s*(.*)$").matchEntire(line)
        when {
            bullet != null -> { flush(); paragraph = bullet.groupValues[1] }
            line.isBlank() -> flush()
            else -> paragraph += (if (paragraph.isEmpty()) "" else " ") + line.trim()
        }
    }
    flush()
    return bullets.take(3)
}

internal fun graphWorkerKey(worker: WorkerSummary) = "worker:${worker.threadId ?: "main"}:${worker.conversationId}:${worker.id}"
internal fun GraphModel.crewSelection(taskId: String, crewId: String): String? = details[taskId]?.let { task ->
    if (crewId.startsWith("thread:")) task.threads.find { "thread:${it.id}" == crewId }?.let { "thread:${it.id}" }
    else task.workers.find { "worker:${it.id}" == crewId }?.let(::graphWorkerKey)
}
internal fun graphWorkerRoute(route: Destination.Chat, worker: WorkerSummary): Destination.Chat =
    route.copy(workerId = worker.id, threadId = worker.threadId?.takeUnless { it == "main" }, highlight = null)
