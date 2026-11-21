package io.github.mitzacoder.kemiri.features.changes

import io.github.mitzacoder.kemiri.features.chat.changedWords
import io.github.mitzacoder.kemiri.protocol.*
import kotlinx.serialization.json.Json
import java.security.MessageDigest

internal const val PROJECT_CHANGES = "project-changes"
internal data class ChangeCounts(val files: Int, val additions: Long, val deletions: Long) {
    fun label() = "$files ${if (files == 1) "file" else "files"} · +$additions −$deletions"
}
internal fun changeCounts(files: List<ChangedFile>) = ChangeCounts(files.size, files.sumOf { it.additions }, files.sumOf { it.deletions })
internal fun groupChangedFiles(files: List<ChangedFile>) = files.groupBy { it.path.substringBeforeLast('/', "") }
internal data class CommitPicker(val allowAll: Boolean, val hash: String?, val reason: String?)
internal fun commitPicker(list: ChangesListResponse, requested: String?): CommitPicker {
    val allowAll = list.contiguous == true && list.commits.isNotEmpty()
    return CommitPicker(allowAll, list.commits.find { it.hash == requested }?.hash ?: if (allowAll) null else list.commits.lastOrNull()?.hash,
        when (list.nonContiguousReason) {
            "not-first-parent-chain" -> "These task commits do not form one continuous range. Review them one at a time."
            "no-commits" -> "No commits are recorded for this task."
            else -> null
        })
}

internal fun viewedChangeKey(backend: String, project: String, source: CodeReviewSource, list: ChangesListResponse, path: String): String =
    MessageDigest.getInstance("SHA-256").digest(Json.encodeToString(listOf(backend, project, source.kind, source.key(),
        list.commits.firstOrNull()?.hash.orEmpty(), list.commits.lastOrNull()?.hash.orEmpty(), list.commits.size.toString(), path)).toByteArray())
        .toHexString()

internal class ViewedChanges(private val storage: io.github.mitzacoder.kemiri.features.chat.ReviewStorage) {
    private val key = "viewed.v1"
    private val digest = Regex("[0-9a-f]{64}")
    fun load(): Set<String> = runCatching {
        storage.get(key)?.takeIf { it.length <= 34_000 }?.let { Json.decodeFromString<List<String>>(it) }
            .orEmpty().filter(digest::matches).takeLast(500).toSet()
    }.getOrDefault(emptySet())
    fun set(previous: Set<String>, entry: String, checked: Boolean): Set<String> {
        val retained = ((previous - entry) + if (checked && digest.matches(entry)) setOf(entry) else emptySet()).toList().takeLast(500)
        runCatching { storage.set(key, Json.encodeToString(retained)) }
        return retained.toSet()
    }
}

internal data class ChangeLine(val before: Int?, val after: Int?, val text: String) {
    val unchanged get() = before != null && after != null
    val side get() = if (after != null) "after" else "before"
    val number get() = after ?: requireNotNull(before)
    val sign get() = if (unchanged) " " else if (after != null) "+" else "−"
}
internal data class ChangeDiff(val lines: List<ChangeLine>, val before: List<String>, val after: List<String>,
                               val wordMarks: Map<Int, List<IntRange>>, val approximate: Boolean)
