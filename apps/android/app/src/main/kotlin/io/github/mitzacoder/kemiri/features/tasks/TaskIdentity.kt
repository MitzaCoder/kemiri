package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.ui.theme.JarvisColors
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.theme.textStyle

internal fun taskIdForeground(colors: JarvisColors): Color =
    if (colors.neutral) colors.fg else if (colors.dark) Color(0xFFC7D2FE) else Color(0xFF4338CA)
internal fun taskIdentityAccent(colors: JarvisColors): Color =
    if (colors.dark && !colors.neutral) Color(0xFF818CF8) else colors.accent2

/** Identity, not status; the same accent pair at every collapsed task surface. */
@Composable
fun TaskIdChip(taskId: String) {
    val colors = Jarvis.colors
    val foreground = taskIdForeground(colors)
    Text(taskId, Modifier.background(taskIdentityAccent(colors).copy(alpha = .12f), RoundedCornerShape(6.dp)).padding(horizontal = 5.dp),
        color = foreground, style = textStyle(.75f, 1.5f, weight = 600, mono = true))
}

private val taskIdPattern = Regex("T[0-9]+")

/** A task mention is a self-reference only inside that task's details. */
internal fun isTaskSelfReference(taskId: String, openTaskId: String?): Boolean =
    taskId == openTaskId && taskIdPattern.matches(taskId)

internal val LocalOpenTaskId = compositionLocalOf<String?> { null }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TaskSelfReferenceChip(taskId: String, fontSize: TextUnit) {
    val colors = Jarvis.colors
    // The tooltip is in a popup, outside the sheet's selectable layout hierarchy.
    DisableSelection {
        TooltipBox(
            positionProvider = TooltipDefaults.rememberPlainTooltipPositionProvider(),
            tooltip = { PlainTooltip { Text(taskId) } },
            state = rememberTooltipState(),
        ) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    "this task",
                    Modifier.clearAndSetSemantics { contentDescription = "this task, $taskId" }
                        .background(colors.success.copy(alpha = .17f), RoundedCornerShape(6.dp))
                        .padding(horizontal = 4.dp),
                    color = lerp(colors.fg, colors.success, .28f),
                    style = TextStyle(fontSize = fontSize, fontWeight = FontWeight.SemiBold),
                    maxLines = 1,
                    softWrap = false,
                )
            }
        }
    }
}

val LocalPreviewTaskId = compositionLocalOf<String?> { null }

internal fun taskReferenceMatches(taskId: String, previewTaskId: String?): Boolean = previewTaskId == taskId

/** One short pulse on entering the preview; never scrolls or changes row navigation. */
@Composable
fun Modifier.taskReferenceHighlight(taskId: String, reducedMotion: Boolean): Modifier {
    val referenced = taskReferenceMatches(taskId, LocalPreviewTaskId.current)
    val pulse = remember { Animatable(0f) }
    LaunchedEffect(referenced, reducedMotion) {
        pulse.snapTo(0f)
        if (referenced && !reducedMotion) {
            pulse.animateTo(1f, tween(280))
            pulse.animateTo(0f, tween(420))
        }
    }
    val accent = taskIdentityAccent(Jarvis.colors)
    return if (!referenced) this else drawWithContent {
        drawRoundRect(accent.copy(alpha = .09f), cornerRadius = CornerRadius(10.dp.toPx()))
        drawContent()
        drawRoundRect(accent.copy(alpha = .28f + .32f * pulse.value), cornerRadius = CornerRadius(10.dp.toPx()),
            style = Stroke((1f + pulse.value).dp.toPx()))
    }
}
