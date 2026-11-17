package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.features.tasks.graph.*
import org.junit.Assert.*
import org.junit.Test

/** Change history is shared with the next motion stage, not retired card geometry. */
class GraphChangesTest {
    @Test fun reconnectAndFirstReadDoNotInventHistory() {
        val first = graphSnapshot(listOf(task("T1")), emptyList(), emptyList(), emptyList())
        val next = graphSnapshot(listOf(task("T1", "done")), emptyList(), emptyList(), emptyList())
        val baseline = GraphChangeBaseline()
        assertTrue(baseline.read(first).isEmpty())
        assertTrue(baseline.read(next, reset = true).isEmpty())
        assertTrue(baseline.read(next).isEmpty())
    }
    @Test fun reconnectBaselineWaitsForEveryAuthoritativeReadInTheNewGeneration() {
        assertFalse(graphReadsComplete(2, 1, 2, 2))
        assertFalse(graphReadsComplete(2, 2, 1, 2))
        assertFalse(graphReadsComplete(2, 2, 2, 1))
        assertTrue(graphReadsComplete(2, 2, 2, 2))
        assertTrue(graphReadsComplete(2, 2, null, null))
    }
    @Test fun historyIsBoundedAndAReportBurstKeepsItsLatestLine() {
        val report = GraphChange("worker:pip:report", listOf("T3"), "pip reported on T3 · first", "worker reports", "pip", "report")
        val entries = batchGraphChanges(emptyList(), listOf(report), 1000, 0)
        val second = batchGraphChanges(entries, listOf(report.copy(text = "pip reported on T3 · latest")), 1999, 1)
        assertEquals("pip reported on T3 · latest", second.single().text)
        assertEquals(2, second.single().count)
        assertEquals(2, batchGraphChanges(second, listOf(report), 2000, 2).size)
        assertEquals(50, batchGraphChanges(emptyList(), (1..60).map { report.copy(key = "$it") }, 1000, 0).size)
    }
}
