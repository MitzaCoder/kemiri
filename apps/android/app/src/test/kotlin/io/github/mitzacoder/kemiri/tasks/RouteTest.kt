package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.features.tasks.route.*
import io.github.mitzacoder.kemiri.features.tasks.taskNeedsYou
import io.github.mitzacoder.kemiri.protocol.BoardLivePlanStep
import io.github.mitzacoder.kemiri.protocol.BoardQuestion
import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.protocol.BoardTaskLive
import org.junit.Assert.*
import org.junit.Test

class RouteTest {
    private val at = "2026-01-04T12:00:00Z"
    private val ownerQuestion = question("Q1", "T1", kind = "question")
    private fun attention(task: BoardTask, questions: List<BoardQuestion> = emptyList()) =
        routeAttention(task, taskNeedsYou(task, questions, false, true))

    @Test fun livePlanWinsOverPartsAndKeepsTheOwnerInterchangeSeparate() {
        val task = task("T1", "in_progress").copy(live = BoardTaskLive(emptyList(), plan = listOf(
            BoardLivePlanStep("Draft the menu", "done"), BoardLivePlanStep("Check the prices", "doing"),
            BoardLivePlanStep("Print proof", "todo"),
        )))
        val part = task("T2", "in_progress").copy(parent = task.id)
        val stops = routeStops(task, listOf(part), attention(task, listOf(ownerQuestion)), at, 0L)
        assertEquals(listOf("asked", "plan-0", "plan-1", "owner", "plan-2", "review", "end"), stops.map { it.id })
        assertEquals(listOf(RouteStopState.Done, RouteStopState.Done, RouteStopState.Now, RouteStopState.Waits,
            RouteStopState.Ahead, RouteStopState.Ahead, RouteStopState.Ahead), stops.map { it.state })
        assertEquals(at, stops[2].at)
        assertFalse(routeStops(task, listOf(part), attention(task, listOf(ownerQuestion.copy(status = "answered"))), now = 0L)
            .any { it.state == RouteStopState.Waits })
    }

    @Test fun partsUseTaskOrderAndLinkToTheirTasks() {
        val task = task("T1", "in_progress")
        val parts = routeParts(task, listOf(task("T3", "in_progress").copy(parent = "T1"),
            task("T2", "done").copy(parent = "T1"), task("T4").copy(parent = "T3")))
        val stops = routeStops(task, parts, attention(task), now = 0L).filter { it.taskId != null }
        assertEquals(listOf("T2" to RouteStopState.Done, "T3" to RouteStopState.Now), stops.map { it.taskId to it.state })
    }

    @Test fun minimalRouteShowsStateReviewInterchangeOrDone() {
        val cases = listOf("todo" to listOf("Asked", "To do", "You check", "Done"),
            "waiting" to listOf("Asked", "Waiting", "You check", "Done"),
            "review" to listOf("Asked", "You check", "Done"),
            "blocked" to listOf("Asked", "Blocked", "Your stop", "You check", "Done"),
            "done" to listOf("Asked", "You check", "Done"),
            "dropped" to listOf("Asked", "You check", "Dropped"))
        for ((status, labels) in cases) {
            val task = task("T1", status)
            val stops = routeStops(task, emptyList(), attention(task), now = 0L)
            assertEquals(labels, stops.map { it.label })
            assertEquals(status in listOf("done", "dropped"), stops.last().state == RouteStopState.Done)
            if (status == "review") assertEquals(RouteStopState.Waits, stops[1].state)
        }
    }

    @Test fun defaultDoorFollowsOwnerAttentionNotAgentQuestions() {
        val task = task("T1", "in_progress")
        assertEquals(RouteDoor.Got, defaultRouteDoor(attention(task).count))
        assertEquals(RouteDoor.You, defaultRouteDoor(attention(task, listOf(ownerQuestion)).count))
        assertEquals("One answer needed", attention(task, listOf(ownerQuestion)).label)
        assertEquals(RouteDoor.Got, defaultRouteDoor(attention(task, listOf(ownerQuestion.copy(waitingOn = "agent"))).count))
        assertEquals(RouteDoor.You, defaultRouteDoor(attention(task.copy(report = task.report.copy(steps = "Try the page."))).count))
        assertEquals("One heads-up", attention(task, listOf(ownerQuestion.copy(kind = "warning"))).label)
    }

    @Test fun excerptsOmitMarkdownFencesAndHeadingLinesAndStayBounded() {
        assertEquals(listOf("Slot limit held.", "Receipt arrived.", "Queue moved."), reportExcerptLines(
            "# Rehearsal\n\n- **Slot limit held.**\n- [Receipt](https://example.test) arrived.\n```sh\nprintf hello\n```\n- Queue moved.\n- Fourth result.", 3))
        assertEquals(listOf("Check the receipt."), reportExcerptLines("1. Check the receipt.\n2. Review the slot picker.", 1))
        assertTrue(reportExcerptLines("", 3).isEmpty())
    }
}
