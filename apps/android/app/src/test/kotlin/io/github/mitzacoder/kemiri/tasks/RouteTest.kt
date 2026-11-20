package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.features.tasks.route.*
import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.protocol.BoardLivePlanStep
import io.github.mitzacoder.kemiri.protocol.BoardQuestion
import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.protocol.BoardTaskLive
import kotlinx.serialization.json.Json
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

    @Test fun routeSelectsTypedResultsOrTheWholeMarkdownFallback() {
        val legacy = task("T1").report.copy(results = "The **legacy** paragraph stays intact.")
        val blocks = Json.parseToJsonElement("""{"results":[{"kind":"finding","title":"The limit held","text":"The clerk accepted ten reservations."}]}""")
        assertEquals(ReportSectionContent.Blocks(listOf(ReportBlock.Finding("The limit held", "The clerk accepted ten reservations."))),
            routeResults(legacy.copy(blocks = blocks)))
        assertEquals(ReportSectionContent.Mirror(legacy.results), routeResults(legacy))
        assertEquals(ReportSectionContent.Mirror(legacy.results), routeResults(legacy.copy(blocks =
            Json.parseToJsonElement("""{"results":[{"kind":"future"}]}"""))))
    }

    @Test fun routeDoorGlancesUseTypedFactsWithLegacyFallbacks() {
        val legacy = task("T1").report.copy(results = "- The **desk** is ready.", notDone = "- The covered queue was not tested.", next = "Check the receipt.")
        val blocks = Json.parseToJsonElement("""{
            "summary":[{"kind":"outcome","text":"The **morning** queue is ready."}],
            "results":[{"kind":"finding","title":"The limit held","text":"The clerk accepted ten reservations."}],
            "notDone":[{"kind":"risk","title":"Rainy-day queue","text":"The covered queue still needs a test."}],
            "next":[{"kind":"nextAction","text":"The team will return."},{"kind":"nextAction","text":"The team will reopen."}]
        }""")
        val fields = TaskDetailFields(showSummary = true, showNotDone = true)
        val typedGlance = routeReportGlance(legacy.copy(blocks = blocks), fields)
        assertEquals("The morning queue is ready.", typedGlance.firstOutcome)
        assertEquals(listOf("The limit held"), typedGlance.findingTitles)
        assertEquals(listOf("Rainy-day queue"), typedGlance.riskTitles)
        assertNull(typedGlance.legacyNotDone)
        assertEquals("The team will return.", typedGlance.firstNextAction)
        val legacyGlance = routeReportGlance(legacy, fields)
        assertEquals("The desk is ready.", legacyGlance.firstOutcome)
        assertEquals("The covered queue was not tested.", legacyGlance.legacyNotDone)
        assertEquals("Check the receipt.", legacyGlance.firstNextAction)
        assertNull(routeReportGlance(legacy, TaskDetailFields()).legacyNotDone)
    }
}
