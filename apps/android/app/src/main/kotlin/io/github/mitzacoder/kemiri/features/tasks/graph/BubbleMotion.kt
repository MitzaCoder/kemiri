package io.github.mitzacoder.kemiri.features.tasks.graph

import androidx.compose.animation.core.Animatable
import io.github.mitzacoder.kemiri.features.tasks.graph.bubble.*
import io.github.mitzacoder.kemiri.features.tasks.graph.bubble.TaskGraph
import io.github.mitzacoder.kemiri.protocol.*

internal data class BubbleMotionBatch(
    val serial: Long = 0, val reset: Boolean = false,
    val reports: List<GraphReportCue> = emptyList(),
    val departures: List<GraphNode> = emptyList(), val arrivals: Set<String> = emptySet(),
)

/** Authoritative reads, not mounted nodes, own the baseline. Filters never invent arrivals or replay reports. */
internal class BubbleMotionBaseline {
    private var generation: Int? = null
    private var graph: TaskGraph? = null
    private var reports = emptyMap<String, String?>()
    private var crewIds = emptySet<String>()
    private var serial = 0L
    fun read(next: TaskGraph, workers: List<WorkerSummary>, threads: List<ThreadSummary>, generation: Int): BubbleMotionBatch {
        val previous = graph
        val reset = previous == null || this.generation != generation
        val ids = workers.map { "worker:${it.id}" }.toSet() + threads.map { "thread:${it.id}" }
        val batch = if (reset) BubbleMotionBatch(++serial, reset = true) else BubbleMotionBatch(++serial,
            reports = graphReportCues(reports, workers, next),
            departures = departingGraphCrew(previous, next, workers, threads),
            arrivals = next.nodes.filter { it.kind != "task" && it.id !in crewIds }.map { it.id }.toSet())
        this.generation = generation; graph = next
        reports = workers.associate { it.id to it.lastReport }; crewIds = ids
        return batch
    }
}

internal class BubbleDeparture(val node: GraphNode, val position: GraphPosition) {
    val progress = Animatable(0f)
}
internal class BubbleReport(val cue: GraphReportCue, val from: GraphPosition, val to: GraphPosition) {
    val progress = Animatable(0f)
}
internal data class BubblePlacement(val positions: Map<String, GraphPosition>, val from: Map<String, GraphPosition> = emptyMap())

/** Reuse the vector-checked web arc without moving the retained task paint layer. */
internal fun bubbleCrewPosition(id: String, placement: BubblePlacement, progress: Float): GraphPosition? {
    val end = placement.positions[id] ?: return null
    val start = placement.from[id] ?: return end
    if (start.parentId == end.parentId || id.startsWith("task:") || progress >= 1f) return end
    return interpolateCrewHandoff(mapOf(id to start), mapOf(id to end), progress.toDouble())[id]
}
