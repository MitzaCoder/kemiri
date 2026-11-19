package io.github.mitzacoder.kemiri.features.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.*
import kotlin.math.abs
import kotlin.math.roundToInt

internal data class ArtifactAnchorRect(val x: Int, val y: Int, val width: Int, val height: Int)
internal data class ArtifactAnchorRects(val width: Int, val height: Int, val byAnchor: Map<String, ArtifactAnchorRect>)
private val RECT_VALUES = Regex("""(-?\d{1,7}),(-?\d{1,7}),(\d{1,7}),(\d{1,7})""")

internal fun artifactReviewPaths(comments: List<ReviewComment>): List<String> = comments.asSequence()
    .mapNotNull { it.anchor?.takeIf(::validPageAnchor)?.drop(2) }.distinct().take(100).toList()

/** A WebView can lie about its own geometry, but cannot point pins outside the native document surface. */
internal fun decodeArtifactAnchorRects(evaluated: String, watchedPaths: List<String>): ArtifactAnchorRects? = runCatching {
    if (evaluated.length > 50_000) return null
    val outer = Json.parseToJsonElement(evaluated) as? JsonPrimitive ?: return null
    if (!outer.isString) return null
    val fields = Json.parseToJsonElement(outer.content) as? JsonObject ?: return null
    if (fields.keys != setOf("width", "height", "rects")) return null
    val width = (fields["width"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull?.takeIf { it in 1..100_000 } ?: return null
    val height = (fields["height"] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull?.takeIf { it in 1..100_000 } ?: return null
    val payload = (fields["rects"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
    val rects = mutableMapOf<String, ArtifactAnchorRect>()
    if (payload.isNotEmpty()) for (entry in payload.split('|')) {
        val path = entry.substringBefore('=')
        if (path !in watchedPaths || !ARTIFACT_REVIEW_PATH.matches(path) || rects.containsKey("p:$path")) return null
        val match = RECT_VALUES.matchEntire(entry.substringAfter('=', "")) ?: return null
        val (x, y, w, h) = match.destructured
        if (w.toInt() == 0 || h.toInt() == 0) return null
        rects["p:$path"] = ArtifactAnchorRect(x.toInt(), y.toInt(), w.toInt(), h.toInt())
    }
    ArtifactAnchorRects(width, height, rects)
}.getOrNull()

internal data class ArtifactReviewPin(val anchor: String, val label: String, val count: Int, val x: Float, val y: Float)
internal fun artifactReviewPins(comments: List<ReviewComment>, rects: ArtifactAnchorRects, width: Float, height: Float, button: Float): List<ArtifactReviewPin> {
    if (width < button || height < button) return emptyList()
    val scale = width / rects.width
    val visibleHeight = minOf(height, rects.height * scale)
    if (visibleHeight < button) return emptyList()
    val half = button / 2
    val pins = mutableListOf<ArtifactReviewPin>()
    for ((anchor, group) in comments.filter { it.anchor != null }.groupBy { it.anchor!! }) {
        val rect = rects.byAnchor[anchor] ?: continue
        if (rect.x * scale >= width || (rect.x + rect.width) * scale <= 0 || rect.y * scale >= visibleHeight || rect.y + rect.height <= 0) continue
        var x = ((rect.x + rect.width) * scale).coerceIn(half, width - half)
        val y = (rect.y * scale).coerceIn(half, visibleHeight - half)
        while (x >= half + button && pins.any { abs(it.x - x) < button && abs(it.y - y) < button }) x -= button
        pins += ArtifactReviewPin(anchor, group.first().text.take(75), group.size, x, y)
    }
    return pins
}

/** All interactive targets are native Compose nodes, never elements in the WebView. */
@Composable
internal fun ArtifactReviewPinLayer(comments: List<ReviewComment>, rects: ArtifactAnchorRects, onPin: (String) -> Unit, modifier: Modifier = Modifier) {
    BoxWithConstraints(modifier) {
        val density = LocalDensity.current
        val size = 48.dp
        val pixels = with(density) { size.toPx() }
        val pins = artifactReviewPins(comments, rects, constraints.maxWidth.toFloat(), constraints.maxHeight.toFloat(), pixels)
        for (pin in pins) {
            val label = "${reviewCommentCount(pin.count)} on ${pin.label}"
            Box(Modifier.absoluteOffset { IntOffset((pin.x - pixels / 2).roundToInt(), (pin.y - pixels / 2).roundToInt()) }
                .size(size).semantics { contentDescription = label }.clickable(role = Role.Button) { onPin(pin.anchor) }, contentAlignment = Alignment.Center) {
                Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary, shadowElevation = 3.dp) {
                    Text("${pin.count}", Modifier.padding(horizontal = 9.dp, vertical = 3.dp), style = MaterialTheme.typography.labelLarge)
                }
            }
        }
    }
}
