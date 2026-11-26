package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.data.BoardView
import io.github.mitzacoder.kemiri.data.wireJson
import io.github.mitzacoder.kemiri.data.withExplicitNulls
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
