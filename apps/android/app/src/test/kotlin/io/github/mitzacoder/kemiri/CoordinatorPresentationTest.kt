package io.github.mitzacoder.kemiri

import io.github.mitzacoder.kemiri.data.BackendConfig
import io.github.mitzacoder.kemiri.features.chat.highlightIndex
import io.github.mitzacoder.kemiri.features.chat.transcript
import io.github.mitzacoder.kemiri.features.coordinators.*
import io.github.mitzacoder.kemiri.features.notifications.AppLink
import io.github.mitzacoder.kemiri.features.notifications.notificationLink
import io.github.mitzacoder.kemiri.navigation.*
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.tasks.task
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class CoordinatorPresentationTest {
    private fun thread(id: String, kind: String = "coordinator", order: Long = 0) = ThreadSummary(
        id = id, title = id, status = "idle", main = id == "main", kind = kind, order = order, startedBy = null,
        scheduleId = null, conversationId = 1, model = null, thinkingLevel = null, onFinish = "record", runningWorkers = 0,
        ownedTasks = emptyList(), openQuestions = 0, current = null, summary = null, failure = null, createdAt = "", updatedAt = "",
        finishedAt = null, archived = false,
    )

    @Test fun rosterOrderIgnoresAttentionAndOmitsJobsAndArchivedCoordinators() {
        val rows = listOf(thread("shop", order = 2), thread("old").copy(archived = true), thread("job", "job"), thread("main", order = 7),
            thread("kitchen", order = 1).copy(runningWorkers = 3), thread("delivery", order = 1))
        assertEquals(listOf("main", "delivery", "kitchen", "shop"), coordinatorRoster(rows).map { it.id })
    }

    @Test fun badgesKeepAttentionWorkPauseAndUnreadIndependent() {
        val shop = thread("shop").copy(status = "running", held = true, lastReplyEntryId = 9, attention = ThreadSummaryAttention(1, 0, 0, 1, 0))
        assertEquals(CoordinatorBadges(2, true, true, true, "Needs you"), coordinatorBadges(shop, 8))
        assertEquals("needs you, 2 need you, working, paused", coordinatorBadges(shop, 9).description())
        assertEquals("Failed", coordinatorBadges(shop.copy(status = "failed")).state)
    }

    @Test fun scopedTasksAndJobQuestionsStayWithTheCoordinatorButExternalPartsRemainLinked() {
        val threads = listOf(thread("shop"), thread("kitchen"), thread("job", "job").copy(parentThreadId = "shop"))
        val parent = task("T1").copy(coordinatorId = "shop")
        val part = task("T2").copy(parent = "T1", coordinatorId = "kitchen")
        val all = listOf(parent, part, part.copy(id = "T3", archived = true), task("T4"))
        val shop = CoordinatorTaskScope(threads, "shop")
        val question = BoardQuestion(id = "Q1", revision = 1, text = "Ready?", options = emptyList(), taskId = null, threadId = "job",
            status = "open", answer = null, askedAt = "", answeredAt = null)
        assertEquals(listOf(question), shop.questions(listOf(question, question.copy(threadId = "kitchen"))))
        assertEquals(listOf(parent), shop.tasks(all))
        assertEquals(listOf(part), shop.externalParts(parent, all, setOf("T1")))
        assertTrue(shop.externalParts(parent, all, setOf("T1", "T2")).isEmpty())
        assertEquals(listOf("T1", "T4"), CoordinatorTaskScope(threads, null, setOf("kitchen")).tasks(all).map { it.id })
    }

    @Test fun transcriptJoinsBatchedReceiverEntriesAndSenderToolResults() {
        fun message(id: String) = ThreadsMessagesResponseMessagesItem(id = id, from = "shop", to = "kitchen", kind = "request", firstLine = "Ready?", text = "Ready?", at = "")
        val peers = listOf(message("a"), message("b")).associateBy { it.id }
        val stalePage = mergeMessages(mapOf("a" to message("a").copy(replied = true)), listOf(message("a")))
        assertEquals(true, stalePage.getValue("a").replied)
        val user = EntryRecord(5, 1, "pi.user", listOf(Json.parseToJsonElement("""{"role":"user","content":"[from shop] Ready?"}""")),
            Json.parseToJsonElement("""{"threadMessageIds":["a","b"],"peerDisplayContent":[{"type":"text","text":"Owner reply"}]}"""))
        val result = EntryRecord(6, 1, "pi.tool-result", listOf(Json.parseToJsonElement("""{"role":"toolResult","toolCallId":"call","toolName":"thread_send","details":{"threadMessageId":"a"}}""")))
        assertEquals(listOf("a", "b", null, "a"), transcript(listOf(user, result), null, peerMessages = peers).map { it.parts.single().peerMessageId })
        assertEquals("Owner reply", transcript(listOf(user), null, peerMessages = peers).last().parts.single().text)
        assertNull(transcript(listOf(user), null, peerMessages = peers - "a").single().parts.single().peerMessageId)
        assertEquals(1, highlightIndex(transcript(listOf(user), null, peerMessages = peers), ChatHighlight.PeerMessage("b")))
    }

    @Test fun pushOpensCoordinatorAtEntryAndPreservesLegacyJobDestination() {
        val backend = BackendConfig(name = "Bakery", url = "https://bakery.example.test")
        val payload = NotificationPayload(kind = "reply_ready", title = "Bakery · Shop", body = "Done", backendKey = backend.key, projectId = "p",
            workerId = null, scheduleId = null, threadId = "job", coordinatorId = "shop", entryId = 42, tag = "reply", at = "")
        val route = Destination.Chat(backend.key, "p", "shop", highlight = ChatHighlight.Entry(42))
        assertEquals(AppLink.Open(listOf(route)), notificationLink(payload, listOf(backend)))
        assertEquals(AppLink.Open(listOf(route.copy(threadId = null, highlight = ChatHighlight.Thread("job")))),
            notificationLink(payload.copy(coordinatorId = null, entryId = null), listOf(backend)))
        assertEquals(Destination.Chat(backend.key, "p"), coordinatorRoute(route, "main"))
    }

    @Test fun mutationRetriesKeepTheOperationIdWithoutReusingItForAnotherMutation() = runBlocking {
        val operations = CoordinatorOperations()
        var attempted: String? = null
        runCatching { operations.run("archive") { attempted = it; error("Response lost") } }
        assertNotEquals(attempted, operations.run("restore") { it })
        assertEquals(attempted, operations.run("archive") { it })
        assertNotEquals(attempted, operations.run("archive") { it })
    }
}
