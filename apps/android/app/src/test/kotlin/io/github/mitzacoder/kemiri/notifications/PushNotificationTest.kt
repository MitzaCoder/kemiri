package io.github.mitzacoder.kemiri.notifications

import io.github.mitzacoder.kemiri.features.notifications.*
import io.github.mitzacoder.kemiri.protocol.NotificationPayload
import io.github.mitzacoder.kemiri.protocol.NotificationPayloadQuestion
import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

class PushNotificationTest {
    private val question = NotificationPayload(
        kind = "board_question", title = "Question · Bakery site",
        body = "Which oven should the benchmark use?\n\nThe **fixed** one is faster.",
        backendKey = "https://studio.example.test", projectId = "bakery", workerId = null, scheduleId = null,
        tag = "board-question:bakery:Q3", at = "2026-01-01T00:00:00Z",
    )

    @Test fun sixChannelsCoverAllLegacyIdsExactlyOnce() {
        val channels = NotificationAttention.entries
        val legacy = channels.flatMap { it.legacyKinds }
        assertEquals(6, channels.map { it.channelId }.toSet().size)
        assertEquals(21, legacy.size)
        assertEquals((NOTIFICATION_KINDS + "test").toSet(), legacy.toSet())
        assertEquals(NotificationAttention.NeedsYou, notificationAttention("task_steps"))
        assertEquals(NotificationAttention.QuietUpdates, notificationAttention("maintenance_failed"))
    }

    @Test fun onlyUnanimousExplicitChannelChoicesTransfer() {
        assertEquals(0, unanimousChannelChoice(listOf(0)))
        assertEquals(2, unanimousChannelChoice(listOf(2, 2)))
        assertNull(unanimousChannelChoice(listOf(2, null)))
        assertNull(unanimousChannelChoice(listOf(2, 3)))
        assertNull(unanimousChannelChoice(emptyList<Int>()))
    }

    @Test fun questionLeadsWithItsWordingAndKeepsParagraphs() {
        val project = legacyNotificationProjectName(question)
        assertEquals("Bakery site", project)
        assertEquals(PushNotificationText("Which oven should the benchmark use?", "The fixed one is faster.", "Bakery site"),
            pushNotificationText(question, project, "Studio", showMessageText = true))
        val another = question.copy(body = "Please choose an oven.\n\nThe stock one matches the shop.")
        assertEquals("Please choose an oven.\n\nThe stock one matches the shop.", pushNotificationText(another, project, null, true).body)
    }

    @Test fun hiddenTextNeverCopiesThePayloadOrNames() {
        for (kind in NOTIFICATION_KINDS + "test") {
            val text = pushNotificationText(question.copy(kind = kind), "Private project", "Private computer", showMessageText = false)
            assertEquals(hiddenNotificationTitle(kind), text.title)
            assertTrue(text.body.isEmpty())
            assertNull(text.context)
        }
    }

    @Test fun reviewMovesTheTaskIdOutOfTheMessageAndComputerEventsNameTheComputer() {
        val review = question.copy(kind = "task_review", taskId = "T7", body = "T7 Keep the basket after reload")
        assertEquals("Keep the basket after reload", pushNotificationText(review, "Bakery site", null, true).body)
        val login = question.copy(kind = "login_prompt", projectId = null, title = "Sign in · Anthropic", body = "Enter the code.")
        assertEquals(PushNotificationText("Studio needs a sign-in", "Anthropic on Studio: Enter the code.", "Studio"),
            pushNotificationText(login, null, "Studio", true))
    }

    @Test fun handledCardsMatchExactComputerProjectChatOrTask() {
        val chat = AppPresence(true, question.backendKey, question.projectId, "main")
        val reply = question.copy(kind = "reply")
        assertTrue(chat.handlesPush(reply))
        assertFalse(chat.handlesPush(reply.copy(coordinatorId = "other")))
        assertFalse(chat.handlesPush(reply.copy(backendKey = "https://lab.example.test")))
        assertFalse(chat.handlesPush(reply.copy(projectId = "recipe")))
        assertFalse(chat.copy(visible = false).handlesPush(reply))
        assertFalse(chat.handlesPush(question))
        val task = chat.copy(coordinatorId = null, taskId = "T7")
        val review = reply.copy(kind = "task_review", taskId = "T7")
        assertTrue(task.handlesPush(review))
        assertFalse(task.handlesPush(review.copy(taskId = "T8")))
        assertFalse(task.handlesPush(reply))
        assertEquals("Q3", notificationQuestionId(question))
        assertNull(notificationQuestionId(question.copy(projectId = "recipe")))
    }

