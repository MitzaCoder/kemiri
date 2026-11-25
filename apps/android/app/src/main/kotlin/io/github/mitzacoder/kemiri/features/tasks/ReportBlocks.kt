package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import io.github.mitzacoder.kemiri.protocol.BoardTaskReport
import kotlinx.serialization.json.*
import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.node.*
import org.commonmark.parser.Parser

internal enum class ReportSectionKind(val wireKey: String) {
    Summary("summary"), Results("results"), NotDone("notDone"), Next("next"), Steps("steps");

    fun mirror(report: BoardTaskReport): String = when (this) {
        Summary -> report.summary.orEmpty()
        Results -> report.results
        NotDone -> report.notDone.orEmpty()
        Next -> report.next
        Steps -> report.steps.orEmpty()
    }
}

internal sealed interface ReportBlock {
    data class Outcome(val text: String) : ReportBlock
    data class Finding(val title: String, val text: String) : ReportBlock
    data class Setup(val title: String, val facts: List<Fact>) : ReportBlock {
        data class Fact(val label: String, val value: String)
    }
    data class Proof(val text: String, val artifactRef: ArtifactRef) : ReportBlock {
        data class ArtifactRef(val artifactId: String, val version: Long?)
    }
    data class Cleanup(val text: String) : ReportBlock
    data class Risk(val title: String, val text: String) : ReportBlock
    data class Metric(val label: String, val value: Double, val unit: String?, val context: String?) : ReportBlock
    data class Step(val text: String, val copyText: String?, val language: String?) : ReportBlock
    data class NextAction(val text: String) : ReportBlock
    data class Markdown(val text: String) : ReportBlock
}

internal sealed interface ReportSectionContent {
    data class Blocks(val blocks: List<ReportBlock>) : ReportSectionContent
    data class Mirror(val markdown: String) : ReportSectionContent

    val hasContent: Boolean get() = when (this) {
        is Blocks -> true
        is Mirror -> markdown.isNotBlank()
    }
}

private fun BoardTaskReport.sectionPayload(section: ReportSectionKind) = (blocks as? JsonObject)?.get(section.wireKey)

/** Read only the requested section. Never let a partial block list or a newer sibling replace readable text. */
internal fun readReportSection(report: BoardTaskReport, section: ReportSectionKind): ReportSectionContent =
    reportSectionContent(section, report.sectionPayload(section), section.mirror(report))

private fun reportSectionContent(section: ReportSectionKind, payload: JsonElement?, mirror: String): ReportSectionContent =
    decodeReportBlocks(payload, section)?.let(ReportSectionContent::Blocks) ?: ReportSectionContent.Mirror(mirror)

@Composable
internal fun rememberReportSection(report: BoardTaskReport, section: ReportSectionKind): ReportSectionContent {
    val payload = report.sectionPayload(section)
    val mirror = section.mirror(report)
    return remember(section, payload, mirror) { reportSectionContent(section, payload, mirror) }
}

internal data class ParsedTaskReport(val summary: ReportSectionContent, val results: ReportSectionContent,
    val notDone: ReportSectionContent, val next: ReportSectionContent, val steps: ReportSectionContent)

@Composable internal fun rememberParsedTaskReport(report: BoardTaskReport) = ParsedTaskReport(
    rememberReportSection(report, ReportSectionKind.Summary), rememberReportSection(report, ReportSectionKind.Results),
    rememberReportSection(report, ReportSectionKind.NotDone), rememberReportSection(report, ReportSectionKind.Next),
    rememberReportSection(report, ReportSectionKind.Steps),
)

private fun decodeReportBlocks(payload: JsonElement?, section: ReportSectionKind): List<ReportBlock>? {
    val blocks = payload as? JsonArray ?: return null
    if (blocks.size !in 1..(if (section == ReportSectionKind.Summary) 2 else 64)) return null
    return blocks.map { decodeReportBlock(it as? JsonObject ?: return null, section) ?: return null }
}

/** An unreadable typed Next is still meant for agents, not for the review check. */
internal fun hasTypedNext(report: BoardTaskReport): Boolean = when (val next = (report.blocks as? JsonObject)?.get("next")) {
    null, JsonNull -> false
    is JsonArray -> next.isNotEmpty()
    else -> true
}

internal enum class ReportNextPlacement { Next, Review }

internal fun reportNextPlacement(report: BoardTaskReport, review: Boolean, next: ReportSectionContent = readReportSection(report, ReportSectionKind.Next)): ReportNextPlacement? = when {
    !next.hasContent -> null
    review && !hasTypedNext(report) -> ReportNextPlacement.Review
    else -> ReportNextPlacement.Next
}

private val rawHtml = Regex("""<!--|<![A-Z]|</?[a-z][a-z0-9-]*(?=[\s/>])""", RegexOption.IGNORE_CASE)
private val signedArtifactUrl = Regex("""(?:/|%2f)artifacts(?:/|%2f)[^\s]*?(?:\?|%3f)[^\s]*?\btoken(?:=|%3d)""", RegexOption.IGNORE_CASE)
private val lineBreak = Regex("[\r\n\u2028\u2029]")
private val safeLink = Regex("^(https?://|mailto:)", RegexOption.IGNORE_CASE)
private val artifactId = Regex("[A-Za-z0-9_-]+")
private val languageName = Regex("[A-Za-z0-9_+.#-]+")
private const val MAX_SAFE_VERSION = 9_007_199_254_740_991L
internal val reportMarkdownParser: Parser = Parser.builder().extensions(listOf(TablesExtension.create())).build()

