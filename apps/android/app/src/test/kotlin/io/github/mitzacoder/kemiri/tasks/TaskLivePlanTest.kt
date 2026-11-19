package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.protocol.*
import org.junit.Assert.*
import org.junit.Test

class TaskLivePlanTest {
    private val steps = listOf(
        BoardLivePlanStep("Trace the payment flow", "done"),
        BoardLivePlanStep("Add gift cards", "done"),
        BoardLivePlanStep("Check partial payments", "done"),
        BoardLivePlanStep("Run checkout tests", "doing"),
        BoardLivePlanStep("Capture a receipt", "todo"),
    )

    @Test fun countsDoneStepsAndSpeaksEachState() {
        val plan = livePlan(steps)
        assertEquals("3 of 5", plan.progress)
        assertEquals("Plan, 3 of 5 done", plan.description)
        assertEquals(listOf("Done: Trace the payment flow", "Done: Add gift cards", "Done: Check partial payments",
            "In progress: Run checkout tests", "To do: Capture a receipt"), plan.steps.map { it.description })
    }

    @Test fun longPhonePlanShowsOnlyTheDoingStepUntilExpanded() {
        val reordered = livePlan(steps.dropLast(2) + steps.last() + steps[3])
        assertTrue(reordered.canFold(foldOnPhone = true))
        assertEquals(listOf(reordered.steps.last()), reordered.visibleSteps(foldOnPhone = true, expanded = false))
        assertEquals(reordered.steps, reordered.visibleSteps(foldOnPhone = true, expanded = true))
        assertFalse(reordered.canFold(foldOnPhone = false))
        assertEquals(reordered.steps, reordered.visibleSteps(foldOnPhone = false, expanded = false))
    }

    @Test fun fallsBackToTheFirstTodoAndHasNoCurrentStepWhenFinished() {
        val noDoing = livePlan(steps.map { if (it.status == "doing") it.copy(status = "todo") else it })
        assertEquals(listOf(noDoing.steps[3]), noDoing.visibleSteps(foldOnPhone = true, expanded = false))
        val done = livePlan(steps.map { it.copy(status = "done") })
        assertEquals("5 of 5", done.progress)
        assertTrue(done.visibleSteps(foldOnPhone = true, expanded = false).isEmpty())
        assertEquals(done.steps, done.visibleSteps(foldOnPhone = true, expanded = true))
    }

    @Test fun unknownStatusesDoNotCountOrMakeAShortPlanFold() {
        val short = livePlan(steps.take(3) + BoardLivePlanStep("Future step", "paused"))
        assertEquals("3 of 3", short.progress)
        assertFalse(short.canFold(foldOnPhone = true))
        assertEquals(short.steps, short.visibleSteps(foldOnPhone = true, expanded = false))
    }

    @Test fun planOnlyRunsShowInLiveAndInFinishedActivityOnlyWithTheFeature() {
        val now = BoardTaskActivity("working", "fern is working", "2026-06-01T12:00:00Z", emptyList(), ageFormat = "duration")
        val live = BoardTaskLive(emptyList(), plan = steps)
        val working = task("T1", "in_progress").copy(live = live, state = BoardTaskState("in_progress", "working", now.since, emptyList(), now))
        assertEquals(now, taskLiveNow(working, true, null))
        assertNull(taskLiveNow(working, false, null))
        assertNull(taskLiveNow(working.copy(live = live.copy(plan = listOf(BoardLivePlanStep("Unknown step", "paused")))), true, null))
        val work = BoardTimelineEntry(at = "2026-06-01T12:10:00Z", kind = "worker", label = "fern worked 10 minutes: 3 of 5 plan steps", live = live)
        assertEquals(steps, taskActivityRows(ActivitySources(entries = listOf(work), taskLiveEnabled = true)).single().live?.plan)
        assertNull(taskActivityRows(ActivitySources(entries = listOf(work))).single().live)
    }
}
