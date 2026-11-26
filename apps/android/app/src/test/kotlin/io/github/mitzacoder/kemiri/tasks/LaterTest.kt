package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.data.BoardView
import io.github.mitzacoder.kemiri.data.wireJson
import io.github.mitzacoder.kemiri.data.withExplicitNulls
import io.github.mitzacoder.kemiri.features.notifications.notificationLaterRequest
import io.github.mitzacoder.kemiri.features.notifications.notificationLaterTarget
import io.github.mitzacoder.kemiri.features.notifications.offersLater
import io.github.mitzacoder.kemiri.features.notifications.pushQuestionActions
import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.features.tasks.board.needsYouCount
import io.github.mitzacoder.kemiri.features.tasks.graph.bubble.buildTaskGraph
import io.github.mitzacoder.kemiri.protocol.*
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class LaterTest {
    private val at = "2026-03-07T18:00:00Z"
    private val zone = ZoneId.of("America/New_York")
    private val now = Instant.parse(at)
    private val record = BoardLater("2026-03-09T12:00:00Z", at, 1)
    private fun view(tasks: List<BoardTask>, questions: List<BoardQuestion>) = BoardView(Board(tasks = tasks, questions = questions, decisions = emptyList(), updatedAt = null))

    @Test fun quickChoicesUseLocalCalendarDaysAndStartAcrossTheSpringGap() {
        val ordinary = laterChoices(now, zone, "02:30", urgent = false, question = false)
        assertEquals(listOf("This evening", "Tomorrow morning", "Next week", "Pick a date…", "When it’s the last thing left"), ordinary.map { it.label })
        assertEquals(Instant.parse("2026-03-07T23:00:00Z"), ordinary[0].until)
        assertEquals(Instant.parse("2026-03-08T07:30:00Z"), ordinary[1].until)
        assertEquals(Instant.parse("2026-03-14T06:30:00Z"), ordinary[2].until)
        assertTrue(ordinary.last().whenLast)
        assertFalse(laterChoices(now, zone, "08:00", urgent = false, question = true).any { it.whenLast })
        assertEquals(listOf("In 1 hour", "This evening", "Tomorrow morning"), laterChoices(now, zone, "08:00", urgent = true, question = false).map { it.label })
    }

    @Test fun lateEveningAndDatesOutsideTheServerWindowAreNotOffered() {
        assertFalse(laterChoices(Instant.parse("2026-03-08T02:15:00Z"), zone, "08:00", urgent = false, question = false).any { it.label == "This evening" })
        assertNull(laterDateDeadline(LocalDate.parse("2026-03-07"), now, zone, "08:00"))
        assertNull(laterDateDeadline(LocalDate.parse("2026-04-08"), now, zone, "08:00"))
        assertEquals(Instant.parse("2026-03-08T07:30:00Z"), laterDateDeadline(LocalDate.parse("2026-03-08"), now, zone, "02:30"))
    }

    @Test fun attachedQuestionsUseTheRootsRevisionAndUrgentScopeWhileApprovalsHaveNoAction() {
        val root = task("T1", "in_progress").copy(revision = 8)
        val part = task("T2", "in_progress").copy(parent = "T1", requestId = "T1")
        val ask = question("Q1", part.id)
        val warning = question("Q2", root.id, "warning")
        val approval = question("Q3", null).copy(mcpApproval = true)
        val loose = question("Q4", null)
        val board = view(listOf(root, part), listOf(ask, warning, approval, loose))
        val target = checkNotNull(board.laterTarget(ask))
        assertEquals(root.id, target.id)
        assertTrue(target.urgent)
        assertEquals(8L, target.revision)
        assertNull(board.laterTarget(approval))
        assertTrue(board.laterTarget(loose)?.question == true)
        val bringBack = target.request("sample", null, false, "07:45", zone, revision = 9)
        val json = withExplicitNulls(wireJson.encodeToJsonElement(BoardLaterSetRequest.serializer(), bringBack).jsonObject, setOf("until"))
        assertEquals(JsonPrimitive("T1"), json["target"]?.jsonObject?.get("taskId"))
        assertEquals(JsonPrimitive(9), json["expectedRevision"])
        assertEquals(JsonNull, json["until"])
        assertEquals(JsonPrimitive("07:45"), json["workDay"]?.jsonObject?.get("start"))
        assertEquals(JsonPrimitive(zone.id), json["workDay"]?.jsonObject?.get("timeZone"))
    }

    private fun notice(kind: String) = NotificationPayload(kind, "Bakery", "Review the sample", "demo", "bakery",
        null, null, tag = "sample", at = at, laterAllowed = true)

    @Test fun shadeQuestionKeepsReplyChoicesAndWritesTomorrowUsingTheLiveRootRevision() {
        val root = task("T1", "in_progress").copy(revision = 8)
        val part = task("T2", "in_progress").copy(parent = root.id, requestId = root.id)
        val ask = question("Q1", part.id).copy(revision = 3)
        val options = listOf("Friday", "Saturday", "Sunday").map { NotificationPayloadQuestionChoicesItem(it, false) }
        val push = notice("board_question").copy(question = NotificationPayloadQuestion(ask.id, ask.revision, true, options))
        assertEquals(listOf("Friday"), pushQuestionActions(push)?.directChoices)
        assertEquals(listOf("Saturday", "Sunday"), pushQuestionActions(push)?.replyChoices)
        assertFalse(push.copy(laterAllowed = null).offersLater())
        assertFalse(push.copy(question = push.question?.copy(approval = true)).offersLater())
        val board = view(listOf(root, part), listOf(ask))
        val request = checkNotNull(board.notificationLaterTarget(push)).notificationLaterRequest("bakery", "02:30", now, zone)
        assertEquals(JsonPrimitive(root.id), request.target.jsonObject["taskId"])
        assertEquals(root.revision, request.expectedRevision)
        assertEquals("2026-03-08T07:30:00Z", request.until)
        assertEquals(zone.id, request.workDay?.timeZone)
        assertNull(request.whenLast)
        assertNull(board.notificationLaterTarget(push.copy(question = push.question?.copy(revision = 2))))
        for (stale in listOf(ask.copy(postponed = true), ask.copy(status = "answered"), ask.copy(outsideModelApproval = true))) {
            assertNull(view(listOf(root, part), listOf(stale)).notificationLaterTarget(push))
        }
        val warning = question("Q2", null, "warning")
        val warningPush = push.copy(question = NotificationPayloadQuestion(warning.id, warning.revision, false, warning = true))
        assertTrue(warningPush.offersLater())
        assertNull(pushQuestionActions(warningPush))
        val warningTarget = checkNotNull(view(emptyList(), listOf(warning)).notificationLaterTarget(warningPush))
        assertTrue(warningTarget.urgent)
        val breakthrough = warning.copy(taskId = part.id)
        assertNotNull(view(listOf(root.copy(later = record), part), listOf(breakthrough)).notificationLaterTarget(warningPush))
        assertNull(view(listOf(root.copy(later = record), part), listOf(breakthrough.copy(postponed = true))).notificationLaterTarget(warningPush))
        assertEquals(JsonPrimitive(warning.id), warningTarget.notificationLaterRequest("bakery", "02:30", now, zone).target.jsonObject["questionId"])
    }

    @Test fun stepsOnAPartAndReviewsRequireTheExactCurrentTaskNotice() {
        val root = task("T1", "in_progress").copy(revision = 5)
        val part = task("T2", "in_progress").let { task -> task.copy(parent = root.id, revision = 2,
            report = task.report.copy(steps = "1. Check the sample."),
            state = BoardTaskState("needs_you", "steps_needed", at, emptyList())) }
        val review = task("T3", "review").copy(state = BoardTaskState("needs_you", "review", at, emptyList()))
        val board = view(listOf(root, part, review), emptyList())
        val steps = notice("task_steps").copy(taskId = part.id, taskRevision = part.revision)
        assertEquals(root.revision, board.notificationLaterTarget(steps)?.revision)
        assertEquals(root.id, board.notificationLaterTarget(steps)?.id)
        assertNull(board.notificationLaterTarget(steps.copy(taskRevision = 1)))
        assertNull(board.notificationLaterTarget(steps.copy(kind = "task_review")))
        assertEquals(review.id, board.notificationLaterTarget(notice("task_review").copy(taskId = review.id, taskRevision = review.revision))?.id)
        assertNull(view(listOf(root.copy(later = record), part), emptyList()).notificationLaterTarget(steps))
    }

    @Test fun postponedQuestionsLeaveAttentionButCanBeAnsweredWithTheirOriginalRevision() {
        val root = task("T1", "in_progress").copy(later = record, state = BoardTaskState("later", "answer_needed", at, listOf("Q1"), later = record))
        val part = task("T2", "in_progress").copy(parent = root.id, requestId = root.id)
        val ask = question("Q1", part.id).copy(revision = 4, postponed = true)
        val loose = question("Q2", null).copy(postponed = true, later = record)
        val board = view(listOf(root, part), listOf(ask, loose))
        assertEquals(0, board.openQuestionCount)
        assertEquals(0, needsYouCount(board.tasks, board.questions))
        assertEquals(TaskSectionId.Later, derivedTaskSection(root))
        assertEquals("Later", taskStateLabel(root))
        assertFalse(familySectionStartsOpen(taskSections(listOf(root), listOf(ask)).single()))
        assertEquals(1, board.laterWaitingParts(root.id))
        assertTrue(questionCanAnswer(ask))
        assertEquals(4L, board.laterQuestions(root.id).single().revision)
        assertFalse(buildTaskGraph(board.tasks, board.questions, emptyList(), emptyList()).nodes.any { it.attention })
        val newWarning = question("Q3", root.id, "warning")
        assertEquals(1, view(board.tasks, board.questions + newWarning).openQuestionCount)
    }
}
