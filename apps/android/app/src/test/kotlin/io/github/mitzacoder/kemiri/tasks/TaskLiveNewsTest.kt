package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.navigation.ChatHighlight
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.protocol.*
import org.junit.Assert.*
import org.junit.Test

class TaskLiveNewsTest {
    private val at = "2026-06-01T12:00:00Z"
    private val line = BoardLiveLine(
        id = "news", at = at, kind = "auto", text = "Updated checkout",
        actor = BoardActivityActor(id = "main:1:run", kind = "worker", name = "fern", threadId = "main", conversationId = 1, runId = "run"),
        picker = "most_steps", evidence = BoardLiveLineEvidence(conversationId = 1, steps = listOf(
            BoardLiveLineEvidenceStepsItem(entryId = "10", description = "Edited checkout.ts"),
            BoardLiveLineEvidenceStepsItem(entryId = "12", description = "Edited checkout.ts"),
            BoardLiveLineEvidenceStepsItem(entryId = "14", description = "Ran checkout tests"),
            BoardLiveLineEvidenceStepsItem(entryId = "16", description = "Edited checkout.ts"),
        )),
    )

    @Test fun showsAutoOnlyWithTheWatcherFeatureAndGroupsConsecutiveSteps() {
        assertTrue(liveTrail(listOf(line), null).lines.isEmpty())
        assertEquals(listOf(line), liveTrail(listOf(line), null, watcher = true).lines)
        val auto = autoLinePresentation(LiveLineKind.Auto, line)!!
        assertEquals("auto", auto.mark)
        assertEquals(listOf("Edited checkout.ts ×2", "Ran checkout tests", "Edited checkout.ts"), auto.evidence.map { it.label })
        assertEquals(listOf("10", "14", "16"), auto.evidence.map { it.entryId })
        assertTrue(auto.canMarkWrong)
        assertFalse(auto.struckThrough)
        assertNull(autoLinePresentation(LiveLineKind.Result, line))
    }

    @Test fun markedWrongKeepsEvidenceReadableAndRemovesTheAction() {
        val wrong = autoLinePresentation(LiveLineKind.Auto, line.copy(wrong = BoardLiveLineWrong(by = "owner", at = at)))!!
        assertEquals("Marked wrong", wrong.wrongLabel)
        assertTrue(wrong.struckThrough)
        assertFalse(wrong.canMarkWrong)
        assertEquals(autoLinePresentation(LiveLineKind.Auto, line)?.evidence, wrong.evidence)
    }

    @Test fun selectsTheNowActorAndOtherRunningWorkersOnTheTask() {
        val now = BoardTaskActivity(kind = "working", text = "fern is checking the balance", since = at, refs = emptyList(), actor = line.actor)
        val fern = WorkerSummary(id = "fern", title = "Checkout", status = "idle", conversationId = 1,
            model = ModelRef(provider = "faux", modelId = "faux-1"), thinkingLevel = null, isolation = "shared", workspacePath = null,
            spawnedByCallId = null, createdAt = at, updatedAt = at, lastReport = null, failure = null)
        val sage = fern.copy(id = "sage", conversationId = 2, threadId = "checkout", taskId = "T1", status = "running")
        val finished = fern.copy(id = "finished", conversationId = 3, taskId = "T1")
        val otherTask = sage.copy(id = "other-task", conversationId = 4, taskId = "T2")
        assertEquals(LiveTranscriptWorkers(fern, listOf(fern, sage)), liveTranscriptWorkers("T1", now, listOf(sage, finished, otherTask, fern)))
        assertNull(liveTranscriptWorkers("T1", now, listOf(fern.copy(threadId = "other"))).nowWorker)
        assertNull(liveTranscriptWorkers("T1", now, listOf(fern.copy(conversationId = 99))).nowWorker)
    }

    @Test fun linksOnlyToTheMatchingWorkersEntry() {
        val chat = Destination.Chat(backendKey = "demo", projectId = "bakery", threadId = "other")
        val worker = WorkerSummary(id = "fern", title = "Checkout", status = "idle", conversationId = 1,
            model = ModelRef(provider = "faux", modelId = "faux-1"), thinkingLevel = null, isolation = "shared", workspacePath = null,
            spawnedByCallId = null, createdAt = at, updatedAt = at, lastReport = null, failure = null)
        assertEquals(chat.copy(threadId = null, workerId = "fern", highlight = ChatHighlight.Entry(10)), liveWorkLogRoute(chat, listOf(worker), line, "10"))
        assertNull(liveWorkLogRoute(chat, listOf(worker.copy(conversationId = 2)), line, "10"))
        assertNull(liveWorkLogRoute(chat, listOf(worker.copy(threadId = "other")), line, "10"))
        assertNull(liveWorkLogRoute(chat, listOf(worker), line, "not-an-entry"))
    }
}
