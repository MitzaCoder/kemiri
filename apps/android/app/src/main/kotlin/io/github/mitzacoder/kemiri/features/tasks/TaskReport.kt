package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import kotlinx.coroutines.delay
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

@Composable
internal fun StaleTaskReport(context: ProjectScreenContext, taskId: String) {
    val colors = Jarvis.colors
    var marked by remember(taskId) { mutableStateOf(false) }
    var problem by remember(taskId) { mutableStateOf<String?>(null) }
    LaunchedEffect(marked) {
        if (marked) { delay(REPORT_STALE_CONFIRMATION_MS); marked = false }
    }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), itemVerticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
        Text("Report may be out of date.", style = TaskType.xs, color = colors.fgMuted)
        ReportStaleAction(context, taskId, marked, onMarked = { problem = null; marked = true }, onError = { problem = it })
    }
    val message = if (marked) REPORT_STALE_CONFIRMATION else problem
    if (message != null) Text(message, Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        style = TaskType.xs, color = if (marked) colors.fgMuted else colors.danger)
}

/** Read-only freshness metadata, shared with the graph preview (no stale/edit actions). */
@Composable
internal fun ReportSectionFreshness(metadata: BoardReportSection, now: Long) {
    val colors = Jarvis.colors
    val meta = buildAnnotatedString {
        append(reportSectionAge(metadata, now))
        if (metadata.stale) {
            if (length > 0) append(" · ")
            withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = colors.fg)) { append("needs update") }
            append(reportSectionStaleness(metadata).orEmpty().removePrefix("needs update"))
        }
    }
    if (meta.isNotEmpty()) Text(meta, style = TaskType.meta, color = colors.fgSubtle)
}
