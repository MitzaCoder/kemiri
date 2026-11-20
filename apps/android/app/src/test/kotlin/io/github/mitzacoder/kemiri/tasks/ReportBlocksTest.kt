package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.features.tasks.media.automaticReportProof
import io.github.mitzacoder.kemiri.features.tasks.media.reportProofArtifact
import io.github.mitzacoder.kemiri.protocol.Artifact
import io.github.mitzacoder.kemiri.protocol.ArtifactVersion
import io.github.mitzacoder.kemiri.protocol.BoardTaskReport
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class ReportBlocksTest {
    private val mirrors = BoardTaskReport(now = "", results = "Results mirror", next = "Next mirror",
        revision = 1L, updatedAt = null, updatedBy = null, summary = "Summary mirror", notDone = "Not done mirror", steps = "Steps mirror")
    private fun report(blocks: String) = mirrors.copy(blocks = Json.parseToJsonElement(blocks))
    private fun blocks(report: BoardTaskReport, section: ReportSectionKind) =
        (readReportSection(report, section) as ReportSectionContent.Blocks).blocks

    @Test fun decodesEveryKindInSourceOrderWithoutItsMirror() {
        val report = report("""{
            "summary":[{"kind":"outcome","text":"The **desk** is open."}],
            "results":[
                {"kind":"markdown","text":"# Prior notes\n\nExisting text."},
                {"kind":"finding","title":"Names match","text":"The names on both signs match."},
                {"kind":"setup","title":"Morning","facts":[{"label":"Site","value":"Linden Hall"},{"label":"Desk","value":"East doors"}]},
                {"kind":"proof","text":"The replay shows the handoff.","artifactRef":{"artifactId":"booking-replay","version":2}},
                {"kind":"cleanup","text":"The team removed the test slips."},
                {"kind":"risk","title":"Small group","text":"The team has not tested with a crowd."},
                {"kind":"metric","label":"Wait","value":12.5,"unit":"seconds","context":"One *morning* session."}
            ],
            "notDone":[{"kind":"risk","title":"Late arrivals","text":"The team has not tested the side door."}],
            "next":[{"kind":"nextAction","text":"The clerk will check the [map](https://example.test/map)."}],
            "steps":[{"kind":"step","text":"Print the sign."}]
        }""")
        assertEquals(listOf(ReportBlock.Outcome("The **desk** is open.")), blocks(report, ReportSectionKind.Summary))
        assertEquals(listOf(
            ReportBlock.Markdown("# Prior notes\n\nExisting text."),
            ReportBlock.Finding("Names match", "The names on both signs match."),
            ReportBlock.Setup("Morning", listOf(ReportBlock.Setup.Fact("Site", "Linden Hall"), ReportBlock.Setup.Fact("Desk", "East doors"))),
            ReportBlock.Proof("The replay shows the handoff.", ReportBlock.Proof.ArtifactRef("booking-replay", 2L)),
            ReportBlock.Cleanup("The team removed the test slips."),
            ReportBlock.Risk("Small group", "The team has not tested with a crowd."),
            ReportBlock.Metric("Wait", 12.5, "seconds", "One *morning* session."),
        ), blocks(report, ReportSectionKind.Results))
        assertEquals(listOf(ReportBlock.Risk("Late arrivals", "The team has not tested the side door.")), blocks(report, ReportSectionKind.NotDone))
        assertEquals(listOf(ReportBlock.NextAction("The clerk will check the [map](https://example.test/map).")), blocks(report, ReportSectionKind.Next))
        assertEquals(listOf(ReportBlock.Step("Print the sign.", null, null)), blocks(report, ReportSectionKind.Steps))
        assertEquals(ReportGlance("The desk is open.", listOf(ReportBlock.Metric("Wait", 12.5, "seconds", "One morning session.")),
            listOf("Names match"), listOf("Small group", "Late arrivals"), "The clerk will check the map."), reportGlance(report))
    }

    @Test fun unknownOrMalformedBlocksReplaceTheEntireSectionWithItsMirror() {
        val invalidBlocks = listOf(
            """{"kind":"futureKind","text":"Do not show this."}""",
            """{"kind":"finding","title":"Missing its body"}""",
            """{"kind":"setup","title":"Morning","facts":[{"label":"Site","value":42}]}""",
            """{"kind":"setup","title":"Morning","facts":[]}""",
            """{"kind":"proof","text":"Replay.","artifactRef":{"artifactId":"replay~1"}}""",
            """{"kind":"proof","text":"Replay.","artifactRef":{"artifactId":"replay","version":1.5}}""",
            """{"kind":"metric","label":"Wait","value":1e309}""",
            """{"kind":"metric","label":"Wait","value":"5"}""",
            """{"kind":"metric","label":"Wait","value":5,"unit":null}""",
            """{"kind":"step","text":"Do not allow steps in Results."}""",
            """{"kind":"outcome","text":"  "}""",
            """{"kind":"outcome","text":"Two\nlines"}""",
            """{"kind":"outcome","text":"# Not inline"}""",
            """{"kind":"outcome","text":"Broken [link](javascript:alert(1))."}""",
            """{"kind":"outcome","text":"Use <em>a tag</em>."}""",
            """{"kind":"outcome","text":"Image: ![Map](https://example.test/map.png)."}""",
            """{"kind":"outcome","text":"A [signed link](https://example.test/artifacts/replay?token=synthetic)."}""",
            """{"kind":"outcome","text":"No extra fields.","extra":true}""",
            "null", "42", "[]",
        )
        for (invalid in invalidBlocks) {
            val report = report("""{"results":[{"kind":"outcome","text":"Never show a partial list."},$invalid],"next":[{"kind":"nextAction","text":"The clerk will check."}]}""")
            assertEquals(invalid, ReportSectionContent.Mirror(mirrors.results), readReportSection(report, ReportSectionKind.Results))
            assertEquals(listOf(ReportBlock.NextAction("The clerk will check.")), blocks(report, ReportSectionKind.Next))
        }
    }

    @Test fun absentEmptyOrInvalidPayloadDoesNotBreakTheBaseReport() {
        val raw = """{"now":"","results":"Results mirror","next":"Next mirror","revision":1,"updatedAt":null,"updatedBy":null,"blocks":"new envelope"}"""
        val opaque = Json.decodeFromString<BoardTaskReport>(raw)
        for (report in listOf(opaque, mirrors, report("[]"), report("null"), report("""{"results":[],"summary":42}"""))) {
            assertEquals(ReportSectionContent.Mirror(mirrors.results), readReportSection(report, ReportSectionKind.Results))
        }
        assertFalse(readReportSection(mirrors.copy(steps = " \n"), ReportSectionKind.Steps).hasContent)
        assertEquals(ReportSectionContent.Mirror(mirrors.summary.orEmpty()), readReportSection(report("""{"summary":[${List(3) { """{"kind":"outcome","text":"Ready."}""" }.joinToString()}]}"""), ReportSectionKind.Summary))
    }

    @Test fun keepsEveryCopyCharacterIncludingWhitespaceAndFenceLikeText() {
        val command = "  printf 'Ready'\r\n\tsecond line\n```\n\n"
        val encoded = Json.encodeToString(command)
        val report = report("""{"steps":[{"kind":"step","text":"Make a sign.","copyText":$encoded,"language":"sh"}]}""")
        assertEquals(ReportBlock.Step("Make a sign.", command, "sh"), blocks(report, ReportSectionKind.Steps).single())
    }

    @Test fun typedNextStaysOutsideReviewEvenWhenItNeedsItsMirror() {
        assertEquals(ReportNextPlacement.Review, reportNextPlacement(mirrors, review = true))
        assertEquals(ReportNextPlacement.Next, reportNextPlacement(mirrors, review = false))
        assertNull(reportNextPlacement(mirrors.copy(next = ""), review = true))
        assertEquals(ReportNextPlacement.Review, reportNextPlacement(report("""{"next":[]}"""), review = true))
        for (payload in listOf("""[{"kind":"nextAction","text":"The clerk will check."}]""", """[{"kind":"futureKind"}]""", "42")) {
            assertEquals(ReportNextPlacement.Next, reportNextPlacement(report("""{"next":$payload}"""), review = true))
        }
    }

    @Test fun legacyGlanceSkipsCodeAndDoesNotInventMetricsOrTitles() {
        val legacy = mirrors.copy(summary = " ", results = "```\nNot the lead\n```\n\n- **Ready** at the east doors.\n- Another fact.",
            next = "### Check the desk\n\nDetails below.")
        assertEquals(ReportGlance("Ready at the east doors.", emptyList(), emptyList(), emptyList(), "Check the desk", "Not done mirror"), reportGlance(legacy))
        val typedOutcome = report("""{"results":[{"kind":"outcome","text":"The east doors are open."}]}""").copy(summary = "")
        assertEquals("The east doors are open.", reportGlance(typedOutcome).firstOutcome)
    }

    private fun artifact(id: String, kind: String = "image", version: Long? = null) = Artifact(
        id, "project", "replay.png", "Booking replay", null, kind, "image/png", 1, null,
        "main", null, "task", sourcePath = "replay.png", createdAt = "2026-01-01T00:00:00Z", version = version,
    )

    @Test fun proofDedupRunsBeforeTheCapAndOnlyForRenderableResults() {
        val proof = """{"kind":"proof","text":"The replay shows the handoff.","artifactRef":{"artifactId":"a","version":1}}"""
        val artifacts = listOf(artifact("a", version = 2L), artifact("b"), artifact("c", "video"), artifact("d"), artifact("e", "file"))
        val rendered = readReportSection(report("""{"results":[$proof]}"""), ReportSectionKind.Results)
        assertEquals(listOf("b", "c", "d"), automaticReportProof(rendered, artifacts).map { it.id })
        val fallback = readReportSection(report("""{"results":[$proof,{"kind":"unknown"}]}"""), ReportSectionKind.Results)
        assertEquals(listOf("a", "b", "c"), automaticReportProof(fallback, artifacts).map { it.id })
        assertEquals(5, artifacts.size)
    }

    @Test fun proofOpensThePinnedVersionRatherThanLatest() {
        val latest = artifact("a", version = 2L)
        val old = ArtifactVersion("a~1", latest.projectId, "old.png", "Earlier replay", null, latest.kind,
            latest.mimeType, latest.size, null, latest.threadId, null, latest.taskId, sourcePath = latest.sourcePath, createdAt = latest.createdAt, version = 1L)
        assertEquals(latest, reportProofArtifact(ReportBlock.Proof.ArtifactRef("a", null), listOf(latest)))
        assertNull(reportProofArtifact(ReportBlock.Proof.ArtifactRef("a", 1L), listOf(latest)))
        assertEquals("a~2", reportProofArtifact(ReportBlock.Proof.ArtifactRef("a", 2L), listOf(latest))?.id)
        assertEquals("Earlier replay", reportProofArtifact(ReportBlock.Proof.ArtifactRef("a", 1L), listOf(latest.copy(versions = listOf(old))))?.title)
    }
}
