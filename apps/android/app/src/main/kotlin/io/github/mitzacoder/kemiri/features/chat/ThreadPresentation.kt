package io.github.mitzacoder.kemiri.features.chat

import kotlinx.serialization.json.*
import io.github.mitzacoder.kemiri.protocol.Artifact
import io.github.mitzacoder.kemiri.protocol.ThreadSummary
import io.github.mitzacoder.kemiri.protocol.BoardQuestion
import io.github.mitzacoder.kemiri.protocol.ProjectActivityBackgroundJobs
import java.time.Instant

data class BoardHandoff(val from: String, val taskId: String, val title: String)
fun parseBoardHandoff(text: String): BoardHandoff? {
    val body = text.trimStart().removePrefix("[board]").trim()
    val match = Regex("""^Thread "([^"]+)" handed (\S+) ("(?:[^"\\]|\\.)*") \(r\d+\) to you\.""").find(body) ?: return null
    val title = runCatching { Json.parseToJsonElement(match.groupValues[3]).jsonPrimitive.content }.getOrNull() ?: return null
    return BoardHandoff(match.groupValues[1],match.groupValues[2],title)
}
data class ThreadNotice(val kind: String, val threadId: String?, val body: String)
fun parseThreadNotice(text: String): ThreadNotice? {
    val value = text.trimStart()
    if(value.startsWith("[thread ")) {
        Regex("^\\[thread (\\S+) failed: ([\\s\\S]*)\\]$").find(value)?.let {
            return ThreadNotice("failed", it.groupValues[1], it.groupValues[2].trim())
        }
        val close = value.indexOf(']'); if(close < 0) return null
        val head = value.substring(8, close).trim(); val rest = value.substring(close + 1).trim()
        Regex("^(\\S+)\\s+finished$").find(head)?.let { return ThreadNotice("finished", it.groupValues[1], rest) }
        Regex("^(\\S+)\\s+failed(?::\\s*([\\s\\S]*))?$").find(head)?.let {
            return ThreadNotice("failed", it.groupValues[1], listOf(it.groupValues[2].trim(),rest).filter(String::isNotEmpty).joinToString("\n\n"))
        }
        return ThreadNotice("other", head.split(Regex("\\s+")).firstOrNull()?.takeIf(String::isNotEmpty), value)
    }
    if(value.startsWith("[from ")) {
        val close = value.indexOf(']'); if(close < 0) return null
        val from = value.substring(6,close).trim()
        if(from.isEmpty() || '\n' in from) return null
        return ThreadNotice("message",from,value.substring(close+1).trim())
    }
    return null
}
internal fun JsonElement?.record(): JsonObject? = obj() ?: (this as? JsonPrimitive)?.contentOrNull?.let { runCatching { Json.parseToJsonElement(it).obj() }.getOrNull() }
fun threadCallId(part: ChatPart): String? = if(part.status in setOf("error","exited")) null else (if(part.name == "thread_start" || part.name == "thread_finish") part.details.record()?.s("threadId") else part.arguments.record()?.s("id"))?.takeIf(String::isNotBlank)
fun artifactCallId(part: ChatPart): String? = if(part.status != "done") null else part.details.record()?.s("artifactId")?.takeIf(String::isNotBlank)
fun finishArtifacts(items: List<Artifact>, threadId: String, timestamp: Long?): List<Artifact> = items.filter {
    it.threadId == threadId && (timestamp == null || runCatching { Instant.parse(it.createdAt).toEpochMilli() <= timestamp }.getOrDefault(false))
}
fun threadCallLabel(part: ChatPart, liveTitle: String? = null): String {
    val target = liveTitle ?: part.arguments.record()?.s("title")?.takeIf(String::isNotBlank)
        ?: (if(part.name == "thread_peek") part.text.lineSequence().firstOrNull()?.substringAfter(" — ", "")?.takeIf(String::isNotBlank) else null)
        ?: threadCallId(part) ?: "a background job"
    if(part.status in setOf("error","exited")) return "Could not ${part.name.removePrefix("thread_").replace('_',' ')} · $target"
    if(part.status != "done") return "${part.name.removePrefix("thread_").replace('_',' ')} · $target · ${part.status}"
    return when(part.name) {
        "thread_list" -> {
            val count = if("No background threads." in part.text || "No background jobs." in part.text) "no" else Regex("(\\d+) background (?:threads?|jobs?)\\.").find(part.text)?.groupValues?.get(1)
            if(count == null) "Listed background jobs" else "Listed $count background job${if(count == "1") "" else "s"}"
        }
        "thread_peek" -> "Looked in on $target"
        "thread_start" -> "Started $target in the background"
        "thread_send" -> "Messaged $target"
        "thread_stop" -> "Stopped $target"
        "thread_archive" -> "${if(part.arguments.record()?.get("archived") == JsonPrimitive(false)) "Restored" else "Archived"} $target"
        "thread_finish" -> "Finished the background job"
        else -> "Ran ${part.name.replace('_',' ')}"
    }
}


