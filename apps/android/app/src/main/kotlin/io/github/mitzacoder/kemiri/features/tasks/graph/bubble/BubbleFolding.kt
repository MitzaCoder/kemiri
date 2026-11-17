package io.github.mitzacoder.kemiri.features.tasks.graph.bubble

import io.github.mitzacoder.kemiri.features.tasks.graph.*
import io.github.mitzacoder.kemiri.protocol.BoardQuestion

/** Adapts bubble membership to T259's shared folding rules; chips never enter the layout solve. */
fun graphFoldGroups(graph: TaskGraph, questions: List<BoardQuestion> = emptyList()): List<GraphFold> {
    val tasks = graph.nodes.filter { it.kind == "task" }
    val family = graph.edges.filter { it.kind == "parent" }.flatMap { listOf(it.from, it.to) }.toSet()
    val busy = graph.nodes.filter { it.kind != "task" && it.status in listOf("running", "failed") }.mapNotNull { it.parent }.toSet()
    val candidates = linkedMapOf<String, GraphFoldKind>()
    tasks.forEach { node ->
        val task = node.task!!
        val section = task.state?.group ?: when {
            task.status in listOf("done", "dropped") -> "closed"
            task.status == "waiting" -> "waiting"
            questions.any { it.taskId == task.id && it.status == "open" && it.waitingOn != "agent" } -> "needs_you"
            task.status == "in_progress" -> "working"
            task.status in listOf("review", "blocked") -> task.status
            else -> "todo"
        }
        graphFoldCandidate(node.status, task.state != null, section,
            node.id in family || task.parent != null || (task.subtaskCount?.total ?: 0) > 0, node.id in busy, node.attention)?.let { candidates[task.id] = it }
    }
    return graphFoldCandidates(tasks.map { it.task!!.id }, candidates, graph.blockers())
}
private fun TaskGraph.blockers() = edges.filter { it.kind == "blockedBy" }.map { it.from.removePrefix("task:") to it.to.removePrefix("task:") }
fun graphFoldExpansion(graph: TaskGraph, groups: List<GraphFold>, expanded: Set<GraphFoldKind>, closing: GraphFoldKind? = null): Set<GraphFoldKind> =
    graphFoldExpansion(graph.blockers(), groups, expanded, closing)

fun liveTaskGraph(graph: TaskGraph, groups: List<GraphFold>, mode: GraphMode, expanded: Set<GraphFoldKind>, showResting: Boolean = false): TaskGraph {
    if (mode == GraphMode.All) return graph
    val revealed = graphFoldExpansion(graph, groups, expanded)
    val hidden = groups.filter { it.kind !in revealed }.flatMap { it.taskIds.map { id -> "task:$id" } }.toSet()
    val visible = graph.nodes.filter { it.kind == "task" && it.id !in hidden }.map { it.task!!.id }.toSet()
    val resting = graph.resting.associateByTo(linkedMapOf()) { it.id }
    val nodes = graph.nodes.filter { node ->
        if (node.kind == "task") node.id !in hidden
        else if (node.worker != null && node.parent != null && node.parent in hidden && graphWorkerRests(node.worker.status, graph.nodes.find { it.id == node.parent }?.task, visible)) {
            resting[node.worker.id] = node.worker
            showResting
        } else true
    }.map { if (it.parent in hidden) it.copy(parent = null) else it }
    val ids = nodes.map { it.id }.toSet()
    return TaskGraph(nodes, graph.edges.filter { it.from in ids && it.to in ids }, resting.values.toList())
}
fun renderedGraphNodes(shownGraph: TaskGraph, departures: List<GraphNode>): List<GraphNode> {
    val ids = shownGraph.nodes.map { it.id }.toSet()
    return shownGraph.nodes + departures.filter { it.id !in ids && it.kind != "task" && (it.parent?.startsWith("task:") != true || it.parent in ids) }
}
fun graphFoldPosition(positions: Map<String, GraphPosition>, previous: GraphPosition? = null): GraphPosition? {
    val tasks = positions.filterKeys { it.startsWith("task:") }.values
    if (tasks.isEmpty()) return null
    val x = previous?.x ?: ((tasks.minOf { it.x } + tasks.maxOf { it.x }) / 2)
    val y = maxOf(previous?.y ?: Double.NEGATIVE_INFINITY, tasks.maxOf { it.y + it.radius } + 150)
    return GraphPosition(x, y, x, y, radius = 90.0, parentId = null)
}
