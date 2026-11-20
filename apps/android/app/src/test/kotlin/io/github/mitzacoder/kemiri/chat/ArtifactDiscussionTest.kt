package io.github.mitzacoder.kemiri.chat

import io.github.mitzacoder.kemiri.features.chat.*
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.tasks.task
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/** Matches the pinned cases in apps/web/test/artifact-discuss.test.ts. */
class ArtifactDiscussionTest {
    private val header = "Discuss \"Seasonal guide\"\n(artifact artifact-abc~4, guide.html)"
    private val guide = Artifact(id = "artifact-abc~4", projectId = "demo", name = "guide.html", title = "Seasonal guide", note = null,
        kind = "text", mimeType = "text/html", size = 20, durationSeconds = null, threadId = "main", workerId = null, taskId = "T4",
        sourcePath = "guide.html", createdAt = "2026-11-10T11:00:00Z", version = 4)

    @Test fun pinsAndParsesTheSameMessageAsWeb() {
        val body = "Move the meeting point to the top."
        assertEquals(header, discussHeader(guide))
        val wire = "$header\n\n$body"
        assertEquals(wire, discussionText(header, body))
        assertEquals(DiscussionReference("Seasonal guide", "artifact-abc", 4, "guide.html", header, body), discussionReference(wire))
        assertEquals(body, discussionReference(wire.replace("\n", "\r\n"))?.body)
        assertNull(discussionReference("Discuss a guide without a reference"))
        assertNull(discussionReference(wire.replace("~4", "~9007199254740992")))
    }

    @Test fun legacyVersionAndMultilineTitle() {
        assertEquals("Discuss \"A ′guide′ for plants\"\n(artifact legacy~1, plants.html)",
            discussHeader(guide.copy(id = "legacy", name = "plants.html", title = "A \"guide\"\nfor plants", version = null)))
    }

    @Test fun replacesTheChipAndTaskWhilePreservingWordsAndQuotes() {
        val draft = DraftContent(text = "Keep my words", quotes = listOf("Keep this quote"), taskId = "T2")
        val attached = attachDiscussion(draft, header, "T4")
        assertEquals(draft.copy(text = "$header\n\nKeep my words", taskId = "T4"), attached)
        assertEquals(attached.copy(taskId = null), attachDiscussion(attached, header, null))
        val admission = PendingAdmission.create("demo", attached.text, emptyList(), WorkerDefaults(null, null), quotes = draft.quotes)
        assertEquals(header, discussionReference(admission.message)?.header)
        assertEquals(draft.quotes, splitQuotes(discussionReference(admission.message)!!.body).quotes)
    }

    @Test fun picksTheNewestCoordinatorFollowUpEvenIfAlreadyDropped() {
        val sent = Instant.parse("2026-11-10T12:00:00Z").toEpochMilli()
        fun followUp(id: String, delta: Long) = task(id).copy(foundWhile = "T1", createdBy = "coordinator", createdAt = Instant.ofEpochMilli(sent + delta).toString())
        val dropped = followUp("T12", 200).copy(status = "dropped")
        val tasks = listOf(followUp("T2", -10), followUp("T3", 0), followUp("T4", 100), followUp("T10", 200), dropped,
            followUp("T13", 300).copy(createdBy = "user"), followUp("T14", 400).copy(foundWhile = "T2"))
        assertEquals(dropped, newestDiscussionFollowUp(tasks, "T1", sent))
        assertTrue(settledDiscussionTask("dropped", null, sent))
        assertFalse(settledDiscussionTask("todo", null, sent))
        assertFalse(settledDiscussionTask("done", Instant.ofEpochMilli(sent + 1).toString(), sent))
    }
}
