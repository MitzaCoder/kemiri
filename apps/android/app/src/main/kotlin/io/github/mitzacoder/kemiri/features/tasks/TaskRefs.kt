package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.BorderStroke
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.refs.LocalRefLinks
import io.github.mitzacoder.kemiri.features.refs.RefLines
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

@Composable
internal fun TaskRefs(refs: List<String>, maxHeight: Dp) {
    val colors = Jarvis.colors
    val links = LocalRefLinks.current
    val summary = taskRefSummary(refs.map { links?.status(it) })
    var expanded by rememberSaveable { mutableStateOf(false) }
    Surface(shape = RoundedCornerShape(8.dp), color = colors.bg, border = BorderStroke(1.dp, colors.border)) {
        Column {
            Surface(onClick = { expanded = !expanded }, color = colors.bg,
                modifier = Modifier.fillMaxWidth().semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }) {
                Row(Modifier.heightIn(min = 44.dp).padding(horizontal = 10.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    LucideGlyph(if (expanded) Lucide.ChevronDown else Lucide.ChevronRight, size = 14.dp, tint = colors.fgSubtle)
                    Column(Modifier.weight(1f)) {
                        Text(summary.counts, style = TaskType.xs, color = colors.fgMuted)
                        Text(summary.status, style = TaskType.xs, color = if (summary.attention) colors.danger else colors.fgSubtle)
                    }
                    Text(if (expanded) "Hide" else "Show", style = TaskType.xs, color = colors.fgSubtle)
                }
            }
            if (expanded) {
                HorizontalDivider(color = colors.border)
                Column(Modifier.fillMaxWidth().heightIn(max = maxHeight).clip(RoundedCornerShape(bottomStart = 8.dp, bottomEnd = 8.dp))
                    .verticalScroll(rememberScrollState()).padding(horizontal = 10.dp, vertical = 4.dp)) {
                    RefLines(refs)
                }
            }
        }
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
