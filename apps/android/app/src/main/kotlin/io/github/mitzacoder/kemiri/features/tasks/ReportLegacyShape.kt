package io.github.mitzacoder.kemiri.features.tasks

import org.commonmark.ext.gfm.tables.TablesExtension
import org.commonmark.node.BulletList
import org.commonmark.node.HardLineBreak
import org.commonmark.node.HtmlInline
import org.commonmark.node.LinkReferenceDefinition
import org.commonmark.node.Node
import org.commonmark.node.Paragraph
import org.commonmark.node.Text
import org.commonmark.parser.IncludeSourceSpans
import org.commonmark.parser.Parser

internal sealed interface LegacyReportSegment {
    data class Markdown(val source: String) : LegacyReportSegment
    data class Rows(val items: List<String>) : LegacyReportSegment
    data class Labeled(val rows: List<LabeledReportRow>) : LegacyReportSegment
}

internal data class LabeledReportRow(val label: String, val value: String)

private val reportParser = Parser.builder()
    .extensions(listOf(TablesExtension.create()))
    .includeSourceSpans(IncludeSourceSpans.BLOCKS_AND_INLINES)
    .build()

private val labelPrefix = Regex("""^(\p{L}[\p{L}\p{M}\p{N}]*(?:[ \t]+[\p{L}\p{M}\p{N}]+){0,3}):[ \t]+(\S.*)$""")
private val taskMarker = Regex("""^\[[ xX]\][ \t]+""")

private fun labeledRow(line: String): LabeledReportRow? {
    val match = labelPrefix.matchEntire(line) ?: return null
    val (label, value) = match.destructured
    if (label.codePointCount(0, label.length) > 32 || value.startsWith("//")) return null
    return LabeledReportRow(label, value)
}

private fun shapeRows(items: List<String>): LegacyReportSegment? {
    val labels = items.mapNotNull(::labeledRow)
    // A partly labeled run is ambiguous; don't turn it into a partial grid.
    if (items.size >= 2 && labels.isNotEmpty()) {
        return if (labels.size == items.size) LegacyReportSegment.Labeled(labels) else null
    }
    return LegacyReportSegment.Rows(items)
}

private fun Node.children(): Sequence<Node> = generateSequence(firstChild) { it.next }

private fun Node.hasReferenceDefinition(): Boolean =
    this is LinkReferenceDefinition || children().any { it.hasReferenceDefinition() }

private fun BulletList.flatItems(source: String): List<String>? = buildList {
    for (item in children()) {
        val paragraph = item.firstChild as? Paragraph ?: return null
        if (paragraph.next != null) return null
        // Spans omit the list marker and its continuation indent, but retain authored inline Markdown.
        val text = paragraph.sourceSpans.joinToString("\n") { source.substring(it.inputIndex, it.inputIndex + it.length) }.trim()
        if (text.isEmpty() || taskMarker.containsMatchIn(text)) return null
        add(text)
    }
}.takeIf { it.isNotEmpty() }

private fun Paragraph.flatLines(source: String): List<String>? {
    if (children().any { it is HardLineBreak || it is HtmlInline || (it !is Text && it.sourceSpans.size > 1) }) return null
    val first = sourceSpans.firstOrNull() ?: return null
    val last = sourceSpans.last()
    val lines = source.substring(first.inputIndex, last.inputIndex + last.length).split('\n')
    if (lines.drop(1).any { it.startsWith(' ') || it.startsWith('\t') }) return null
    return lines.map { it.trim() }
}

/** Read-time layout only. Keep unshaped blocks as source instead of rebuilding their Markdown. */
internal fun shapeLegacyReport(section: ReportSectionKind, source: String): List<LegacyReportSegment> {
    if (source.isBlank()) return emptyList()
    val markdown = listOf(LegacyReportSegment.Markdown(source))
    if (section == ReportSectionKind.Summary || section == ReportSectionKind.Steps) return markdown
    val normalized = source.replace("\r\n", "\n").replace('\r', '\n')
    val document = reportParser.parse(normalized)
    // Keep reference definitions with their users, even when a definition is nested in another block.
    if (document.hasReferenceDefinition()) return markdown

    val blocks = document.children().toList()
    val plainNotDone = section == ReportSectionKind.NotDone && blocks.singleOrNull() is Paragraph
    val flatBullets = blocks.filterIsInstance<BulletList>().mapNotNull { list ->
        list.flatItems(normalized)?.let { list to it }
    }.toMap()
    if (section == ReportSectionKind.NotDone && !plainNotDone && flatBullets.size != blocks.size) return markdown

    val segments = mutableListOf<LegacyReportSegment>()
    var markdownStart = 0
    for (block in blocks) {
        val shaped = when (block) {
            is BulletList -> flatBullets[block]?.let(::shapeRows)
            is Paragraph -> block.flatLines(normalized)?.let(::shapeRows)
                ?.takeIf { plainNotDone || it is LegacyReportSegment.Labeled }
            else -> null
        } ?: continue
        val first = block.sourceSpans.firstOrNull() ?: return markdown
        val last = block.sourceSpans.last()
        val blockStart = first.inputIndex - first.columnIndex
        val precedingMarkdown = normalized.substring(markdownStart, blockStart)
        if (precedingMarkdown.isNotBlank()) segments += LegacyReportSegment.Markdown(precedingMarkdown)
        segments += shaped
        markdownStart = last.inputIndex + last.length
    }
    if (segments.isEmpty()) return markdown
    val trailingMarkdown = normalized.substring(markdownStart)
    if (trailingMarkdown.isNotBlank()) segments += LegacyReportSegment.Markdown(trailingMarkdown)
    return segments
}
