package io.github.mitzacoder.kemiri.changes

import io.github.mitzacoder.kemiri.features.changes.*
import io.github.mitzacoder.kemiri.features.chat.ReviewStorage
import io.github.mitzacoder.kemiri.protocol.*
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import kotlin.random.Random

class ChangesTest {
    @Serializable private data class ReviewCase(val source: CodeReviewSource, val review: CodeReview, val expected: String)
    private class MemoryStorage : ReviewStorage {
        val records = mutableMapOf<String, String>()
        override fun get(key: String) = records[key]
        override fun set(key: String, text: String) { records[key] = text }
        override fun remove(key: String) { records.remove(key) }
    }
    private val task = CodeReviewSource("task", taskId = "T12")
    private val hash = "a".repeat(40)
    private val other = "b".repeat(40)
    private val rows = listOf(hash, other).map { ChangeCommit(it, "Adjust bakery hours", "Example", "2026-01-01T00:00:00Z", false) }
    private fun listing(contiguous: Boolean, reason: String? = null) = ChangesListResponse(id = "r", commits = rows, files = emptyList(), truncated = false,
        contiguous = contiguous, nonContiguousReason = reason)
    private fun comment() = CodeComment("one", task, CodeAnchor("src/hours.ts", "after", 2, 2, "hours"), note = "Check this")

