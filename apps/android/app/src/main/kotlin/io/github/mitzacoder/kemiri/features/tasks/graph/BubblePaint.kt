package io.github.mitzacoder.kemiri.features.tasks.graph

import android.graphics.Paint
import android.graphics.Typeface
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.*
import androidx.compose.ui.graphics.drawscope.*
import androidx.compose.ui.graphics.vector.PathParser
import io.github.mitzacoder.kemiri.features.tasks.TaskIcons
import io.github.mitzacoder.kemiri.features.tasks.graph.bubble.*
import io.github.mitzacoder.kemiri.ui.components.Lucide

/** One retained canvas instead of a measured Text/vector composition for every task on each pinch. */
internal class BubblePaint {
    private val idPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER; typeface = Typeface.create("monospace", Typeface.BOLD) }
    private val titlePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { textAlign = Paint.Align.CENTER; typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL) }
    private val glyphs = mutableMapOf<String, List<Path>>()

    fun DrawScope.glyph(node: GraphNode, tone: Color) {
        val paths = glyphs.getOrPut(node.status) {
            val icon = when (node.status) {
                "failed", "blocked" -> TaskIcons.TriangleAlert
                "answer_needed", "clarifying" -> TaskIcons.CircleHelp
                "review" -> TaskIcons.Eye
                "paused" -> TaskIcons.Pause
                "blocked_by_task" -> TaskIcons.Lock
                "waiting_outside", "waiting" -> Lucide.Clock
                "todo" -> TaskIcons.Circle
                "done" -> Lucide.Check
                "dropped" -> TaskIcons.Ban
                else -> null
            }
            icon?.paths?.map { PathParser().parsePathString(it).toPath() }.orEmpty()
        }
        if (paths.isEmpty()) drawCircle(tone, 6f, Offset.Zero)
        else translate(-10f, -10f) { scale(20f / 24, 20f / 24, Offset.Zero) {
            paths.forEach { drawPath(it, tone, style = Stroke(2f, cap = StrokeCap.Round, join = StrokeJoin.Round)) }
        } }
    }

    fun DrawScope.caption(node: GraphNode, position: GraphPosition, label: GraphLabelBox?, zoom: Double, fontScale: Float,
        ink: Color, chip: Color, title: Color, background: Color, alpha: Float) {
        val scale = graphCaptionScale(zoom).toFloat()
        val x = position.x.toFloat()
        val y = (position.y + node.radius + 12 * scale).toFloat()
        val id = node.task!!.id
        val captionScale = scale * fontScale
        val width = (id.length * 7 + 14) * captionScale
        drawRoundRect(chip.copy(alpha = .12f * alpha), Offset(x - width / 2, y - 8 * captionScale), Size(width, 18 * captionScale), CornerRadius(6 * captionScale))
        idPaint.color = ink.copy(alpha = alpha).toArgb(); idPaint.textSize = 12 * captionScale
        drawContext.canvas.nativeCanvas.drawText(id, x, y + 5 * captionScale, idPaint)
        if (label != null) {
            titlePaint.color = title.copy(alpha = alpha).toArgb(); titlePaint.textSize = (12 * label.scale * fontScale).toFloat()
            // Paint the same background outline as the web to keep crossing edges out of captions.
            titlePaint.strokeJoin = Paint.Join.ROUND
            label.lines.forEachIndexed { index, line ->
                val baseline = (label.y + (12 + index * 16) * label.scale * fontScale).toFloat()
                titlePaint.style = Paint.Style.STROKE; titlePaint.strokeWidth = (4 * label.scale).toFloat()
                titlePaint.color = background.copy(alpha = alpha).toArgb()
                drawContext.canvas.nativeCanvas.drawText(line, (label.x + label.width / 2).toFloat(), baseline, titlePaint)
                titlePaint.style = Paint.Style.FILL; titlePaint.color = title.copy(alpha = alpha).toArgb()
                drawContext.canvas.nativeCanvas.drawText(line, (label.x + label.width / 2).toFloat(), baseline, titlePaint)
            }
        }
    }
}
