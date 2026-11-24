package io.github.mitzacoder.kemiri.data

import io.github.mitzacoder.kemiri.features.tasks.isSettled
import io.github.mitzacoder.kemiri.features.tasks.taskStatusWords
import io.github.mitzacoder.kemiri.protocol.BoardTask
import kotlinx.coroutines.CompletableDeferred

/** A single owner decision shared by sheet, editor and board saves. Null means Cancel. */
data class CloseTaskParts(val taskId: String, val parts: List<BoardTask>, val reply: CompletableDeferred<String?> = CompletableDeferred(), val serverMessage: String? = null) {
    val question: String get() = if (parts.isEmpty()) (serverMessage ?: "$taskId has open parts.") + " What should happen to them?" else "$taskId has ${parts.size} open parts: " +
        parts.joinToString(", ") { "${it.id} (${when (it.status) { "review" -> "in review"; "in_progress" -> "in progress"; else -> taskStatusWords(it.status).lowercase() }})" } +
        ". What should happen to them?"
}

fun openDirectParts(tasks: List<BoardTask>, taskId: String): List<BoardTask> =
    tasks.filter { it.parent == taskId && !isSettled(it.status) }

fun needsClosePartsChoice(
    status: String?, taskId: String?, tasks: List<BoardTask>, supported: Boolean, requestDigest: Boolean = false,
): Boolean {
    if (!supported || taskId == null || status?.let(::isSettled) != true) return false
    val task = tasks.find { it.id == taskId }
    if (requestDigest && task != null && (task.parent != null || task.status == status)) return false
    return openDirectParts(tasks, taskId).isNotEmpty()
}

fun isOpenPartsError(error: Throwable): Boolean = (error as? ClientException)?.code == "open_parts"
