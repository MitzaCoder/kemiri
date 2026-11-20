package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.features.tasks.ReportSectionKind
import io.github.mitzacoder.kemiri.features.tasks.ReportSectionViewEntry
import io.github.mitzacoder.kemiri.features.tasks.reportSectionViewEntry
import io.github.mitzacoder.kemiri.protocol.Artifact
import io.github.mitzacoder.kemiri.protocol.ArtifactVersion
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Test

class ReportSectionViewTest {
    private val reportViews = Json.parseToJsonElement("""{"results":{"artifactId":"table","version":2,"label":"Open comparison table"}}""")
    private val pinned = ArtifactVersion("table~2", "project", "table.html", null, null, "text", "text/html", 42, null, "main", null, "T1", sourcePath = "", createdAt = "", version = 2)
    private val latest = Artifact("table", "project", "table.html", null, null, "text", "text/html", 45, null, "main", null, "T1", sourcePath = "", createdAt = "", version = 3, versions = listOf(pinned))
    private fun entry(artifacts: List<Artifact>, supported: Boolean = true, section: ReportSectionKind = ReportSectionKind.Results) =
        reportSectionViewEntry(supported, reportViews, section, "project", "T1", artifacts)

    @Test fun noAttachmentOrFeatureHidesEntry() {
        assertEquals(ReportSectionViewEntry.Hidden, entry(listOf(latest), section = ReportSectionKind.NotDone))
        assertEquals(ReportSectionViewEntry.Hidden, entry(listOf(latest), supported = false))
    }

    @Test fun retainedPinOpensFileWithExactAddress() {
        val file = entry(listOf(latest)) as ReportSectionViewEntry.File
        assertEquals("Open comparison table", file.label)
        assertEquals("table~2", file.artifact.id)
        assertEquals(42L, file.artifact.size)
    }

    @Test fun missingUnsupportedOrOversizedPinNeverUsesLatest() {
        assertEquals(ReportSectionViewEntry.Unavailable, entry(emptyList()))
        assertEquals(ReportSectionViewEntry.Unavailable, entry(listOf(latest.copy(versions = null))))
        assertEquals(ReportSectionViewEntry.Unavailable, entry(listOf(latest.copy(versions = listOf(pinned.copy(mimeType = "text/plain"))))))
        assertEquals(ReportSectionViewEntry.Unavailable, entry(listOf(latest.copy(versions = listOf(pinned.copy(size = 262145))))))
    }
}