/** Emitted state is authoritative. Derive only for an older server. */
fun threadState(thread: ThreadSummary): String = thread.state ?: when {
    thread.status == "done" -> "finished"
    thread.status == "stopped" -> "stopped"
    thread.status == "failed" -> "failed"
    thread.openQuestions > 0 -> "needs_you"
    thread.status == "running" || thread.runningWorkers > 0 -> "working"
    else -> "paused"
}
fun threadStateLabel(state: String): String = when (state) {
    "needs_you" -> "Needs you"; "working" -> "Working"; "paused" -> "Paused"
    "failed" -> "Failed"; "finished" -> "Finished"; "stopped" -> "Stopped"
    else -> state
}
fun threadStateLine(thread: ThreadSummary,
    questions: List<BoardQuestion> = emptyList(),
    now: Long = System.currentTimeMillis()): String = when (threadState(thread)) {
    "needs_you" -> questions.firstOrNull { it.status == "open" && it.waitingOn != "agent" && it.threadId == thread.id }?.text ?: "1 question for you"
    "working" -> thread.current.orEmpty()
    "paused" -> "Nothing is running. Send it a message to continue."
    "failed" -> listOfNotNull(thread.failure?.takeIf(String::isNotBlank), "Send a message to retry.").joinToString(" ")
    "finished" -> thread.summary?.lineSequence()?.map { it.trim().trimStart('#').trim() }?.firstOrNull { it.isNotEmpty() }.orEmpty()
    "stopped" -> "Stopped " + io.github.mitzacoder.kemiri.features.panels.panelRelativeTime(thread.finishedAt ?: thread.updatedAt, Instant.ofEpochMilli(now))
    else -> ""
}
fun threadStateRank(thread: ThreadSummary): Int = when(threadState(thread)) {
    "needs_you" -> 0; "failed" -> 1; "working" -> 2; "paused" -> 3; else -> 4
}
private fun threadEndTime(thread: ThreadSummary): Long =
    runCatching { Instant.parse(thread.finishedAt ?: thread.updatedAt).toEpochMilli() }.getOrDefault(Long.MAX_VALUE)
fun orderedBackgroundJobs(threads: List<ThreadSummary>) =
    threads.filter { !it.main && it.id != "main" }.sortedWith(compareBy<ThreadSummary> { threadStateRank(it) }
        .thenByDescending { if (threadStateRank(it) == 4) threadEndTime(it) else runCatching { Instant.parse(it.updatedAt).toEpochMilli() }.getOrDefault(0) })
fun foldFinishedJob(thread: ThreadSummary, now: Long): Boolean =
    threadState(thread) in setOf("finished", "stopped") && threadEndTime(thread) < now - 24 * 60 * 60 * 1000L
fun backgroundJobCounts(threads: List<ThreadSummary>): ProjectActivityBackgroundJobs {
    val jobs = threads.filter { !it.main && it.id != "main" && !it.archived }
    return ProjectActivityBackgroundJobs(
        needsYou = jobs.count { threadState(it) in setOf("needs_you", "failed") }.toLong(),
        working = jobs.count { threadState(it) == "working" }.toLong())
}
fun backgroundJobCountsText(counts: ProjectActivityBackgroundJobs): String? =
    listOfNotNull("${counts.needsYou} needs you".takeIf { counts.needsYou > 0 }, "${counts.working} working".takeIf { counts.working > 0 }).joinToString(" · ").ifEmpty { null }
