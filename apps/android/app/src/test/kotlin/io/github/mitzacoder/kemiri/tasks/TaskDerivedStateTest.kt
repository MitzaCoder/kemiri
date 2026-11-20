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
            derived("T9", "needs_you", "steps_needed"),
        )
        val sections = taskSections(tasks, emptyList())
        assertEquals(listOf("Needs you", "In progress", "Waiting", "To do", "Recently closed"), sections.map { it.label })
        assertEquals(listOf("T3", "T2", "T9", "T1"), sections.first().rows.map { it.task.id })
        assertEquals(listOf("T5", "T4"), sections[1].rows.map { it.task.id })
        val columns = kanbanColumns(tasks, emptyList())
        assertEquals(listOf("Needs you", "In progress", "Waiting", "To do", "Closed"), columns.map { it.label })
        assertEquals(listOf("T3", "T2", "T9", "T1"), columns.first().cards.map { it.task.id })
        assertEquals(4, needsYouCount(tasks, emptyList()))
        assertEquals(listOf("T3", "T2", "T9", "T1"), kanbanColumns(tasks, emptyList(), onlyNeedsYou = true).flatMap { it.cards }.map { it.task.id })
    }

    @Test fun stepsHaveTheReviewToneAndTheirOwnGraphSemanticsAndStayVisible() {
        val task = derived("T1", "needs_you", "steps_needed").copy(status = "review")
        assertEquals(TaskStatusTone.Review, taskStateTone(task))
        assertEquals(GraphStatus("steps_needed", "Your steps", "☷"), graphTaskLabel(task))
        val graph = io.github.mitzacoder.kemiri.features.tasks.graph.bubble.buildTaskGraph(listOf(task), emptyList(), emptyList(), emptyList())
        val node = graph.nodes.single()
        assertEquals("steps_needed", node.status)
        assertTrue(node.attention)
        assertTrue(io.github.mitzacoder.kemiri.features.tasks.graph.bubble.graphFoldGroups(graph).isEmpty())
        val review = BoardTaskActivity("review", "Ready to check", task.createdAt, emptyList())
        assertEquals("Your steps", taskRowActivity(task.copy(activity = review), true)?.text)
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

    @Test fun sameDerivedGroupNestsAttentionPartsAcrossDifferentStatuses() {
        val parent = derived("T1", "needs_you", "failed").copy(status = "blocked")
        val child = derived("T2", "needs_you", "review").copy(parent = "T1", status = "review")
        val section = taskSections(listOf(child, parent), emptyList()).single()
        for (expanded in listOf(false, true)) {
            val family = taskFamilies(section, mapOf("T1" to expanded)).single()
            assertEquals("T1", family.row.task.id)
            assertEquals("T2", family.children.single().row.task.id)
            assertFalse(family.canToggle)
        }
    }

    @Test fun labelsTonesAndAgesDistinguishPausedBlockedAndQuestions() {
        assertNull(taskRowStateLabel(derived("T9", "in_progress", "working")))
        for (kind in listOf("failed", "answer_needed", "review", "paused", "blocked_by_task", "waiting_outside", "todo", "done", "dropped")) {
            assertNull(kind, taskRowStateLabel(derived("T9", "todo", kind)))
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

    @Test fun compactRowsAlwaysSayTheDerivedStateOnce() {
        val labels = mapOf("failed" to "Failed", "answer_needed" to "Answer needed", "steps_needed" to "Your steps", "review" to "Ready for review",
            "working" to "Working", "paused" to "Paused", "blocked_by_task" to "Blocked by T7",
            "waiting_outside" to "Waiting", "todo" to "To do", "done" to "Done", "dropped" to "Dropped")
        for ((kind, label) in labels) {
            val row = derived("T1", "todo", kind).let { it.copy(state = it.state!!.copy(refs = listOf("T7"))) }
            assertEquals(kind, label, taskRowActivity(row, false)?.text)
            val unrelated = row.copy(activity = BoardTaskActivity("unknown", "Old activity", row.createdAt, emptyList()))
            assertEquals(kind, label, taskRowActivity(unrelated, true)?.text)
            assertEquals(row.state!!.since, taskRowActivity(unrelated, true)?.since)
            assertNull(taskRowStateLabel(row))
        }
    }

    @Test fun matchingActivityKeepsItsDetailAndClockWithNoSecondLabel() {
        for ((kind, activityKind) in listOf("failed" to "failure", "answer_needed" to "question", "review" to "review",
            "working" to "working", "working" to "deploy", "blocked_by_task" to "blocked", "waiting_outside" to "waiting",
            "done" to "done", "dropped" to "dropped")) {
            val activity = BoardTaskActivity(activityKind, "Canonical sentence with detail", "2026-11-05T11:00:00Z", listOf("Q1"))
            val row = derived("T1", "todo", kind).copy(activity = activity)
            assertSame(kind, activity, taskRowActivity(row, true))
        }
        val paused = derived("T1", "in_progress", "paused").copy(activity = BoardTaskActivity("idle", "Idle", "2026-11-05T09:00:00Z", emptyList()))
        assertEquals("Paused", taskRowActivity(paused, true)?.text)
        assertEquals("Failed: Printer disconnected", taskRowActivity(derived("T1", "needs_you", "failed").copy(blockedReason = "Printer disconnected"), true)?.text)
        val legacy = taskWithSupportedState(paused, false)
        assertNull(taskRowActivity(legacy, false))
        assertSame(legacy.activity, taskRowActivity(legacy, true))
    }

    @Test fun graphUsesDerivedColourKeysAndOnlyNeedsYouReasons() {
        val tasks = listOf(derived("T1", "waiting", "blocked_by_task"), derived("T2", "in_progress", "paused"), derived("T3", "needs_you", "failed"), derived("T4", "needs_you", "answer_needed"))
        assertEquals(listOf("waiting", "paused", "failed", "answer_needed"), tasks.map(::graphTaskStatus))
        val graph = io.github.mitzacoder.kemiri.features.tasks.graph.bubble.buildTaskGraph(tasks, emptyList(), emptyList(), emptyList())
        assertEquals(listOf(false, false, true, true), graph.nodes.map { it.attention })
        assertEquals(2, io.github.mitzacoder.kemiri.features.tasks.graph.bubble.graphCounts(graph).attention)
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
