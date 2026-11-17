package io.github.mitzacoder.kemiri.features.chat

import io.github.mitzacoder.kemiri.protocol.Artifact
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class ArtifactPageThumbTest {
    private val page = Artifact(id = "page", projectId = "p", name = "report.HTML", title = null, note = null, kind = "text",
        mimeType = "application/octet-stream", size = 12, durationSeconds = null, threadId = "main", workerId = null,
        taskId = "T1", sourcePath = "", createdAt = "")

    @Test fun pagesComeFirstWithoutReorderingEitherGroup() {
        val text = page.copy(id = "text", name = "notes.txt", mimeType = "text/plain")
        val image = page.copy(id = "image", name = "image.png", mimeType = "image/png", kind = "image")
        val mimePage = page.copy(id = "mime", name = "page", mimeType = "text/html; charset=utf-8")
        val source = listOf(text, page, image, mimePage)
        assertEquals(listOf("page", "mime", "text", "image"), pagesFirst(source).map { it.id })
        assertEquals("text", source.first().id)
    }

    @Test fun pageChipIsFirstAndNeverDoubleCountsTextInEitherGallery() {
        val text = page.copy(id = "text", kind = "text", name = "notes.txt", mimeType = "text/plain")
        val image = page.copy(id = "image", kind = "image", name = "image.png", mimeType = "image/png")
        val mimePage = page.copy(id = "mime", kind = "file", name = "page", mimeType = "application/xhtml+xml")
        val mixed = listOf(text, image, page, mimePage)
        val expected = listOf("page" to 2, "image" to 1, "text" to 1)
        assertEquals(expected, artifactKindCounts(mixed))
        assertEquals(expected, io.github.mitzacoder.kemiri.features.panels.panelArtifactKinds(mixed))
        assertEquals(listOf(page, mimePage), filterByKind(mixed, "page"))
        assertEquals(listOf(text), filterByKind(mixed, "text"))
        assertEquals(emptyList<Artifact>(), filterByKind(mixed, "file"))
        assertEquals(mixed, filterByKind(mixed, null))
        assertEquals("Page", artifactKindLabel("page"))
        assertEquals("Pages", artifactKindLabel("page", true))
        assertEquals("Page", io.github.mitzacoder.kemiri.features.panels.panelArtifactKindLabel("page"))
        assertEquals("Pages", io.github.mitzacoder.kemiri.features.panels.panelArtifactKindLabel("page", true))
        assertEquals(listOf("text", "file"), listOf(page.kind, mimePage.kind))
    }

    @Test fun thumbnailIsStricterThanTheViewerOnlyByDisablingScripts() {
        val policy = artifactPageThumbPolicy()
        assertFalse(policy.javaScript)
        assertEquals(artifactPagePolicy(), policy.copy(javaScript = true))
        assertEquals(1024 * 1024, PAGE_PREVIEW_BYTES)
    }

    @Test fun webViewsAreBoundedOriginlessNonInteractiveAndDestroyedWhenHidden() {
        val source = File("src/main/kotlin/io/github/mitzacoder/kemiri/features/chat/ArtifactPageThumb.kt").readText()
        assertTrue(source.contains("Semaphore(2)"))
        assertTrue(source.contains("if (!visible || connection.status"))
        assertTrue(source.contains("boundsInWindow()"))
        assertTrue(source.contains("loadDataWithBaseURL(null, document"))
        assertTrue(source.contains("artifactThemeTokens(colors), blockRequests, false"))
        assertTrue(source.contains("view.destroy()"))
        assertTrue(source.contains("continuation.invokeOnCancellation { call.cancel() }"))
        assertTrue(source.contains("IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS"))
        assertFalse(source.contains("addJavascriptInterface"))
    }
}
