package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.data.DeviceSettings
import io.github.mitzacoder.kemiri.data.familyExpansion
import io.github.mitzacoder.kemiri.data.withFamilyExpansion
import io.github.mitzacoder.kemiri.data.wireJson
import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.features.tasks.board.needsYouCount
import io.github.mitzacoder.kemiri.protocol.BoardQuestion
import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.protocol.BoardTaskState
import org.junit.Assert.*
import org.junit.Test

/** Keep visibility/nesting cases parallel to apps/web/test/task-families.test.ts. */
class TaskFamiliesTest {
    private val quietFamily = listOf(task("T1"), task("T2").copy(parent = "T1"), task("T3").copy(parent = "T2"), task("T4"))
    private fun grouped(tasks: List<BoardTask>, questions: List<BoardQuestion> = emptyList(), expansion: Map<String, Boolean> = emptyMap()) =
        taskFamilySections(taskSections(tasks, questions)).associate { it.id to taskFamilies(it, expansion) }
    private fun visible(families: List<TaskFamily>): List<String> = families.flatMap { listOf(it.row.task.id) + visible(it.children) }

    @Test fun quietSameStatusFamiliesStartFoldedAndCountsStillIncludeFoldedTasks() {
        val section = taskSections(quietFamily, emptyList()).single()
        val families = taskFamilies(section)
        assertEquals(4, section.rows.size)
        assertEquals(listOf("T1", "T4"), visible(families))
        assertTrue(families.first().canToggle)
        assertFalse(families.first().expanded)
        assertEquals(2, families.first().foldedCount)
    }
    @Test fun nestedExpansionIsIndependentAndPreservedWhenAnAncestorCloses() {
        assertEquals(listOf("T1", "T2", "T4"), visible(grouped(quietFamily, expansion = mapOf("T1" to true)).getValue(TaskSectionId.Todo)))
        assertEquals(listOf("T1", "T2", "T3", "T4"), visible(grouped(quietFamily, expansion = mapOf("T1" to true, "T2" to true)).getValue(TaskSectionId.Todo)))
        assertEquals(listOf("T1", "T4"), visible(grouped(quietFamily, expansion = mapOf("T1" to false, "T2" to true)).getValue(TaskSectionId.Todo)))
    }
    @Test fun parentsPrecedeChildrenWhileRootsAndSiblingsKeepTheirPriority() {
        val families = grouped(listOf(task("T3", order = 0.0).copy(parent = "T1"), task("T4", order = 1.0), task("T1", order = 2.0), task("T2", order = 3.0).copy(parent = "T1")), expansion = mapOf("T1" to true))
        assertEquals(listOf("T4", "T1", "T3", "T2"), visible(families.getValue(TaskSectionId.Todo)))
    }
    @Test fun differentStatusesStayInTheirOwnGroupsAtEveryDepth() {
        val tasks = listOf(
            task("T1", "in_progress"), task("T2", "in_progress").copy(parent = "T1"),
            task("T3", "review").copy(parent = "T1"), task("T4", "blocked").copy(parent = "T2"),
            task("T5", "waiting").copy(parent = "T1"), task("T6", "done").copy(parent = "T1"), task("T7").copy(parent = "T1"),
        )
        val sections = grouped(tasks)
        listOf(TaskSectionId.Review to "T3", TaskSectionId.Blocked to "T4", TaskSectionId.Waiting to "T5", TaskSectionId.Closed to "T6", TaskSectionId.Todo to "T7").forEach { (section, id) ->
            assertEquals(listOf(id), visible(sections.getValue(section)))
            assertNotNull(sections.getValue(section).single().row.task.parent) // Root renders a parent link.
        }
        assertEquals(listOf("T1"), visible(sections.getValue(TaskSectionId.Working)))
    }
    private fun assertAttentionStatusVisible(status: String) {
        val families = grouped(listOf(task("T1", status), task("T2", status).copy(parent = "T1"), task("T3", status).copy(parent = "T2")), expansion = mapOf("T1" to false, "T2" to false)).values.single()
        assertEquals(listOf("T1", "T2", "T3"), visible(families))
        assertFalse(families.first().canToggle) // Never offer a toggle with no effect.
    }
    @Test fun reviewDescendantsStayVisibleUnderASavedCollapsedParent() = assertAttentionStatusVisible("review")
    @Test fun blockedDescendantsStayVisibleUnderASavedCollapsedParent() = assertAttentionStatusVisible("blocked")
    @Test fun waitingDescendantsStayVisibleUnderASavedCollapsedParent() = assertAttentionStatusVisible("waiting")

