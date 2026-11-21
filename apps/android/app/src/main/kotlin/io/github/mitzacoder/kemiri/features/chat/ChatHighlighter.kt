package io.github.mitzacoder.kemiri.features.chat

import android.content.res.AssetManager
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import org.eclipse.tm4e.core.grammar.IStateStack
import org.eclipse.tm4e.core.internal.grammar.tokenattrs.EncodedTokenAttributes
import org.eclipse.tm4e.core.internal.theme.FontStyle as TokenFontStyle
import java.io.IOException
import java.time.Duration

/** Bundled TextMate grammars, cached per theme; chat never downloads grammars or caches user text. */
internal object ChatHighlighter {
    const val MAX_CODE_CHARS = 50_000
    // Limit CPU contention when a transcript brings several cold grammars into view at once.
    private val tokenizerDispatcher = Dispatchers.Default.limitedParallelism(1)
    private val lineBudget = Duration.ofMillis(150)
    private val initialLineBudget = Duration.ofMillis(500)
    private val blockBudget = Duration.ofMillis(750)
    private val retryBudget = Duration.ofMillis(1500)
    private var textMate: ChatTextMate? = null

    suspend fun highlight(code: String, language: String, dark: Boolean, assets: AssetManager): AnnotatedString =
        highlight(code, language, dark) {
            synchronized(this) {
                textMate ?: ChatTextMate { assets.open(CHAT_TEXTMATE_ASSETS + it) }.also { textMate = it }
            }
        }

    suspend fun highlight(
        code: String,
        language: String,
        dark: Boolean,
        firstLineBudget: Duration = initialLineBudget,
        engine: () -> ChatTextMate,
    ): AnnotatedString {
        if (code.isEmpty() || code.length > MAX_CODE_CHARS || fenceLanguageLabel(language) in plainLabels) return AnnotatedString(code)
        return withContext(tokenizerDispatcher) {
            val context = currentCoroutineContext()
            try {
                val textMate = engine()
                val scope = textMate.scopeForFence(language) ?: return@withContext AnnotatedString(code)
                val highlighted = AnnotatedString.Builder(code)
                val styles = mutableMapOf<Pair<Int, Int>, SpanStyle>()
                var state: IStateStack? = null
                var offset = 0
                for (retry in listOf(false, true)) {
                    context.ensureActive()
                    val completed = textMate.withGrammar(scope, dark) { grammar, palette ->
                        val deadline = System.nanoTime() + (if (retry) retryBudget else blockBudget).toNanos()
                        while (offset < code.length) {
                            context.ensureActive()
                            val remaining = deadline - System.nanoTime()
                            if (remaining <= 0) break
                            val newline = code.indexOf('\n', offset)
                            val line = code.substring(offset, if (newline == -1) code.length else newline)
                            val budget = when {
                                retry -> retryBudget
                                offset == 0 -> firstLineBudget
                                else -> lineBudget
                            }
                            val parsed = grammar.tokenizeLine2(line, state, minOf(budget, Duration.ofNanos(remaining)))
                            if (parsed.isStoppedEarly) break // Retry this line, not the incomplete rule stack.
                            val tokens = parsed.tokens
                            for (i in tokens.indices step 2) {
                                val start = tokens[i].coerceIn(0, line.length)
                                val end = tokens.getOrElse(i + 2) { line.length }.coerceIn(start, line.length)
                                if (start == end) continue
                                val foreground = EncodedTokenAttributes.getForeground(tokens[i + 1])
                                val fontStyle = EncodedTokenAttributes.getFontStyle(tokens[i + 1])
                                val style = styles.getOrPut(foreground to fontStyle) { tokenStyle(palette.getOrNull(foreground), fontStyle) }
                                highlighted.addStyle(style, offset + start, offset + end)
                            }
                            state = parsed.ruleStack
                            offset += line.length + 1
                        }
                        offset >= code.length
                    } ?: break
                    if (completed) break
                    // Let other blocks run before one bounded retry. tm4e may have compiled regexes even when it timed out.
                    if (!retry) yield()
                }
                highlighted.toAnnotatedString()
            } catch (canceled: CancellationException) {
                throw canceled
            } catch (_: RuntimeException) {
                // tm4e and its regex engine may reject a grammar or input. Leave the literal readable.
                AnnotatedString(code)
            } catch (_: IOException) {
                AnnotatedString(code)
            }
        }
    }

    private val plainLabels = setOf("", "diff", "plain", "text", "plaintext", "txt")

    private fun tokenStyle(hex: String?, font: Int): SpanStyle {
        val decoration = buildList {
            if (font and TokenFontStyle.Underline != 0) add(TextDecoration.Underline)
            if (font and TokenFontStyle.Strikethrough != 0) add(TextDecoration.LineThrough)
        }
        return SpanStyle(
            color = hex?.removePrefix("#")?.takeIf { it.length == 6 }?.toLongOrNull(16)?.let { Color(0xFF000000 or it) }
                ?: Color.Unspecified,
            fontStyle = if (font and TokenFontStyle.Italic != 0) FontStyle.Italic else null,
            fontWeight = if (font and TokenFontStyle.Bold != 0) FontWeight.Bold else null,
            textDecoration = if (decoration.isEmpty()) null else TextDecoration.combine(decoration),
        )
    }
}
