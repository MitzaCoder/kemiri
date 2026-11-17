package io.github.mitzacoder.kemiri.features.tasks.graph.bubble

import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.features.tasks.graph.graphWorkerRests
import io.github.mitzacoder.kemiri.features.tasks.taskStateLabel

/** World units and Double precision match the web bubble graph, not the retired card geometry. */
data class GraphNode(
    val id: String, val kind: String, val title: String, val status: String,
    val parent: String?, val attention: Boolean, val radius: Double,
    val task: BoardTask? = null, val worker: WorkerSummary? = null, val thread: ThreadSummary? = null,
)
data class GraphEdge(val id: String, val from: String, val to: String, val kind: String)
data class TaskGraph(val nodes: List<GraphNode>, val edges: List<GraphEdge>, val resting: List<WorkerSummary>)

fun visibleGraphTasks(tasks: List<BoardTask>, showClosed: Boolean = false) = tasks.filter {
    !it.archived && (showClosed || it.status !in listOf("done", "dropped"))
}

fun buildTaskGraph(tasks: List<BoardTask>, questions: List<BoardQuestion>, workers: List<WorkerSummary>, threads: List<ThreadSummary>, showClosed: Boolean = false, showResting: Boolean = false): TaskGraph {
    val shown = visibleGraphTasks(tasks, showClosed)
    val visible = shown.map { it.id }.toSet()
    val failed = workers.filter { it.status == "failed" }.mapNotNull { it.taskId }.toSet()
    val attention = questions.filter { it.status == "open" && it.waitingOn != "agent" }.mapNotNull { it.taskId }.toSet() + failed
    val nodes = shown.map { task -> GraphNode("task:${task.id}", "task", task.title,
        task.state?.kind ?: if (task.id in failed) "failed" else task.status,
        task.parent?.let { "task:$it" }, task.state?.let { it.group == "needs_you" } ?: (task.status == "review" || task.id in attention),
        if ((task.subtaskCount?.total ?: tasks.count { it.parent == task.id }.toLong()) > 0) 47.0 else 29.0, task = task)
    }.toMutableList()
    val edges = linkedMapOf<String, GraphEdge>()
    fun add(from: String, to: String, kind: String) {
        if (from == to) return
        val id = if (kind == "related") "$kind:${listOf(from, to).sorted().joinToString(":")}" else "$kind:$from:$to"
        edges.putIfAbsent(id, GraphEdge(id, from, to, kind))
    }
    shown.forEach { task ->
        listOf("parent" to listOfNotNull(task.parent), "foundWhile" to listOfNotNull(task.foundWhile), "blockedBy" to task.blockedBy, "related" to task.related.orEmpty()).forEach { (kind, targets) ->
            targets.forEach { add("task:${task.id}", "task:$it", kind) }
        }
    }
    threads.filter { !it.main && !it.archived && it.status != "done" }.forEach { thread ->
        val parent = thread.taskId?.takeIf { it in visible } ?: thread.ownedTasks.firstOrNull { it in visible }
        nodes.add(GraphNode("thread:${thread.id}", "thread", thread.title, thread.status, parent?.let { "task:$it" }, false, 32.0, thread = thread))
    }
    val resting = mutableListOf<WorkerSummary>()
    workers.filter { it.status !in listOf("done", "stopped") }.forEach { worker ->
        val thread = nodes.find { it.id == "thread:${worker.threadId}" }
        val taskId = worker.taskId ?: tasks.find { worker.id in it.workerIds }?.id
        val task = tasks.find { it.id == taskId }
        if (graphWorkerRests(worker.status, task, visible)) {
            resting.add(worker)
            if (!showResting) return@forEach
        }
        if (task == null && thread == null && worker.status !in listOf("running", "idle", "failed")) return@forEach
        nodes.add(GraphNode("worker:${worker.id}", "worker", worker.title, worker.status,
            if (task != null && task.id in visible) "task:${task.id}" else thread?.parent, false, 21.0, worker = worker))
    }
    val ids = nodes.map { it.id }.toSet()
    return TaskGraph(nodes, edges.values.filter { it.from in ids && it.to in ids }, resting)
}

fun graphNeighborhood(graph: TaskGraph, id: String?): Set<String> {
    if (id == null) return graph.nodes.map { it.id }.toSet()
    val family = linkedSetOf(id)
    do {
        var changed = false
        graph.edges.filter { it.kind == "parent" }.forEach { edge ->
            if (edge.from in family || edge.to in family) {
                if (family.add(edge.from)) changed = true
                if (family.add(edge.to)) changed = true
            }
        }
    } while (changed)
    val highlighted = family.toMutableSet()
    graph.edges.filter { it.kind == "blockedBy" && (it.from in family || it.to in family) }.forEach { highlighted.addAll(listOf(it.from, it.to)) }
    graph.nodes.filter { it.kind != "task" && it.parent in highlighted }.forEach { highlighted.add(it.id) }
    return highlighted
}
fun visibleGraphEdges(graph: TaskGraph, focused: String? = null, allLinks: Boolean = false): List<GraphEdge> {
    val neighborhood = if (focused != null) graphNeighborhood(graph, focused) else emptySet()
    return graph.edges.filter { it.kind in listOf("parent", "blockedBy") || (it.kind in listOf("foundWhile", "related") && (allLinks || it.from in neighborhood || it.to in neighborhood)) }
}
fun graphLabel(node: GraphNode): String {
    val status = when {
        node.task?.state?.kind == "waiting_outside" -> node.task.waiting?.note?.takeIf { it.isNotEmpty() }?.let {
            if (Regex("^waiting for\\b", RegexOption.IGNORE_CASE).containsMatchIn(it)) it else "Waiting for $it"
        } ?: "Waiting"
        node.task?.state != null -> taskStateLabel(node.task)
        else -> node.status.replace('_', ' ')
    }
    return "${if (node.kind == "task") node.task?.id else node.kind}: ${node.title}, $status" +
        (if (node.attention) ", needs attention" else "") +
        (node.task?.subtaskCount?.let { ", ${it.done} of ${it.total} subtasks done" } ?: "")
}
