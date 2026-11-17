package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.features.tasks.graph.*
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.components.AgentMotion
import org.junit.Assert.*
import org.junit.Test

class GraphCrewTest {
    private fun worker(id: String, taskId: String?, status: String = "idle") = WorkerSummary(
        id = id, title = "Synthetic worker", status = status, model = ModelRef(provider = "faux", modelId = "faux-1"),
        thinkingLevel = null, isolation = "shared", workspacePath = null, conversationId = 1, taskId = taskId,
        spawnedByCallId = null, createdAt = "2026-01-01T00:00:00Z", updatedAt = "2026-01-01T00:00:00Z", lastReport = null, failure = null)

    @Test fun restingRuleHasNoClockAndNeverRestsRunningCrew() {
        val open = task("T1")
        for (status in listOf("idle", "failed")) {
            assertFalse(graphWorkerRests(status, open, setOf("T1")))
            for (hidden in listOf(null, open.copy(status = "done"), open.copy(status = "dropped"), open.copy(archived = true)))
                assertTrue(graphWorkerRests(status, hidden, setOf("T1")))
            assertTrue(graphWorkerRests(status, open, emptySet()))
        }
        for (t in listOf(null, open, open.copy(status = "done"))) assertFalse(graphWorkerRests("running", t, emptySet()))
    }
    @Test fun modelKeepsUnassignedAndThreadWorkersForRestingTranscriptRows() {
        val tasks = listOf(task("T1"), task("T2", status = "done"), task("T3").copy(workerIds = listOf("legacy")))
        val workers = listOf(worker("open", "T1"), worker("closed", "T2"), worker("absent", "T99", "failed"),
            worker("none", null), worker("legacy", null), worker("thread", "T2").copy(threadId = "garden"), worker("running", null, "running"))
        val model = buildGraphModel(tasks, emptyList(), workers, emptyList(), 0)
        assertEquals(listOf("closed", "absent", "none", "thread"), model.restingWorkers(setOf("T1", "T2", "T3")).map { it.id })
        assertEquals("T3", model.workerTask(workers[4])?.id)
        assertEquals("garden", model.restingWorkers(setOf("T1", "T3")).last().threadId)
        assertEquals("idle · 0 min", graphIdleTime(workers[0], 0))
        assertTrue(graphTaskCrew(model.details.getValue("T2")).isEmpty())
        val layout = layoutGraphFamilies(tasks.map { GraphLayoutTask(it.id, null, it.id) })
        assertFalse(graphCrewPlacements(layout, model).any { it.taskId == "T2" })
    }
    @Test fun workerMotionMatchesWebStatusAndBlockingQuestionPrecedence() {
        val open = task("T1")
        val ask = question("Q1", "T1")
        assertEquals(AgentMotion.Working, workerMotion("running", open, listOf(ask)))
        assertEquals(AgentMotion.Failed, workerMotion("failed", open.copy(status = "review"), listOf(ask)))
        for (status in listOf("done", "stopped")) assertEquals(AgentMotion.Done, workerMotion(status, open, listOf(ask)))
        assertEquals(AgentMotion.Waiting, workerMotion("idle", open.copy(status = "review"), emptyList()))
        assertEquals(AgentMotion.Waiting, workerMotion("idle", open, listOf(ask)))
        assertEquals(AgentMotion.Waiting, workerMotion("idle", open, listOf(ask.copy(kind = "warning", blocksWork = true))))
        for (q in listOf(ask.copy(status = "answered"), ask.copy(waitingOn = "agent"), ask.copy(blocksWork = false), ask.copy(kind = "warning"), ask.copy(taskId = "T2")))
            assertEquals(AgentMotion.Sleeping, workerMotion("idle", open, listOf(q)))
        for (t in listOf(null, open.copy(status = "done"), open.copy(status = "dropped")))
            assertEquals(AgentMotion.Sleeping, workerMotion("idle", t, listOf(ask)))
    }
    @Test fun onlySuccessOrRemovalCelebrates() {
        assertTrue(graphCrewFinishes("done")); assertTrue(graphCrewFinishes(null))
        for (status in listOf("stopped", "running", "idle", "failed")) assertFalse(graphCrewFinishes(status))
    }
    @Test fun motionBudgetIsVisibleCappedStableAndStillBelowHalfZoom() {
        val crew = (1..20).map { GraphMotionCandidate("worker:$it", AgentMotion.Sleeping, true) } +
            GraphMotionCandidate("offscreen", AgentMotion.Working, false) + GraphMotionCandidate("failed", AgentMotion.Failed, true)
        val allowed = graphLoopingWorkers(crew, 1f, true)
        assertEquals(12, allowed.size)
        assertEquals(allowed, graphLoopingWorkers(crew.reversed(), .5f, true))
        assertFalse("offscreen" in allowed); assertFalse("failed" in allowed)
        assertTrue(graphLoopingWorkers(crew, .49f, true).isEmpty())
        assertTrue(graphLoopingWorkers(crew, Float.NaN, true).isEmpty())
        assertTrue(graphLoopingWorkers(crew, 1f, false).isEmpty())
        assertNotEquals(workerMotionPhase("worker:pip"), workerMotionPhase("worker:dot"))
        assertTrue(workerMotionPhase("worker:pip") in 0L..5999L)
    }
}