    private fun assertQuestionEscapes(kind: String) {
        val sections = grouped(quietFamily, listOf(question("Q1", "T3", kind)))
        assertEquals(listOf("T3"), visible(sections.getValue(TaskSectionId.NeedsYou)))
        assertEquals(listOf("T1", "T4"), visible(sections.getValue(TaskSectionId.Todo)))
    }
    private fun assertNestedQuestionsVisible(kind: String) {
        val questions = (1..3).map { question("Q$it", "T$it", kind) }
        val families = grouped(quietFamily.take(3), questions, mapOf("T1" to false, "T2" to false)).getValue(TaskSectionId.NeedsYou)
        assertEquals(listOf("T1", "T2", "T3"), visible(families))
    }
    @Test fun openQuestionEscapesQuietFamilyIntoNeedsYou() = assertQuestionEscapes("question")
    @Test fun openWarningEscapesQuietFamilyIntoNeedsYou() = assertQuestionEscapes("warning")
    @Test fun sameStatusNestedQuestionCannotBeFoldedWithSavedFalseChoices() = assertNestedQuestionsVisible("question")
    @Test fun sameStatusNestedWarningCannotBeFoldedWithSavedFalseChoices() = assertNestedQuestionsVisible("warning")
    @Test fun differentStatusesNeverNestEvenWhenBothRowsAreInNeedsYou() {
        val families = grouped(listOf(task("T1"), task("T2", "blocked").copy(parent = "T1")), listOf(question("Q1", "T1"), question("Q2", "T2"))).getValue(TaskSectionId.NeedsYou)
        assertEquals(2, families.size)
        assertTrue(families.all { it.children.isEmpty() })
    }
    @Test fun aStatusChangeImmediatelyRevealsAFormerlyFoldedChild() {
        assertFalse(grouped(quietFamily).values.flatMap(::visible).contains("T2"))
        val after = grouped(quietFamily.map { if (it.id == "T2") it.copy(status = "review") else it })
        assertEquals("T2", after.getValue(TaskSectionId.Review).single().row.task.id)
    }
    @Test fun archivedAndUnavailableParentsDoNotSwallowChildren() {
        assertEquals(listOf("T2"), visible(grouped(listOf(task("T1", archived = true), task("T2").copy(parent = "T1"))).values.single()))
        assertEquals(listOf("T2"), visible(grouped(listOf(task("T2").copy(parent = "T404"))).values.single()))
    }
    @Test fun leavesHaveNoDisclosureAndStaleCyclesOrSelfLinksDoNotLoseTasks() {
        val families = grouped(listOf(task("T1").copy(parent = "T2"), task("T2").copy(parent = "T1"), task("T3").copy(parent = "T3")), expansion = mapOf("T1" to true, "T2" to true)).values.single()
        assertEquals(listOf("T1", "T2", "T3"), visible(families).sorted())
        assertFalse(families.find { it.row.task.id == "T3" }!!.canToggle)
    }
    @Test fun unlinkedRowsRemainFlatOnOlderBackends() {
        assertEquals(listOf("T1", "T2"), visible(grouped(listOf(task("T1"), task("T2"))).values.single()))
    }
    @Test fun attentionRulesDoNotTreatOrdinaryWorkAsAnAlert() {
        listOf("todo", "in_progress", "done", "dropped").forEach { assertFalse(needsFamilyAttention(TaskRow(task("T1", it), emptyList(), TaskSectionId.Todo))) }
    }
    @Test fun attentionSectionsStartOpenIncludingClosedTasksWithQuestions() {
        val waiting = taskSections(listOf(task("T1", "waiting")), emptyList()).single()
        val closed = taskSections(listOf(task("T1", "done")), emptyList()).single()
        val closedQuestion = taskSections(listOf(task("T1", "done")), listOf(question("Q1", "T1"))).single()
        assertTrue(familySectionStartsOpen(waiting))
        assertFalse(familySectionStartsOpen(closed))
        assertTrue(familySectionStartsOpen(closedQuestion))
    }
    @Test fun choicesAreScopedToParentBackendAndProjectAndSurviveSerialization() {
        val saved = DeviceSettings().withFamilyExpansion("https://one.example.test", "p", "T1", false)
            .withFamilyExpansion("https://one.example.test", "p", "T2", true)
            .withFamilyExpansion("https://two.example.test", "p", "T1", true)
            .withFamilyExpansion("https://one.example.test", "q", "T1", true)
        val restored = wireJson.decodeFromString(DeviceSettings.serializer(), wireJson.encodeToString(DeviceSettings.serializer(), saved))
        assertEquals(mapOf("T1" to false, "T2" to true), restored.familyExpansion("https://one.example.test", "p"))
        assertEquals(mapOf("T1" to true), restored.familyExpansion("https://two.example.test", "p"))
        assertEquals(mapOf("T1" to true), restored.familyExpansion("https://one.example.test", "q"))
        assertTrue(restored.familyExpansion("https://one.example.test", "missing").isEmpty())
        assertTrue(wireJson.decodeFromString(DeviceSettings.serializer(), "{}").taskFamilyExpansion.isEmpty())
    }

