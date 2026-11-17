package io.github.mitzacoder.kemiri.panels

import io.github.mitzacoder.kemiri.features.panels.*
import io.github.mitzacoder.kemiri.protocol.MemoryMaintenanceRun
import org.junit.Assert.*
import org.junit.Test

class MemoryMaintenancePresentationTest {
    private val now = java.time.Instant.parse("2026-11-04T19:00:00Z").toEpochMilli()
    private fun run(outcome: String, message: String? = "Service unavailable", trigger: String = "nightly") =
        MemoryMaintenanceRun(at = "2026-11-04T18:30:00Z", trigger = trigger, outcome = outcome, commit = null, message = message)

    @Test fun olderBackendsAndEmptyHistoryAddNoWarning() {
        assertEquals(0, memoryFailureStreak(null))
        assertEquals(0, memoryFailureStreak(emptyList()))
        assertNull(memoryFailureWarning(null))
        assertTrue(memoryRunRows(emptyList(), now).isEmpty())
    }

    @Test fun oneFailureIsNotRepeatedFailure() {
        assertEquals(1, memoryFailureStreak(listOf(run("failed"), run("ok"))))
        assertNull(memoryFailureWarning(listOf(run("failed"))))
    }

    @Test fun countsOnlyConsecutiveNewestFailuresIncludingAllFailedWindow() {
        assertEquals(2, memoryFailureStreak(listOf(run("failed"), run("failed"), run("ok"), run("failed"))))
        assertEquals(10, memoryFailureStreak(List(10) { run("failed") }))
        assertEquals("The last 3 maintenance runs failed: Service unavailable", memoryFailureWarning(List(3) { run("failed") }))
    }

    @Test fun bothSuccessfulOutcomesBreakStreak() {
        listOf("ok", "nothing_to_do").forEach { outcome ->
            assertEquals(0, memoryFailureStreak(listOf(run(outcome), run("failed"), run("failed"))))
            assertNull(memoryFailureWarning(listOf(run(outcome), run("failed"), run("failed"))))
        }
    }

    @Test fun shortensReasonsWithoutChangingFullTextOrSplittingUnicode() {
        val message = "  Service\n unavailable\t " + "😀".repeat(100)
        val row = memoryRunRows(listOf(run("failed", message)), now).single()
        assertEquals(message, row.run.message)
        assertEquals(100, row.reason!!.codePointCount(0, row.reason!!.length))
        assertTrue(row.reason!!.endsWith("…"))
        assertEquals("short reason", shortMemoryReason("  short\n reason "))
        assertEquals("a".repeat(100), shortMemoryReason("a".repeat(100)))
    }

    @Test fun explainsMissingAndBlankReasons() {
        listOf(null, "", " \n ").forEach { assertEquals("No failure reason was recorded.", shortMemoryReason(it)) }
        assertTrue(memoryFailureWarning(listOf(run("failed", null), run("failed")))!!.contains("No failure reason was recorded."))
    }

    @Test fun preservesOrderTriggerOutcomeExactTimeAndCommit() {
        val rows = memoryRunRows(listOf(run("failed"), run("ok", trigger = "manual").copy(commit = "123456789"), run("nothing_to_do", trigger = "writes")), now)
        assertEquals(listOf("Nightly", "Manual", "After writes"), rows.map { it.trigger })
        assertEquals(listOf("failed", "changed memory", "nothing to do"), rows.map { it.outcome })
        assertEquals(listOf("!", "✓", "–"), rows.map { it.mark })
        assertEquals("30 min ago", rows.first().time)
        assertTrue(rows.first().exactTime.isNotEmpty())
        assertEquals("123456789", rows[1].run.commit)
        assertNull(rows[1].reason)
    }
}
