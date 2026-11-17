package io.github.mitzacoder.kemiri.features.tasks.graph

import io.github.mitzacoder.kemiri.data.DeviceSettings

enum class GraphMode(val stored: String, val label: String) { Live("live", "Live"), All("all", "All") }
fun graphMode(stored: String?): GraphMode = if (stored == "all") GraphMode.All else GraphMode.Live
fun DeviceSettings.graphMode(backend: String, project: String) = graphMode(projectGraphMode[backend]?.get(project))
fun DeviceSettings.withGraphMode(backend: String, project: String, mode: GraphMode) = copy(
    projectGraphMode = projectGraphMode + (backend to (projectGraphMode[backend].orEmpty() + (project to mode.stored))))

enum class GraphFoldKind(val stored: String, val label: String) { Todo("todo", "To do"), Waiting("waiting", "Waiting") }
data class GraphFold(val kind: GraphFoldKind, val taskIds: List<String>)

/** Port of task-graph-live.ts: full All membership first, then only quiet standalone tasks may fold. */
fun graphFoldGroups(model: GraphModel, allTaskIds: Set<String>): List<GraphFold> {
    val tasks = model.details.values.filter { it.task.id in allTaskIds }
    val family = tasks.flatMap { d -> d.task.parent?.takeIf(allTaskIds::contains)?.let { listOf(d.task.id, it) }.orEmpty() }.toSet()
    val threadParents = model.threads.filter { !it.main && !it.archived && it.status != "done" }.associate { thread ->
        thread.id to (thread.taskId?.takeIf(allTaskIds::contains) ?: thread.ownedTasks.firstOrNull(allTaskIds::contains))
    }
    val busy = model.threads.filter { !it.main && !it.archived && it.status in listOf("running", "failed") }.mapNotNull { threadParents[it.id] }.toMutableSet()
    model.workers.filter { it.status in listOf("running", "failed") }.forEach { worker ->
        val task = model.workerTask(worker)
        if (!graphWorkerRests(worker.status, task, allTaskIds))
            (task?.id?.takeIf(allTaskIds::contains) ?: threadParents[worker.threadId])?.let(busy::add)
    }
    val candidates = linkedMapOf<String, GraphFoldKind>()
    tasks.forEach { d ->
        val task = d.task
        val section = task.state?.group ?: when {
            graphClosed(task.status) -> "closed"
            task.status == "waiting" -> "waiting"
            d.questions.isNotEmpty() -> "needs_you"
            else -> task.status
        }
        val attention = if (task.state != null) task.state.group == "needs_you" else task.status == "review" || d.questions.isNotEmpty() || model.workers.any { it.status == "failed" && it.taskId == task.id }
        if (task.id in family || task.parent != null || (task.subtaskCount?.total ?: 0) > 0 || task.id in busy || attention ||
            section in listOf("needs_you", "review", "blocked", "working", "in_progress", "closed")) return@forEach
        when (task.state?.kind ?: task.status) {
            "todo" -> candidates[task.id] = GraphFoldKind.Todo
            "waiting_outside" -> candidates[task.id] = GraphFoldKind.Waiting
            "waiting" -> if (task.state == null) candidates[task.id] = GraphFoldKind.Waiting
        }
    }
    val shown = allTaskIds.filterNot(candidates::containsKey).toMutableSet()
    var changed: Boolean
    do {
        changed = false
        tasks.filter { it.task.id in shown }.forEach { d ->
            d.task.blockedBy.filter(allTaskIds::contains).forEach { if (shown.add(it)) changed = true }
        }
    } while (changed)
    return GraphFoldKind.entries.map { kind -> GraphFold(kind, candidates.filter { it.value == kind && it.key !in shown }.keys.toList()) }.filter { it.taskIds.isNotEmpty() }
}

fun revealGraphTask(groups: List<GraphFold>, expanded: Set<GraphFoldKind>, taskId: String?): Set<GraphFoldKind> =
    expanded + groups.filter { taskId in it.taskIds }.map { it.kind }

/** Opening includes prerequisite groups; closing a prerequisite closes its dependent groups, including cycles. */
fun graphFoldExpansion(model: GraphModel, groups: List<GraphFold>, expanded: Set<GraphFoldKind>, closing: GraphFoldKind? = null): Set<GraphFoldKind> {
    val groupOfTask = groups.flatMap { group -> group.taskIds.map { it to group.kind } }.toMap()
    val next = (expanded - setOfNotNull(closing)).toMutableSet()
    var changed: Boolean
    do {
        changed = false
        groupOfTask.forEach { (id, dependent) -> model.details[id]?.task?.blockedBy.orEmpty().forEach { target ->
            val prerequisite = groupOfTask[target]
            if (prerequisite != null && dependent != prerequisite && dependent in next && prerequisite !in next) {
                if (closing == null) next.add(prerequisite) else next.remove(dependent)
                changed = true
            }
        } }
    } while (changed)
    return next
}

fun graphShownTaskIds(model: GraphModel, allTaskIds: Set<String>, groups: List<GraphFold>, mode: GraphMode, expanded: Set<GraphFoldKind>): Set<String> {
    if (mode == GraphMode.All) return allTaskIds
    val revealed = graphFoldExpansion(model, groups, expanded)
    return allTaskIds - groups.filter { it.kind !in revealed }.flatMap { it.taskIds }.toSet()
}
