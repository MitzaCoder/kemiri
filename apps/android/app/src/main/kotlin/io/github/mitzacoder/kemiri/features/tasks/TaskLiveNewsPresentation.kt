package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.navigation.ChatHighlight
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.protocol.BoardLiveLine
import io.github.mitzacoder.kemiri.protocol.WorkerSummary

internal data class LiveEvidenceStep(val entryId: String, val description: String, val count: Int = 1) {
    val label: String get() = if (count > 1) "$description ×$count" else description
}

internal data class AutoLinePresentation(val mark: String, val evidence: List<LiveEvidenceStep>, val wrongLabel: String?) {
    val struckThrough get() = wrongLabel != null
    val canMarkWrong get() = !struckThrough
}

internal fun autoLinePresentation(kind: LiveLineKind, line: BoardLiveLine): AutoLinePresentation? {
    if (kind != LiveLineKind.Auto) return null
    // The server has merged each call with its result. Group only consecutive identical descriptions, as on web.
    val groups = mutableListOf<LiveEvidenceStep>()
    for (step in line.evidence?.steps.orEmpty()) {
        val previous = groups.lastOrNull()
        if (previous?.description == step.description) groups[groups.lastIndex] = previous.copy(count = previous.count + 1)
        else groups += LiveEvidenceStep(step.entryId, step.description)
    }
    return AutoLinePresentation(kind.label, groups, if (line.wrong != null) "Marked wrong" else null)
}

internal fun liveWorkLogRoute(
    chat: Destination.Chat, workers: List<WorkerSummary>, line: BoardLiveLine, entryId: String,
): Destination.Chat? {
    val worker = workers.firstOrNull {
        it.conversationId == line.evidence?.conversationId && it.id == line.actor.name &&
            (it.threadId ?: "main") == line.actor.threadId
    } ?: return null
    val entry = entryId.takeIf { it.firstOrNull()?.let { first -> first in '1'..'9' } == true && it.all { digit -> digit in '0'..'9' } }
        ?.toLongOrNull() ?: return null
    return chat.copy(workerId = worker.id, threadId = worker.threadId?.takeUnless { it == "main" }, highlight = ChatHighlight.Entry(entry))
}
