package io.github.mitzacoder.kemiri.chat

import io.github.mitzacoder.kemiri.features.chat.*
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.protocol.*
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.time.Instant

class BackgroundJobPageTest {
    private val now = Instant.parse("2026-11-17T12:00:00Z").toEpochMilli()
    private fun job() = ThreadSummary(
        id = "garden", title = "Garden", status = "idle", main = false, startedBy = "main", scheduleId = null,
        conversationId = 42, model = null, thinkingLevel = null, onFinish = "record", runningWorkers = 0,
        ownedTasks = emptyList(), openQuestions = 0, current = null, summary = null,
        failure = null, createdAt = "2026-11-17T09:00:00Z", updatedAt = "2026-11-17T11:00:00Z",
        finishedAt = null, archived = false)
    @Test fun startersAndRelativeTimeMirrorWeb() {
        assertEquals("started by Main chat 3 hr ago", backgroundJobBandText(job(), now).origin)
        assertEquals("started by you 3 hr ago", backgroundJobBandText(job().copy(startedBy = "user"), now).origin)
        assertEquals("started by a schedule 3 hr ago", backgroundJobBandText(job().copy(startedBy = "schedule"), now).origin)
        assertEquals("started by schedule Nightly 3 hr ago", backgroundJobBandText(job().copy(startedBy = "schedule"), now, "Nightly").origin)
    }
    @Test fun outcomesAndStopVisibilityUseEmittedStateOrFallback() {
        for (state in listOf("needs_you", "working", "paused")) {
            val text = backgroundJobBandText(job().copy(state = state), now)
            assertEquals("reports back there when it finishes", text.outcome)
            assertTrue(text.canStop)
        }
        val finished = backgroundJobBandText(job().copy(status = "done"), now)
        assertEquals("Finished 1 hr ago · its report is in Main chat", finished.outcome)
        assertFalse(finished.canStop)
        val stopped = backgroundJobBandText(job().copy(state = "stopped", finishedAt = "2026-11-17T10:00:00Z"), now)
        assertEquals("Stopped 2 hr ago · Main chat keeps what it reported so far", stopped.outcome)
        assertFalse(stopped.canStop)
        val failed = backgroundJobBandText(job().copy(status = "failed"), now)
        assertEquals("Failed 1 hr ago · send a message to retry", failed.outcome)
        assertTrue(failed.canStop)
    }
    @Test fun composerNoteAndBandBelongOnlyToJobConversations() {
        val main = Destination.Chat("b", "p")
        assertNull(backgroundJobComposerNote(main))
        assertNull(backgroundJobComposerNote(main.copy(threadId = "main")))
        assertNull(backgroundJobComposerNote(main.copy(threadId = "garden", workerId = "worker")))
        val job = main.copy(threadId = "garden")
        assertTrue(isBackgroundJobPage(job))
        assertEquals("The main chat does not see what you write here, only the job's report.", backgroundJobComposerNote(job))
    }
    @Test fun drawerNamesOnlyTheOpenJobAndFallsBackToItsId() {
        val route = Destination.Chat("b", "p", threadId = "garden")
        assertEquals("Open: Garden", openBackgroundJobLabel(route, listOf(job())))
        assertEquals("Open: garden", openBackgroundJobLabel(route, emptyList()))
        assertNull(openBackgroundJobLabel(route.copy(threadId = null), listOf(job())))
        assertNull(openBackgroundJobLabel(route.copy(workerId = "worker"), listOf(job())))
        assertNull(openBackgroundJobLabel(null, listOf(job())))
    }
    @Test fun bandOnlyGetsThisJobsOpenQuestions() {
        fun question(id: String, thread: String, status: String = "open"): BoardQuestion = Json.decodeFromString("""{
            "id":"$id","revision":1,"text":"Keep originals?","kind":"question","status":"$status","threadId":"$thread",
            "taskId":null,"options":[],"answer":null,"askedAt":"2026-11-17T09:00:00Z","answeredAt":null}""")
        val questions = listOf(question("Q1", "garden"), question("Q2", "other"), question("Q3", "garden", "answered"), question("Q4", "garden"))
        assertEquals(listOf("Q1", "Q4"), backgroundJobQuestions(questions, "garden").map { it.id })
    }
    @Test fun questionPlacementAndSharedStopAreWiredAtTheirOnlySurfaces() {
        val root = File("src/main/kotlin/io/github/mitzacoder/kemiri")
        val chat = root.resolve("features/chat/ChatScreen.kt").readText()
        assertTrue(chat.contains("if (coordinator != null || !isBackgroundJobPage(context.route)) BoardQuestionPin"))
        assertTrue(chat.contains("backgroundJobComposerNote(context.route)"))
        assertTrue(chat.contains("if (coordinator == null && isBackgroundJobPage(context.route)) activeThread?.let"))
        assertTrue(root.resolve("features/chat/BackgroundJobBand.kt").readText().contains("ThreadStopConfirmation(context"))
        assertTrue(root.resolve("features/panels/PanelsScreen.kt").readText().contains("ThreadStopConfirmation(context"))
    }
}