    private fun derived(id: String, group: String, kind: String, parent: String? = null) =
        task(id, if (group == "closed") kind else "in_progress").copy(parent = parent, state = BoardTaskState(group, kind, "2026-11-05T10:00:00Z", emptyList()))
    @Test fun derivedPartsMoveToParentFinishedLastAndCountsIgnoreFoldedParts() {
        val tasks = listOf(derived("T1", "in_progress", "working"), derived("T2", "closed", "done", "T1"), derived("T3", "waiting", "waiting_outside", "T1"), derived("T4", "todo", "todo", "T1"), derived("T5", "closed", "dropped", "T1"))
        val section = taskFamilySections(taskSections(tasks, emptyList())).single()
        assertEquals(1, taskFamilyCount(section))
        assertEquals(listOf("T1"), visible(taskFamilies(section)))
        assertEquals(listOf("T1", "T3", "T4", "T2", "T5"), visible(taskFamilies(section, mapOf("T1" to true))))
    }
    private fun fullRows(families: List<TaskFamily>): List<String> = families.flatMap { family ->
        listOfNotNull(family.row.task.id.takeIf { family.role == TaskFamilyRole.Task }) + fullRows(family.children)
    }

    @Test fun everyAttentionKindHasExactlyOneFullRowAcrossSectionsAndFoldChoices() {
        val parentGroups = mapOf("needs_you" to "review", "in_progress" to "working", "waiting" to "waiting_outside", "todo" to "todo", "closed" to "done")
        for (kind in listOf("failed", "answer_needed", "steps_needed", "review")) {
            for ((group, parentKind) in parentGroups) for (expanded in listOf(false, true)) {
                val tasks = listOf(derived("T1", group, parentKind), derived("T2", "needs_you", kind, "T1"))
                val families = grouped(tasks, expansion = mapOf("T1" to expanded))
                assertEquals("$kind under $group, expanded=$expanded", listOf("T1", "T2"), families.values.flatMap(::fullRows).sorted())
            }
        }
    }

    @Test fun allAttentionPartsArePinnedUnderTheirAttentionParentWithoutAChevron() {
        val tasks = listOf(derived("T1", "needs_you", "answer_needed"), derived("T2", "needs_you", "review", "T1"), derived("T3", "needs_you", "steps_needed", "T1"))
        val parent = grouped(tasks, expansion = mapOf("T1" to false)).getValue(TaskSectionId.NeedsYou).single()
        assertEquals(listOf("T3", "T2"), visible(parent.children))
        assertFalse(parent.canToggle)
        assertEquals(0, parent.foldedCount)
    }

    @Test fun attentionParentFoldsOnlyTheWorkingPart() {
        val tasks = listOf(derived("T1", "needs_you", "review"), derived("T2", "in_progress", "working", "T1"), derived("T3", "needs_you", "failed", "T1"))
        val folded = grouped(tasks).getValue(TaskSectionId.NeedsYou).single()
        assertTrue(folded.canToggle)
        assertEquals(1, folded.foldedCount)
        assertEquals(listOf("T3"), visible(folded.children))
        val unfolded = grouped(tasks, expansion = mapOf("T1" to true)).getValue(TaskSectionId.NeedsYou).single()
        assertEquals(listOf("T3", "T2"), visible(unfolded.children))
    }

    @Test fun workingParentGetsOneHeaderAndItsAttentionPointersFoldInProgress() {
        val tasks = listOf(derived("T1", "in_progress", "working"), derived("T2", "needs_you", "steps_needed", "T1"), derived("T3", "needs_you", "failed", "T1"))
        val folded = grouped(tasks)
        val header = folded.getValue(TaskSectionId.NeedsYou).single()
        assertEquals("T1", header.row.task.id)
        assertEquals(TaskFamilyRole.ParentHeader, header.role)
        assertFalse(header.canToggle)
        assertEquals(listOf("T3", "T2"), fullRows(header.children))
        assertTrue(folded.getValue(TaskSectionId.Working).single().children.isEmpty())
        val expanded = grouped(tasks, expansion = mapOf("T1" to true)).getValue(TaskSectionId.Working).single()
        assertEquals(listOf("T2", "T3"), visible(expanded.children))
        assertTrue(expanded.children.all { it.role == TaskFamilyRole.Pointer })
    }