internal fun changeDiff(beforeText: String?, afterText: String?): ChangeDiff {
    // Preserve the final empty line, so EOF newline edits and anchor numbering match the web document.
    val before = beforeText?.let(::codeLines).orEmpty()
    val after = afterText?.let(::codeLines).orEmpty()
    var prefix = 0
    while (prefix < minOf(before.size, after.size) && before[prefix] == after[prefix]) prefix++
    var suffix = 0
    while (suffix < minOf(before.size, after.size) - prefix && before[before.lastIndex - suffix] == after[after.lastIndex - suffix]) suffix++
    val matches = matchingLines(before.subList(prefix, before.size - suffix), after.subList(prefix, after.size - suffix))
    val lines = ArrayList<ChangeLine>(maxOf(before.size, after.size))
    val marks = mutableMapOf<Int, List<IntRange>>()
    var old = 0
    var new = 0
    var pairs = 0
    fun difference(oldEnd: Int, newEnd: Int) {
        val first = lines.size
        if (matches != null) for (offset in 0 until minOf(oldEnd - old, newEnd - new, 128 - pairs)) {
            val words = changedWords(before[old + offset], after[new + offset])
            if (words != null) {
                if (words.removed.isNotEmpty()) marks[first + offset] = words.removed
                if (words.added.isNotEmpty()) marks[first + oldEnd - old + offset] = words.added
            }
            pairs++
        }
        while (old < oldEnd) { lines += ChangeLine(old + 1, null, before[old]); old++ }
        while (new < newEnd) { lines += ChangeLine(null, new + 1, after[new]); new++ }
    }
    fun same() { lines += ChangeLine(old + 1, new + 1, after[new]); old++; new++ }
    repeat(prefix) { same() }
    for ((a, b) in matches.orEmpty()) { difference(prefix + a, prefix + b); same() }
    difference(before.size - suffix, after.size - suffix)
    repeat(suffix) { same() }
    return ChangeDiff(lines, before, after, marks, matches == null)
}

/** Myers' shortest edit path, bounded in both edit distance and comparisons. Empty sides need no search. */
private fun matchingLines(before: List<String>, after: List<String>): List<Pair<Int, Int>>? {
    if (before.isEmpty() || after.isEmpty()) return emptyList()
    val limit = 256
    if (kotlin.math.abs(before.size - after.size) > limit) return null
    val frontier = IntArray(2 * limit + 3)
    val origin = limit + 1
    val trace = ArrayList<IntArray>()
    var comparisons = 0
    for (distance in 0..limit) {
        trace += frontier.copyOf()
        for (diagonal in -distance..distance step 2) {
            val at = origin + diagonal
            val down = diagonal == -distance || (diagonal != distance && frontier[at - 1] < frontier[at + 1])
            var x = if (down) frontier[at + 1] else frontier[at - 1] + 1
            var y = x - diagonal
            while (x < before.size && y < after.size) {
                if (++comparisons > 2_000_000) return null
                if (before[x] != after[y]) break
                x++; y++
            }
            frontier[at] = x
            if (x < before.size || y < after.size) continue
            val matches = ArrayList<Pair<Int, Int>>()
            for (step in distance downTo 0) {
                val previous = trace[step]
                val k = x - y
                val i = origin + k
                val previousK = if (k == -step || (k != step && previous[i - 1] < previous[i + 1])) k + 1 else k - 1
                val previousX = previous[origin + previousK]
                val previousY = previousX - previousK
                while (x > previousX && y > previousY) { x--; y--; matches += x to y }
                x = previousX; y = previousY
            }
            return matches.asReversed()
        }
    }
    return null
}

internal data class DiffBand(val start: Int, val endExclusive: Int, val folded: Boolean = false)
/** Keep two context lines on each edge, and never hide a saved comment pin. */
internal fun diffBands(lines: List<ChangeLine>, pinned: Set<Int>): List<DiffBand> = buildList {
    var at = 0
    while (at < lines.size) {
        if (!lines[at].unchanged || at in pinned) { add(DiffBand(at, at + 1)); at++; continue }
        val start = at
        while (at < lines.size && lines[at].unchanged && at !in pinned) at++
        val foldFrom = if (start == 0) start else start + 2
        val foldTo = if (at == lines.size) at else at - 2
        if (foldTo - foldFrom >= 3) {
            for (i in start until foldFrom) add(DiffBand(i, i + 1))
            add(DiffBand(foldFrom, foldTo, true))
            for (i in foldTo until at) add(DiffBand(i, i + 1))
        } else for (i in start until at) add(DiffBand(i, i + 1))
    }
}
