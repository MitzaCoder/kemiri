package io.github.mitzacoder.kemiri

import io.github.mitzacoder.kemiri.navigation.*
import io.github.mitzacoder.kemiri.protocol.*
import org.junit.Assert.*
import org.junit.Test

class SidebarAttentionTest {
    private val empty = ProjectAttention(0, 0, 0, 0, null, 0, 0, 0, null, null, null, null, null)
    private fun project(id: String, attention: ProjectAttention? = null) = ProjectSummary(
        id = id, name = id, path = "/test", coordinator = WorkerDefaults(ModelRef("faux", "faux-1"), null),
        workerModels = emptyList(), checkIns = ProjectCheckIns(true, 10),
        state = "open", activity = ProjectActivity("idle", 0, null, null), attention = attention,
    )

    @Test fun crossBackendQuestionsAndFailuresLeadReviewsAndEqualPrioritiesAreStable() {
        val links = needsYouLinks(listOf(
            BackendAttentionProjects("a", "Studio", listOf(project("review", empty.copy(reviewTasks = 3, reviewTaskId = "T1")), project("failure", empty.copy(failedWorkers = 1, failedWorkerTaskId = "T2")))),
            BackendAttentionProjects("b", "Remote", listOf(project("q", empty.copy(questions = 2, warnings = 1, questionTaskId = "T3")), project("also-q", empty.copy(questions = 1)))),
        ))
        assertEquals(listOf("q/Question", "also-q/Question", "q/Warning", "failure/Worker", "review/Review"), links.map { "${it.projectName}/${it.action.kind}" })
        assertEquals(8L, links.sumOf { it.action.count })
        assertEquals("b", links.first().backendKey)
        assertEquals("T3", links.first().action.taskId)
    }

    @Test fun allSignalsAreCountedOnceAndArchivedProjectsAreExcluded() {
        val all = project("all", empty.copy(questions = 1, warnings = 2, failedWorkers = 3, failedThreads = 1, stepsTasks = 2, reviewTasks = 4)).copy(activity = ProjectActivity("failed", 0, null, null))
        assertEquals(14L, attentionCount(all))
        assertEquals(AttentionKind.entries.filter { it != AttentionKind.Task }, projectAttentionActions(all).map { it.kind })
        assertEquals(0L, attentionCount(all.copy(archived = true)))
    }

    @Test fun summaryLinksToTheFirstStepsTaskBeforeReview() {
        val project = project("shop", empty.copy(stepsTasks = 1, stepsTaskId = "T4", reviewTasks = 2, reviewTaskId = "T5"))
        val actions = projectAttentionActions(project)
        assertEquals(listOf(AttentionKind.Steps, AttentionKind.Review), actions.map { it.kind })
        assertEquals("1 with your steps", actions.first().label)
        assertEquals("T4", actions.first().taskId)
        assertEquals("☷", sidebarStatus(project, projectStatus(project, 0)).glyph)
    }

    @Test fun loadedBoardKeepsTheStepsRowAndDoesNotCountItTwice() {
        val steps = io.github.mitzacoder.kemiri.tasks.task("T4", "review").copy(state = BoardTaskState("needs_you", "steps_needed", "now", emptyList()))
        val review = io.github.mitzacoder.kemiri.tasks.task("T5", "review").copy(state = BoardTaskState("needs_you", "review", "now", emptyList()))
        val project = project("shop", empty.copy(stepsTasks = 1, stepsTaskId = "T4", reviewTasks = 1, reviewTaskId = "T5"))
        val board = Board(tasks = listOf(steps, review), questions = emptyList(), decisions = emptyList(), updatedAt = null)
        val actions = projectAttentionActions(project, board)
        assertEquals(2L, attentionCount(project, board))
        assertEquals(AttentionAction(AttentionKind.Steps, 1, "1 with your steps", "T4"), actions.single { it.kind == AttentionKind.Steps })
        assertEquals(1L, actions.single { it.kind == AttentionKind.Task }.count)
    }

    @Test fun oldServersUseActivityButInventNoTaskTotals() {
        val old = project("old").copy(activity = ProjectActivity("failed", 0, null, null, openQuestions = 2))
        assertEquals(listOf("2 questions", "Main chat failed"), projectAttentionActions(old).map { it.label })
        assertEquals(3L, attentionCount(old))
        assertTrue(projectAttentionActions(project("empty", empty)).isEmpty())
    }

    @Test fun waitingIsCalmUntilServerReturnsItAndAllThreadWorkersAreIncluded() {
        val waiting = project("wait", empty.copy(waitingTasks = 2, nextReturnAt = "2026-11-16T09:00:00Z"))
        assertEquals(0L, attentionCount(waiting))
        assertTrue(sidebarStatus(waiting, projectStatus(waiting, 0)).label.startsWith("Returns "))
        assertEquals("1 to review", projectAttentionActions(waiting.copy(attention = waiting.attention!!.copy(reviewTasks = 1))).first().label)
        val working = project("work", empty.copy(runningWorkers = 2))
        assertEquals("Working · 2 workers", sidebarStatus(working, projectStatus(working, 0)).label)
    }

    @Test fun loadedDerivedBoardCountsTasksOnceAndDoesNotCountWaitingAsNeedsYou() {
        val tasks = listOf(
            io.github.mitzacoder.kemiri.tasks.task("T1").copy(state = BoardTaskState("needs_you", "failed", "now", emptyList())),
            io.github.mitzacoder.kemiri.tasks.task("T2").copy(state = BoardTaskState("needs_you", "review", "now", emptyList())),
            io.github.mitzacoder.kemiri.tasks.task("T3").copy(state = BoardTaskState("waiting", "blocked_by_task", "now", listOf("T1"))),
        )
        val board = Board(tasks = tasks, questions = listOf(io.github.mitzacoder.kemiri.tasks.question("Q1", "T1")), decisions = emptyList(), updatedAt = null)
        val project = project("bakery", empty.copy(questions = 1, failedWorkers = 1, reviewTasks = 1))
        val links = needsYouLinks(listOf(BackendAttentionProjects("b", "Bakery", listOf(project), mapOf(project.id to board))))
        assertEquals(2L, links.single().action.count)
        assertEquals("2 need you", links.single().action.label)
        assertEquals(2L, attentionCount(project, board))
    }

    @Test fun actionableFailuresAddStandaloneRowsWithoutRepeatingFailedTasks() {
        val failed = io.github.mitzacoder.kemiri.tasks.task("T1")
            .copy(state = BoardTaskState("needs_you", "failed", "now", emptyList()))
        val board = Board(tasks = listOf(failed), questions = emptyList(), decisions = emptyList(), updatedAt = null)
        val summary = empty.copy(failedWorkers = 1, failedWorkerTaskId = "T1", failedThreads = 1,
            failedThreadId = "audit", failedCoordinators = 0, failedTaskIds = listOf("T1"))
        val project = project("bakery", summary).copy(activity = ProjectActivity("failed", 0, null, null))
        val actions = projectAttentionActions(project, board)
        assertEquals(listOf(AttentionKind.Worker, AttentionKind.Thread), actions.map { it.kind })
        assertEquals(2L, attentionCount(project, board))
    }

    @Test fun failedThreadKeepsBackendProjectAndThreadIdentity() {
        val link = needsYouLinks(listOf(BackendAttentionProjects("b", "Remote", listOf(project("p", empty.copy(failedThreads = 1, failedThreadId = "release")))))).single()
        assertEquals("b", link.backendKey)
        assertEquals("p", link.projectId)
        assertEquals("release", link.action.threadId)
    }
}
