package io.github.mitzacoder.kemiri.features.answers

import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import io.github.mitzacoder.kemiri.protocol.AnswerWork
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import java.time.Instant
import kotlinx.coroutines.delay

@Composable
internal fun rememberAnswerWorkStatus(work: AnswerWork, at: String): AnswerWorkStatus {
    var now by remember(work, at) { mutableStateOf(Instant.now()) }
    val status = answerWorkStatus(work, at, now)
    if (status.indicator == AnswerWorkIndicator.Pulse) LaunchedEffect(work, at) {
        while (true) {
            delay(5_000)
            now = Instant.now()
        }
    }
    return status
}

@Composable
internal fun answerWorkColor(indicator: AnswerWorkIndicator?) =
    if (indicator == AnswerWorkIndicator.Problem) MaterialTheme.colorScheme.error else Jarvis.colors.fgMuted

@Composable
internal fun AnswerWorkGlyph(indicator: AnswerWorkIndicator, modifier: Modifier = Modifier) {
    when (indicator) {
        AnswerWorkIndicator.Problem -> LucideGlyph(Lucide.CircleAlert, modifier, size = 16.dp, tint = answerWorkColor(indicator))
        AnswerWorkIndicator.Pulse, AnswerWorkIndicator.Waiting -> {
            val opacity = if (indicator == AnswerWorkIndicator.Pulse) {
                rememberInfiniteTransition(label = "Working errand").animateFloat(
                    1f, .35f, infiniteRepeatable(tween(850), RepeatMode.Reverse), label = "Working dot opacity",
                )
            } else null
            Box(modifier.size(16.dp), contentAlignment = Alignment.Center) {
                Box(Modifier.size(8.dp).graphicsLayer { alpha = opacity?.value ?: 1f }.background(Jarvis.colors.accent2, CircleShape))
            }
        }
    }
}
