package io.github.mitzacoder.kemiri.features.tasks.graph.bubble

import kotlin.math.*

/** Mutable solve state; every public reconciliation/interpolation copies its input positions. */
data class GraphPosition(var x: Double, var y: Double, var anchorX: Double, var anchorY: Double, var vx: Double = 0.0, var vy: Double = 0.0, var radius: Double, val parentId: String?)

// JS for-of visits code points but charCodeAt(0) hashes only the first UTF-16 code unit.
private fun seed(id: String): Double {
    var hash = 2166136261L
    var index = 0
    while (index < id.length) {
        val char = id[index]
        hash = ((hash xor char.code.toLong()) * 16777619L) and 0xffffffffL
        index += if (char.isHighSurrogate() && index + 1 < id.length && id[index + 1].isLowSurrogate()) 2 else 1
    }
    return hash / 4294967296.0
}
// Identifiers use the same locale-independent UTF-16 order as task-graph.ts (T10 before T2).
private val nodeOrder = compareBy<GraphNode> { it.id }

fun reconcileGraphPositions(graph: TaskGraph, previous: Map<String, GraphPosition> = emptyMap(), aspect: Double = 1.0): LinkedHashMap<String, GraphPosition> {
    val positions = linkedMapOf<String, GraphPosition>()
    val roots = graph.nodes.filter { it.kind == "task" && graph.nodes.none { p -> p.id == it.parent } }
    val families = roots.filter { root -> graph.nodes.any { it.kind == "task" && it.parent == root.id } }
    val singles = roots.filter { it !in families }
    val columns = if (aspect < 1) 1 else ceil(sqrt(families.size * aspect * .8)).toInt().coerceIn(2, 5)
    val familyRows = ceil(families.size.toDouble() / columns).toInt()
    val singleColumns = if (aspect < 1) 3 else 6
    graph.nodes.forEach { node -> previous[node.id]?.takeIf { node.kind == "task" || it.parentId == node.parent }?.let { positions[node.id] = it.copy(radius = node.radius) } }
    fun place(node: GraphNode, visited: MutableSet<String> = mutableSetOf()): GraphPosition {
        positions[node.id]?.let { return it }
        visited.add(node.id)
        val parent = graph.nodes.find { it.id == node.parent && it.id !in visited }
        var x: Double
        var y: Double
        if (parent != null) {
            val center = place(parent, visited)
            val siblings = graph.nodes.filter { it.parent == parent.id && (if (node.kind == "task") it.kind == "task" else it.kind != "task") }.sortedWith(nodeOrder)
            val angle = if (node.kind != "task") -PI / 2 + (siblings.indexOf(node) - (siblings.size - 1) / 2.0) * 1.1
                else if (parent.parent != null) -PI * .8 else siblings.indexOf(node).toDouble() / max(1, siblings.size) * PI * 2 - PI / 2
            val distance = if (node.kind == "task") (if (parent.parent != null) 200.0 else 220.0) else parent.radius + node.radius * .55
            x = center.x + cos(angle) * distance; y = center.y + sin(angle) * distance
        } else if (node in families) {
            val index = families.indexOf(node)
            x = 300.0 + index % columns * 680; y = 280.0 + index / columns * 540
        } else {
            val index = max(0, singles.indexOf(node))
            x = 135.0 + index % singleColumns * 220; y = familyRows * 540 + 180.0 + index / singleColumns * 175
            if (node.kind != "task") {
                val free = graph.nodes.filter { it.kind != "task" && it.parent == null }.indexOf(node) + singles.size
                x = 135.0 + free % singleColumns * 220; y = familyRows * 540 + 180.0 + free / singleColumns * 175
            }
        }
        val angle = seed(node.id + ":position") * PI * 2
        return GraphPosition(x + cos(angle) * 18, y + sin(angle) * 18, x, y, radius = node.radius, parentId = node.parent).also { positions[node.id] = it }
    }
    graph.nodes.forEach { place(it) }
    placeGraphCrewOnRims(graph, positions)
    return positions
}
fun placeGraphCrewOnRims(graph: TaskGraph, positions: MutableMap<String, GraphPosition>) {
    graph.nodes.filter { it.kind != "task" && it.parent != null }.forEach { node ->
        val parent = positions[node.parent] ?: return@forEach
        val position = positions[node.id] ?: return@forEach
        val siblings = graph.nodes.filter { it.kind != "task" && it.parent == node.parent }.sortedWith(nodeOrder)
        val angle = -PI / 2 + (siblings.indexOf(node) - (siblings.size - 1) / 2.0) * 1.1
        val distance = parent.radius + node.radius * .55
        position.x = parent.x + cos(angle) * distance; position.anchorX = position.x
        position.y = parent.y + sin(angle) * distance; position.anchorY = position.y
        position.vx = 0.0; position.vy = 0.0
    }
}
fun stepGraphLayout(positions: MutableMap<String, GraphPosition>, pinned: Set<String> = emptySet()): Double {
    val entries = positions.entries.toList()
    for (i in entries.indices) for (j in i + 1 until entries.size) {
        val (aid, a) = entries[i]; val (bid, b) = entries[j]
        val dx = (b.x - a.x).let { if (it == 0.0) .01 else it }; val dy = (b.y - a.y).let { if (it == 0.0) .01 else it }
        val distance = hypot(dx, dy)
        if ((a.parentId != null && !aid.startsWith("task:")) || (b.parentId != null && !bid.startsWith("task:"))) continue
        val minimum = a.radius + b.radius + 110
        if (distance >= minimum) continue
        val force = (minimum - distance) * .09
        a.vx -= dx / distance * force; a.vy -= dy / distance * force
        b.vx += dx / distance * force; b.vy += dy / distance * force
    }
    var energy = 0.0
    entries.forEach { (id, p) ->
        if (id in pinned) { p.vx = 0.0; p.vy = 0.0 } else {
            p.vx = (p.vx + (p.anchorX - p.x) * .025) * .72; p.vy = (p.vy + (p.anchorY - p.y) * .025) * .72
            p.x += p.vx; p.y += p.vy; energy += abs(p.vx) + abs(p.vy)
        }
    }
    return energy
}
fun settledGraphPositions(graph: TaskGraph, previous: Map<String, GraphPosition> = emptyMap(), aspect: Double = 1.0): LinkedHashMap<String, GraphPosition> {
    val positions = reconcileGraphPositions(graph, previous, aspect)
    val pinned = graph.nodes.filter { previous[it.id]?.let { p -> it.kind == "task" || p.parentId == it.parent } == true }.map { it.id }.toSet()
    val retained = positions.filterKeys { it in pinned }.mapValues { it.value.copy() }
    for (tick in 0 until 70) { val energy = stepGraphLayout(positions, pinned); if (tick > 20 && energy < .05) break }
    positions.putAll(retained)
    val tasks = graph.nodes.filter { it.kind == "task" }
    val occupied = tasks.filter { it.id in pinned }.map { positions.getValue(it.id) }.toMutableList()
    tasks.filter { it.id !in pinned }.forEach { node ->
        val p = positions.getValue(node.id); val x = p.x; val y = p.y
        fun free(x: Double, y: Double) = occupied.all { abs(x - it.x) >= 200 || abs(y - it.y) >= p.radius + it.radius + 90 }
        if (!free(x, y)) {
            search@ for (ring in 1..graph.nodes.size) for (dy in -ring..ring) for (dx in -ring..ring) {
                if (max(abs(dx), abs(dy)) != ring) continue
                val candidateX = x + dx * 50; val candidateY = y + dy * 50
                if (free(candidateX, candidateY)) { p.x = candidateX; p.y = candidateY; break@search }
            }
        }
        p.anchorX = p.x; p.anchorY = p.y; occupied.add(p)
    }
    placeGraphCrewOnRims(graph, positions)
    return positions
}
fun interpolateGraphPositions(from: Map<String, GraphPosition>, to: Map<String, GraphPosition>, progress: Double): Map<String, GraphPosition> {
    val amount = 1 - (1 - progress.coerceIn(0.0, 1.0)).pow(3)
    return to.mapValues { (id, p) ->
        val start = from[id]
        if (progress >= 1) p.copy() else if (start != null) p.copy(x = start.x + (p.x - start.x) * amount, y = start.y + (p.y - start.y) * amount)
        else p.copy(y = p.y + (1 - amount) * 12)
    }
}
