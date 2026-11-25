package io.github.mitzacoder.kemiri.features.coordinators

import io.github.mitzacoder.kemiri.navigation.ChatHighlight
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.protocol.*
import kotlinx.serialization.json.*

internal fun coordinatorRoster(threads: List<ThreadSummary>) = threads
    .filter { !it.archived && (it.main || it.kind == "coordinator") }
    .sortedWith(compareByDescending<ThreadSummary> { it.main }.thenBy { it.order ?: 0 }.thenBy { it.id })

internal fun coordinatorForChat(route: Destination.Chat, threads: List<ThreadSummary>): ThreadSummary? =
    if (route.workerId != null) null
    else threads.find { it.id == (route.threadId ?: MAIN_THREAD_ID) && (it.main || it.kind == "coordinator") }

internal fun otherCoordinatorsNeedingAttention(threads: List<ThreadSummary>, openCoordinatorId: String): Long =
    coordinatorRoster(threads).count { it.id != openCoordinatorId && coordinatorBadges(it).needsYou > 0 }.toLong()

internal fun coordinatorOfThread(id: String?, threads: List<ThreadSummary>): String {
    val thread = threads.find { it.id == id }
    return if (thread?.kind == "coordinator") thread.id else thread?.parentThreadId ?: MAIN_THREAD_ID
}

internal val BoardTask.coordinator get() = coordinatorId ?: MAIN_THREAD_ID

internal data class CoordinatorTaskScope(val threads: List<ThreadSummary>, val coordinator: String?, val hidden: Set<String> = emptySet()) {
    val roster = coordinatorRoster(threads)
    fun includes(id: String) = if (coordinator == null) id !in hidden else id == coordinator
    fun tasks(tasks: List<BoardTask>) = tasks.filter { includes(it.coordinator) }
    fun questions(questions: List<BoardQuestion>) = questions.filter { includes(coordinatorOfThread(it.threadId, threads)) }
    fun externalParts(parent: BoardTask, tasks: List<BoardTask>, shown: Set<String>) =
        tasks.filter { !it.archived && it.parent == parent.id && it.coordinator != parent.coordinator && it.id !in shown }
}

internal data class CoordinatorBadges(val needsYou: Long, val working: Boolean, val paused: Boolean, val unread: Boolean, val state: String) {
    fun description() = buildList {
        add(state.lowercase())
        if (needsYou > 0) add("$needsYou need you")
        if (working && state != "Working") add("working")
        if (paused && state != "Paused") add("paused")
        if (unread) add("unread reply")
    }.joinToString(", ")
}

internal fun coordinatorBadges(thread: ThreadSummary, seen: Long = 0): CoordinatorBadges {
    val count = thread.attention?.let { it.questions + it.warnings + it.steps + it.review + it.failed }
        ?: (thread.openQuestions + if (thread.status == "failed") 1 else 0)
    val working = thread.status == "running" || thread.runningWorkers > 0
    val paused = thread.held == true
    val state = when {
        thread.status == "failed" -> "Failed"
        count > 0 -> "Needs you"
        paused -> "Paused"
        working -> "Working"
        else -> "Idle"
    }
    return CoordinatorBadges(count, working, paused, (thread.lastReplyEntryId ?: 0) > seen, state)
}

internal fun coordinatorRoute(chat: Destination.Chat, id: String, highlight: ChatHighlight? = null) =
    chat.copy(threadId = id.takeUnless { it == MAIN_THREAD_ID }, workerId = null, highlight = highlight)

internal fun transcriptMessageIds(data: JsonElement?): List<String> {
    val fields = data as? JsonObject ?: return emptyList()
    fun string(value: JsonElement?) = (value as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull
    return string(fields["threadMessageId"])?.let(::listOf)
        ?: (fields["threadMessageIds"] as? JsonArray)?.mapNotNull(::string)?.distinct().orEmpty()
}

/** A page begun before a push cannot turn an answered request back into an awaiting request. */
internal fun mergeMessages(
    previous: Map<String, ThreadsMessagesResponseMessagesItem>, incoming: List<ThreadsMessagesResponseMessagesItem>,
): Map<String, ThreadsMessagesResponseMessagesItem> = previous.toMutableMap().apply {
    incoming.forEach { message ->
        if (get(message.id)?.replied != true || message.replied == true) put(message.id, message)
    }
}
