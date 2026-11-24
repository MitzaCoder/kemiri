package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import io.github.mitzacoder.kemiri.features.chat.CODE_TAG
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.refs.LocalRefLinks
import io.github.mitzacoder.kemiri.features.coordinators.CoordinatorMark
import io.github.mitzacoder.kemiri.features.refs.RefLinks
import io.github.mitzacoder.kemiri.features.refs.title
import io.github.mitzacoder.kemiri.protocol.ThreadSummary
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

@Composable
internal fun TaskSheetMetadata(refs: List<String>, coordinatorTitle: String?, coordinator: ThreadSummary?, onMove: (() -> Unit)?) {
    if (refs.isEmpty() && coordinatorTitle == null) return
    val colors = Jarvis.colors
    val links = LocalRefLinks.current
    var expanded by rememberSaveable { mutableStateOf(false) }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), itemVerticalAlignment = Alignment.CenterVertically) {
        if (coordinatorTitle != null) TaskMetadataChip(onClick = onMove, onClickLabel = "Move to coordinator") {
            CoordinatorMark(coordinator, coordinatorTitle)
            Text(coordinatorTitle, style = TaskType.xsMedium, color = colors.fg,
                maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (refs.size > 2) {
            val summary = taskRefSummary(refs.map { links?.status(it) })
            TaskMetadataChip(Modifier.semantics {
                stateDescription = (if (expanded) "Expanded" else "Collapsed") + if (summary.failingChecks) ", checks failing" else ""
            }, onClick = { expanded = !expanded }, onClickLabel = if (expanded) "Hide links" else "Show links") {
                Text(summary.counts, Modifier.weight(1f, fill = false), style = TaskType.xs,
                    color = if (summary.failingChecks) colors.danger else colors.fgMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                LucideGlyph(if (expanded) Lucide.ChevronDown else Lucide.ChevronRight, size = 14.dp, tint = colors.fgMuted)
            }
        } else refs.forEach { ref ->
            val status = links?.status(ref)
            TaskMetadataChip(onClick = refAction(ref, links), onClickLabel = "Open link") {
                Text(refLabel(ref, links?.links) + " · " + taskRefStateLabel(status), style = TaskType.xs,
                    color = if (taskRefHasFailingChecks(status)) colors.danger else colors.fgMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
    if (refs.size > 2 && expanded) Column(Modifier.fillMaxWidth()) {
        refs.forEach { ref -> key(ref) {
            val status = links?.status(ref)
            val open = refAction(ref, links)
            HorizontalDivider(color = colors.border)
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp)
                .then(if (open != null) Modifier.clickable(role = Role.Button, onClickLabel = "Open link", onClick = open) else Modifier)
                .padding(vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Column(Modifier.weight(1f)) {
                    Text(refLabel(ref, links?.links), style = TaskType.xsMedium, color = colors.fg)
                    status?.title?.takeIf { it.isNotBlank() }?.let { Text(it, style = TaskType.xs, color = colors.fgMuted) }
                }
                Text(taskRefStateLabel(status), Modifier.widthIn(max = 132.dp), style = TaskType.xs,
                    color = if (taskRefHasFailingChecks(status)) colors.danger else colors.fgMuted)
                if (open != null) LucideGlyph(Lucide.ExternalLink, size = 12.dp, tint = colors.fgSubtle)
            }
        } }
    }
}

private fun refAction(ref: String, links: RefLinks?): (() -> Unit)? =
    if (links?.url(ref) != null) { { links.open(ref) } } else null

@Composable
private fun TaskMetadataChip(
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)?,
    onClickLabel: String,
    content: @Composable RowScope.() -> Unit,
) {
    val colors = Jarvis.colors
    val shape = RoundedCornerShape(50)
    Box(modifier.heightIn(min = 48.dp).clip(shape)
        .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClickLabel = onClickLabel, onClick = onClick) else Modifier),
        contentAlignment = Alignment.CenterStart) {
        Row(Modifier.heightIn(min = 30.dp).background(colors.surface2, shape).border(1.dp, colors.border, shape)
            .padding(horizontal = 8.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp), content = content)
    }
}

internal data class TaskDetailReferences(val text: AnnotatedString, val chips: Map<String, InlineTextContent> = emptyMap())

/** Keep existing text and links intact except for self-references. Code snippets and external links stay literal. */
@Composable
internal fun taskDetailReferences(text: AnnotatedString, fontSize: TextUnit): TaskDetailReferences {
    val openTaskId = LocalOpenTaskId.current ?: return TaskDetailReferences(text)
    return remember(text, openTaskId, fontSize) {
        val pieces = splitTaskMentions(text.text) { isTaskSelfReference(it, openTaskId) }
        val replaced = buildAnnotatedString {
            var offset = 0
            for (piece in pieces) {
                val shown = when (piece) {
                    is TextPiece.Plain -> piece.text
                    is TextPiece.Task -> piece.taskId
                }
                val end = offset + shown.length
                if (piece is TextPiece.Task &&
                    text.getLinkAnnotations(offset, end).all { (it.item as? LinkAnnotation.Clickable)?.tag == "task:$openTaskId" } &&
                    text.getStringAnnotations(CODE_TAG, offset, end).all { it.start == offset && it.end == end }
                ) appendInlineContent(openTaskId, "this task")
                else append(text, offset, end)
                offset = end
            }
        }
        if (replaced == text) TaskDetailReferences(text)
        else TaskDetailReferences(replaced, mapOf(openTaskId to InlineTextContent(
            Placeholder(4.4.em, 1.22.em, PlaceholderVerticalAlign.TextCenter),
        ) { TaskSelfReferenceChip(openTaskId, if (fontSize.isSp) fontSize * .85f else 12.sp) }))
    }
}

/** Plain or already styled detail text. Other IDs retain the caller's original display. */
@Composable
internal fun TaskDetailText(
    text: AnnotatedString,
    modifier: Modifier = Modifier,
    style: TextStyle = LocalTextStyle.current,
    color: Color = Color.Unspecified,
    maxLines: Int = Int.MAX_VALUE,
    overflow: TextOverflow = TextOverflow.Clip,
) {
    val references = taskDetailReferences(text, style.fontSize)
    Text(references.text, modifier, color = color, style = style, maxLines = maxLines,
        overflow = overflow, inlineContent = references.chips)
}

@Composable
internal fun TaskDetailText(
    text: String,
    modifier: Modifier = Modifier,
    style: TextStyle = LocalTextStyle.current,
    color: Color = Color.Unspecified,
    maxLines: Int = Int.MAX_VALUE,
    overflow: TextOverflow = TextOverflow.Clip,
) = TaskDetailText(AnnotatedString(text), modifier, style, color, maxLines, overflow)
