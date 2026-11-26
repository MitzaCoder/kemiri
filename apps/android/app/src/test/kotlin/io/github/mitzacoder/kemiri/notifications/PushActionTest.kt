package io.github.mitzacoder.kemiri.notifications

import io.github.mitzacoder.kemiri.data.wireJson
import io.github.mitzacoder.kemiri.features.notifications.*
import io.github.mitzacoder.kemiri.protocol.BoardQuestion
import io.github.mitzacoder.kemiri.protocol.NotificationPayload
import io.github.mitzacoder.kemiri.protocol.NotificationPayloadQuestion
import io.github.mitzacoder.kemiri.protocol.NotificationPayloadQuestionChoicesItem
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Test

class PushActionTest {
    private val choices = listOf("Stock oven", "Fixed oven", "Bake both").mapIndexed { index, label ->
        NotificationPayloadQuestionChoicesItem(label, recommended = index == 0)
    }
    private val question = NotificationPayloadQuestion("Q3", 7, true, choices)
    private val push = NotificationPayload(kind = "board_question", title = "A question", body = "Which oven?", projectId = "bakery",
        backendKey = "https://studio.example.test", coordinatorId = "order-builder", workerId = null, scheduleId = null,
        tag = "board-question:bakery:Q3", at = "2026-01-01T00:00:00Z", question = question)
    private val pending = PendingPushAction("9cc5890b-fa44-443a-b879-148294d66d52", "card", push, PushActionKind.Answer,
        "Stock oven", PushActionBinding("studio", "session"), 42, 10_000, 7)

    @Test fun nativeSlotsLeaveAFreeReplyAndKeepAllThreeExactChoices() {
        assertEquals(PushQuestionActions(listOf("Stock oven", "Fixed oven"), listOf("Bake both")), pushQuestionActions(push))
        assertEquals(PushQuestionActions(listOf("Stock oven"), emptyList()), pushQuestionActions(push.copy(question = question.copy(choices = choices.take(1)))))
        assertEquals(PushQuestionActions(emptyList(), emptyList()), pushQuestionActions(push.copy(question = question.copy(quickAnswerAllowed = false))))
        assertNull(pushQuestionActions(push.copy(question = question.copy(warning = true))))
        assertNull(pushQuestionActions(push.copy(question = question.copy(approval = true))))
        assertNull(pushQuestionActions(push.copy(question = null)))
    }

    @Test fun liveWarningsAndApprovalsAreNeverShadeAnswers() {
        val live = BoardQuestion(id = "Q3", revision = 7, text = "Which oven?", options = emptyList(), taskId = null,
            status = "open", answer = null, askedAt = "", answeredAt = null)
        assertTrue(live.canAnswerFromShade())
        assertFalse(live.copy(kind = "warning").canAnswerFromShade())
        assertFalse(live.copy(mcpApproval = true).canAnswerFromShade())
        assertFalse(live.copy(outsideModelApproval = true).canAnswerFromShade())
        assertFalse(live.copy(usageDrainIncident = "incident").canAnswerFromShade())
    }

    @Test fun persistedUndoUsesElapsedTimeAndDoesNotCarryCredentials() {
        val raw = wireJson.encodeToString(PendingPushAction.serializer(), pending)
        val recovered = wireJson.decodeFromString(PendingPushAction.serializer(), raw)
        assertEquals(5_000L, PUSH_UNDO_MS)
        assertTrue(recovered.canUndo(9_999, 7))
        assertFalse(recovered.canUndo(10_000, 7))
        assertFalse(recovered.canUndo(9_999, 8))
        assertFalse(recovered.due(9_999))
        assertTrue(recovered.due(10_000))
        assertFalse(recovered.copy(phase = PushActionPhase.Sending).due(10_000))
        assertTrue(recovered.expired(10_000, 8))
        assertTrue(recovered.expired(131_000, 7))
        assertFalse(raw.contains("sessionToken"))
    }

    @Test fun anAnswerKeepsItsRevisionAndAnExplicitReplyRetryKeepsItsOwnRequestId() {
        val answer = pending.answerRequest("bakery")
        assertEquals("Q3", answer.questionId)
        assertEquals(7L, answer.expectedRevision)
        assertEquals("Stock oven", answer.answer)
        val reply = pending.copy(kind = PushActionKind.Reply)
        val first = reply.replyRequest("bakery")
        val retry = reply.copy(dueElapsedMs = 20_000).replyRequest("bakery")
        assertEquals(first.requestId, retry.requestId)
        assertNotEquals(first.id, retry.id)
        assertEquals("order-builder", first.threadId)
        assertEquals(JsonPrimitive("Stock oven"), first.content)
        assertEquals(true, first.keepDraft)
    }
}
