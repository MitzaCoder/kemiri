package io.github.mitzacoder.kemiri.features.answers

import io.github.mitzacoder.kemiri.data.BackendConfig
import io.github.mitzacoder.kemiri.data.ConnectionState
import io.github.mitzacoder.kemiri.data.answersListRequest
import io.github.mitzacoder.kemiri.data.copyAnswerFromTaskRequest
import io.github.mitzacoder.kemiri.data.supportsAnswersWorkAndTasks
import io.github.mitzacoder.kemiri.data.toCatalogue
import io.github.mitzacoder.kemiri.data.wireJson
import io.github.mitzacoder.kemiri.features.notifications.AppLink
import io.github.mitzacoder.kemiri.features.notifications.InAppAlert
import io.github.mitzacoder.kemiri.features.notifications.PendingAppLink
import io.github.mitzacoder.kemiri.features.notifications.notificationLink
import io.github.mitzacoder.kemiri.features.notifications.pushPayload
import io.github.mitzacoder.kemiri.features.notifications.resolve
import io.github.mitzacoder.kemiri.navigation.ChatHighlight
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.protocol.*
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.*
import org.junit.Test

class AnswersTest {
    private fun answer(id: String = "A1", at: String = "2026-01-08T13:30:00Z", pinned: Boolean = false,
        read: Boolean = true, coordinator: String = "main", entry: Long? = null, earlier: List<AnswerExchange> = emptyList()) =
        Answer("Was the menu updated?", "Yes.", at, coordinator, "General", "agent", entryId = entry,
            id = id, title = "Menu update", related = emptyList(), pinned = pinned, read = read, exchanges = earlier)

    @Test fun `pinned first then newest first in local day groups`() {
        val groups = groupAnswers(listOf(answer("A1", "2026-01-01T13:00:00Z", pinned = true),
            answer("A2", "2026-01-08T03:00:00Z"), answer("A4"), answer("A8"), answer("A3", "2026-01-06T13:00:00Z"),
            answer("A5", pinned = true)), LocalDate.parse("2026-01-08"), ZoneId.of("America/New_York"))
        assertEquals(listOf("Pinned", "Today", "Yesterday"), groups.take(3).map { it.label })
        assertEquals(listOf(listOf("A5", "A1"), listOf("A8", "A4"), listOf("A2"), listOf("A3")),
            groups.map { group -> group.entries.map { it.key } })
    }

    @Test fun `unread pinned or outside search still lights the tab`() {
        val catalogue = listOf(answer(), answer("A2", pinned = true, read = false))
        assertTrue(hasUnreadAnswers(catalogue))
        assertFalse(hasUnreadAnswers(catalogue.take(1)))
        assertFalse(hasUnreadAnswers(emptyList()))
    }

    @Test fun `search sends trimmed query without changing subscription`() {
        val search = answersListRequest("bakery", "  recipe archive  ")
        assertEquals("answers.list", search.type)
        assertEquals("bakery", search.projectId)
        assertEquals("recipe archive", search.query)
        assertNull(search.subscribe)
        val catalogue = answersListRequest("bakery", "  ", subscribe = true)
        assertNull(catalogue.query)
        assertEquals(true, catalogue.subscribe)
    }

    @Test fun `catalogue and search decode task questions alongside saved answers`() {
        val result = wireJson.decodeFromString(AnswersListResponse.serializer(), """
            {"id":"search","answers":[],"taskQuestions":[
              {"taskId":"T5","feedbackId":"F2","question":"Can I print old cards?\nWhere?","note":"Use Print.","at":"2026-01-08T13:32:00Z"},
              {"taskId":"T6","feedbackId":"F2","question":"Can I use this oven?","at":"2026-01-08T13:29:00Z"}
            ]}
        """.trimIndent())
        val catalogue = result.copy(answers = listOf(answer())).toCatalogue(extended = true)
        val groups = groupAnswers(catalogue.answers.orEmpty(), LocalDate.parse("2026-01-08"), ZoneId.of("UTC"), catalogue.taskQuestions)
        val entries = groups.single().entries
        assertEquals(listOf("task-question:T5:F2", "A1", "task-question:T6:F2"), entries.map { it.key })
        val question = entries.first() as AnswerListEntry.TaskQuestion
        assertEquals("Can I print old cards?", question.title)
        assertEquals("T5", question.question.taskId)
        assertEquals("Use Print.", question.question.note)
        assertTrue(entries[1] is AnswerListEntry.SavedAnswer)
    }

