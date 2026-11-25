package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.data.BoardView
import io.github.mitzacoder.kemiri.data.reuseBoardTasks
import io.github.mitzacoder.kemiri.features.tasks.forTaskSheet
import io.github.mitzacoder.kemiri.protocol.Board
import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.protocol.BoardTaskLive
import io.github.mitzacoder.kemiri.protocol.BoardTaskLivePulse
import org.junit.Assert.*
import org.junit.Test

class TaskBoardProjectionTest {
    @Test fun boardPushReusesEqualRowsButKeepsLiveChangesAtTheSameRevision() {
        val unchanged = task("T1")
        val working = task("T2", status = "in_progress")
        val previous = listOf(unchanged, working)
        assertSame(previous, reuseBoardTasks(previous, listOf(unchanged.copy(), working.copy())))

        val withLivePulse = working.copy(live = BoardTaskLive(emptyList(), BoardTaskLivePulse("Checking", since = working.updatedAt)))
        val incoming = listOf(withLivePulse, unchanged.copy())
        val merged = reuseBoardTasks(previous, incoming)
        assertEquals(incoming, merged)
        assertSame(withLivePulse, merged.first())
        assertSame(unchanged, merged.last())
        assertTrue(reuseBoardTasks(previous, emptyList()).isEmpty())
    }

    @Test fun taskSheetIgnoresUnrelatedWorkButObservesBlockersAndItsQuestions() {
        val shown = task("T1").copy(blockedBy = listOf("T2"))
        val blocker = task("T2")
        val unrelated = task("T3")
        val taskQuestion = question("Q1", shown.id)
        fun view(blockingTask: BoardTask, otherTitle: String) = BoardView(Board(
            tasks = listOf(shown, blockingTask, unrelated.copy(title = otherTitle)),
            questions = listOf(taskQuestion, question("Q2", unrelated.id)), decisions = emptyList(), updatedAt = null,
        ))
        val initial = view(blocker, "Before").forTaskSheet(shown, null)
        assertEquals(listOf(taskQuestion), initial.questions)
        assertEquals(listOf(blocker), initial.relatedTasks)
        assertEquals(initial, view(blocker, "After").forTaskSheet(shown, null))
        assertNotEquals(initial, view(blocker.copy(status = "done"), "After").forTaskSheet(shown, null))
        assertEquals("After", view(blocker, "After").forTaskSheet(shown, unrelated.id).previousTaskTitle)
    }
}
