package io.github.mitzacoder.kemiri.chat

import io.github.mitzacoder.kemiri.features.chat.*
import org.junit.Assert.*
import org.junit.Test

class DiffWordMarksTest {
    @Test fun marksWordsAndPunctuationWithoutMarkingSharedText() {
        val old = "plant(\"Fern\", 2);"
        val new = "plant(\"Basil\", 3):"
        val marks = changedWords(old, new)!!
        assertEquals(listOf("Fern", "2", ";"), marks.removed.map(old::substring))
        assertEquals(listOf("Basil", "3", ":"), marks.added.map(new::substring))
    }

    @Test fun insertionsAndUnicodeUseComposeOffsets() {
        val old = "🌱 thé"
        val new = "🌱 thé vert"
        val marks = changedWords(old, new)!!
        assertEquals(emptyList<IntRange>(), marks.removed)
        assertEquals(listOf(6..10), marks.added)
        assertEquals(" vert", new.substring(marks.added.single()))
        assertNull(changedWords(old, old))
    }

    @Test fun pairsAdjacentRowsWithoutCrossingContextOrGaps() {
        val lines = displayDiffLines(" 1 seed\n- 2 \tbed = Fern\n- 3 alone\n+ 2 \tbed = Basil\n...\n+ 11 rain\n- 19 dry\n 20 sun\n+ 21 light")
        val marks = diffWordMarks(lines)
        assertEquals(setOf(1, 3), marks.keys)
        assertEquals("Fern", lines[1].displayText().substring(marks.getValue(1).single()))
        assertEquals("Basil", lines[3].displayText().substring(marks.getValue(3).single()))
    }

    @Test fun capsLongLinesDenseTokensAndManyPairs() {
        assertNull(changedWords("x".repeat(2049), "y"))
        assertNull(changedWords(";".repeat(65), ":".repeat(65)))
        val diff = List(129) { "- Fern\n+ Basil" }.joinToString("\n")
        assertEquals(256, diffWordMarks(displayDiffLines(diff)).size)
    }
}
