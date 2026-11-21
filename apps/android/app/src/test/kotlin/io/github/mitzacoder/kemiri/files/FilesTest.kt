package io.github.mitzacoder.kemiri.files

import io.github.mitzacoder.kemiri.data.TimeFormat
import io.github.mitzacoder.kemiri.data.localizedTimeFormatter
import io.github.mitzacoder.kemiri.features.changes.*
import io.github.mitzacoder.kemiri.features.files.*
import io.github.mitzacoder.kemiri.navigation.BackStack
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.protocol.*
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import java.time.ZoneId
import java.util.Locale

class FilesTest {
    private val chat = Destination.Chat("sample", "bakery", threadId = "stock")
    private val project = CodeRootProject()
    private val worker = CodeRootWorker(workerId = "fern")
    private val thread = CodeRootThread(threadId = "stock")

    @Test fun `opening a search result and drilling into folders preserves Back history`() {
        val root = Destination.Files(chat, root = worker, taskId = "T12")
        val folder = root.browse("docs/recipes")
        val file = folder.open("src/hours.ts", 24)
        val trail = BackStack().push(chat).push(root).push(folder).push(file)
        assertEquals(folder, Json.decodeFromString<BackStack>(Json.encodeToString(trail)).back().current)
        assertEquals(24, file.line)
        assertEquals("src", file.folder)
        assertEquals("T12", file.switchRoot(project).taskId)
        assertEquals("", file.switchRoot(project).folder)
        assertNull(file.switchRoot(project).path)
        assertEquals(listOf("Root" to "", "docs" to "docs", "recipes" to "docs/recipes"), checkoutBreadcrumb(folder.folder))
    }

    @Test fun `root picker lists project then isolated workers and background checkouts`() {
        val isolated = Json.decodeFromString<WorkerSummary>("""{"id":"fern","title":"Bake a sample","status":"done","model":{"provider":"faux","modelId":"faux-1"},"thinkingLevel":null,"isolation":"workspace","workspacePath":"/example/scratch","conversationId":42,"spawnedByCallId":null,"createdAt":"","updatedAt":"","lastReport":null,"failure":null}""")
        val job = Json.decodeFromString<ThreadSummary>("""{"id":"stock","title":"Count supplies","status":"done","main":false,"startedBy":"main","scheduleId":null,"conversationId":43,"model":null,"thinkingLevel":null,"onFinish":"record","runningWorkers":0,"ownedTasks":[],"openQuestions":0,"current":null,"summary":null,"failure":null,"createdAt":"","updatedAt":"","finishedAt":null,"archived":false}""")
        val choices = checkoutChoices(listOf(isolated, isolated.copy(id = "removed", workspacePath = null), isolated.copy(id = "shared", isolation = "shared")),
            listOf(job, job.copy(id = "archived", archived = true), job.copy(id = "main", main = true)))
        assertEquals(listOf(project, worker, thread), choices.map { it.root })
        assertEquals(worker, preferredCheckout(isolated, job.id))
        assertEquals(thread, preferredCheckout(null, job.id))
        assertEquals(project, preferredCheckout(null, "main"))
    }

    @Test fun `search keys ignore blank input and keep delayed results scoped to checkout and query`() {
        assertNull(fileSearchKey(project, "   "))
        assertEquals(FileSearchRequestKey(project, "bread"), fileSearchKey(project, " bread "))
        assertNotEquals(fileSearchKey(project, "bread"), fileSearchKey(worker, "bread"))
        assertNotEquals(fileSearchKey(project, "bread"), fileSearchKey(project, "rolls"))
        assertEquals(256, searchFileQuery("a".repeat(400))?.length)
    }

    @Test fun `tool paths are made relative only to the known checkout`() {
        assertEquals("src/hours.ts", pathInCheckout("/example/work/src/hours.ts", "/example/work"))
        assertEquals("src/hours.ts", pathInCheckout("./src/hours.ts", null))
        for (path in listOf("../outside", "/example/work-other/foo", ".git/config", "vendor/.JJ/store", "src//menu", "C:/other/file")) {
            assertNull(path, pathInCheckout(path, "/example/work"))
        }
    }

    @Test fun `sensitive binary and oversized states do not render text`() {
        val file = FilesReadResponse(id = "read", size = 2_097_152, modifiedAt = "", text = "sample", hash = "a".repeat(64))
        assertEquals(CheckoutFile.Sensitive, checkoutFile(file.copy(sensitive = true)))
        assertEquals(CheckoutFile.Binary("image/example"), checkoutFile(file.copy(binary = true, mimeType = "image/example")))
        assertEquals(CheckoutFile.TooLarge(file.size), checkoutFile(file.copy(tooLarge = true)))
        assertEquals("2.0 MiB", fileBytes(file.size))
        assertEquals(CheckoutFile.Text("sample", "a".repeat(64)), checkoutFile(file))
        assertEquals(CheckoutFile.Unavailable, checkoutFile(file.copy(text = null)))
    }

    @Test fun `working header shows base and read time and refresh retains only an existing file`() {
        val file = ChangedFile(path = "src/hours.ts", status = "modified", additions = 2, deletions = 1, binary = false)
        val listing = ChangesListResponse(id = "list", commits = emptyList(), files = listOf(file), truncated = false,
            baseCommit = "d".repeat(40), readAt = "2026-01-01T20:07:29.233Z")
        fun clock(choice: TimeFormat) = localizedTimeFormatter(locale = Locale.US, choice = choice)
            .withZone(ZoneId.of("Europe/Paris"))
        val hour24 = clock(TimeFormat.Hour24)
        val hour12 = clock(TimeFormat.Hour12)
        assertEquals(listOf("1 file · +2 −1", "against dddddddd · as of 21:07"), workingChangeMetadata(listing, hour24))
        assertEquals("against dddddddd · as of 09:07 PM", workingChangeMetadata(listing, hour12).last().replace('\u202f', ' ').replace('\u00a0', ' '))
        assertEquals("against empty base", workingChangeMetadata(listing.copy(baseCommit = null, readAt = null), hour24).last())
        assertEquals("against dddddddd", workingChangeMetadata(listing.copy(readAt = "unavailable"), hour24).last())
        val another = file.copy(path = "docs/menu.md")
        assertEquals(file, selectChangedFile(listOf(another, file), file.path))
        assertEquals(another, selectChangedFile(listOf(another), file.path))
        assertNull(selectChangedFile(emptyList(), file.path))
        assertEquals(worker, ChangeRequestSourceWorking(root = worker).root)
    }

    @Test fun `file review uses the web header and marks ambiguous or removed quotes outdated`() {
        val old = CodeReviewSource("file", root = "project", path = "menu.md", hash = "a".repeat(64))
        val source = old.copy(hash = "b".repeat(64))
        val comment = CodeComment("one", old, CodeAnchor("menu.md", "file", 1, 1, "Bread"), note = "Fresh daily?")
        val updated = reconcileFileComments(listOf(comment), source, listOf("Menu", "Bread")).single()
        assertEquals(2, updated.anchor.startLine)
        assertFalse(updated.outdated)
        assertEquals("Code review (file project/menu.md@${source.hash})\n\n1. Note · menu.md · file line 2\n> Bread\n\nFresh daily?",
            formatCodeReview(source, CodeReview(listOf(updated))))
        assertTrue(reconcileFileComments(listOf(comment), source, listOf("Rolls")).single().outdated)
    }
}
