package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.features.tasks.board.*
import io.github.mitzacoder.kemiri.features.tasks.graph.*
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.theme.TaskStatusTone
import org.junit.Assert.*
import org.junit.Test

class TaskDerivedStateTest {
    private fun derived(id: String, group: String, kind: String, since: String = "2026-11-05T10:00:00Z") =
        task(id).copy(state = BoardTaskState(group, kind, since, emptyList()))

    @Test fun listAndBoardShareFiveGroupsAndKindOrdering() {
        val tasks = listOf(
            derived("T1", "needs_you", "review"), derived("T2", "needs_you", "answer_needed"),
            derived("T3", "needs_you", "failed"), derived("T4", "in_progress", "paused"),
            derived("T5", "in_progress", "working"), derived("T6", "waiting", "blocked_by_task"),
            derived("T7", "todo", "todo"), derived("T8", "closed", "done"),
        )
        val sections = taskSections(tasks, emptyList())
        assertEquals(listOf("Needs you", "In progress", "Waiting", "To do", "Recently closed"), sections.map { it.label })
        assertEquals(listOf("T3", "T2", "T1"), sections.first().rows.map { it.task.id })
        assertEquals(listOf("T5", "T4"), sections[1].rows.map { it.task.id })
        val columns = kanbanColumns(tasks, emptyList())
        assertEquals(listOf("Needs you", "In progress", "Waiting", "To do", "Closed"), columns.map { it.label })
        assertEquals(listOf("T3", "T2", "T1"), columns.first().cards.map { it.task.id })
        assertEquals(3, needsYouCount(tasks, emptyList()))
        assertEquals(listOf("T3", "T2", "T1"), kanbanColumns(tasks, emptyList(), onlyNeedsYou = true).flatMap { it.cards }.map { it.task.id })
    }

    @Test fun waitsAndNeedsYouUseSinceNotPriorityWhileTodoKeepsPriority() {
        for ((group, kind) in listOf("needs_you" to "failed", "waiting" to "blocked_by_task", "in_progress" to "paused")) {
            val tasks = listOf(derived("T1", group, kind), derived("T2", group, kind, "2026-11-05T09:00:00Z"))
            assertEquals(listOf("T2", "T1"), taskSections(tasks, emptyList()).single().rows.map { it.task.id })
            assertEquals(listOf("T2", "T1"), kanbanColumns(tasks, emptyList()).flatMap { it.cards }.map { it.task.id })
        }
        val tasks = listOf(derived("T2", "todo", "todo"), derived("T1", "todo", "todo"))
        assertEquals(listOf("T1", "T2"), taskSections(tasks, emptyList()).single().rows.map { it.task.id })
    }

    @Test fun missingFeatureOrFieldPreservesLegacyGroupingLabelsAndMoves() {
        val task = derived("T1", "needs_you", "failed")
        val legacy = taskWithSupportedState(task, false)
        assertNull(legacy.state)
        assertEquals(TaskSectionId.Todo, derivedTaskSection(legacy))
        assertEquals("To do", taskStateLabel(legacy))
        assertEquals(KanbanColumnId.Todo, columnOfTask(legacy))
        assertEquals(6, kanbanColumns(listOf(legacy), emptyList()).size)
        assertTrue(moveChoices(legacy).any { it.target == "blocked" })
        assertEquals(TaskSectionId.Working, derivedTaskSection(legacy.copy(status = "in_progress")))
    }

    @Test fun mixedOptionalFieldsNeverHideLegacyReviewOrBlockedTasks() {
        val tasks = listOf(derived("T1", "todo", "todo"), task("T2", "review"), task("T3", "blocked"))
        assertEquals(setOf("T1", "T2", "T3"), kanbanColumns(tasks, emptyList()).flatMap { it.cards }.map { it.task.id }.toSet())
    }

    @Test fun boardInProgressSortsBySinceAcrossWorkingAndPaused() {
        val tasks = listOf(derived("T1", "in_progress", "working"), derived("T2", "in_progress", "paused", "2026-11-05T09:00:00Z"))
        assertEquals(listOf("T2", "T1"), kanbanColumns(tasks, emptyList()).first { it.id == KanbanColumnId.Working }.cards.map { it.task.id })
    }

