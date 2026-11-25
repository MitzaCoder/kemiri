package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.data.ProjectThreadList
import io.github.mitzacoder.kemiri.data.mergeThreadPush
import io.github.mitzacoder.kemiri.protocol.ThreadSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test

class ProjectThreadsTest {
    @Test fun livePushKeepsArchivesUntilTheSameThreadReturns() {
        val oldJob = thread("archive", archived = true)
        val archived = ProjectThreadList(listOf(oldJob), null)
        val running = thread("running")
        val merged = mergeThreadPush(archived, ProjectThreadList(listOf(running), null))
        assertEquals(listOf(running, oldJob), merged.threads)
        assertSame(oldJob, merged.threads.last())

        val restored = oldJob.copy(archived = false)
        assertEquals(listOf(running, restored), mergeThreadPush(merged, ProjectThreadList(listOf(running, restored), null)).threads)
    }

    private fun thread(id: String, archived: Boolean = false) = ThreadSummary(
        id = id, title = id, status = "done", main = false, startedBy = null, scheduleId = null, conversationId = 1,
        model = null, thinkingLevel = null, onFinish = "report", runningWorkers = 0, ownedTasks = emptyList(),
        openQuestions = 0, current = null, summary = null, failure = null, createdAt = "2026-01-01T00:00:00Z",
        updatedAt = "2026-01-01T00:00:00Z", finishedAt = null, archived = archived,
    )
}
