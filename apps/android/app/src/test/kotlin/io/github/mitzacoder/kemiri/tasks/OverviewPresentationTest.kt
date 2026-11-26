package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.features.tasks.board.*
import io.github.mitzacoder.kemiri.features.tasks.overview.*
import io.github.mitzacoder.kemiri.protocol.*
import org.junit.Assert.*
import org.junit.Test

class OverviewPresentationTest {
    @Test fun openingTicksWithoutAnotherRead() {
        val counts = OverviewGetResponseCounts(1, 0, 1, "2026-01-01T00:00:00.000Z")
        val start = overviewTime(counts.oldestWaitSince!!)!!
        assertEquals("1 request is open, and 1 thing waits on you for up to 2 min.", overviewOpening(counts, start + 120_000))
        assertEquals("1 request is open across 2 coordinators, and 1 thing waits on you for up to 3 min.", overviewOpening(counts, start + 180_000, 2))
        assertEquals("1 request open · 1 waits on you", overviewRosterFacts(counts))
    }

    @Test fun estimateWidthsAndOverrunsArePresentedAsAgentTime() {
        val estimate = OverviewTimeLeftRange(minutes = 90.0, low = 60.0, high = 120.0, basis = "project", overrunInMs = 60_000.0)
        assertEquals(OverviewEstimateLine("About 1½ h", "1 h to 2 h of agent work · project history"), overviewEstimateLine(estimate, 59_999))
        assertEquals("Running longer than estimated", overviewEstimateLine(estimate, 60_000)?.title)
        assertEquals("Longer than usual", overviewEstimateLine(OverviewTimeLeftUsual(low = 10.0, high = 20.0, basis = "coordinator", runningSince = "", longerInMs = 60_000.0, longer = false), 60_000)?.title)
        assertEquals(OverviewEstimateLine("Stopped", "Waiting for review.", stopped = true), overviewEstimateLine(OverviewTimeLeftStopped(reason = "review"), 0))
        assertEquals(OverviewEstimateLine("No estimate", "The range is too wide to be useful."), overviewEstimateLine(OverviewTimeLeftNone(reason = "wide_range"), 0))
    }

    @Test fun savedOverviewFallsBackWithoutChangingOtherViews() {
        val saved = tasksViewMode("overview")
        assertEquals(TasksViewMode.Overview, availableTasksViewMode(saved, true))
        assertEquals(TasksViewMode.List, availableTasksViewMode(saved, false))
        assertEquals(TasksViewMode.Board, availableTasksViewMode(tasksViewMode("board"), false))
        assertEquals(TasksViewMode.Graph, availableTasksViewMode(tasksViewMode("graph"), false))
    }
}
