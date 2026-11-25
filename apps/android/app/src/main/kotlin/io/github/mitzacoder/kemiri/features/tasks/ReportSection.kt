package io.github.mitzacoder.kemiri.features.tasks

import android.content.ClipData
import androidx.compose.foundation.border
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.mitzacoder.kemiri.features.chat.ArtifactDownloadAction
import io.github.mitzacoder.kemiri.features.chat.ArtifactThumb
import io.github.mitzacoder.kemiri.features.chat.isHtmlArtifact
import io.github.mitzacoder.kemiri.features.chat.ChatArtifactMetadata
import io.github.mitzacoder.kemiri.features.chat.MarkdownContent
import io.github.mitzacoder.kemiri.features.chat.QuotableSelection
import io.github.mitzacoder.kemiri.features.chat.RichMarkdown
import io.github.mitzacoder.kemiri.features.chat.artifactTitle
import io.github.mitzacoder.kemiri.features.tasks.media.isMedia
import io.github.mitzacoder.kemiri.features.tasks.media.reportProofArtifact
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.Artifact
import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.theme.JetBrainsMono
import io.github.mitzacoder.kemiri.ui.theme.Text as TextStyles
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Render one report body in source order. The host owns headings, placement, feature gates and scroll state.
 * Pass the task's artifact feed and project context to enable proof links. Captions need neither.
 * Use [reportNextPlacement] to place Next; use the same Results content with `automaticReportProof` for thumbnails.
 */
@Composable
internal fun ReportSection(
    task: BoardTask,
    section: ReportSectionKind,
    context: ProjectScreenContext? = null,
    artifacts: List<Artifact> = emptyList(),
    sectionViewsSupported: Boolean = false,
    content: ReportSectionContent = rememberReportSection(task.report, section),
) {
    when (content) {
        is ReportSectionContent.Mirror -> ReportSectionBody(section, content.markdown)
        is ReportSectionContent.Blocks -> ReportProseStyle(section) {
            QuotableSelection(Modifier.widthIn(max = 560.dp)) {
                Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    for ((index, block) in content.blocks.withIndex()) when (block) {
                        is ReportBlock.Outcome -> ReportProse(block.text)
                        is ReportBlock.Finding -> ReportTitledProse(block.title, block.text)
                        is ReportBlock.Setup -> ReportSetup(block)
                        is ReportBlock.Proof -> {
                            val artifact = remember(task.id, context?.route?.projectId, block.artifactRef, artifacts) {
                                reportProofArtifact(block.artifactRef, artifacts.filter {
                                    it.taskId == task.id && it.projectId == context?.route?.projectId
                                })
                            }
                            ReportProofBlock(block, context, artifact)
                        }
                        is ReportBlock.Cleanup -> ReportProse("**Cleaned up:** ${block.text}")
                        is ReportBlock.Risk -> ReportTitledProse(block.title, block.text,
                            label = if (section == ReportSectionKind.Results) "Caveat" else null)
                        is ReportBlock.Metric -> ReportMetric(block)
                        is ReportBlock.Step -> ReportStep(index + 1, block)
                        is ReportBlock.NextAction -> ReportProse(block.text)
                        is ReportBlock.Markdown -> MarkdownContent(block.text)
                    }
                }
            }
        }
    }
    if (context != null) {
        val entry = remember(sectionViewsSupported, task.report.sectionViews, section, context.route.projectId, task.id, artifacts) {
            reportSectionViewEntry(sectionViewsSupported, task.report.sectionViews, section, context.route.projectId, task.id, artifacts)
        }
        when (entry) {
            ReportSectionViewEntry.Hidden -> Unit
            ReportSectionViewEntry.Unavailable -> ReportViewUnavailable()
            is ReportSectionViewEntry.File -> key(context.backend.config.key, context.route.projectId, entry.artifact.id) {
                var unavailable by remember { mutableStateOf(false) }
                if (unavailable) ReportViewUnavailable()
                else ArtifactDownloadAction(context, entry.artifact, entry.artifact.id, canSave = true,
                    fileEntryLabel = entry.label, onFileUnavailable = { unavailable = true })
            }
        }
    }
}

@Composable
private fun ReportViewUnavailable() {
    Text("View unavailable", color = Jarvis.colors.fgMuted, style = TaskType.xs)
}

@Composable
private fun ReportProseStyle(section: ReportSectionKind, content: @Composable () -> Unit) {
    val style = if (section == ReportSectionKind.Summary) TextStyles.task.copy(fontSize = 16.sp, lineHeight = 24.sp, fontWeight = FontWeight.Medium)
        else TextStyles.task
    ProvideTextStyle(style, content)
}

@Composable
private fun ReportProse(text: String) = MarkdownContent(text, inlineOnly = true)

@Composable
private fun ReportBlockTitle(title: String) {
    Text(title, Modifier.semantics { heading() }, color = Jarvis.colors.fg, fontWeight = FontWeight.SemiBold)
}

@Composable
private fun ReportLabel(label: String) {
    Text(label, color = Jarvis.colors.fgMuted, style = TaskType.xs, fontWeight = FontWeight.SemiBold)
}

@Composable
private fun ReportTitledProse(title: String, text: String, label: String? = null) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        if (label != null) ReportLabel(label)
        ReportBlockTitle(title)
        ReportProse(text)
    }
}

