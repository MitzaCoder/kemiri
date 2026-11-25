package io.github.mitzacoder.kemiri.data

import io.github.mitzacoder.kemiri.protocol.*

/** Wire snapshots only, before applying UI capability fallbacks. Owned by one socket's receiver. */
internal class BoardStreams {
    private val snapshots = mutableMapOf<String, BoardStateEvent>()

    fun accept(snapshot: BoardStateEvent) {
        if (snapshot.sequence != null) snapshots[snapshot.projectId] = snapshot
        else snapshots.remove(snapshot.projectId)
    }

    fun apply(delta: BoardDeltaEvent): BoardStateEvent? {
        val before = snapshots.remove(delta.projectId) ?: return null
        if (before.sequence != delta.baseSequence || delta.sequence != delta.baseSequence + 1) return null
        val board = applyBoardDelta(before.board, delta) ?: return null
        val liveOnly = delta.taskLive != null && delta.tasks == null && delta.questions == null &&
            delta.decisions == null && delta.archivedLinks == null && board.updatedAt == before.board.updatedAt
        return BoardStateEvent(projectId = delta.projectId, board = board, sequence = delta.sequence, liveOnly = true.takeIf { liveOnly })
            .also(::accept)
    }
}

private fun <Row> List<Row>.applyRowsDelta(
    upsert: List<Row>?, remove: List<String>?, order: List<String>?, id: (Row) -> String,
): List<Row> {
    val byId = associateByTo(LinkedHashMap(), id)
    remove?.forEach { byId.remove(it) }
    upsert?.forEach { byId[id(it)] = it }
    return order?.map { byId.getValue(it) } ?: byId.values.toList()
}

private fun applyBoardDelta(before: Board, delta: BoardDeltaEvent): Board? {
    var tasks = delta.tasks?.let { before.tasks.applyRowsDelta(it.upsert, it.remove, it.order, BoardTask::id) } ?: before.tasks
    if (delta.taskLive != null) {
        val liveByTask = delta.taskLive.associateByTo(mutableMapOf(), BoardTaskLiveDelta::taskId)
        tasks = tasks.map { task ->
            val live = task.live ?: return@map task
            val changes = liveByTask.remove(task.id) ?: return@map task
            task.copy(live = BoardTaskLive(
                lines = changes.lines?.let { live.lines.applyRowsDelta(it.upsert, it.remove, it.order, BoardLiveLine::id) } ?: live.lines,
                pulse = changes.pulse, counters = changes.counters, plan = changes.plan,
            ))
        }
        if (liveByTask.isNotEmpty()) return null
    }
    return before.copy(
        tasks = tasks,
        questions = delta.questions?.let { before.questions.applyRowsDelta(it.upsert, it.remove, it.order, BoardQuestion::id) } ?: before.questions,
        decisions = delta.decisions?.let { before.decisions.applyRowsDelta(it.upsert, it.remove, it.order, BoardDecision::id) } ?: before.decisions,
        archivedLinks = if (delta.archivedLinks == null) before.archivedLinks else delta.archivedLinks.let {
            before.archivedLinks.orEmpty().applyRowsDelta(it.upsert, it.remove, it.order, BoardTaskBrief::id).takeIf(List<BoardTaskBrief>::isNotEmpty)
        },
        updatedAt = delta.updatedAt,
    )
}
