package io.github.mitzacoder.kemiri.chat

import io.github.mitzacoder.kemiri.features.chat.*
import io.github.mitzacoder.kemiri.protocol.DraftContent
import io.github.mitzacoder.kemiri.protocol.DraftAttachment
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class ArtifactReviewTest {
    @Serializable private data class Case(val name: String, val artifact: ReviewArtifact, val review: ArtifactReview, val expected: String)
    private class MemoryStorage : ReviewStorage {
        val entries = mutableMapOf<String, String>()
        override fun get(key: String) = entries[key]
        override fun set(key: String, text: String) { entries[key] = text }
        override fun remove(key: String) { entries.remove(key) }
    }
    @Test fun `shared web fixture is byte identical without copying`() {
        val fixture = File("../../web/test/fixtures/artifact-review.json")
        assertTrue("Run from the Android app module: shared web fixture must exist", fixture.isFile)
        val cases = Json.decodeFromString<List<Case>>(fixture.readText())
        assertTrue(cases.size >= 4)
        for (case in cases) assertArrayEquals(case.name, case.expected.toByteArray(Charsets.UTF_8), formatArtifactReview(case.artifact, case.review).toByteArray(Charsets.UTF_8))
    }
    private fun selection(extra: String = "") = Json.parseToJsonElement("""{"type":"kemiri:artifact-selection","text":"Passage"$extra}""")
    @Test fun `selection accepts only exact string keys and known blocks`() {
        assertEquals("Passage", validateArtifactSelection(selection())?.text)
        for (extra in listOf(",\"html\":\"<b>x</b>\"", ",\"section\":7", ",\"elementId\":null", ",\"block\":\"table\"", ",\"block\":{}")) assertNull(validateArtifactSelection(selection(extra)))
        assertNull(validateArtifactSelection(JsonNull)); assertNull(validateArtifactSelection(JsonArray(emptyList())))
        assertNull(validateArtifactSelection(Json.parseToJsonElement("""{"text":"x"}""")))
        for (block in REVIEW_BLOCKS) assertEquals(block, validateArtifactSelection(selection(",\"block\":\"$block\""))?.block)
    }
    @Test fun `selection strips controls normalizes whitespace and caps UTF16 text`() {
        val selection = validateArtifactSelection(buildJsonObject {
            put("type", REVIEW_SELECTION_TYPE); put("text", "\u0000Hello\u00a0 world  \r\n\r\n\r\nend\u007f\u0085")
            put("section", "s".repeat(500)); put("elementId", "i".repeat(500))
        })!!
        assertEquals("Hello  world\n\nend", selection.text)
        assertEquals(300, selection.section!!.length); assertTrue(selection.section!!.endsWith("…"))
        assertEquals(120, selection.elementId!!.length)
        assertEquals(4000, reviewText("a".repeat(5000), 4000).length)
    }
    @Test fun `evaluateJavascript decodes exactly one JSON string layer`() {
        assertEquals("Passage", decodeArtifactSelection(Json.encodeToString(selection().toString()))?.text)
        for (input in listOf("null", selection().toString(), "7", "{", "\"bad\"", "a".repeat(100001))) assertNull(decodeArtifactSelection(input))
    }
    @Test fun `storage scopes backend project stable ID and version`() {
        val key = artifactReviewKey("backend", "project", "sample~2", 2)
        assertEquals(key, artifactReviewKey("backend", "project", "sample", 2))
        assertNotEquals(key, artifactReviewKey("other", "project", "sample", 2))
        assertNotEquals(key, artifactReviewKey("backend", "other", "sample", 2))
        assertNotEquals(key, artifactReviewKey("backend", "project", "sample", 3))
        val storage = MemoryStorage()
        val review = ArtifactReview(listOf(ReviewComment("Quote", "Heading", block = "chart", intent = "Clarify", note = "Why?")), "Overall")
        assertTrue(saveArtifactReview(storage, key, review)); assertEquals(review, loadArtifactReview(storage, key))
        assertTrue(saveArtifactReview(storage, key, ArtifactReview())); assertNull(storage.get(key))
    }
    @Test fun `storage drops malformed comments and bounds restored reviews`() {
        val storage = MemoryStorage(); storage.set("key", "broken")
        assertEquals(ArtifactReview(), loadArtifactReview(storage, "key"))
        storage.set("key", """{"comments":[{"text":"quote","note":"n","intent":"Invented"},{"text":"x","note":"n","type":"forged"},{"text":"x","note":"n","html":"bad"},{"text":"ok","note":"note"}],"overall":"overall"}""")
        assertEquals(listOf(ReviewComment("ok", note = "note")), loadArtifactReview(storage, "key").comments)
        saveArtifactReview(storage, "key", ArtifactReview(List(110) { ReviewComment("q", intent = "Keep") }))
        assertEquals(100, loadArtifactReview(storage, "key").comments.size)
    }
    @Test fun `storage failures are explicit`() {
        val storage = object : ReviewStorage {
            override fun get(key: String): String? = error("unavailable")
            override fun set(key: String, text: String): Unit = error("unavailable")
            override fun remove(key: String): Unit = error("unavailable")
        }
        assertEquals(ArtifactReview(), loadArtifactReview(storage, "key"))
        assertFalse(saveArtifactReview(storage, "key", ArtifactReview(overall = "Note")))
        assertFalse(saveArtifactReview(storage, "key", ArtifactReview()))
    }
    @Test fun `submission retries unchanged text and renews after accept`() {
        var ids = 0; val submission = ArtifactReviewSubmission { "id-${++ids}" }
        assertEquals("id-1", submission.requestIdFor("review")); assertEquals("id-1", submission.requestIdFor("review"))
        assertEquals("id-2", submission.requestIdFor("edit")); submission.accepted(); assertEquals("id-3", submission.requestIdFor("edit"))
    }
    @Test fun `task reviews go to main other reviews stay in source chat`() {
        assertNull(reviewThreadId("T1", "thread")); assertEquals("thread", reviewThreadId(null, "thread")); assertNull(reviewThreadId(null, null))
    }
    @Test fun `draft append preserves quotes task and attachments`() {
        val draft = DraftContent(text = "Existing", taskId = "T2", quotes = listOf("A quote"), attachments = listOf(DraftAttachment("image", "image/png", 12)))
        val appended = appendReviewDraft(draft, "Review", "T1")
        assertEquals("Existing\n\nReview", appended.text); assertEquals("T1", appended.taskId)
        assertEquals(draft.quotes, appended.quotes); assertEquals(draft.attachments, appended.attachments)
        assertEquals("T2", appendReviewDraft(draft, "Review", null).taskId)
        assertEquals("Review", appendReviewDraft(draft.copy(text = ""), "Review", null).text)
    }
    @Test fun `native paragraphs carry preceding headings`() {
        val paragraphs = artifactReviewParagraphs("# Title\n\nFirst\n\n## Section\n\nSecond\nline")
        assertEquals(listOf("First", "Second\nline"), paragraphs.map { it.text })
        assertEquals(listOf("Title", "Section"), paragraphs.map { it.section }); assertTrue(paragraphs.all { it.block == "paragraph" })
    }
    @Test fun `in flight reviews cannot collect comments that an acknowledgement would clear`() {
        val state = ArtifactReviewState(MemoryStorage(), "key")
        state.update(ArtifactReview(listOf(ReviewComment("q", intent = "Keep"))))
        state.sending = true
        state.comment(ArtifactSelection("New quote"))
        assertNull(state.selection); assertEquals(1, state.review.comments.size); assertTrue(state.tray)
        assertEquals("1 comment", reviewCommentCount(1)); assertEquals("2 comments", reviewCommentCount(2))
    }
    @Test fun `page picking has no outbound transport or permission changes`() {
        assertFalse(ARTIFACT_REVIEW_READ.contains("postMessage")); assertFalse(ARTIFACT_REVIEW_READ.contains("location.href"))
        assertTrue(ARTIFACT_REVIEW_PICK.contains("picking=true")); assertTrue(ARTIFACT_REVIEW_CANCEL_PICK.contains("picking=false"))
    }
}
