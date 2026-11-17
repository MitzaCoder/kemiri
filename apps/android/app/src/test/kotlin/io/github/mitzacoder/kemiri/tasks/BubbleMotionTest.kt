package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.features.tasks.graph.*
import io.github.mitzacoder.kemiri.features.tasks.graph.bubble.*
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.components.AgentMotion
import org.junit.Assert.*
import org.junit.Test

class BubbleMotionTest {
    private fun worker(id: String = "pip", taskId: String? = "T1", status: String = "running", report: String? = null) = WorkerSummary(
        id = id, title = "Synthetic worker", status = status, model = ModelRef("faux", "faux-1"), thinkingLevel = null,
        isolation = "shared", workspacePath = null, conversationId = 1, taskId = taskId, spawnedByCallId = null,
        createdAt = "2026-01-01T00:00:00Z", updatedAt = "2026-01-01T00:00:00Z", lastReport = report, failure = null)
    private val tasks = listOf(task("T1"), task("T2"))
    private fun graph(workers: List<WorkerSummary>, resting: Boolean = false) = buildTaskGraph(tasks, emptyList(), workers, emptyList(), showResting = resting)

    @Test fun reportsAreOneShotAndHistoryReconnectAndFiltersAreBaselines() {
        val baseline = BubbleMotionBaseline()
        fun read(workers: List<WorkerSummary>, generation: Int = 1, hidden: Boolean = false) = baseline.read(
            graph(workers).let { if (hidden) it.copy(nodes = it.nodes.filter { n -> n.kind == "task" }) else it }, workers, emptyList(), generation)
        assertTrue(read(listOf(worker(report = "History"))).reset)
        assertTrue(read(listOf(worker(report = "History"))).reports.isEmpty())
        val report = read(listOf(worker(report = "New report"))).reports.single()
        assertEquals("worker:pip", report.workerId); assertEquals("task:T1", report.taskId)
        assertTrue(read(listOf(worker(report = "New report"))).reports.isEmpty())
        assertTrue(read(listOf(worker(report = "  \n"))).reports.isEmpty())
        assertTrue(read(listOf(worker(report = "Hidden update")), hidden = true).reports.isEmpty())
        assertTrue(read(listOf(worker(report = "Hidden update"))).reports.isEmpty())
        val reconnect = read(listOf(worker(report = "Reconnect history")), generation = 2)
        assertTrue(reconnect.reset); assertTrue(reconnect.reports.isEmpty()); assertTrue(reconnect.arrivals.isEmpty())
    }

    @Test fun realDeparturesOnlyAndNewWorkersNotRemountedWorkersFadeIn() {
        val baseline = BubbleMotionBaseline()
        fun read(workers: List<WorkerSummary>, resting: Boolean = false) = baseline.read(graph(workers, resting), workers, emptyList(), 1)
        val pip = worker()
        read(listOf(pip))
        val move = read(listOf(pip.copy(taskId = "T2")))
        assertTrue(move.departures.isEmpty()); assertTrue(move.arrivals.isEmpty())
        val rest = pip.copy(taskId = null, status = "idle")
        assertTrue(read(listOf(rest)).departures.isEmpty())
        assertTrue(read(listOf(rest), resting = true).arrivals.isEmpty())
        assertTrue(read(listOf(pip)).arrivals.isEmpty())
        assertEquals(setOf("worker:new"), read(listOf(pip, worker("new"))).arrivals)
        val stopped = read(listOf(pip, worker("new", status = "stopped"))).departures.single()
        assertEquals("stopped", stopped.status)
        assertTrue(read(listOf(pip, worker("new", status = "stopped"))).departures.isEmpty())
        assertEquals("done", read(listOf(pip.copy(status = "done"))).departures.single().status)
        assertTrue(read(emptyList()).departures.isEmpty())
        read(listOf(pip))
        assertEquals("done", read(emptyList()).departures.single().status)
    }

    @Test fun handoffsUseTheVectorCheckedArcOnlyOnAChangedTaskRim() {
        val start = GraphPosition(0.0, 0.0, 0.0, 0.0, radius = 21.0, parentId = "task:T1")
        val end = start.copy(x = 240.0, parentId = "task:T2")
        val placement = BubblePlacement(mapOf("worker:pip" to end), mapOf("worker:pip" to start))
        val halfway = bubbleCrewPosition("worker:pip", placement, .5f)!!
        val expected = interpolateCrewHandoff(placement.from, placement.positions, .5).getValue("worker:pip")
        assertEquals(expected.x, halfway.x, 0.0); assertEquals(expected.y, halfway.y, 0.0)
        assertTrue(halfway.y < 0); assertEquals(end, bubbleCrewPosition("worker:pip", placement, 1f))
        val sameRim = placement.copy(positions = mapOf("worker:pip" to end.copy(parentId = start.parentId)))
        assertEquals(sameRim.positions["worker:pip"], bubbleCrewPosition("worker:pip", sameRim, .5f))
    }

    @Test fun canvasBudgetStopsLoopsAtViewportZoomAndReducedMotionBoundaries() {
        val crew = (1..30).map { GraphMotionCandidate("worker:$it", AgentMotion.Working, it % 2 == 0) }
        assertEquals(12, graphLoopingWorkers(crew, .5f, true).size)
        assertEquals(graphLoopingWorkers(crew, 1f, true), graphLoopingWorkers(crew.reversed(), 1f, true))
        assertTrue(graphLoopingWorkers(crew, .499f, true).isEmpty())
        assertTrue(graphLoopingWorkers(crew, 1f, false).isEmpty())
        assertTrue(graphLoopingWorkers(crew.map { it.copy(inView = false) }, 1f, true).isEmpty())
        assertEquals(30, crew.map { workerMotionPhase(it.id) }.distinct().size)
    }
}
