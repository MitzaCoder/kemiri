package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.protocol.BoardTask

internal enum class PartTone { Done, Working, NeedsYou, Other }
internal data class PartSegment(val tone: PartTone, val count: Int)
internal data class TaskPartProgress(val text: String, val segments: List<PartSegment>, val proportional: Boolean)

internal fun taskPartProgress(task: BoardTask): TaskPartProgress? {
    val states = task.subtaskStates?.filter { it != "dropped" }?.takeIf { it.isNotEmpty() } ?: return null
    fun tone(kind: String) = when (kind) {
        "done" -> PartTone.Done
        "working" -> PartTone.Working
        "failed", "answer_needed", "review" -> PartTone.NeedsYou
        else -> PartTone.Other
    }
    val counts = PartTone.entries.map { PartSegment(it, states.count { state -> tone(state) == it }) }
    val text = "${counts[0].count} of ${states.size} parts done" +
        (if (counts[1].count > 0) " · ${counts[1].count} working" else "") +
        (if (counts[2].count > 0) " · ${counts[2].count} needs you" else "")
    val proportional = states.size > 12
    val segments = if (proportional) counts.filter { it.count > 0 } else counts.flatMap { group -> List(group.count) { PartSegment(group.tone, 1) } }
    return TaskPartProgress(text, segments, proportional)
}

internal fun taskUsesPartsSentence(task: BoardTask): Boolean =
    taskPartProgress(task) != null && task.state?.group in listOf("in_progress", "todo")
