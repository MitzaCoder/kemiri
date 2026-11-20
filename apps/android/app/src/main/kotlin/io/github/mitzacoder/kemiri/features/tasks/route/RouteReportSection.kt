package io.github.mitzacoder.kemiri.features.tasks.route

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.chat.markdownText
import io.github.mitzacoder.kemiri.features.tasks.ReportMarkdown
import io.github.mitzacoder.kemiri.features.tasks.TaskSheetState
import io.github.mitzacoder.kemiri.features.tasks.emptyFinishedResults
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.theme.Text as TextStyles

private val fenceMarker = Regex("^(`{3,}|~{3,})")
private val skippedLine = Regex("^\\s*(?:#{1,6}\\s|[-*_]{3,}\\s*$)")
private val listMarker = Regex("^\\s*(?:[-+*]|\\d+[.)])\\s+")

internal fun reportExcerptLines(source: String, limit: Int): List<String> = buildList {
    var fence: String? = null
    for (line in source.lineSequence()) {
        if (size >= limit) break
        val marker = fenceMarker.find(line.trimStart())?.value
        if (marker != null) {
            val opening = fence
            if (opening == null) fence = marker
            else if (marker.first() == opening.first() && marker.length >= opening.length) fence = null
        } else if (fence == null && !skippedLine.containsMatchIn(line)) {
            markdownText(line.replaceFirst(listMarker, "")).trim().takeIf { it.isNotEmpty() }?.let { add(it) }
        }
    }
}

internal enum class RouteReport { Summary, Results, NotDone, Next, Steps }

/** Swap the full and glance renderers here when typed report blocks arrive. */
@Composable
internal fun RouteReportSection(sheet: TaskSheetState, section: RouteReport, excerptLimit: Int? = null) {
    val source = when (section) {
        RouteReport.Summary -> sheet.fields.summary
        RouteReport.Results -> sheet.task.report.results
        RouteReport.NotDone -> sheet.fields.notDoneMarkdown
        RouteReport.Next -> sheet.task.report.next
        RouteReport.Steps -> sheet.needsYou.stepsMarkdown
    }.orEmpty()
    val colors = Jarvis.colors
    when {
        source.isBlank() -> if (section == RouteReport.Results && sheet.fields.summary == null) {
            RouteQuiet(if (emptyFinishedResults(sheet.task.status, source)) "No results yet · work finished" else "Nothing written yet.")
        } else if (section == RouteReport.Next && excerptLimit != null && sheet.fields.notDoneMarkdown == null) RouteQuiet("Nothing written yet.")
        section == RouteReport.Summary -> Text(source, style = TextStyles.base.copy(fontWeight = FontWeight.Bold), color = colors.fg,
            maxLines = if (excerptLimit != null) 4 else Int.MAX_VALUE, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
        excerptLimit == null -> ReportMarkdown(source)
        else -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            reportExcerptLines(source, excerptLimit).forEach { RouteQuiet(it, maxLines = 3) }
        }
    }
}