    @Test fun `working pulses with elapsed minutes but failed and awaiting reply do not`() {
        val now = Instant.parse("2026-01-08T13:32:20Z")
        val pending = answer(read = false).copy(working = AnswerWork("menu-preview", "running", 1))
        val running = requireNotNull(pending.working)
        assertEquals(AnswerWorkStatus("Working · menu-preview · 2 min", AnswerWorkIndicator.Pulse), answerWorkStatus(running, pending.at, now))
        assertEquals("Working · menu-preview · 4 min", answerWorkStatus(running.copy(elapsedMinutes = 4), pending.at, now).label)
        assertEquals(AnswerWorkStatus("Worker failed · menu-preview", AnswerWorkIndicator.Problem), answerWorkStatus(running.copy(status = "failed"), pending.at, now))
        assertEquals(AnswerWorkStatus("Awaiting reply · menu-preview", AnswerWorkIndicator.Waiting), answerWorkStatus(running.copy(status = "awaiting_reply"), pending.at, now))
        assertFalse(hasUnreadAnswers(listOf(pending)))
        assertTrue(hasUnreadAnswers(listOf(pending.copy(working = null))))
    }

    @Test fun `only closed requests can send Copy to Answers when both features are present`() {
        val request = copyAnswerFromTaskRequest("bakery", "T5")
        val payload = wireJson.encodeToJsonElement(AnswersCopyFromTaskRequest.serializer(), request)
        assertEquals(wireJson.parseToJsonElement("""{"type":"answers.copyFromTask","id":"${request.id}","projectId":"bakery","taskId":"T5"}"""), payload)
        assertTrue(canCopyToAnswers(true, null, "done"))
        assertTrue(canCopyToAnswers(true, null, "dropped"))
        assertFalse(canCopyToAnswers(true, null, "review"))
        assertFalse(canCopyToAnswers(true, "T9", "done"))
        assertFalse(canCopyToAnswers(false, null, "done"))
    }

    @Test fun `legacy catalogue has only saved answers and no task copy capability`() {
        fun supports(vararg features: String) = ConnectionState(hello = HelloResponse(id = "hello", features = features.toList(),
            server = HelloResponseServer("Harness", "test"))).supportsAnswersWorkAndTasks()
        assertFalse(supports("answers"))
        assertFalse(supports("answers-work-and-tasks"))
        assertTrue(supports("answers", "answers-work-and-tasks"))
        val oldResponse = wireJson.decodeFromString(AnswersListResponse.serializer(), """{"id":"list","answers":[]}""")
        assertEquals(emptyList<TaskAnswerQuestion>(), oldResponse.toCatalogue(extended = true).taskQuestions)
        val mixed = oldResponse.copy(answers = listOf(answer(), answer("A2").copy(working = AnswerWork("menu-preview"))),
            taskQuestions = listOf(TaskAnswerQuestion("T5", "F1", "Can I print old cards?", at = answer().at)))
        assertEquals(listOf(answer()), mixed.toCatalogue(extended = false).answers)
        assertTrue(mixed.toCatalogue(extended = false).taskQuestions.isEmpty())
    }

    @Test fun `chat chips match coordinator and latest or earlier entry`() {
        val older = AnswerExchange("How much room?", "12 GB.", "2026-01-08T13:00:00Z", "main", "General", "agent", entryId = 6)
        val answers = listOf(answer(entry = 9, earlier = listOf(older)), answer("A2", coordinator = "recipes", entry = 9), answer("A3"))
        assertEquals(mapOf(6L to "A1", 9L to "A1"), answersByReply(answers, "main"))
        assertEquals(mapOf(9L to "A2"), answersByReply(answers, "recipes"))
        assertTrue(answersByReply(answers, "unrelated").isEmpty())
    }

    @Test fun `reply push and banner open answer with chat behind and no ID keeps chat only`() {
        val backend = BackendConfig("Bakery", "https://bakery.example.test")
        val notice = NotificationAlert("reply", "Replied", "The menu is live", backend.key, "bakery", null, null,
            coordinatorId = "recipes", entryId = 17, tag = "reply", at = "2026-01-08T13:00:00Z", answerId = "A9",
            seq = 1, key = "reply:1", level = "info", backendEpoch = "epoch")
        val chat = Destination.Chat(backend.key, "bakery", "recipes", highlight = ChatHighlight.Entry(17))
        val target = AppLink.Open(listOf(chat, Destination.Answers(chat, "A9")))
        val bannerPayload = InAppAlert(backend.key, notice).pushPayload()
        assertEquals(target, notificationLink(bannerPayload, listOf(backend)))
        val raw = wireJson.encodeToString(NotificationPayload.serializer(), bannerPayload)
        assertEquals(target, PendingAppLink.Notification(raw).resolve(listOf(backend)))
        assertEquals(AppLink.Open(listOf(chat)), notificationLink(bannerPayload.copy(answerId = null), listOf(backend)))
    }

    @Test fun `older backends keep existing project controls and worker transcripts get no tabs`() {
        fun hello(features: List<String>?) = ConnectionState(hello = HelloResponse(id = "hello", features = features,
            server = HelloResponseServer("Harness", "test")))
        assertTrue(answersProjectTabs(hello(null), null).isEmpty())
        assertTrue(answersProjectTabs(hello(listOf("board")), null).isEmpty())
        assertTrue(answersProjectTabs(hello(listOf("board", "answers")), "worker").isEmpty())
        assertEquals(AnswersProjectTab.entries, answersProjectTabs(hello(listOf("board", "answers")), null))
    }
}
