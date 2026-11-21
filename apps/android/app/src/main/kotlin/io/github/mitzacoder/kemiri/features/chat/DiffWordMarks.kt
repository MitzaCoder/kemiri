package io.github.mitzacoder.kemiri.features.chat

internal data class WordMarks(val removed: List<IntRange>, val added: List<IntRange>)

private val wordTokens = Regex("[\\p{L}\\p{M}\\p{N}_]+|\\s+|[^\\p{L}\\p{M}\\p{N}_\\s]")
private const val MAX_LINE_CHARS = 2_048
private const val MAX_LCS_CELLS = 4_096
private const val MAX_CHANGED_PAIRS = 128

/** LCS over words, whitespace and punctuation. Ranges use Compose's UTF-16 text offsets. */
internal fun changedWords(removed: String, added: String): WordMarks? {
    if (removed.length > MAX_LINE_CHARS || added.length > MAX_LINE_CHARS || removed == added) return null
    val before = wordTokens.findAll(removed).toList()
    val after = wordTokens.findAll(added).toList()
    val width = after.size + 1
    val cells = (before.size + 1) * width
    if (cells > MAX_LCS_CELLS) return null
    val lengths = IntArray(cells)
    fun cell(a: Int, b: Int) = a * width + b
    for (a in before.indices.reversed()) {
        for (b in after.indices.reversed()) {
            lengths[cell(a, b)] = if (before[a].value == after[b].value) 1 + lengths[cell(a + 1, b + 1)]
                else maxOf(lengths[cell(a + 1, b)], lengths[cell(a, b + 1)])
        }
    }
    val removedRanges = mutableListOf<IntRange>()
    val addedRanges = mutableListOf<IntRange>()
    fun MutableList<IntRange>.mark(range: IntRange) {
        val previous = lastOrNull()
        if (previous != null && previous.last + 1 == range.first) this[lastIndex] = previous.first..range.last
        else add(range)
    }
    var a = 0
    var b = 0
    while (a < before.size || b < after.size) {
        if (a < before.size && b < after.size && before[a].value == after[b].value) {
            a++
            b++
        } else if (b == after.size || (a < before.size && lengths[cell(a + 1, b)] >= lengths[cell(a, b + 1)])) {
            removedRanges.mark(before[a++].range)
        } else {
            addedRanges.mark(after[b++].range)
        }
    }
    return WordMarks(removedRanges, addedRanges)
}

internal fun DisplayDiffLine.displayText(): String = text.replace("\t", "    ")

/** Pair adjacent delete/add runs in display order. Context, gaps and unpaired rows stay line-only. */
internal fun diffWordMarks(lines: List<DisplayDiffLine>): Map<Int, List<IntRange>> = buildMap {
    var line = 0
    var pairs = 0
    while (line < lines.size && pairs < MAX_CHANGED_PAIRS) {
        if (lines[line].kind != DisplayDiffLine.Kind.Del) {
            line++
            continue
        }
        val deleted = line
        while (lines.getOrNull(line)?.kind == DisplayDiffLine.Kind.Del) line++
        val added = line
        while (lines.getOrNull(line)?.kind == DisplayDiffLine.Kind.Add) line++
        val pairCount = minOf(added - deleted, line - added, MAX_CHANGED_PAIRS - pairs)
        for (offset in 0 until pairCount) {
            val before = lines[deleted + offset]
            val after = lines[added + offset]
            // Reject long lines before expanding tabs into display columns.
            if (before.text.length > MAX_LINE_CHARS || after.text.length > MAX_LINE_CHARS) continue
            val marks = changedWords(before.displayText(), after.displayText()) ?: continue
            if (marks.removed.isNotEmpty()) put(deleted + offset, marks.removed)
            if (marks.added.isNotEmpty()) put(added + offset, marks.added)
        }
        pairs += pairCount
    }
}
