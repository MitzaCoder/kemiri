package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.Color
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