    @Test fun onlyActionableColumnsAcceptBareMoves() {
        assertNull(dropTarget(KanbanColumnId.NeedsYou))
        assertNull(dropTarget(KanbanColumnId.Waiting))
        assertEquals("in_progress", dropTarget(KanbanColumnId.Working))
        assertEquals(listOf("in_progress", "done", "dropped"), moveChoices(derived("T1", "todo", "todo")).map { it.target })
        val paused = derived("T9", "in_progress", "paused").copy(status = "in_progress")
        assertTrue(moveChoices(paused).any { it.target == "in_progress" })
        assertEquals("Start it now", startAgainNote(paused, "in_progress"))
        assertEquals("done", dropTarget(KanbanColumnId.Done))
        assertEquals("dropped", dropTarget(KanbanColumnId.Done, true))
    }

    @Test fun sameDerivedGroupNestsDifferentStoredStatusesAndAttentionStaysVisible() {
        val parent = derived("T1", "needs_you", "failed").copy(status = "blocked")
        val child = derived("T2", "needs_you", "review").copy(parent = "T1", status = "review")
        val families = taskFamilies(taskSections(listOf(child, parent), emptyList()).single(), mapOf("T1" to false))
        assertEquals(1, families.size)
        assertEquals("T2", families.single().children.single().row.task.id)
        assertFalse(families.single().canToggle)
    }

    @Test fun labelsTonesAndAgesDistinguishPausedBlockedAndQuestions() {
        assertNull(taskRowStateLabel(derived("T9", "in_progress", "working")))
        for (kind in listOf("failed", "answer_needed", "review", "paused", "blocked_by_task", "waiting_outside", "todo", "done", "dropped")) {
            assertNotNull(kind, taskRowStateLabel(derived("T9", "todo", kind)))
        }
        assertEquals("Working", taskRowStateLabel(task("T9", "in_progress")))
        val paused = derived("T1", "in_progress", "paused")
        assertEquals("Paused", taskStateLabel(paused))
        assertEquals(TaskStatusTone.Paused, taskStateTone(paused))
        val blocked = derived("T2", "waiting", "blocked_by_task").let { it.copy(state = it.state!!.copy(refs = listOf("T7"))) }
        assertEquals("Blocked by T7 Repair the oven", taskStateLabel(blocked) { "Repair the oven" })
        val now = java.time.Instant.parse("2026-11-05T11:00:00Z").toEpochMilli()
        assertEquals("1h", rowTime(TaskRow(paused, emptyList(), TaskSectionId.Working), now))
        assertEquals("1h", cardTime(KanbanCard(paused, emptyList(), KanbanColumnId.Working), now).text)
    }

    @Test fun graphUsesDerivedColourKeysAndOnlyNeedsYouReasons() {
        val tasks = listOf(derived("T1", "waiting", "blocked_by_task"), derived("T2", "in_progress", "paused"), derived("T3", "needs_you", "failed"), derived("T4", "needs_you", "answer_needed"))
        assertEquals(listOf("waiting", "paused", "failed", "answer_needed"), tasks.map(::graphTaskStatus))
        val model = buildGraphModel(tasks, emptyList(), emptyList(), emptyList(), 0)
        assertEquals(emptyList<String>(), model.details.getValue("T1").reasons)
        assertEquals(listOf("failed"), model.details.getValue("T3").reasons)
        assertEquals(listOf("question"), model.details.getValue("T4").reasons)
        assertEquals(2, graphDotCounts(model, tasks.map { it.id }).needsYou)
        assertFalse(model.counters.any { it.key == "reason:waiting" || it.key == "reason:blocked" })
        assertEquals(1, model.counters.first { it.key == "status:waiting" }.count)
    }

    @Test fun closeChoiceCountsOnlyOpenDirectPartsIncludingReview() {
        val tasks = listOf(task("T1"), task("T2").copy(parent = "T1"), task("T3", "review").copy(parent = "T1"), task("T4", "done").copy(parent = "T1"), task("T5").copy(parent = "T2"))
        assertEquals(listOf("T2", "T3"), openDirectParts(tasks, "T1").map { it.id })
        assertTrue(needsClosePartsChoice("done", "T1", tasks, true))
        assertTrue(needsClosePartsChoice("dropped", "T1", tasks, true))
        assertFalse(needsClosePartsChoice("done", "T1", tasks, false))
        assertFalse(needsClosePartsChoice("review", "T1", tasks, true))
        assertEquals("T1 has 2 open parts: T2 (to do), T3 (in review). What should happen to them?", CloseTaskParts("T1", openDirectParts(tasks, "T1")).question)
        assertTrue(isOpenPartsError(ClientException("open_parts", "Choose")))
        assertFalse(isOpenPartsError(ClientException("board_conflict", "Changed")))
    }
}
