package io.github.mitzacoder.kemiri.navigation

import io.github.mitzacoder.kemiri.protocol.ProjectSummary
import io.github.mitzacoder.kemiri.protocol.Board
import io.github.mitzacoder.kemiri.features.tasks.looseWaiting
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Same grouping/order as web sidebar-attention.ts. Older backends use activity only. */
enum class AttentionKind { Question, Warning, Coordinator, Worker, Thread, Steps, Review, Task }
data class AttentionAction(val kind: AttentionKind, val count: Long, val label: String, val taskId: String? = null, val threadId: String? = null)
data class BackendAttentionProjects(val key: String, val name: String, val projects: List<ProjectSummary>, val boards: Map<String, Board> = emptyMap())
data class ProjectAttentionLink(val backendKey: String, val backendName: String, val projectId: String, val projectName: String, val action: AttentionAction)

private fun stepsAction(count: Long, taskId: String?) =
    AttentionAction(AttentionKind.Steps, count, "$count with your steps", taskId)

internal fun attentionGlyph(kind: AttentionKind): String = when (kind) {
    AttentionKind.Question -> "?"
    AttentionKind.Steps -> "☷"
    AttentionKind.Review -> "✓"
    else -> "!"
}

fun projectAttentionActions(project: ProjectSummary, board: Board? = null): List<AttentionAction> = buildList {
    if (project.archived == true) return@buildList
    val summary = project.attention
    val coveredFailedTasks = summary?.failedTaskIds.orEmpty().toSet()
    val derived = board?.tasks?.any { it.state != null } == true
    if (derived) {
        val tasks = board.tasks.filter { !it.archived && it.state?.group == "needs_you" &&
            (it.state.kind != "failed" || (it.state.fromPartId ?: it.id) !in coveredFailedTasks) }
        val (steps, otherTasks) = tasks.partition { it.state?.kind == "steps_needed" }
        if (otherTasks.isNotEmpty()) add(AttentionAction(AttentionKind.Task, otherTasks.size.toLong(), "${otherTasks.size} need you", otherTasks.first().id))
        val loose = looseWaiting(board)
        if (loose.isNotEmpty()) add(AttentionAction(AttentionKind.Question, loose.size.toLong(), "${loose.size} question${if (loose.size == 1) "" else "s"}"))
        if (steps.isNotEmpty()) add(stepsAction(steps.size.toLong(), steps.first().id))
    } else {
        val questions = summary?.questions ?: project.activity?.openQuestions ?: 0
        if (questions > 0) add(AttentionAction(AttentionKind.Question, questions, "$questions question${if (questions == 1L) "" else "s"}", summary?.questionTaskId))
        val warnings = summary?.warnings ?: 0
        if (warnings > 0) add(AttentionAction(AttentionKind.Warning, warnings, "$warnings warning${if (warnings == 1L) "" else "s"}", summary?.warningTaskId))
    }
    if (project.state == "failed") add(AttentionAction(AttentionKind.Coordinator, 1, "Project failed"))
    val coordinators = summary?.failedCoordinators ?: if (project.state != "failed" && project.activity?.coordinator == "failed") 1 else 0
    if (coordinators > 0) add(AttentionAction(AttentionKind.Coordinator, coordinators,
        if (summary?.failedCoordinators == null) "Main chat failed" else if (coordinators == 1L) "Coordinator failed" else "$coordinators coordinators failed",
        threadId = summary?.failedCoordinatorId?.takeUnless { it == "main" }))
    if (derived && summary?.failedCoordinators == null) return@buildList // Older backends do not deduplicate failed task rows.
    val workers = summary?.failedWorkers ?: 0
    if (workers > 0) add(AttentionAction(AttentionKind.Worker, workers, if (workers == 1L) "Worker failed" else "$workers workers failed", summary?.failedWorkerTaskId))
    val threads = summary?.failedThreads ?: 0
    if (threads > 0) add(AttentionAction(AttentionKind.Thread, threads, if (threads == 1L) "Background job failed" else "$threads background jobs failed", threadId = summary?.failedThreadId))
    if (derived) return@buildList
    val steps = summary?.stepsTasks ?: 0
    if (steps > 0) add(stepsAction(steps, summary?.stepsTaskId))
    val reviews = summary?.reviewTasks ?: 0
    if (reviews > 0) add(AttentionAction(AttentionKind.Review, reviews, "$reviews to review", summary?.reviewTaskId))
}

fun attentionCount(project: ProjectSummary, board: Board? = null): Long = projectAttentionActions(project, board).sumOf { it.count }
fun needsYouLinks(backends: List<BackendAttentionProjects>): List<ProjectAttentionLink> = backends.flatMap { backend ->
    backend.projects.flatMap { project -> projectAttentionActions(project, backend.boards[project.id]).map { action -> ProjectAttentionLink(backend.key, backend.name, project.id, project.name, action) } }
}.sortedBy { it.action.kind.ordinal }

data class SidebarStatus(val label: String, val glyph: String, val urgent: Boolean = false, val working: Boolean = false)
fun sidebarStatus(project: ProjectSummary, row: ProjectStatus, board: Board? = null): SidebarStatus {
    val action = projectAttentionActions(project, board).firstOrNull()
    val running = project.attention?.runningWorkers ?: project.activity?.runningWorkers ?: 0
    val working = project.activity?.coordinator == "working" || running > 0
    if (action != null) return SidebarStatus(action.label, attentionGlyph(action.kind), action.kind != AttentionKind.Review, working)
    if (working) return SidebarStatus(if (running > 0) "Working · $running worker${if (running == 1L) "" else "s"}" else "Working", "◌", working = true)
    val returning = project.attention?.nextReturnAt?.let { try { Instant.parse(it).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofPattern("MMM d", Locale.getDefault())) } catch (_: java.time.DateTimeException) { null } }
    if (returning != null) return SidebarStatus("Returns $returning", "◷")
    val waiting = project.attention?.waitingTasks ?: 0
    if (waiting > 0) return SidebarStatus("$waiting waiting", "◷")
    return SidebarStatus(listOfNotNull(row.label, row.detail).joinToString(" · "), "·", row.tone == ProjectStatusTone.Warn || row.tone == ProjectStatusTone.Error)
}
