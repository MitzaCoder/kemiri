package io.github.mitzacoder.kemiri.features.usage

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.protocol.UsageWindow

@Composable
internal fun HistoryChart(w: UsageWindow, p: WindowPace, now: Double, color: Color) {
    val grid = MaterialTheme.colorScheme.outlineVariant
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val geometry = usageChart(w, now, 300.0, 72.0)
    Box(Modifier.fillMaxWidth().height(48.dp).semantics { contentDescription = "Usage history: ${w.samples.size} samples. Solid: used. Dashed: even pace. Dotted: average pace continued." }, contentAlignment = Alignment.Center) {
        Canvas(Modifier.fillMaxSize().padding(horizontal = 4.dp, vertical = 6.dp)) {
            fun pt(p: ChartPoint) = Offset((p.x / 300 * size.width).toFloat(), (p.y / 72 * size.height).toFloat())
            fun segment(s: ChartSegment, c: Color, dash: FloatArray) = drawLine(c, pt(s.from), pt(s.to), 1.5.dp.toPx(), pathEffect = PathEffect.dashPathEffect(dash))
            val limitY = (geometry.limitY / 72 * size.height).toFloat()
            drawLine(grid, Offset(0f, limitY), Offset(size.width, limitY))
            drawLine(grid, Offset(0f, size.height), Offset(size.width, size.height))
            geometry.evenPace?.let { segment(it, muted, floatArrayOf(8f, 8f)) }
            if(geometry.points.isNotEmpty()) {
                val line = Path().apply { geometry.points.forEachIndexed { i, p -> val o = pt(p); if(i == 0) moveTo(o.x, o.y) else lineTo(o.x, o.y) } }
                val area = Path().apply { addPath(line); lineTo(pt(geometry.points.last()).x, size.height); lineTo(pt(geometry.points.first()).x, size.height); close() }
                drawPath(area, Brush.verticalGradient(listOf(color.copy(alpha = .28f), color.copy(alpha = .02f))))
                drawPath(line, color, style = Stroke(2.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
            }
            geometry.projection?.let { segment(it, color, floatArrayOf(4f, 8f)) }
            geometry.nowX?.let {
                val x = (it / 300 * size.width).toFloat()
                drawLine(muted.copy(alpha = .5f), Offset(x, 0f), Offset(x, size.height), pathEffect = PathEffect.dashPathEffect(floatArrayOf(2f, 6f)))
                geometry.points.lastOrNull()?.let { last -> drawCircle(color, 3.dp.toPx(), pt(last)) }
            }
        }
        if(geometry.points.isEmpty()) Text("No history yet", style = MaterialTheme.typography.labelSmall)
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
        Text(p.startsAt?.let(::clockTime) ?: "First sample", style = MaterialTheme.typography.labelSmall)
        Text(p.resetsAt?.let(::clockTime) ?: "Now", style = MaterialTheme.typography.labelSmall)
    }
}
