package io.github.mitzacoder.kemiri.features.changes

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import io.github.mitzacoder.kemiri.features.chat.ChatHighlighter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.Locale

private val changeLanguageAliases = mapOf("kt" to "kotlin", "kts" to "kotlin", "rs" to "rust", "h" to "c", "hpp" to "cpp", "rb" to "ruby", "exs" to "elixir", "cs" to "csharp", "ps1" to "powershell")
private fun changeLanguage(path: String): String {
    val name = path.substringAfterLast('/').lowercase(Locale.ROOT)
    if (name == "dockerfile" || name == "makefile") return name
    val extension = name.substringAfterLast('.', "")
    return changeLanguageAliases[extension] ?: extension
}

/** Tokenize the whole side before slicing: an offscreen line can open a string or comment. */
internal suspend fun highlightChangeDocument(lines: List<String>, path: String, dark: Boolean,
                                             highlight: suspend (String, String, Boolean) -> AnnotatedString): List<AnnotatedString> =
    withContext(Dispatchers.Default) {
        val language = changeLanguage(path)
        if (language.isEmpty() || lines.isEmpty() || lines.sumOf { it.length.toLong() + 1 } - 1 > ChatHighlighter.MAX_CODE_CHARS) {
            return@withContext emptyList()
        }
        val document = highlight(lines.joinToString("\n"), language, dark)
        val tokens = document.spanStyles
        if (tokens.isEmpty()) return@withContext emptyList()
        // ChatHighlighter emits spans in source order. Walk them once, keeping UTF-16 offsets for word marks.
        var start = 0
        var nextToken = 0
        lines.map { line ->
            val end = start + line.length
            buildAnnotatedString {
                append(line)
                while (nextToken < tokens.size && tokens[nextToken].end <= start) nextToken++
                var token = nextToken
                while (token < tokens.size && tokens[token].start < end) {
                    val span = tokens[token++]
                    val from = maxOf(start, span.start)
                    val to = minOf(end, span.end)
                    if (from < to) addStyle(span.item, from - start, to - start)
                }
            }.also { start = end + 1 }
        }
    }

internal fun changeLineText(text: String, syntax: AnnotatedString?, marks: List<IntRange>, wordTint: Color): AnnotatedString =
    buildAnnotatedString {
        append(syntax ?: AnnotatedString(text))
        for (range in marks) addStyle(SpanStyle(background = wordTint), range.first, range.last + 1)
    }
