package io.github.mitzacoder.kemiri.changes

import androidx.compose.ui.graphics.Color
import io.github.mitzacoder.kemiri.features.changes.changeLineText
import io.github.mitzacoder.kemiri.features.changes.highlightChangeDocument
import io.github.mitzacoder.kemiri.features.chat.ChatHighlighter
import io.github.mitzacoder.kemiri.features.chat.ChatTextMate
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class ChangeHighlightingTest {
    @Test fun `whole sides use their own syntax state in both themes and word marks keep the foreground`() = runBlocking {
        val assets = File("src/main/assets/chat-textmate")
        val engine = ChatTextMate { assets.resolve(it).inputStream() }
        val before = listOf("const menu = `", "Fresh bread", "`;")
        val after = listOf("const menu = 'Daily';", "/*", "", "Fresh rolls", "*/")
        val caller = Thread.currentThread()
        for (dark in listOf(false, true)) {
            suspend fun color(lines: List<String>, path: String) = highlightChangeDocument(lines, path, dark) { text, language, theme ->
                assertNotSame(caller, Thread.currentThread())
                assertEquals(lines.joinToString("\n"), text)
                assertEquals(dark, theme)
                ChatHighlighter.highlight(text, language, theme) { engine }
            }
            val old = color(before, "src/Menu.TS")
            val new = color(after, "src/menu.ts")
            assertEquals(before, old.map { it.text })
            assertEquals(after, new.map { it.text })
            val breadColor = old[1].spanStyles.single { 0 in it.start until it.end }.item.color
            val rollsColor = new[3].spanStyles.single { 0 in it.start until it.end }.item.color
            assertEquals(new[0].spanStyles.single { after[0].indexOf("Daily") in it.start until it.end }.item.color, breadColor)
            assertEquals(new[1].spanStyles.single { 0 in it.start until it.end }.item.color, rollsColor)
            assertNotEquals(Color.Unspecified, breadColor)
            assertNotEquals(Color.Unspecified, rollsColor)
            assertNotEquals(breadColor, rollsColor)
            if (dark) assertEquals(Color(0xFFA6E3A1), breadColor)
            val marked = changeLineText(old[1].text, old[1], listOf(6..10), Color.Red)
            assertEquals(old[1].spanStyles, marked.spanStyles.dropLast(1))
            assertEquals(Color.Red, marked.spanStyles.last().item.background)
            assertEquals(11, marked.spanStyles.last().end)
        }
    }
}