    @Test fun `web code review fixture is byte identical without copying it`() {
        val fixture = File("../../../packages/protocol/test-vectors/code-review.json")
        val examples = Json.decodeFromString<List<ReviewCase>>(fixture.readText())
        assertTrue(examples.size >= 2)
        for (example in examples) assertArrayEquals(example.expected.toByteArray(), formatCodeReview(example.source, example.review).toByteArray())
    }
    @Test fun `optional true flags are absent on a plain text response and remain present on a fallback`() {
        val text = Json.decodeFromString<ChangesFileResponse>("""{"type":"changes.file","id":"r","after":{"text":"hours","hash":"$hash"}}""")
        assertNull(text.binary); assertNull(text.tooLarge); assertNull(text.sensitive); assertNull(text.patchTruncated)
        val patch = Json.decodeFromString<ChangesFileResponse>("""{"type":"changes.file","id":"r","tooLarge":true,"patch":"patch","patchTruncated":true}""")
        assertEquals(true, patch.tooLarge); assertEquals(true, patch.patchTruncated); assertNull(patch.binary)
    }
    @Test fun `commit picker permits combined ranges only for contiguous commits`() {
        assertEquals(CommitPicker(true, null, null), commitPicker(listing(true), null))
        assertEquals(hash, commitPicker(listing(true), hash).hash)
        val broken = commitPicker(listing(false, "not-first-parent-chain"), "missing")
        assertFalse(broken.allowAll); assertEquals(other, broken.hash); assertTrue(broken.reason!!.contains("one at a time"))
        assertFalse(commitPicker(listing(true).copy(commits = emptyList()), null).allowAll)
    }
    @Test fun `files keep folder order and renamed files use their destination`() {
        val renamed = ChangedFile(path = "src/hours.ts", previousPath = "old/hours.ts", status = "renamed", additions = 12, deletions = 4, binary = false)
        val files = listOf(renamed, renamed.copy(path = "README.md"), renamed.copy(path = "src/menu.ts"))
        assertEquals(listOf("src", ""), groupChangedFiles(files).keys.toList())
        assertEquals(listOf("src/hours.ts", "src/menu.ts"), groupChangedFiles(files).getValue("src").map { it.path })
        assertEquals("3 files · +36 −12", changeCounts(files).label())
    }
    @Test fun `Viewed keys scope the exact range and persist at most five hundred marks`() {
        val storage = MemoryStorage()
        val model = ViewedChanges(storage)
        val first = viewedChangeKey("backend", "bakery", task, listing(true), "hours.ts")
        assertNotEquals(first, viewedChangeKey("backend", "bakery", task, listing(true).copy(commits = rows.take(1)), "hours.ts"))
        assertNotEquals(first, viewedChangeKey("backend", "elsewhere", task, listing(true), "hours.ts"))
        val entries = (1..501).map { it.toString(16).padStart(64, '0') }
        var marked = emptySet<String>()
        entries.forEach { marked = model.set(marked, it, true) }
        assertEquals(500, marked.size); assertFalse(entries.first() in marked)
        assertEquals(marked, ViewedChanges(storage).load())
        assertFalse(entries.last() in model.set(marked, entries.last(), false))
    }
    @Test fun `diff pairs replacement words keeps source line numbers and folds context except pins`() {
        val before = (1..26).map { "line $it" }.toMutableList().apply { this[12] = "open at nine" }
        val after = before.toMutableList().apply { this[12] = "open at eight" }
        val diff = changeDiff(before.joinToString("\n"), after.joinToString("\n"))
        assertEquals(listOf("−", "+"), diff.lines.filterNot { it.unchanged }.map { it.sign })
        assertEquals(listOf(13, 13), diff.lines.filterNot { it.unchanged }.map { it.number })
        assertEquals(listOf(8..11), diff.wordMarks[12]); assertEquals(listOf(8..12), diff.wordMarks[13])
        val bands = diffBands(diff.lines, setOf(4))
        assertTrue(bands.any { it.folded }); assertTrue(bands.any { !it.folded && it.start == 4 })
        assertEquals(diff.lines.indices.toList(), bands.flatMap { (it.start until it.endExclusive).toList() })
    }
    @Test fun `bounded diff preserves both documents and aligns a shortest edit path for small inputs`() {
        val random = Random(12)
        repeat(250) {
            val old = List(random.nextInt(1, 20)) { random.nextInt(4).toString() }
            val new = List(random.nextInt(1, 20)) { random.nextInt(4).toString() }
            val lcs = Array(old.size + 1) { IntArray(new.size + 1) }
            for (a in old.indices) for (b in new.indices) lcs[a + 1][b + 1] = if (old[a] == new[b]) 1 + lcs[a][b] else maxOf(lcs[a + 1][b], lcs[a][b + 1])
            val diff = changeDiff(old.joinToString("\n"), new.joinToString("\n"))
            assertFalse(diff.approximate)
            assertEquals(old, diff.lines.filter { it.before != null }.map { it.text })
            assertEquals(new, diff.lines.filter { it.after != null }.map { it.text })
            assertEquals(lcs.last().last(), diff.lines.count { it.unchanged })
        }
        assertTrue(changeDiff(List(300) { "old $it" }.joinToString("\n"), List(300) { "new $it" }.joinToString("\n")).approximate)
    }
    @Test fun `exact ranges keep indentation move on a unique match and flag ambiguity or disappearance`() {
        val quote = anchorCodeLines(codeLines("start\r\n  hours\r\n\tmenu\r\nend"), "src/hours.ts", "after", 2, 3)!!
        assertEquals("  hours\n\tmenu", quote.quotedText)
        assertEquals(3, reanchorCodeLines(codeLines("new\nstart\n  hours\n\tmenu\nend"), quote)?.startLine)
        assertNull(reanchorCodeLines(codeLines("hours\nother\nhours"), comment().anchor))
        assertNull(anchorCodeLines(listOf("x".repeat(4001)), "file", "after", 1, 1))
        val outdated = reconcileCodeComments(listOf(comment()), task, "src/hours.ts", null, emptyList(), listOf("unrelated")).single()
        assertTrue(outdated.outdated)
        val renamed = reconcileCodeComments(listOf(outdated), task, "src/new.ts", "src/hours.ts", emptyList(), listOf("hours")).single()
        assertEquals("src/new.ts", renamed.anchor.path); assertEquals(1, renamed.anchor.startLine); assertFalse(renamed.outdated)
    }
    @Test fun `accepted reviews clear storage and uncertain sends retain their retry id across reload`() {
        val storage = MemoryStorage()
        val key = codeReviewKey("backend", "bakery", "T12")
        val review = CodeReview(listOf(comment()), "Overall")
        val formatted = formatCodeReview(task, review)
        val first = codeReviewAttempt(null, formatted) { "first" }
        assertTrue(saveCodeReview(storage, key, review.copy(attempt = first)))
        assertEquals(first, codeReviewAttempt(loadCodeReview(storage, key).attempt, formatted) { "wrong" })
        assertEquals("next", codeReviewAttempt(first, "New note") { "next" }.requestId)
        assertFalse(codeReviewFits(review.copy(comments = List(41) { comment() })))
        assertTrue(saveCodeReview(storage, key, CodeReview())); assertNull(storage.get(key))
    }
}
