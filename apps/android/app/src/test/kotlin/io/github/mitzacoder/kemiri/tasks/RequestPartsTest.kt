package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.data.needsClosePartsChoice
import io.github.mitzacoder.kemiri.data.openDirectParts
import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.protocol.*
import org.junit.Assert.*
import org.junit.Test

class RequestPartsTest {
    private val at = "2026-01-01T14:02:00Z"
    private fun state(kind: String, group: String) = BoardTaskState(group, kind, at, emptyList())
    private fun part(id: String, title: String, state: String, summary: String = "") = PartsDigestPartsItem(
        id, "T1", title, state, summary, PartsDigestPartsItemChecks(1, 1, 2), 0, at, "coordinator",
    )

    @Test fun needsYouCountsRequestsAndTargetsTheQuestionOnThePart() {
        val request = task("T1", "in_progress").copy(state = state("answer_needed", "needs_you")
            .copy(fromPartId = "T2", fromPartTitle = "Choose the sample boxes", refs = listOf("Q2")))
        val part = task("T2", "in_progress").copy(parent = "T1", state = state("answer_needed", "needs_you"))
        val closedPart = task("T3", "done").copy(parent = "T1")
        val followUp = task("T4", "done").copy(foundWhile = "T1")
        val tasks = listOf(request, part, closedPart, followUp)
        val questions = listOf(question("Q1", "T2"), question("Q2", "T2").copy(text = "Paper boxes or tins?\nA longer explanation."))
        val sections = taskFamilySections(taskSections(tasks, questions), requestAttention = true).associateBy { it.id }
        val needsYou = sections.getValue(TaskSectionId.NeedsYou)
        assertEquals(1, taskFamilyCount(needsYou, requestAttention = true))
        val family = taskFamilies(needsYou, partsByRequest = emptyMap()).single()
        assertEquals("T1", family.row.task.id)
        assertFalse(family.canToggle)
        assertEquals(TaskFamilyRole.Task, family.role)
        assertEquals(RequestAttention("T2", "Q2", "Paper boxes or tins? · asked while building “Choose the sample boxes”"), requestAttention(request, questions))
        assertEquals("Q2", taskNeedsYou(part, questions, false, true, attentionQuestionId = "Q2").ownerQuestions.first().id)
        assertEquals(listOf("T4"), sections.getValue(TaskSectionId.Closed).rows.map { it.task.id })
        assertEquals(listOf(request, followUp), requestRows(tasks, requestAttention = true))
    }

    @Test fun unfoldingPrioritizesWorkingAndAttentionAndFoldsDonePartsIntoACount() {
        val request = task("T1", "in_progress").copy(state = state("working", "in_progress"))
        val parts = listOf(
            task("T2", order = 0.0),
            task("T3", "done", order = 1.0),
            task("T4", "in_progress", order = 2.0).copy(state = state("working", "in_progress")),
            task("T5", "in_progress", order = 3.0).copy(state = state("steps_needed", "needs_you")),
            task("T6", "dropped", order = 4.0),
        ).map { it.copy(parent = "T1") }
        val sections = taskSections(listOf(request) + parts, emptyList())
        val section = taskFamilySections(sections, requestAttention = true).single()
        val byRequest = mapOf("T1" to sections.flatMap { it.rows }.filter { it.task.parent != null })
        val folded = taskFamilies(section, partsByRequest = byRequest).single()
        assertTrue(folded.canToggle)
        assertTrue(folded.children.isEmpty())
        assertEquals(0, folded.doneParts)
        val open = taskFamilies(section, mapOf("T1" to true), byRequest).single()
        assertEquals(listOf("T4", "T5", "T2", "T6"), open.children.map { it.row.task.id })
        assertTrue(open.children.all { it.role == TaskFamilyRole.Task })
        assertEquals(1, open.doneParts)
    }

    @Test fun checklistUsesDigestOrderAndJoinsChecksAndProofByPartId() {
        val parts = listOf(part("T3", "Lay out the menu", "done", "A single page.\nMore detail."), part("T2", "Write the menu", "working"))
        val rows = partsChecklist(PartsDigest(parts, 1, 2, 1, 0), listOf(ArtifactsListResponsePartProofItem("T3", 2, 1, 0, 0)))
        assertEquals(listOf("T3", "T2"), rows.map { it.part.id })
        assertEquals("A single page.", rows.first().summary)
        assertEquals("2 checks · 1 failed · 2 images · 1 video", rows.first().counts)
        assertEquals("2 checks · 1 failed", rows.last().counts)
        assertEquals("Working", partStateLabel(rows.last().part.state))
    }

    @Test fun partPageShowsPositionAndClosureWithReopenAndCommentButNoClose() {
        val parts = listOf(part("T2", "Write the menu", "done"), part("T3", "Lay out the menu", "done").copy(closedBy = "user"))
        val request = task("T1").copy(partsDigest = PartsDigest(parts, 2, 2, 0, 0))
        val checked = task("T2", "done").copy(parent = "T1")
        val closed = task("T3", "done").copy(parent = "T2", requestId = "T1")
        val page = requestPartPage(checked, listOf(request), digestSupported = true)
        assertEquals(RequestPartPage("T1", "Part 1 of 2", "Checked by the coordinator", at), page)
        assertEquals(RequestPartPage("T1", "Part 2 of 2", "Closed by you", at), requestPartPage(closed, listOf(request), true))
        assertEquals(TaskPageActions(false, true, true), taskPageActions(checked, page))
        val running = checked.copy(status = "in_progress")
        assertEquals(TaskPageActions(false, false, true), taskPageActions(running, requestPartPage(running, listOf(request), true)))
        assertEquals(TaskPageActions(true, false, false), taskPageActions(request, requestPartPage(request, emptyList(), true)))
    }

    @Test fun closingRequestsOnlyPromptsForUnfinishedDirectParts() {
        val request = task("T1", "review")
        val checked = task("T2", "done").copy(parent = "T1", updatedBy = "coordinator")
        val dropped = task("T3", "dropped").copy(parent = "T1")
        val working = task("T4", "in_progress").copy(parent = "T1")
        val tasks = listOf(request, checked, dropped, working)
        assertEquals(listOf(working), openDirectParts(tasks, request.id))
        assertFalse(needsClosePartsChoice("done", request.id, tasks.dropLast(1), true, requestDigest = true))
        assertTrue(needsClosePartsChoice("done", request.id, tasks, true, requestDigest = true))
        assertFalse(needsClosePartsChoice("done", request.id, listOf(request.copy(status = "done"), working), true, requestDigest = true))
        assertFalse(needsClosePartsChoice("in_progress", request.id, tasks, true, requestDigest = true))
    }

    @Test fun withoutRequestFeaturesLegacyAttentionAndPageActionsRemain() {
        val request = task("T1", "in_progress").copy(state = state("working", "in_progress"))
        val part = task("T2", "in_progress").copy(parent = "T1", state = state("answer_needed", "needs_you"))
        val tasks = listOf(request, part)
        val section = taskFamilySections(taskSections(tasks, listOf(question("Q1", "T2"))), false).first()
        assertEquals(TaskFamilyRole.ParentHeader, taskFamilies(section).single().role)
        assertEquals(tasks, requestRows(tasks, requestAttention = false))
        assertNull(requestPartPage(part, tasks, digestSupported = false))
        assertEquals(TaskPageActions(true, false, false), taskPageActions(part, null))
        assertTrue(needsClosePartsChoice("done", request.id, tasks, supported = true))
        assertFalse(needsClosePartsChoice("done", request.id, tasks, supported = false))
    }
}
