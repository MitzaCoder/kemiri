package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.protocol.*

internal fun requestRows(tasks: List<BoardTask>, requestAttention: Boolean): List<BoardTask> =
    if (requestAttention) tasks.filter { it.parent == null } else tasks

internal data class RequestAttention(val taskId: String, val questionId: String?, val text: String)

internal fun requestAttention(task: BoardTask, questions: List<BoardQuestion>): RequestAttention? {
    val state = task.state?.takeIf { it.group == "needs_you" } ?: return null
    val taskId = state.fromPartId ?: task.id
    val questionRefs = state.refs.takeIf { state.kind == "answer_needed" }.orEmpty()
    val question = questionRefs.firstNotNullOfOrNull { ref -> questions.find { it.id == ref && it.taskId == taskId && it.postponed != true } }
    val text = question?.let { firstLine(it.text, 160) } ?: state.sentence?.text ?: taskStateLabel(task)
    val part = state.fromPartTitle ?: state.fromPartId
    return RequestAttention(taskId, question?.id ?: questionRefs.firstOrNull(),
        if (part == null) text else "$text · asked while building “$part”")
}

internal fun requestPartRows(rows: List<TaskRow>): List<TaskRow> = rows.filter { it.task.status != "done" }
    .sortedWith(compareBy<TaskRow> { partTone(it.task.state?.kind.takeUnless { _ -> it.task.state?.group == "later" }) !in setOf(PartTone.Working, PartTone.NeedsYou) }
        .thenBy { it.task.order }.thenComparing({ it.task.id }, taskIdOrder))

internal fun partStateLabel(state: String): String = when (state) {
    "answer_needed" -> "Answer needed"
    "steps_needed" -> "Your steps"
    "review" -> "In review"
    "blocked_by_task" -> "Blocked"
    "waiting_outside" -> "Waiting"
    else -> taskStatusWords(state)
}

internal data class PartsChecklistRow(val part: PartsDigestPartsItem, val summary: String, val counts: String)

internal const val PARTS_CHECKLIST_PREVIEW = 5

internal fun partsChecklist(digest: PartsDigest, proof: List<ArtifactsListResponsePartProofItem>): List<PartsChecklistRow> {
    val proofByPart = proof.associateBy { it.partId }
    fun countLabel(count: Long, noun: String) = "$count $noun${if (count == 1L) "" else "s"}"
    return digest.parts.map { part ->
        val counts = buildList {
            add(countLabel(part.checks.total, "check"))
            if (part.checks.failed > 0) add("${part.checks.failed} failed")
            proofByPart[part.id]?.let { counts ->
                listOf(counts.images to "image", counts.videos to "video", counts.html to "page", counts.files to "file")
                    .filter { it.first > 0 }.forEach { (count, noun) -> add(countLabel(count, noun)) }
            }
        }
        PartsChecklistRow(part, firstLine(part.summary, 200), counts.joinToString(" · "))
    }
}

internal data class RequestPartPage(val requestId: String, val position: String, val closure: String?, val closedAt: String?)

internal fun requestPartPage(task: BoardTask, tasks: List<BoardTask>, digestSupported: Boolean): RequestPartPage? {
    if (!digestSupported || task.parent == null) return null
    val requestId = task.requestId ?: task.parent
    val parts = tasks.find { it.id == requestId }?.partsDigest?.parts.orEmpty()
    val index = parts.indexOfFirst { it.id == task.id }
    val part = parts.getOrNull(index)
    val closedAt = if (isSettled(task.status)) part?.closedAt ?: task.settledAt else null
    val closedBy = if (isSettled(task.status)) part?.closedBy ?: task.updatedBy.takeIf { task.updatedAt == closedAt } else null
    val closure = when {
        closedBy == "user" -> "Closed by you"
        closedBy == "coordinator" && task.status == "done" -> "Checked by the coordinator"
        else -> null
    }
    return RequestPartPage(requestId, if (part == null) "Part" else "Part ${index + 1} of ${parts.size}", closure, closedAt)
}

internal data class TaskPageActions(val canClose: Boolean, val reopenWithNote: Boolean, val comment: Boolean)

internal fun taskPageActions(task: BoardTask, part: RequestPartPage?): TaskPageActions =
    TaskPageActions(canClose = part == null, reopenWithNote = part != null && isSettled(task.status), comment = part != null)

internal data class PartProofOrigin(val partId: String, val title: String)

internal fun proofPartOrigin(artifact: Artifact, parts: List<PartsDigestPartsItem>): PartProofOrigin? =
    (parts.firstOrNull { it.id == artifact.taskId } ?: parts.firstOrNull { it.id in artifact.laterTaskIds.orEmpty() })
        ?.let { PartProofOrigin(it.id, it.title) }
