package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.features.chat.markdownText
import io.github.mitzacoder.kemiri.protocol.BoardTaskReport
import org.commonmark.node.Heading
import org.commonmark.node.ListBlock
import org.commonmark.node.Paragraph

internal data class ReportGlance(
    val firstOutcome: String?,
    val metrics: List<ReportBlock.Metric>,
    val findingTitles: List<String>,
    val riskTitles: List<String>,
    val firstNextAction: String?,
)

/** Use the first readable paragraph, heading or list item, not a code fence or table. */
private fun firstLegacyLine(markdown: String): String? =
    generateSequence(reportMarkdownParser.parse(markdown).firstChild) { it.next }.firstNotNullOfOrNull { node ->
        when (node) {
            is ListBlock -> node.firstChild
            is Paragraph, is Heading -> node
            else -> null
        }?.let(::markdownText)?.takeIf { it.isNotEmpty() }
    }

private inline fun <reified Block : ReportBlock> ReportSectionContent.blocksOfKind(): List<Block> =
    (this as? ReportSectionContent.Blocks)?.blocks?.filterIsInstance<Block>().orEmpty()

private inline fun <reified Block : ReportBlock> ReportSectionContent.firstLine(text: (Block) -> String): String? = when (this) {
    is ReportSectionContent.Blocks -> blocks.firstOrNull { it is Block }?.let { it as Block }?.let { markdownText(text(it)) }
    is ReportSectionContent.Mirror -> firstLegacyLine(markdown)
}

/** Short reader-facing facts for alternate layouts. Markdown never implies a finding, risk or metric. */
internal fun reportGlance(report: BoardTaskReport): ReportGlance {
    val summary = readReportSection(report, ReportSectionKind.Summary)
    val results = readReportSection(report, ReportSectionKind.Results)
    val notDone = readReportSection(report, ReportSectionKind.NotDone)
    val next = readReportSection(report, ReportSectionKind.Next)
    return ReportGlance(
        firstOutcome = summary.firstLine(ReportBlock.Outcome::text) ?: results.firstLine(ReportBlock.Outcome::text),
        metrics = results.blocksOfKind<ReportBlock.Metric>().map { it.copy(context = it.context?.let(::markdownText)) },
        findingTitles = results.blocksOfKind<ReportBlock.Finding>().map { it.title },
        riskTitles = (results.blocksOfKind<ReportBlock.Risk>() + notDone.blocksOfKind<ReportBlock.Risk>()).map { it.title },
        firstNextAction = next.firstLine(ReportBlock.NextAction::text),
    )
}
