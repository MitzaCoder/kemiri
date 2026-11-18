package io.github.mitzacoder.kemiri.features.chat

import io.github.mitzacoder.kemiri.data.ClientException
import io.github.mitzacoder.kemiri.features.tasks.isSettled
import io.github.mitzacoder.kemiri.features.tasks.taskIdsIn
import io.github.mitzacoder.kemiri.protocol.BoardKeepOnTaskRequest
import io.github.mitzacoder.kemiri.protocol.BoardKeepOnTaskResponse
import io.github.mitzacoder.kemiri.protocol.BoardTask
import kotlinx.coroutines.CancellationException
import org.commonmark.node.*

/** One stored assistant entry, with all its prose in order. No live message carries this identity. */
data class CommittedReply(val conversationId: Long, val entryId: Long, val textParts: List<String>)

private val localTaskLink = Regex("""\?task=(T\d+)""")
private val bareUrl = Regex("""(?i)\b(?:https?://|www\.)\S+""")
private val taskIdHint = Regex("""T\d""")
internal const val REPLY_TASK_CARD_LIMIT = 3

/** Match prose, not code, HTML, links to other pages, or image labels. */
internal fun replyTaskIds(reply: CommittedReply): List<String> = buildSet {
    fun visit(node: Node) {
        when (node) {
            is Text -> addAll(taskIdsIn(node.literal.replace(bareUrl, " ")))
            is Code, is FencedCodeBlock, is IndentedCodeBlock, is HtmlBlock, is HtmlInline, is Image -> Unit
            is Link -> {
                val id = localTaskLink.matchEntire(node.destination)?.groupValues?.get(1) ?: return
                if (id in taskIdsIn(linkLabel(node))) add(id)
            }
            else -> {
                var child = node.firstChild
                while (child != null) { visit(child); child = child.next }
            }
        }
    }
    reply.textParts.filter(taskIdHint::containsMatchIn).forEach { visit(chatMarkdownParser.parse(it)) }
}.toList()

private fun linkLabel(node: Node): String = buildString {
    var child = node.firstChild
    while (child != null) {
        when (child) {
            is Text -> append(child.literal)
            is Code -> append(child.literal)
            else -> append(linkLabel(child))
        }
        child = child.next
    }
}

internal fun committedCoordinatorReply(part: ChatPart, workerId: String?, supportsTaskReports: Boolean): CommittedReply? =
    part.committedReply.takeIf { supportsTaskReports && workerId == null && part.kind == "text" }

internal fun openReplyTasks(ids: List<String>, tasks: Map<String, BoardTask>): List<BoardTask> =
    ids.mapNotNull { tasks[it]?.takeIf(::isOpenReplyTask) }

private fun isOpenReplyTask(task: BoardTask): Boolean = !task.archived && !isSettled(task.status)

internal fun canKeepOnTask(supported: Boolean, task: BoardTask): Boolean = supported && isOpenReplyTask(task)

internal sealed interface KeepReplyResult {
    data class Kept(val feedbackId: String) : KeepReplyResult
    data class Failed(val message: String) : KeepReplyResult
}

internal suspend fun keepReplyOnTask(
    projectId: String,
    taskId: String,
    reply: CommittedReply,
    request: suspend (BoardKeepOnTaskRequest) -> BoardKeepOnTaskResponse,
): KeepReplyResult = try {
    val response = request(BoardKeepOnTaskRequest(projectId = projectId, taskId = taskId, conversationId = reply.conversationId, entryId = reply.entryId))
    KeepReplyResult.Kept(response.feedbackId)
} catch (cause: CancellationException) {
    throw cause
} catch (cause: Exception) {
    KeepReplyResult.Failed(when ((cause as? ClientException)?.code) {
        "unknown_request" -> "This backend does not support Keep on task."
        "unknown_project" -> "This project is no longer available."
        "unknown_task" -> "This task is no longer available."
        "no_coordinator_model" -> "Set a coordinator model before keeping this reply on the task."
        "bad_request" -> "This reply can no longer be kept on the task. The task may have closed."
        null, "not_ready", "disconnected", "timeout" -> "Could not reach the backend. Try again."
        else -> "Could not keep this reply on the task. Try again."
    })
}
