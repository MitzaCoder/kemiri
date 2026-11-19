package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.features.tasks.bindingShareText
import io.github.mitzacoder.kemiri.features.tasks.taskUsagePresentation
import io.github.mitzacoder.kemiri.protocol.*
import org.junit.Assert.*
import org.junit.Test

class TaskUsageTest {
    private val orchard = TaskSubscriptionUsage("orchard-example", "Orchard", "subscription", 35.0,
        TaskSubscriptionUsageBindingWindow("Weekly limit", 10_080.0, .07), false)
    private val own = TaskUsageAmount(2, 20.0)
    private val total = TaskUsageAmount(8, 41.8)
    private val parts = listOf(TaskUsagePart("T2", "T1", "Draw the maps", TaskUsageAmount(6, 21.8)),
        TaskUsagePart("T3", "T2", "Check the map", TaskUsageAmount(2, 5.62)))
    private fun worker(id: String, model: String = "spruce") = TaskConversationUsage("worker", "main", id, id, "orchard-example", model, 1.0)

    private val usage = UsageTaskResponse(id = "task", own = own, total = total, parts = parts,
        subscriptions = listOf(orchard.copy(label = "Unmeasured", apiValue = 60.0, bindingWindow = null), orchard),
        payAsYouGo = listOf(PayAsYouGoValue("metered", "Metered", .62, true)),
        conversations = listOf(worker("atlas"), worker("mapmaker"), worker("mapmaker", "clover"), worker("proofreader")),
        notes = TaskUsageNotes(1, listOf("Meadow")))

    @Test fun `line chooses highest measured subscription and counts distinct workers and nested subtasks`() {
        val line = taskUsagePresentation(usage, "T1")!!
        assertEquals("$41.80 at API prices · ≈ 7% of an Orchard week · 3 workers, 2 subtasks", line.headline)
        assertEquals(listOf(0, 1), line.parts.map { it.depth })
        assertEquals(listOf("1 unpriced request not included in dollar amounts.",
            "Limit share unavailable for some or all requests on Meadow.", "Some older requests use assumed billing."), line.notes)
    }

    @Test fun `there is no line before requests are recorded but unpriced requests still count`() {
        assertNull(taskUsagePresentation(null, "T1"))
        assertNull(taskUsagePresentation(usage.copy(total = TaskUsageAmount(0, 0.0)), "T1"))
        assertEquals("$0.00 at API prices · 1 thread", taskUsagePresentation(usage.copy(total = TaskUsageAmount(1, 0.0),
            parts = emptyList(), subscriptions = emptyList(), conversations = listOf(worker("atlas").copy(kind = "thread", workerId = null))), "T1")!!.headline)
    }

    @Test fun `limit wording covers tiny shares and nonstandard windows`() {
        assertEquals("≈ <1% of a Meadow day", bindingShareText(orchard.copy(label = "Meadow",
            bindingWindow = TaskSubscriptionUsageBindingWindow("Daily limit", 1440.0, .004))))
        assertEquals("≈ 12% of the Orchard monthly limit", bindingShareText(orchard.copy(
            bindingWindow = TaskSubscriptionUsageBindingWindow("Monthly Limit", null, .12))))
        assertNull(bindingShareText(orchard.copy(bindingWindow = null)))
    }
}
