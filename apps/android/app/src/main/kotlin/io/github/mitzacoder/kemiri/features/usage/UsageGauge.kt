package io.github.mitzacoder.kemiri.features.usage

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlin.math.cos
import kotlin.math.roundToInt
import kotlin.math.sin

@Composable
internal fun UsageGauge(usedPercent: Double?, elapsedShare: Double?, color: Color) {
    val colors = MaterialTheme.colorScheme
    val elapsed = elapsedShare?.coerceIn(0.0, 1.0)
    Box(Modifier.size(84.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize()) {
            val usageRadius = size.width * .425f
            val timeRadius = size.width / 3
            fun arc(radius: Float, share: Double, tone: Color, stroke: Float) {
                drawArc(tone, 135f, 270f * share.toFloat(), false,
                    Offset(center.x - radius, center.y - radius), Size(radius * 2, radius * 2),
                    style = Stroke(stroke, cap = StrokeCap.Round))
            }
            arc(usageRadius, 1.0, colors.surfaceVariant, 6.dp.toPx())
            usedPercent?.takeIf { it > 0 }?.let { arc(usageRadius, (it / 100).coerceAtMost(1.0), color, 6.dp.toPx()) }
            arc(timeRadius, 1.0, colors.outlineVariant, 1.5.dp.toPx())
            if (elapsed != null) {
                arc(timeRadius, elapsed, colors.onSurfaceVariant, 1.5.dp.toPx())
                val angle = Math.toRadians(135 + elapsed * 270)
                fun point(radius: Float) = center + Offset(cos(angle).toFloat(), sin(angle).toFloat()) * radius
                drawCircle(colors.onSurfaceVariant, 2.5.dp.toPx(), point(timeRadius), style = Stroke(1.dp.toPx()))
                drawLine(colors.onSurface, point(usageRadius - 4.dp.toPx()), point(usageRadius + 4.dp.toPx()), 1.dp.toPx())
            }
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(percentLabel(usedPercent), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text("used", style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
        }
        if (elapsed != null) {
            Text("${(elapsed * 100).roundToInt()}% of time", Modifier.align(Alignment.BottomCenter),
                style = MaterialTheme.typography.labelSmall, color = colors.onSurfaceVariant)
        }
    }
}
