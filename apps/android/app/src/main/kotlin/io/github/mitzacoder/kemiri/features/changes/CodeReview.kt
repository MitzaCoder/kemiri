package io.github.mitzacoder.kemiri.features.changes

import io.github.mitzacoder.kemiri.features.chat.REVIEW_INTENTS
import io.github.mitzacoder.kemiri.features.chat.ReviewStorage
import io.github.mitzacoder.kemiri.features.chat.reviewText
import io.github.mitzacoder.kemiri.features.chat.sha256Hex
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.util.UUID

internal const val MAX_CODE_QUOTE = 4000
internal const val MAX_CODE_COMMENTS = 40
private const val MAX_REVIEW_CHARS = 96 * 1024

@Serializable internal data class CodeReviewSource(val kind: String, val taskId: String? = null, val hash: String? = null, val versionId: String? = null) {
    fun key() = when (kind) { "task" -> taskId.orEmpty(); "commit" -> hash.orEmpty(); else -> versionId.orEmpty() }
    fun label() = "$kind ${key()}"
}
@Serializable internal data class CodeAnchor(val path: String, val side: String, val startLine: Int, val endLine: Int, val quotedText: String) {
    fun location() = "${path.replace(Regex("[\r\n\t]"), " ")} · $side " +
        if (startLine == endLine) "line $startLine" else "lines $startLine–$endLine"
}
@Serializable internal data class CodeComment(val id: String, val source: CodeReviewSource, val anchor: CodeAnchor,
    val intent: String? = null, val note: String = "", val replacement: String? = null, val outdated: Boolean = false)
@Serializable internal data class CodeReview(val comments: List<CodeComment> = emptyList(), val overall: String = "", val attempt: CodeReviewAttempt? = null)
@Serializable internal data class CodeReviewAttempt(val contentHash: String, val requestId: String)

internal fun normalizeCode(text: String) = text.replace("\r\n", "\n").replace('\r', '\n')
internal fun codeLines(text: String) = normalizeCode(text).split('\n')
internal fun anchorCodeLines(lines: List<String>, path: String, side: String, start: Int, end: Int): CodeAnchor? {
    if (start < 1 || end < start || end > lines.size || end - start >= 100) return null
    val selection = lines.subList(start - 1, end)
    if (selection.sumOf { it.length.toLong() } + end - start > MAX_CODE_QUOTE) return null
    return CodeAnchor(path, side, start, end, selection.joinToString("\n"))
}
internal fun reanchorCodeLines(lines: List<String>, anchor: CodeAnchor): CodeAnchor? {
    val span = anchor.endLine - anchor.startLine
    val quote = anchor.quotedText.split('\n')
    fun matches(at: Int) = at >= 1 && at <= lines.size - span && quote.indices.all { lines[at - 1 + it] == quote[it] }
    if (matches(anchor.startLine)) return anchor
    if (anchor.quotedText.isBlank()) return null
    for (distance in 1..100) {
        val left = anchor.startLine - distance
        val right = anchor.startLine + distance
        val earlier = matches(left)
        val later = matches(right)
        if (earlier && later) return null
        if (earlier || later) return (if (earlier) left else right).let { anchor.copy(startLine = it, endLine = it + span) }
    }
    return null
}
internal fun reconcileCodeComments(comments: List<CodeComment>, source: CodeReviewSource, path: String, previousPath: String?,
                                   before: List<String>, after: List<String>): List<CodeComment> = comments.map { comment ->
    if (comment.source != source || (comment.anchor.path != path && comment.anchor.path != previousPath)) comment
    else {
        val match = reanchorCodeLines(if (comment.anchor.side == "before") before else after, comment.anchor)
        if (match == null) comment.copy(outdated = true) else comment.copy(anchor = match.copy(path = path), outdated = false)
    }
}