    @Test fun archivedOrFilteredParentLeavesTheAttentionPartAsAPlainRoot() {
        val parent = derived("T1", "in_progress", "working")
        val part = derived("T2", "needs_you", "review", "T1")
        for (tasks in listOf(listOf(parent.copy(archived = true), part), listOf(part))) {
            val root = grouped(tasks).getValue(TaskSectionId.NeedsYou).single()
            assertEquals(TaskFamilyRole.Task, root.role)
            assertEquals("T2", root.row.task.id)
            assertEquals("T1", root.row.task.parent) // The row can still draw a parent link.
        }
    }

    @Test fun quietMiddleTaskStaysVisibleAboveItsAttentionGrandchild() {
        val tasks = listOf(derived("T1", "needs_you", "review"), derived("T2", "in_progress", "working", "T1"), derived("T3", "needs_you", "failed", "T2"))
        val families = grouped(tasks, expansion = mapOf("T1" to false, "T2" to false)).values.single()
        assertEquals(listOf("T1", "T2", "T3"), fullRows(families))
        assertFalse(families.single().canToggle)
        assertFalse(families.single().children.single().canToggle)
    }

    @Test fun needsYouCountExcludesHeadersPointersAndQuietPartsRegardlessOfFolding() {
        val tasks = listOf(derived("T1", "needs_you", "review"), derived("T2", "in_progress", "working", "T1"), derived("T3", "needs_you", "failed", "T1"), derived("T4", "todo", "todo"), derived("T5", "needs_you", "steps_needed", "T4"))
        val section = taskFamilySections(taskSections(tasks, emptyList())).first { it.id == TaskSectionId.NeedsYou }
        assertEquals(3, taskFamilyCount(section))
        assertEquals(needsYouCount(tasks, emptyList()), taskFamilyCount(section))
        for (expanded in listOf(false, true)) {
            val fullAttentionRows = fullRows(taskFamilies(section, mapOf("T1" to expanded))).count { it != "T2" }
            assertEquals(taskFamilyCount(section), fullAttentionRows)
        }
    }

    @Test fun groupUrgencyUsesTheMostUrgentPartEvenWhenItsParentIsInReview() {
        val tasks = listOf(derived("T1", "needs_you", "answer_needed"), derived("T2", "needs_you", "review", "T1"), derived("T3", "needs_you", "review"), derived("T4", "needs_you", "failed", "T3"))
        assertEquals(listOf("T3", "T4", "T1", "T2"), fullRows(grouped(tasks).getValue(TaskSectionId.NeedsYou)))
    }

    @Test fun derivedCyclesCannotLoseOrDuplicateFullRows() {
        val tasks = listOf(derived("T1", "needs_you", "review", "T2"), derived("T2", "in_progress", "working", "T1"), derived("T3", "needs_you", "failed", "T3"))
        for (expanded in listOf(false, true)) {
            assertEquals(listOf("T1", "T2", "T3"), grouped(tasks, expansion = mapOf("T1" to expanded, "T2" to expanded)).values.flatMap(::fullRows).sorted())
        }
    }

    @Test fun derivedNestedParentsRetainFoldMemoryAndClosedPartsStayWithClosedParents() {
        val tasks = listOf(derived("T1", "todo", "todo"), derived("T2", "waiting", "waiting_outside", "T1"), derived("T3", "closed", "done", "T2"))
        assertEquals(listOf("T1", "T2", "T3"), visible(grouped(tasks, expansion = mapOf("T1" to true, "T2" to true)).values.single()))
        assertEquals(listOf("T1"), visible(grouped(tasks, expansion = mapOf("T1" to false, "T2" to true)).values.single()))
        val closed = listOf(derived("T1", "closed", "done"), derived("T2", "closed", "done", "T1"))
        assertEquals(listOf("T1", "T2"), visible(grouped(closed, expansion = mapOf("T1" to true)).getValue(TaskSectionId.Closed)))
        assertEquals(listOf("T2"), visible(grouped(closed.drop(1)).values.single()))
        assertEquals(listOf("T2"), visible(grouped(listOf(closed[0].copy(archived = true), closed[1])).values.single()))
    }
}
