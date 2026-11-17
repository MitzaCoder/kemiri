package io.github.mitzacoder.kemiri.features.tasks.graph

import io.github.mitzacoder.kemiri.data.DeviceSettings

enum class GraphMode(val stored: String, val label: String) { Live("live", "Live"), All("all", "All") }
fun graphMode(stored: String?): GraphMode = if (stored == "all") GraphMode.All else GraphMode.Live
fun DeviceSettings.graphMode(backend: String, project: String) = graphMode(projectGraphMode[backend]?.get(project))
fun DeviceSettings.withGraphMode(backend: String, project: String, mode: GraphMode) = copy(
    projectGraphMode = projectGraphMode + (backend to (projectGraphMode[backend].orEmpty() + (project to mode.stored))))

enum class GraphFoldKind(val stored: String, val label: String) { Todo("todo", "To do"), Waiting("waiting", "Waiting") }
data class GraphFold(val kind: GraphFoldKind, val taskIds: List<String>)

/** Both card and bubble adapters use this one candidate/prerequisite algorithm, in All task order. */
internal fun graphFoldCandidates(taskIds: List<String>, candidates: Map<String, GraphFoldKind>, blockers: List<Pair<String, String>>): List<GraphFold> {
    val shown = taskIds.filterNot(candidates::containsKey).toMutableSet()
    var changed: Boolean
    do {
        changed = false
        blockers.forEach { (from, to) -> if (from in shown && shown.add(to)) changed = true }
    } while (changed)
    return GraphFoldKind.entries.map { kind -> GraphFold(kind, taskIds.filter { candidates[it] == kind && it !in shown }) }.filter { it.taskIds.isNotEmpty() }
}
internal fun graphFoldCandidate(status: String, derived: Boolean, section: String, family: Boolean, busy: Boolean, attention: Boolean): GraphFoldKind? = when {
    family || busy || attention || section in listOf("needs_you", "review", "blocked", "working", "in_progress", "closed") -> null
    status == "todo" -> GraphFoldKind.Todo
    status == "waiting_outside" || (!derived && status == "waiting") -> GraphFoldKind.Waiting
    else -> null
}

/** Port of task-graph-live.ts: full All membership first, then only quiet standalone tasks may fold. */
fun revealGraphTask(groups: List<GraphFold>, expanded: Set<GraphFoldKind>, taskId: String?): Set<GraphFoldKind> =
    expanded + groups.filter { taskId in it.taskIds }.map { it.kind }

/** Opening includes prerequisite groups; closing a prerequisite closes its dependent groups, including cycles. */
internal fun graphFoldExpansion(blockers: List<Pair<String, String>>, groups: List<GraphFold>, expanded: Set<GraphFoldKind>, closing: GraphFoldKind?): Set<GraphFoldKind> {
    val groupOfTask = groups.flatMap { group -> group.taskIds.map { it to group.kind } }.toMap()
    val next = (expanded - setOfNotNull(closing)).toMutableSet()
    var changed: Boolean
    do {
        changed = false
        blockers.forEach { (from, to) ->
            val dependent = groupOfTask[from]; val prerequisite = groupOfTask[to]
            if (dependent != null && prerequisite != null && dependent != prerequisite && dependent in next && prerequisite !in next) {
                if (closing == null) next.add(prerequisite) else next.remove(dependent)
                changed = true
            }
        }
    } while (changed)
    return next
}
