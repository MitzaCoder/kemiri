package io.github.mitzacoder.kemiri.features.tasks.graph

import io.github.mitzacoder.kemiri.protocol.BoardQuestion
import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.ui.components.AgentMotion

/** Status wins over asks; only idle crew on open tasks can wait for an answer. */
fun workerMotion(status: String, task: BoardTask?, questions: List<BoardQuestion>): AgentMotion = when (status) {
    "running" -> AgentMotion.Working
    "failed" -> AgentMotion.Failed
    "done", "stopped" -> AgentMotion.Done
    else -> if (task != null && !graphClosed(task.status) && (task.status == "review" || questions.any {
        it.taskId == task.id && it.status == "open" && it.waitingOn != "agent" && (it.blocksWork ?: (it.kind != "warning"))
    })) AgentMotion.Waiting else AgentMotion.Sleeping
}

/** Removal or success may celebrate; stopped and visibility changes never do. */
internal fun graphCrewFinishes(status: String?): Boolean = status == null || status == "done"

fun workerMotionPhase(id: String): Long {
    var hash = 2166136261L
    var index = 0
    // Match JS for-of + charCodeAt(0), including supplementary Unicode identifiers.
    while (index < id.length) {
        val char = id[index]
        hash = ((hash xor char.code.toLong()) * 16777619L) and 0xffffffffL
        index += if (char.isHighSurrogate() && index + 1 < id.length && id[index + 1].isLowSurrogate()) 2 else 1
    }
    return hash % 6000L
}

data class GraphMotionCandidate(val id: String, val state: AgentMotion, val inView: Boolean)
fun graphLoopingWorkers(crew: List<GraphMotionCandidate>, zoom: Float, motion: Boolean): Set<String> =
    if (!motion || !zoom.isFinite() || zoom < .5f) emptySet() else crew.filter {
        it.inView && it.state in listOf(AgentMotion.Working, AgentMotion.Waiting, AgentMotion.Sleeping)
    }.map { it.id }.sorted().take(12).toSet()

/** The card crew and canvas use exactly the same hide rule, including when closed cards are shown. */
internal data class GraphCrewMember(val id: String, val status: String, val state: AgentMotion, val background: Boolean)
internal fun graphTaskCrew(d: GraphTask): List<GraphCrewMember> =
    d.workers.filter { it.status !in listOf("done", "stopped") && !graphWorkerRests(it.status, d.task, setOf(d.task.id)) }
        .map { GraphCrewMember("worker:${it.id}", it.status, workerMotion(it.status, d.task, d.questions), false) } +
    d.threads.filter { !it.main && !it.archived && it.status != "done" }
        .map { GraphCrewMember("thread:${it.id}", it.status, workerMotion(it.status, d.task, d.questions), true) }
