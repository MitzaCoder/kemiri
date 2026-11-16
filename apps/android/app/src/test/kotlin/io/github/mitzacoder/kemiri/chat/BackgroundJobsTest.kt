package io.github.mitzacoder.kemiri.chat

import io.github.mitzacoder.kemiri.features.chat.*
import io.github.mitzacoder.kemiri.navigation.*
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.components.*
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class BackgroundJobsTest {
    private val now = Instant.parse("2026-11-17T12:00:00Z").toEpochMilli()
    private fun job(status: String = "idle") = ThreadSummary(
        id = "garden", title = "Garden", status = status, main = false, startedBy = "main", scheduleId = null,
        conversationId = 42, model = null, thinkingLevel = null, onFinish = "record", runningWorkers = 0,
        ownedTasks = emptyList(), openQuestions = 0, current = "Sorting plants", summary = "Ready\nDetails",
        failure = "Provider unavailable.", createdAt = "2026-11-17T09:00:00Z", updatedAt = "2026-11-17T11:00:00Z",
        finishedAt = null, archived = false)

    @Test fun fallbackFirstMatchWins() {
        for ((status, expected) in listOf("done" to "finished", "stopped" to "stopped", "failed" to "failed")) {
            assertEquals(expected, threadState(job(status).copy(openQuestions = 2, runningWorkers = 3)))
        }
        assertEquals("needs_you", threadState(job("running").copy(openQuestions = 1, runningWorkers = 2)))
        assertEquals("working", threadState(job("running")))
        assertEquals("working", threadState(job().copy(runningWorkers = 1)))
        assertEquals("paused", threadState(job()))
        assertEquals("paused", threadState(job("running").copy(state = "paused")))
    }
    @Test fun labelsAndTonesAreExplicit() {
        val states = listOf("needs_you", "working", "paused", "failed", "finished", "stopped")
        assertEquals(listOf("Needs you", "Working", "Paused", "Failed", "Finished", "Stopped"), states.map(::threadStateLabel))
        assertEquals(listOf(StatusTone.Warning, StatusTone.Active, StatusTone.Neutral, StatusTone.Danger, StatusTone.Success, StatusTone.Subtle), states.map { workbenchStatus(it, "thread").tone })
    }
    @Test fun linesFollowStateNotStaleCurrent() {
        val question = BoardQuestion(id = "Q1", revision = 1, text = "Keep originals?", kind = "question", status = "open", threadId = "garden", taskId = null, options = emptyList(), answer = null, askedAt = "2026-11-17T09:00:00Z", answeredAt = null)
        assertEquals("Keep originals?", threadStateLine(job().copy(state = "needs_you"), listOf(question), now))
        assertEquals("1 question for you", threadStateLine(job().copy(state = "needs_you")))
        assertEquals("Sorting plants", threadStateLine(job("running")))
        assertEquals("Nothing is running. Send it a message to continue.", threadStateLine(job()))
        assertEquals("Provider unavailable. Send a message to retry.", threadStateLine(job("failed")))
        assertEquals("Send a message to retry.", threadStateLine(job("failed").copy(failure = null)))
        assertEquals("Ready", threadStateLine(job("done")))
        assertEquals("Stopped 1 hr ago", threadStateLine(job("stopped"), now = now))
        assertEquals("Stopped Just now", threadStateLine(job("stopped").copy(finishedAt = "2026-11-17T12:00:00Z"), now = now))
    }
    @Test fun orderAnd24HourBoundary() {
        val old = job("done").copy(id = "old", finishedAt = "2026-11-16T11:59:59Z")
        val boundary = old.copy(id = "boundary", finishedAt = "2026-11-16T12:00:00Z")
        val recent = job("stopped").copy(id = "recent")
        val jobs = listOf(old, boundary, recent, job(), job("running"), job("failed"), job().copy(state = "needs_you"))
        assertEquals(listOf("needs_you", "failed", "working", "paused", "stopped", "finished", "finished"), orderedBackgroundJobs(jobs).map(::threadState))
        assertTrue(foldFinishedJob(old, now))
        assertFalse(foldFinishedJob(boundary, now))
        assertFalse(foldFinishedJob(recent, now))
        assertTrue(foldFinishedJob(old.copy(status = "stopped"), now))
        assertFalse(foldFinishedJob(old.copy(status = "failed"), now))
        assertFalse(foldFinishedJob(old.copy(finishedAt = "invalid"), now))
    }
    @Test fun countsExcludeMainAndArchivedAndPaused() {
        val jobs = listOf(job().copy(openQuestions = 1), job("failed"), job("running"), job(), job("done"), job("stopped"), job("running").copy(main = true), job("failed").copy(archived = true), job("running").copy(id = "main"))
        assertEquals(ProjectActivityBackgroundJobs(needsYou = 2, working = 1), backgroundJobCounts(jobs))
        assertEquals("2 needs you · 1 working", backgroundJobCountsText(backgroundJobCounts(jobs)))
        assertEquals("1 working", backgroundJobCountsText(ProjectActivityBackgroundJobs(0, 1)))
        assertEquals("1 needs you", backgroundJobCountsText(ProjectActivityBackgroundJobs(1, 0)))
        assertNull(backgroundJobCountsText(ProjectActivityBackgroundJobs(0, 0)))
        assertEquals("2 background jobs", backgroundThreadsText(2))
    }
    @Test fun startNeverFoldsIntoStepsAtEitherBoundary() {
        val call = ChatPart("one", "tool", name = "board", status = "done")
        val start = call.copy(key = "start", name = "thread_start")
        val rows = groupParts(listOf(call, call.copy(key = "two"), start, call.copy(key = "three"), call.copy(key = "four")))
        assertEquals(listOf(2, 1, 2), rows.map { it.parts.size })
        assertTrue(rows[0].isSteps)
        assertFalse(rows[1].isSteps)
        assertTrue(rows[2].isSteps)
        assertFalse(ChatRow("malformed", listOf(call, start)).isSteps)
        assertEquals("Background jobs", PanelTab.Threads.label)
    }
}
