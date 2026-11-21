package io.github.mitzacoder.kemiri.chat

import io.github.mitzacoder.kemiri.features.chat.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class ChatPresentationTest {
    @Test fun boundedReadsDoNotConsumeBeyondLimit() {
        val stream = "abcdef".byteInputStream()
        assertEquals("abc",stream.readAtMost(3).toString(Charsets.UTF_8))
        assertEquals("def",stream.readAtMost(99).toString(Charsets.UTF_8))
        assertEquals(0,stream.readAtMost(0).size)
    }
    @Test fun expirationRefreshIsEarlyAndBounded() {
        assertEquals(55000L,artifactRefreshDelay("1970-01-01T00:01:00Z",0))
        assertEquals(1000L,artifactRefreshDelay("1970-01-01T00:00:00Z",10000))
        assertEquals(55000L,artifactRefreshDelay("invalid",0))
    }
    @Test fun highlighterNeverDropsSource() = runBlocking {
        val source = "const answer = 42; // hello\nreturn \"done\";"
        val textMate = ChatTextMate { File("src/main/assets/$CHAT_TEXTMATE_ASSETS", it).inputStream() }
        val highlighted = ChatHighlighter.highlight(source,"javascript",true) { textMate }
        assertEquals(source,highlighted.text)
        assertTrue(highlighted.spanStyles.isNotEmpty())
        assertEquals(source,ChatHighlighter.highlight(source,"plaintext",false) { error("Plain text must skip tm4e") }.text)
    }
}
