package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.data.wireJson
import io.github.mitzacoder.kemiri.features.tasks.LabeledReportRow
import io.github.mitzacoder.kemiri.features.tasks.LegacyReportSection
import io.github.mitzacoder.kemiri.features.tasks.LegacyReportSegment
import io.github.mitzacoder.kemiri.features.tasks.shapeLegacyReport
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

class ReportLegacyShapeTest {
    @Test fun matchesEverySharedWebFixture() {
        val file = generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .map { it.resolve("packages/protocol/test-vectors/report-legacy-shape-v1.json") }
            .first { it.isFile }
        for (fixture in wireJson.parseToJsonElement(file.readText()).jsonArray.map { it.jsonObject }) {
            val section = when (val name = fixture.text("section")) {
                "results" -> LegacyReportSection.Results
                "notDone" -> LegacyReportSection.NotDone
                "next" -> LegacyReportSection.Next
                else -> error("Unknown report section: $name")
            }
            val expected = fixture.getValue("expected").jsonArray.map { it.jsonObject.segment() }
            assertEquals(fixture.text("name"), expected, shapeLegacyReport(section, fixture.text("markdown")))
        }
    }

    private fun JsonObject.text(key: String) = getValue(key).jsonPrimitive.content

    private fun JsonObject.segment(): LegacyReportSegment = when (val kind = text("kind")) {
        "markdown" -> LegacyReportSegment.Markdown(text("source"))
        "rows" -> LegacyReportSegment.Rows(getValue("items").jsonArray.map { it.jsonPrimitive.content })
        "labeled" -> LegacyReportSegment.Labeled(getValue("rows").jsonArray.map {
            LabeledReportRow(it.jsonObject.text("label"), it.jsonObject.text("value"))
        })
        else -> error("Unknown report segment: $kind")
    }
}
