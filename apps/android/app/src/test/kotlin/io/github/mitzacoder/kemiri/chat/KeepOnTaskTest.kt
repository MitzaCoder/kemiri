package io.github.mitzacoder.kemiri.chat

import io.github.mitzacoder.kemiri.data.ClientException
import io.github.mitzacoder.kemiri.data.wireJson
import io.github.mitzacoder.kemiri.features.chat.*
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.protocol.BoardKeepOnTaskRequest
import io.github.mitzacoder.kemiri.protocol.BoardKeepOnTaskResponse
import io.github.mitzacoder.kemiri.protocol.EntryRecord
import io.github.mitzacoder.kemiri.tasks.task
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class KeepOnTaskTest {
    private val reply = CommittedReply(12, 34, listOf("T3 is ready."))

    private fun message(role: String, vararg texts: String) = buildJsonObject {
        put("role", role)
        putJsonArray("content") {
            texts.forEach { text -> add(buildJsonObject { put("type", "text"); put("text", text) }) }
        }
    }

    private fun entry(id: Long, kind: String, vararg texts: String) = EntryRecord(
        id = id, conversationId = 12, kind = "pi.$kind", model = listOf(message(kind, *texts)),
    )

    @Test fun onlyCommittedCoordinatorProseAddsCardsOncePerEntry() {
        val live = buildJsonObject { putJsonObject("generation") { put("message", message("assistant", "T13 is still streaming.")) } }
        val parts = transcript(listOf(
            entry(31, "user", "Look at T10"),
            entry(32, "user", "[worker owl reported]\nT11 is fine."),
            entry(34, "assistant", "T3 and [T4](?task=T4). Ignore `T5` and [T6](https://example.test/T6).", "**T3** and T7"),
            entry(35, "assistant", "T9 is a different reply."),
            entry(0, "assistant", "T12 has no committed entry ID."),
        ), live).flatMap { it.parts }
        val replies = parts.mapNotNull { committedCoordinatorReply(it, workerId = null, supportsTaskReports = true) }
        assertEquals(listOf(listOf("T3", "T4", "T7"), listOf("T9")), replies.map(::replyTaskIds))
        assertEquals(listOf(34L, 35L), replies.map { it.entryId })
        assertEquals("**T3** and T7", parts.single { it.committedReply?.entryId == 34L }.text)
        assertTrue(parts.none { committedCoordinatorReply(it, "worker", true) != null })
        assertTrue(parts.none { committedCoordinatorReply(it, null, false) != null })
    }

    @Test fun excludesCodeImagesAndLinkDestinationsButReadsListsAndTableCells() {
        val markdown = """
            - T1 and [different T2](?task=T3)
            - ![T4](https://example.test/T5) and https://example.test/?task=T6

            ```
            T7
            ```

            | Pull | Work |
            | ---- | ---- |
            | external | T8 |
            | local | [**T9**](?task=T9) |
        """.trimIndent()
        assertEquals(listOf("T1", "T8", "T9"), replyTaskIds(reply.copy(textParts = listOf(markdown))))
    }

    @Test fun cardsKeepMentionOrderForKnownOpenTasksAndKeepNeedsTheFeature() {
        val open = task("T3", "review")
        val todo = task("T1")
        val done = task("T2", "done")
        val archived = task("T4", archived = true)
        val dropped = task("T5", "dropped")
        val tasks = listOf(todo, done, open, archived, dropped).associateBy { it.id }
        assertEquals(listOf(open, todo), openReplyTasks(listOf("T5", "T3", "T8", "T2", "T4", "T1"), tasks))
        assertEquals(3, REPLY_TASK_CARD_LIMIT)
        assertFalse(canKeepOnTask(false, open))
        assertTrue(canKeepOnTask(true, open))
        for (closed in listOf(done, archived, dropped)) assertFalse(canKeepOnTask(true, closed))
    }

    @Test fun typedRequestNamesTheCommittedEntryAndReturnsTheReceiptNote() = runBlocking {
        val sent = mutableListOf<BoardKeepOnTaskRequest>()
        suspend fun keep() = keepReplyOnTask("project-test", "T3", reply) {
            sent += it
            BoardKeepOnTaskResponse(id = it.id, feedbackId = "F2")
        }
        val receipt = keep() as KeepReplyResult.Kept
        assertEquals(receipt, keep())
        val request = wireJson.encodeToJsonElement(BoardKeepOnTaskRequest.serializer(), sent.first()).jsonObject
        assertEquals(setOf("type", "id", "projectId", "taskId", "conversationId", "entryId"), request.keys)
        assertEquals(JsonPrimitive("board.keepOnTask"), request["type"])
        assertEquals(JsonPrimitive("project-test"), request["projectId"])
        assertEquals(JsonPrimitive("T3"), request["taskId"])
        assertEquals(JsonPrimitive(12L), request["conversationId"])
        assertEquals(JsonPrimitive(34L), request["entryId"])
        assertEquals(sent.first().copy(id = sent.last().id), sent.last())
        val route = Destination.Task(Destination.Chat("backend", "project-test"), "T3", feedbackId = receipt.feedbackId)
        assertEquals(route, wireJson.decodeFromString(Destination.serializer(), wireJson.encodeToString(Destination.serializer(), route)))
    }

    @Test fun expectedErrorsShowHelpfulWordsInsteadOfBackendText() = runBlocking {
        for ((code, prefix) in mapOf(
            "unknown_request" to "This backend does not support",
            "unknown_project" to "This project is no longer available",
            "unknown_task" to "This task is no longer available",
            "no_coordinator_model" to "Set a coordinator model",
            "bad_request" to "This reply can no longer be kept",
        )) {
            val result = keepReplyOnTask("project-test", "T3", reply) { throw ClientException(code, "opaque backend text") }
            assertTrue((result as KeepReplyResult.Failed).message.startsWith(prefix))
        }
    }
}