    @Test fun delayedFinishedWorkUsesTheOriginalExpiry() {
        val now = Instant.parse("2026-01-01T12:00:00Z")
        assertEquals(43_200_000L, finishedWorkTimeout(question.copy(kind = "work_finished"), now))
        assertTrue(finishedWorkTimeout(question.copy(kind = "thread_finished"), now.plusSeconds(86_400))!! < 0)
        assertNull(finishedWorkTimeout(question, now))
        assertNull(finishedWorkTimeout(question.copy(kind = "login_prompt"), now))
    }

    @Test fun namedConversationsKeepTheirShortcutAcrossRenamesAndKinds() {
        val reply = question.copy(kind = "reply", coordinatorId = "order", coordinatorName = "Order Builder")
        val chat = requireNotNull(pushConversation(reply, "Bakery site"))
        assertEquals("Order Builder · Bakery site", chat.label)
        assertEquals(chat.shortcutId, pushConversation(reply.copy(coordinatorName = "Orders"), "New name")?.shortcutId)
        assertEquals(chat.shortcutId, pushConversation(reply.copy(kind = "board_question"), "Bakery site")?.shortcutId)
        assertNotEquals(chat.shortcutId, pushConversation(reply.copy(backendKey = "https://lab.example.test"), "Bakery site")?.shortcutId)
        assertNotEquals(chat.shortcutId, pushConversation(reply.copy(coordinatorId = "inventory"), "Bakery site")?.shortcutId)
        assertNotEquals(chat.shortcutId, pushConversation(reply.copy(projectId = "other"), "Bakery site")?.shortcutId)
        val approval = reply.copy(kind = "board_question", question = NotificationPayloadQuestion("Q3", 2, false, approval = true))
        assertNull(pushConversation(approval, "Bakery site"))
        assertEquals("An approval is waiting", hiddenNotificationTitle(approval))
    }

    @Test fun newQuestionIdentityAndPlainPreviewTakePrecedenceOverLegacyTitleAndTag() {
        val rich = question.copy(question = NotificationPayloadQuestion("Q4", 7, false),
            projectName = "Bakery site", message = "What should ship?\n\nKeep 2 * 3 in the formula.")
        assertEquals("Q4", notificationQuestionId(rich))
        val text = pushNotificationText(rich, "Bakery site", "Studio", true)
        assertEquals("What should ship?", text.title)
        assertEquals("Keep 2 * 3 in the formula.", text.body)
        assertEquals(PushNotificationText("A question is waiting", "", null), pushNotificationText(rich, "Bakery site", "Studio", false))
    }

    @Test fun sharedLimitCardsUseExactExpiryAndKeepUnconfirmedAccountsSeparate() {
        val now = Instant.parse("2026-01-01T00:00:00Z")
        val limit = question.copy(kind = "usage_limit_reached", sharedLimitKey = "a".repeat(43), expiresAt = "2026-01-01T01:00:00Z")
        assertEquals(3_600_000L, pushTimeout(limit, now))
        assertEquals(0L, pushTimeout(limit, now.plusSeconds(3600)))
        assertEquals(sharedLimitCard(limit), sharedLimitCard(limit.copy(backendKey = "https://lab.example.test")))
        assertNull(sharedLimitCard(limit.copy(expiresAt = null)))
        assertNull(sharedLimitCard(limit.copy(sharedLimitKey = null)))
        assertNull(sharedLimitCard(limit.copy(kind = "usage_drain_paused")))
        assertNull(pushTimeout(limit.copy(expiresAt = "tomorrow"), now))
        val text = pushNotificationText(limit, null, "Studio", true, listOf("Studio", "Lab"))
        assertEquals("Studio, Lab", text.context)
        assertTrue(text.body.startsWith("On Studio, Lab: Work waits until "))
    }

}