@Composable
private fun ReportSetup(setup: ReportBlock.Setup) {
    Surface(shape = RoundedCornerShape(10.dp), color = Jarvis.colors.surface2, contentColor = Jarvis.colors.fg,
        border = BorderStroke(1.dp, Jarvis.colors.border)) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            ReportBlockTitle(setup.title)
            for ((label, value) in setup.facts) Column {
                ReportLabel(label)
                Text(value, color = Jarvis.colors.fg)
            }
        }
    }
}

@Composable
private fun ReportProofBlock(block: ReportBlock.Proof, context: ProjectScreenContext?, artifact: Artifact?) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (context == null || artifact == null) {
            ReportLabel("Proof file unavailable")
        } else {
            val title = artifactTitle(artifact)
            val shape = RoundedCornerShape(8.dp)
            Column(Modifier.fillMaxWidth().clip(shape).border(1.dp, Jarvis.colors.borderStrong, shape)
                .clickable(role = Role.Button, onClickLabel = "Open proof") {
                    ChatArtifactMetadata.keep(context.backend.config.key, artifact)
                    context.navigate(Destination.Artifact(context.route, artifact.id))
                }.semantics { contentDescription = "Open proof: $title" }) {
                if (isMedia(artifact) || isHtmlArtifact(artifact.name, artifact.mimeType)) {
                    ArtifactThumb(context, artifact, Modifier.fillMaxWidth().aspectRatio(16f / 9f), contentScale = ContentScale.Fit)
                }
                Box(Modifier.heightIn(min = 48.dp).padding(horizontal = 12.dp, vertical = 8.dp), contentAlignment = Alignment.CenterStart) {
                    Text(title, fontWeight = FontWeight.SemiBold, color = Jarvis.colors.fg)
                }
            }
        }
        ReportProse(block.text)
    }
}

@Composable
private fun ReportMetric(metric: ReportBlock.Metric) {
    val value = metric.value.toString().removeSuffix(".0")
    val withUnit = listOfNotNull(value, metric.unit).joinToString(" ")
    val labels: @Composable () -> Unit = {
        Text(withUnit, style = TextStyles.task.copy(fontSize = 20.sp), fontWeight = FontWeight.Bold, color = Jarvis.colors.fg)
        Text(metric.label, fontWeight = FontWeight.SemiBold, color = Jarvis.colors.fg)
    }
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        val readingOrder = Modifier.semantics(mergeDescendants = true) {}
        if (LocalDensity.current.fontScale >= 1.5f) Column(readingOrder, content = { labels() })
        else FlowRow(readingOrder, horizontalArrangement = Arrangement.spacedBy(8.dp),
            itemVerticalAlignment = Alignment.CenterVertically, content = { labels() })
        metric.context?.let { ReportProse(it) }
    }
}

@Composable
private fun ReportStep(number: Int, step: ReportBlock.Step) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("$number.", color = Jarvis.colors.fgMuted, fontWeight = FontWeight.SemiBold, lineHeight = 25.sp)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            ReportProse(step.text)
            step.copyText?.let { ReportStepCopy(number, it, step.language) }
        }
    }
}

@Composable
private fun ReportStepCopy(number: Int, text: String, language: String?) {
    val clipboard = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var copyFeedback by remember(text) { mutableStateOf<String?>(null) }
    LaunchedEffect(copyFeedback) {
        if (copyFeedback != null) { delay(2_000); copyFeedback = null }
    }
    Surface(shape = RoundedCornerShape(8.dp), color = Jarvis.colors.surface2, contentColor = Jarvis.colors.fg,
        border = BorderStroke(1.dp, Jarvis.colors.border)) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp)) {
            Text(text, Modifier.padding(vertical = 6.dp), style = TaskType.xs, fontFamily = JetBrainsMono)
            HorizontalDivider(color = Jarvis.colors.border)
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween,
                itemVerticalAlignment = Alignment.CenterVertically) {
                if (language != null) ReportLabel(language)
                TextButton(onClick = {
                    scope.launch {
                        copyFeedback = try {
                            clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("Step $number", text)))
                            "Copied"
                        } catch (cause: CancellationException) { throw cause }
                        catch (_: Exception) { "Could not copy" }
                    }
                }, modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = copyFeedback ?: "Copy step $number text" }) {
                    Text(copyFeedback ?: "Copy")
                }
            }
        }
    }
}

/** The host supplies the heading and placement; only the section and its authored text shape the body. */
@Composable
internal fun ReportSectionBody(section: ReportSectionKind, markdown: String) {
    val segments = remember(section, markdown) { shapeLegacyReport(section, markdown) }
    if (segments.isEmpty()) return
    val unshaped = segments.singleOrNull() as? LegacyReportSegment.Markdown
    if (unshaped != null) {
        ReportProseStyle(section) { RichMarkdown(unshaped.source) }
        return
    }

    val colors = Jarvis.colors
    ProvideTextStyle(TextStyles.task) {
        QuotableSelection {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                for (segment in segments) when (segment) {
                    is LegacyReportSegment.Markdown -> MarkdownContent(segment.source)
                    is LegacyReportSegment.Rows -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        for (item in segment.items) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text("•", color = colors.fgSubtle, lineHeight = 25.sp)
                            Box(Modifier.weight(1f)) { MarkdownContent(item, inlineOnly = true) }
                        }
                    }
                    is LegacyReportSegment.Labeled -> Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        for ((label, value) in segment.rows) Column {
                            Text("$label:", color = colors.fgMuted, fontWeight = FontWeight.SemiBold)
                            MarkdownContent(value, inlineOnly = true)
                        }
                    }
                }
            }
        }
    }
}