private fun JsonObject.string(key: String): String? = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
private fun JsonObject.line(key: String): String? = string(key)?.takeIf { it.isNotBlank() && !lineBreak.containsMatchIn(it) }
private fun JsonObject.literal(key: String): String? = line(key)?.takeUnless(rawHtml::containsMatchIn)
private fun JsonObject.prose(key: String): String? = line(key)?.takeIf(::isInlineReportProse)
private fun JsonObject.onlyFields(vararg fields: String): Boolean = keys.all { it in fields }
private fun JsonObject.blockFields(vararg fields: String): Boolean = onlyFields("kind", *fields)
private fun JsonObject.number(key: String): Double? =
    (get(key) as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull?.takeIf(Double::isFinite)

private fun isInlineReportProse(text: String): Boolean {
    val paragraph = reportMarkdownParser.parse(text.trim()).firstChild as? Paragraph ?: return false
    if (paragraph.next != null) return false
    fun isSafe(node: Node): Boolean {
        when (node) {
            is Link -> if (!safeLink.containsMatchIn(node.destination)) return false
            is Paragraph, is Text, is Code, is Emphasis, is StrongEmphasis -> Unit
            else -> return false
        }
        return generateSequence(node.firstChild) { it.next }.all(::isSafe)
    }
    return isSafe(paragraph)
}

private fun decodeReportBlock(block: JsonObject, section: ReportSectionKind): ReportBlock? = with(block) {
    val kind = string("kind") ?: return null
    val allowed = when (section) {
        ReportSectionKind.Summary -> kind == "outcome"
        ReportSectionKind.Results -> kind in setOf("outcome", "finding", "setup", "proof", "cleanup", "risk", "metric", "markdown")
        ReportSectionKind.NotDone -> kind == "risk"
        ReportSectionKind.Next -> kind == "nextAction"
        ReportSectionKind.Steps -> kind == "step"
    }
    if (!allowed || kind != "markdown" && signedArtifactUrl.containsMatchIn(toString())) return null
    when (kind) {
        "outcome" -> if (blockFields("text")) ReportBlock.Outcome(prose("text") ?: return null) else null
        "finding" -> if (blockFields("title", "text")) ReportBlock.Finding(literal("title") ?: return null, prose("text") ?: return null) else null
        "setup" -> {
            if (!blockFields("title", "facts")) return null
            val title = literal("title") ?: return null
            val facts = (get("facts") as? JsonArray)?.takeIf { it.size in 1..8 } ?: return null
            ReportBlock.Setup(title, facts.map { fact ->
                val pair = fact as? JsonObject ?: return null
                if (!pair.onlyFields("label", "value")) return null
                ReportBlock.Setup.Fact(pair.literal("label") ?: return null, pair.literal("value") ?: return null)
            })
        }
        "proof" -> {
            if (!blockFields("text", "artifactRef")) return null
            val ref = get("artifactRef") as? JsonObject ?: return null
            if (!ref.onlyFields("artifactId", "version")) return null
            val id = ref.string("artifactId")?.takeIf(artifactId::matches) ?: return null
            val version = if ("version" in ref) {
                val numeric = ref.number("version") ?: return null
                val integer = numeric.toLong()
                if (integer !in 1..MAX_SAFE_VERSION || numeric != integer.toDouble()) return null
                integer
            } else null
            ReportBlock.Proof(prose("text") ?: return null, ReportBlock.Proof.ArtifactRef(id, version))
        }
        "cleanup" -> if (blockFields("text")) ReportBlock.Cleanup(prose("text") ?: return null) else null
        "risk" -> if (blockFields("title", "text")) ReportBlock.Risk(literal("title") ?: return null, prose("text") ?: return null) else null
        "metric" -> {
            if (!blockFields("label", "value", "unit", "context")) return null
            val unit = if ("unit" in this) literal("unit") ?: return null else null
            val context = if ("context" in this) prose("context") ?: return null else null
            ReportBlock.Metric(literal("label") ?: return null, number("value") ?: return null, unit, context)
        }
        "step" -> {
            if (!blockFields("text", "copyText", "language")) return null
            val copyText = if ("copyText" in this) string("copyText")?.takeIf { it.isNotBlank() } ?: return null else null
            val language = if ("language" in this) string("language")?.takeIf(languageName::matches) ?: return null else null
            ReportBlock.Step(prose("text") ?: return null, copyText, language)
        }
        "nextAction" -> if (blockFields("text")) ReportBlock.NextAction(prose("text") ?: return null) else null
        "markdown" -> if (blockFields("text")) ReportBlock.Markdown(string("text")?.takeIf { it.isNotBlank() } ?: return null) else null
        else -> null
    }
}
