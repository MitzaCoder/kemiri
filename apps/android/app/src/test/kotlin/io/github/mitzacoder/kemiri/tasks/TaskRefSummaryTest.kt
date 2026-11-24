package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.features.tasks.taskRefSummary
import io.github.mitzacoder.kemiri.features.tasks.taskRefStateLabel
import io.github.mitzacoder.kemiri.features.tasks.taskRefHasFailingChecks
import io.github.mitzacoder.kemiri.protocol.*
import org.junit.Assert.*
import org.junit.Test

class TaskRefSummaryTest {
    private fun pull(state: String, checks: String?) = RefStatusPull(ref = "#1", url = "https://example.com/ref", title = "Synthetic ref", checkedAt = "2026-01-01T00:00:00Z", state = state, checks = checks)

    @Test fun callsReferencesWithoutLiveStateLinks() {
        val summary = taskRefSummary(listOf(null, null))
        assertEquals("2 links", summary.counts)
        assertEquals("Link", taskRefStateLabel(null))
        assertFalse(summary.failingChecks)
    }

    @Test fun onlyFailingChecksOnOpenOrDraftPullsAreWarnings() {
        assertTrue(taskRefSummary(listOf(pull("open", "failing"), null)).failingChecks)
        assertTrue(taskRefHasFailingChecks(pull("draft", "failing")))
        assertFalse(taskRefHasFailingChecks(pull("open", "pending")))
        assertFalse(taskRefHasFailingChecks(pull("closed", "failing")))
        val merged = pull("merged", "failing")
        assertFalse(taskRefHasFailingChecks(merged))
        assertEquals("Merged", taskRefStateLabel(merged))
        assertEquals("Open · checks failing", taskRefStateLabel(pull("open", "failing")))
    }

    @Test fun countsTicketsPullRequestsIssuesAndLinks() {
        val issue = RefStatusIssue(ref = "#2", url = "https://example.com/issue", title = "Synthetic issue", checkedAt = "2026-01-01T00:00:00Z", state = "open")
        val ticket = RefStatusJira(ref = "EX-1", url = "https://example.com/ticket", title = "Synthetic ticket", checkedAt = "2026-01-01T00:00:00Z", status = "Verified", category = "done")
        assertEquals("1 ticket · 2 PRs · 1 issue · 1 link", taskRefSummary(listOf(issue, ticket, pull("open", null), pull("draft", null), null)).counts)
        assertEquals("Verified", taskRefStateLabel(ticket))
        assertEquals("Open", taskRefStateLabel(issue))
    }
}