private fun patchPath(prefix: Char, path: String): String {
    fun needsQuote(c: Char) = c < ' ' || c == '\u007f' || c == '"' || c == '\\'
    val value = "$prefix/$path"
    if (value.none(::needsQuote)) return value
    return buildString {
        append('"')
        for (c in value) when {
            c == '"' || c == '\\' -> append('\\').append(c)
            needsQuote(c) -> append('\\').append(c.code.toString(8).padStart(3, '0'))
            else -> append(c)
        }
        append('"')
    }
}
internal fun suggestedPatch(anchor: CodeAnchor, replacement: String?): String? {
    val clean = replacement?.let(::normalizeCode) ?: return null
    if (clean == anchor.quotedText) return null
    val previous = anchor.quotedText.split('\n')
    val next = if (clean.isEmpty()) emptyList() else clean.split('\n')
    val start = anchor.startLine
    return (listOf("--- ${patchPath('a', anchor.path)}", "+++ ${patchPath('b', anchor.path)}",
        "@@ -$start,${previous.size} +${if (next.isEmpty()) start - 1 else start},${next.size} @@") +
        previous.map { "-$it" } + next.map { "+$it" }).joinToString("\n")
}
internal fun formatCodeReview(source: CodeReviewSource, review: CodeReview): String = buildList {
    add("Code review (${source.label()})")
    for ((index, comment) in review.comments.withIndex()) add(buildString {
        append("${index + 1}. ${comment.intent ?: "Note"} · ${comment.anchor.location()}")
        if (comment.source != source) append(" · ${comment.source.label()}")
        if (comment.outdated) append(" · Outdated")
        append('\n').append(comment.anchor.quotedText.split('\n').joinToString("\n") { if (it.isEmpty()) ">" else "> $it" })
        reviewText(comment.note, 4000).takeIf { it.isNotEmpty() }?.let { append("\n\n").append(it) }
        suggestedPatch(comment.anchor, comment.replacement)?.let { patch ->
            val fence = "`".repeat(maxOf(2, Regex("`+").findAll(patch).maxOfOrNull { it.value.length } ?: 0) + 1)
            append("\n\nSuggested edit:\n${fence}diff\n$patch\n$fence")
        }
    })
    reviewText(review.overall, 4000).takeIf { it.isNotEmpty() }?.let { add("Overall: $it") }
}.joinToString("\n\n")

internal fun codeReviewKey(backend: String, project: String, task: String) = "review.v1:" + Json.encodeToString(listOf(backend, project, task))
internal fun codeReviewFits(review: CodeReview) = review.comments.size <= MAX_CODE_COMMENTS && Json.encodeToString(review).length <= MAX_REVIEW_CHARS - 5000
internal fun loadCodeReview(storage: ReviewStorage, key: String): CodeReview = runCatching {
    val review = storage.get(key)?.takeIf { it.length <= MAX_REVIEW_CHARS }?.let { Json.decodeFromString<CodeReview>(it) } ?: return CodeReview()
    review.copy(overall = review.overall.take(4000), comments = review.comments.filter { comment ->
        val a = comment.anchor
        a.path.length in 1..4096 && a.side in listOf("before", "after") && a.startLine in 1..1_048_577 && a.endLine in a.startLine..a.startLine + 99 &&
            a.quotedText.length <= MAX_CODE_QUOTE && a.quotedText.count { it == '\n' } == a.endLine - a.startLine &&
            comment.id.length in 1..100 && comment.note.length <= 4000 && (comment.intent == null || comment.intent in REVIEW_INTENTS) &&
            (comment.replacement?.length ?: 0) <= MAX_CODE_QUOTE && comment.source.kind in listOf("task", "commit")
    }.distinctBy { it.id }.take(MAX_CODE_COMMENTS))
}.getOrDefault(CodeReview())
internal fun saveCodeReview(storage: ReviewStorage, key: String, review: CodeReview): Boolean = runCatching {
    if (review == CodeReview()) storage.remove(key) else {
        val encoded = Json.encodeToString(review)
        check(encoded.length <= MAX_REVIEW_CHARS)
        storage.set(key, encoded)
    }
}.isSuccess
internal fun codeReviewAttempt(previous: CodeReviewAttempt?, text: String, createId: () -> String = { "review-${UUID.randomUUID()}" }): CodeReviewAttempt {
    val hash = sha256Hex(text.toByteArray())
    return previous?.takeIf { it.contentHash == hash } ?: CodeReviewAttempt(hash, createId())
}

internal fun CodeReview.hasUnconfirmedAttempt(source: CodeReviewSource): Boolean =
    attempt?.let { it.contentHash == sha256Hex(formatCodeReview(source, this).toByteArray()) } == true
