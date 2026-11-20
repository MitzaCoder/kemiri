package io.github.mitzacoder.kemiri.features.chat

import io.github.mitzacoder.kemiri.features.tasks.taskIdOrder
import io.github.mitzacoder.kemiri.protocol.Artifact
import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.protocol.DraftContent
import java.time.Instant

internal data class DiscussionReference(val title: String, val artifactId: String, val version: Long, val name: String, val header: String, val body: String) {
    val versionId get() = "$artifactId~$version"
}

private val headerLines = Regex("[\r\n]+")
private val versionSuffix = Regex("~[0-9]+$")
private val discussionPrefix = Regex("""^Discuss "([^"\r\n]+)"\r?\n\(artifact ([A-Za-z0-9_-]+)~([1-9][0-9]*), ([^\r\n]+)\)(?:\r?\n\r?\n|\z)""")

internal fun discussHeader(artifact: Artifact): String {
    val title = artifactTitle(artifact).replace(headerLines, " ").replace('"', '′')
    val name = artifact.name.replace(headerLines, " ")
    return "Discuss \"$title\"\n(artifact ${artifact.id.replace(versionSuffix, "")}~${artifact.version ?: 1}, $name)"
}

internal fun discussionReference(text: String): DiscussionReference? {
    val match = discussionPrefix.find(text) ?: return null
    val (title, id, number, name) = match.destructured
    val version = number.toLongOrNull()?.takeIf { it <= 9_007_199_254_740_991L } ?: return null
    return DiscussionReference(title, id, version, name, match.value.trimEnd(), text.substring(match.range.last + 1))
}

internal fun discussionText(header: String, body: String): String = if (body.isEmpty()) header else "$header\n\n$body"

internal fun attachDiscussion(draft: DraftContent, header: String, taskId: String?): DraftContent =
    draft.copy(text = discussionText(header, discussionReference(draft.text)?.body ?: draft.text), taskId = taskId)

internal fun discussionTime(at: String?): Instant? = at?.let { runCatching { Instant.parse(it) }.getOrNull() }
internal fun settledDiscussionTask(status: String?, settledAt: String?, sentAt: Long): Boolean =
    (status == "done" || status == "dropped") && (settledAt == null || discussionTime(settledAt)?.isAfter(Instant.ofEpochMilli(sentAt)) == false)

/** Include dropped tasks in the search so a retry never falls back to an older sibling. */
internal fun newestDiscussionFollowUp(tasks: List<BoardTask>, homeId: String, sentAt: Long): BoardTask? {
    val sent = Instant.ofEpochMilli(sentAt)
    return tasks.asSequence().filter { it.foundWhile == homeId && it.createdBy == "coordinator" }
        .mapNotNull { task -> discussionTime(task.createdAt)?.takeIf { it > sent }?.let { task to it } }
        .maxWithOrNull(compareBy<Pair<BoardTask, Instant>> { it.second }.thenComparator { left, right -> taskIdOrder.compare(left.first.id, right.first.id) })?.first
}
