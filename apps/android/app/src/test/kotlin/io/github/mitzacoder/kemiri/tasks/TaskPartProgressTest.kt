package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.protocol.BoardTaskState
import org.junit.Assert.*
import org.junit.Test

class TaskPartProgressTest {
    @Test fun partsHaveStableToneOrderAndOmitDroppedAndZeroCounts() {
        val parent = task("T1").copy(subtaskStates = listOf("todo", "review", "working", "done", "failed", "dropped"))
        val progress = taskPartProgress(parent)!!
        assertEquals("1 of 5 parts done · 1 working · 2 needs you", progress.text)
        assertEquals(listOf(PartTone.Done, PartTone.Working, PartTone.NeedsYou, PartTone.NeedsYou, PartTone.Other), progress.segments.map { it.tone })
        assertEquals("0 of 1 parts done", taskPartProgress(parent.copy(subtaskStates = listOf("todo")))!!.text)
        assertNull(taskPartProgress(parent.copy(subtaskStates = emptyList())))
        assertNull(taskPartProgress(task("T1")))
    }

    @Test fun aboveTwelvePartsUseSharesRatherThanTinySegments() {
        val parent = task("T1").copy(subtaskStates = List(12) { "todo" })
        assertEquals(12, taskPartProgress(parent)!!.segments.size)
        val progress = taskPartProgress(parent.copy(subtaskStates = listOf("done") + List(12) { "todo" }))!!
        assertTrue(progress.proportional)
        assertEquals(listOf(PartSegment(PartTone.Done, 1), PartSegment(PartTone.Other, 12)), progress.segments)
    }

    @Test fun parentSentenceYieldsToOwnAttentionAndWaitsAndUnadvertisedPartsUseRing() {
        val parent = task("T1").copy(subtaskStates = listOf("done", "working", "todo"), state = BoardTaskState("in_progress", "working", "2026-11-12T12:00:00Z", listOf("T3")))
        assertTrue(taskUsesPartsSentence(parent))
        for (group in listOf("needs_you", "waiting", "closed")) assertFalse(taskUsesPartsSentence(parent.copy(state = parent.state!!.copy(group = group))))
        assertNull(taskWithSupportedState(parent, true).subtaskStates)
        assertEquals(parent.subtaskStates, taskWithSupportedState(parent, true, true).subtaskStates)
    }
}
