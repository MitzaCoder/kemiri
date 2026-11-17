package io.github.mitzacoder.kemiri.features.tasks.graph

import androidx.compose.animation.core.*
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.*
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.tasks.graph.bubble.*
import kotlin.math.*

/** Translate retained dash paint inside each segment's clip. Neither tasks nor edges repaint per frame. */
@Composable
internal fun BubbleBlockerMotion(edges: List<GraphEdge>, positions: Map<String, GraphPosition>, ink: Color, modifier: Modifier) {
    val density = LocalDensity.current.density
    val transition = rememberInfiniteTransition(label = "blocker dashes")
    val travel = transition.animateFloat(0f, 10f, infiniteRepeatable(tween(2400, easing = LinearEasing)), label = "toward blocker")
    Box(modifier) {
        edges.forEach { edge ->
            val a = positions[edge.from]; val b = positions[edge.to]
            if (a != null && b != null) key(edge.id) {
                val segment = graphEdgeSegment(a, b)
                val dx = segment.x2 - segment.x1; val dy = segment.y2 - segment.y1
                val length = hypot(dx, dy)
                Box(Modifier.requiredSize(length.dp, 4.dp).graphicsLayer {
                    transformOrigin = TransformOrigin(0f, .5f)
                    translationX = (segment.x1 * density).toFloat(); translationY = ((segment.y1 - 2) * density).toFloat()
                    rotationZ = (atan2(dy, dx) * 180 / PI).toFloat(); clip = true
                }) {
                    Canvas(Modifier.requiredSize((length + 20).dp, 4.dp).offset(x = (-10).dp).graphicsLayer {
                        translationX = travel.value * density
                    }) {
                        drawLine(ink, Offset(0f, size.height / 2), Offset(size.width, size.height / 2), 1.8.dp.toPx(),
                            pathEffect = PathEffect.dashPathEffect(floatArrayOf(5.dp.toPx(), 5.dp.toPx())))
                    }
                }
            }
        }
    }
}
