package io.github.mitzacoder.kemiri.features.answers

import io.github.mitzacoder.kemiri.data.BackendConfig
import io.github.mitzacoder.kemiri.data.ConnectionState
import io.github.mitzacoder.kemiri.data.answersListRequest
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
            groups.map { group -> group.answers.map { it.id } })
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
