package io.github.mitzacoder.kemiri.features.chat

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.layout.layoutId
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import kotlinx.serialization.json.*
import kotlin.math.abs
import kotlin.math.roundToInt

internal data class ArtifactAnchorRect(val x: Int, val y: Int, val width: Int, val height: Int, val scrollsWithPage: Boolean)
internal data class ArtifactAnchorRects(val width: Int, val height: Int, val scrollX: Int, val scrollY: Int, val byAnchor: Map<String, ArtifactAnchorRect>)
private val RECT_VALUES = Regex("""(-?\d{1,7}),(-?\d{1,7}),(\d{1,7}),(\d{1,7}),([01])""")

internal fun artifactReviewPaths(comments: List<ReviewComment>): List<String> = comments.asSequence()
    .mapNotNull { it.anchor?.takeIf(::validPageAnchor)?.drop(2) }.distinct().take(100).toList()

/** A WebView can lie about its own geometry, but cannot point pins outside the native document surface. */
internal fun decodeArtifactAnchorRects(evaluated: String, watchedPaths: List<String>): ArtifactAnchorRects? = runCatching {
    if (evaluated.length > 50_000) return null
    val outer = Json.parseToJsonElement(evaluated) as? JsonPrimitive ?: return null
    if (!outer.isString) return null
    val fields = Json.parseToJsonElement(outer.content) as? JsonObject ?: return null
    if (fields.keys != setOf("width", "height", "scrollX", "scrollY", "rects")) return null
    fun boundedInt(key: String, bounds: IntRange) =
        (fields[key] as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull?.takeIf { it in bounds }
    val width = boundedInt("width", 1..100_000) ?: return null
    val height = boundedInt("height", 1..100_000) ?: return null
    val scrollX = boundedInt("scrollX", -9_999_999..9_999_999) ?: return null
    val scrollY = boundedInt("scrollY", -9_999_999..9_999_999) ?: return null
    val payload = (fields["rects"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
    val rects = mutableMapOf<String, ArtifactAnchorRect>()
    if (payload.isNotEmpty()) for (entry in payload.split('|')) {
        val path = entry.substringBefore('=')
        if (path !in watchedPaths || !ARTIFACT_REVIEW_PATH.matches(path) || rects.containsKey("p:$path")) return null
        val match = RECT_VALUES.matchEntire(entry.substringAfter('=', "")) ?: return null
        val (x, y, w, h, scrollsWithPage) = match.destructured
        if (w.toInt() == 0 || h.toInt() == 0) return null
        rects["p:$path"] = ArtifactAnchorRect(x.toInt(), y.toInt(), w.toInt(), h.toInt(), scrollsWithPage == "1")
    }
    ArtifactAnchorRects(width, height, scrollX, scrollY, rects)
}.getOrNull()

internal data class ArtifactReviewPin(val anchor: String, val label: String, val count: Int, val x: Float, val y: Float)
internal fun artifactReviewPins(
    comments: List<ReviewComment>, rects: ArtifactAnchorRects, width: Float, height: Float, button: Float, scroll: IntOffset,
): List<ArtifactReviewPin> {
    if (width < button || height < button) return emptyList()
    val scale = width / rects.width
    val visibleHeight = minOf(height, rects.height * scale)
    if (visibleHeight < button) return emptyList()
    val half = button / 2
    val pins = mutableListOf<ArtifactReviewPin>()
    for ((anchor, group) in comments.filter { it.anchor != null }.groupBy { it.anchor!! }) {
        val rect = rects.byAnchor[anchor] ?: continue
        // Reproject page-relative targets using the WebView's present native scroll instead of waiting for JS.
        val left = if (rect.scrollsWithPage) (rect.x + rects.scrollX) * scale - scroll.x else rect.x * scale
        val right = left + rect.width * scale
        val y = if (rect.scrollsWithPage) (rect.y + rects.scrollY) * scale - scroll.y else rect.y * scale
        if (left >= width || right <= 0 || y < 0 || y >= visibleHeight) continue
        var x = right.coerceIn(half, width - half)
        while (x >= half + button && pins.any { abs(it.x - x) < button && abs(it.y - y) < button }) x -= button
        pins += ArtifactReviewPin(anchor, group.first().text.take(75), group.size, x, y)
    }
    return pins
}

/** All interactive targets are native Compose nodes, never elements in the WebView. */
@Composable
internal fun ArtifactReviewPinLayer(comments: List<ReviewComment>, rects: ArtifactAnchorRects, scroll: () -> IntOffset, onPin: (String) -> Unit, modifier: Modifier = Modifier) {
    val groups = comments.filter { it.anchor in rects.byAnchor }.groupBy { it.anchor!! }
    Layout(modifier = modifier, content = {
        for ((anchor, group) in groups) key(anchor) {
            val label = "${reviewCommentCount(group.size)} on ${group.first().text.take(75)}"
            Box(Modifier.layoutId(anchor).semantics { contentDescription = label }
                .clickable(role = Role.Button) { onPin(anchor) }, contentAlignment = Alignment.Center) {
                Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.primary, contentColor = MaterialTheme.colorScheme.onPrimary, shadowElevation = 3.dp) {
                    Text("${group.size}", Modifier.padding(horizontal = 9.dp, vertical = 3.dp), style = MaterialTheme.typography.labelLarge)
                }
            }
        }
    }) { measurables, constraints ->
        val size = 48.dp.roundToPx()
        val buttons = measurables.associate { it.layoutId to it.measure(Constraints.fixed(size, size)) }
        layout(constraints.maxWidth, constraints.maxHeight) {
            // Reading scroll here invalidates placement, not composition or measurement.
            val pins = artifactReviewPins(comments, rects, constraints.maxWidth.toFloat(), constraints.maxHeight.toFloat(), size.toFloat(), scroll())
            for (pin in pins) buttons[pin.anchor]?.place((pin.x - size / 2f).roundToInt(), (pin.y - size / 2f).roundToInt())
        }
    }
}
