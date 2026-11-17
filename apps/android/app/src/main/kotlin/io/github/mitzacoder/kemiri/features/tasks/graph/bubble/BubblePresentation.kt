package io.github.mitzacoder.kemiri.features.tasks.graph.bubble

import io.github.mitzacoder.kemiri.features.tasks.graph.workerMotion
import io.github.mitzacoder.kemiri.protocol.*
import kotlin.math.*

data class GraphCounts(val open: Int, val working: Int, val attention: Int)
fun graphCounts(graph: TaskGraph): GraphCounts {
    val open = graph.nodes.filter { it.kind == "task" && it.task!!.status !in listOf("done", "dropped") }
    return GraphCounts(open.size, open.count { it.status in listOf("working", "in_progress", "clarifying") }, open.count { it.attention })
}
fun graphCaptionScale(zoom: Double) = max(1.0, .85 / zoom)
data class GraphEdgeSegment(val x1: Double, val y1: Double, val x2: Double, val y2: Double)
fun graphEdgeSegment(a: GraphPosition, b: GraphPosition): GraphEdgeSegment {
    val dx = b.x - a.x; val dy = b.y - a.y; val d = hypot(dx, dy).let { if (it == 0.0) 1.0 else it }
    return GraphEdgeSegment(a.x + dx / d * (a.radius + 5), a.y + dy / d * (a.radius + 5), b.x - dx / d * (b.radius + 9), b.y - dy / d * (b.radius + 9))
}
fun graphCrewMotion(node: GraphNode, tasks: List<BoardTask>, questions: List<BoardQuestion>): io.github.mitzacoder.kemiri.ui.components.AgentMotion {
    val taskId = node.parent?.takeIf { it.startsWith("task:") }?.removePrefix("task:") ?: node.worker?.taskId ?: node.thread?.taskId
    return workerMotion(node.worker?.status ?: node.thread?.status ?: "idle", tasks.find { it.id == taskId }, questions)
}
fun graphCrewInView(position: GraphPosition?, camera: GraphCamera, width: Double, height: Double): Boolean {
    if (position == null || width <= 0 || height <= 0) return false
    val radius = max(45.0, position.radius)
    return abs(position.x - camera.x) <= width / camera.zoom / 2 + radius && abs(position.y - camera.y) <= height / camera.zoom / 2 + radius
}
const val crewHandoffMs = 650L
const val crewFinishMs = 1700L
fun interpolateCrewHandoff(from: Map<String, GraphPosition>, to: Map<String, GraphPosition>, progress: Double): Map<String, GraphPosition> {
    val positions = interpolateGraphPositions(from, to, progress)
    val amount = 1 - (1 - progress.coerceIn(0.0, 1.0)).pow(3)
    positions.forEach { (id, position) ->
        val start = from[id]; val end = to.getValue(id)
        if (start != null && !id.startsWith("task:") && start.parentId != end.parentId) {
            val lift = min(96.0, hypot(end.x - start.x, end.y - start.y) * .25)
            position.y -= 4 * amount * (1 - amount) * lift
        }
    }
    return positions
}
fun departingGraphCrew(previous: TaskGraph, next: TaskGraph, workers: List<WorkerSummary>, threads: List<ThreadSummary>): List<GraphNode> {
    val retained = next.nodes.map { it.id }.toSet()
    return previous.nodes.filter { it.kind != "task" && it.id !in retained }.mapNotNull { node ->
        val worker = if (node.kind == "worker") workers.find { it.id == node.worker?.id } else null
        val thread = if (node.kind == "thread") threads.find { it.id == node.thread?.id } else null
        val status = worker?.status ?: thread?.status
        if (status != null && status !in listOf("done", "stopped")) null else node.copy(status = status ?: "done", worker = worker, thread = thread)
    }
}
data class GraphReportCue(val id: String, val workerId: String, val taskId: String)
fun graphReportCues(previous: Map<String, String?>, workers: List<WorkerSummary>, graph: TaskGraph): List<GraphReportCue> = workers.mapNotNull { worker ->
    val node = graph.nodes.find { it.worker?.id == worker.id }
    if (previous.containsKey(worker.id) && !worker.lastReport.isNullOrBlank() && previous[worker.id] != worker.lastReport && node?.parent?.startsWith("task:") == true)
        GraphReportCue("${worker.id}:${worker.updatedAt}:${worker.lastReport}", node.id, node.parent) else null
}
