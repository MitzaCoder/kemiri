package io.github.mitzacoder.kemiri.features.tasks.graph.bubble

import io.github.mitzacoder.kemiri.data.DeviceSettings
import kotlinx.serialization.Serializable
import kotlin.math.*

@Serializable
data class GraphCamera(val x: Double = 0.0, val y: Double = 0.0, val zoom: Double = 1.0)
fun validGraphCamera(camera: GraphCamera?) = camera?.takeIf { it.x.isFinite() && it.y.isFinite() && it.zoom.isFinite() && it.zoom in .08..4.0 }
/** Android uses structured backend/project keys rather than concatenated browser storage keys. */
fun loadGraphCamera(settings: DeviceSettings, backend: String, project: String): GraphCamera? = validGraphCamera(settings.projectBubbleCamera[backend]?.get(project))
fun saveGraphCamera(settings: DeviceSettings, backend: String, project: String, camera: GraphCamera): DeviceSettings =
    settings.copy(projectBubbleCamera = settings.projectBubbleCamera + (backend to (settings.projectBubbleCamera[backend].orEmpty() + (project to camera))))

fun fitGraphCamera(positions: Map<String, GraphPosition>, width: Double, height: Double): GraphCamera {
    if (positions.isEmpty()) return GraphCamera()
    val points = positions.values
    val left = points.minOf { it.x - max(80.0, it.radius) } - 30; val right = points.maxOf { it.x + max(80.0, it.radius) } + 30
    val top = points.minOf { it.y - it.radius } - 48; val bottom = points.maxOf { it.y + it.radius } + 100
    val padding = if (width < 600) 24 else 48
    return GraphCamera((left + right) / 2, (top + bottom) / 2, max(.08, minOf(1.4, (width - padding * 2) / (right - left), (height - padding * 2) / (bottom - top))))
}
data class GraphLabelBox(val x: Double, val y: Double, val width: Double, val height: Double, val text: String, val lines: List<String>, val scale: Double)
private data class Box(val x: Double, val y: Double, val width: Double, val height: Double)
private fun GraphLabelBox.box() = Box(x, y, width, height)
private fun boxesOverlap(a: Box, b: Box) = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
fun truncatedGraphTitle(title: String) = if (title.length > 23) title.take(22) + "…" else title
fun graphTitleLines(title: String): List<String> {
    val lines = mutableListOf<String>(); var line = ""
    for (word in title.split(Regex("[\\s\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+"))) {
        if (line.isNotEmpty() && (line + " " + word).length > 24) { lines.add(line); line = word }
        else line += (if (line.isNotEmpty()) " " else "") + word
    }
    if (line.isNotEmpty()) lines.add(line)
    return lines.take(2).mapIndexed { index, text -> if (text.length > 24 || (index == 1 && lines.size > 2)) text.take(23) + "…" else text }
}
/** All graph first, then filter by shown IDs. IDs remain visible at every zoom. */
fun placeGraphLabels(graph: TaskGraph, positions: Map<String, GraphPosition>, camera: GraphCamera): Map<String, GraphLabelBox> {
    val labels = linkedMapOf<String, GraphLabelBox>()
    val preferredScale = max(1.0, .85 / camera.zoom)
    graph.nodes.forEach { node ->
        if (node.kind != "task" || (camera.zoom < .6 && node.radius <= 35)) return@forEach
        val p = positions[node.id] ?: return@forEach
        val lines = graphTitleLines(node.title)
        labels[node.id] = GraphLabelBox(p.x - 80, p.y + p.radius + 12 + 18 * preferredScale, 160.0, lines.size * 16.0, node.title, lines, 1.0)
    }
    labels.keys.toList().forEach { id ->
        val base = labels.getValue(id)
        val occupied = positions.filterKeys { it != id }.values.map { Box(it.x - it.radius - 7, it.y - it.radius - 7, it.radius * 2 + 14, it.radius * 2 + 14) }
        val otherLabels = labels.filterKeys { it != id }.values.map { it.box() }
        if (camera.zoom < .6 && occupied.any { boxesOverlap(base.box(), it) }) { labels.remove(id); return@forEach }
        var scale = preferredScale
        while (scale > 1) {
            val box = base.copy(x = base.x + 80 - 80 * scale, width = 160 * scale, height = base.lines.size * 16 * scale, scale = scale)
            if ((occupied + otherLabels).none { boxesOverlap(box.box(), it) }) { labels[id] = box; break }
            scale = max(1.0, scale - .15)
        }
    }
    return labels
}
