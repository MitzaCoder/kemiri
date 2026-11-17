package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.features.tasks.graph.*
import io.github.mitzacoder.kemiri.navigation.*
import io.github.mitzacoder.kemiri.protocol.*
import org.junit.Assert.*
import org.junit.Test

class GraphPeekTest {
    private val worker = WorkerSummary("pip", "Polish the lens", "running", ModelRef("faux", "faux-1"), null,
        "shared", null, 7, taskId = "T1", spawnedByCallId = null, createdAt = "2026-01-01T00:00:00Z",
        updatedAt = "2026-01-01T00:00:00Z", lastReport = "Checked the lens", failure = null)
    private val actor = BoardActivityActor("worker:pip", "worker", "pip", "main", 7, "run-1")
    private val activity = BoardTaskActivity("working", "Polishing the lens", "2026-01-01T00:00:00Z", emptyList(), actor)

    @Test fun doingNowRequiresTheExactWorkerActorConversationAndTask() {
        val task = task("T1").copy(activity = activity)
        assertEquals(activity, graphWorkerActivity(worker, task, true))
        assertEquals(activity.text, graphWorkerDoingNow(worker, task, true))
        for (other in listOf(actor.copy(kind = "thread"), actor.copy(name = "dot"), actor.copy(threadId = "garden"), actor.copy(conversationId = 8))) {
            assertNull(graphWorkerActivity(worker, task.copy(activity = activity.copy(actor = other)), true))
            assertEquals(worker.lastReport, graphWorkerDoingNow(worker, task.copy(activity = activity.copy(actor = other)), true))
        }
        assertNull(graphWorkerActivity(worker, task.copy(id = "T2"), true))
        assertNull(graphWorkerActivity(worker, null, true))
        assertEquals(worker.lastReport, graphWorkerDoingNow(worker, task, false))
        assertNull(graphWorkerDoingNow(worker.copy(lastReport = "  "), task, false))
        val threaded = worker.copy(threadId = "garden")
        assertEquals(activity.text, graphWorkerDoingNow(threaded, task.copy(activity = activity.copy(actor = actor.copy(threadId = "garden"))), true))
        assertNotEquals(graphWorkerKey(worker), graphWorkerKey(threaded))
    }

    @Test fun partsListOnlyDirectWorkingClarifyingOrNeedsYouPartsInBoardOrder() {
        fun state(kind: String, group: String) = BoardTaskState(group, kind, "now", emptyList())
        val parent = task("T1").copy(subtasks = listOf("T8"))
        val parts = listOf(
            task("T2", "in_progress").copy(parent = "T1"),
            task("T3", "done").copy(parent = "T1"),
            task("T4").copy(parent = "T1", state = state("failed", "needs_you")),
            task("T5").copy(parent = "T1", state = state("clarifying", "in_progress")),
            task("T6").copy(parent = "T1"),
            task("T7", "in_progress").copy(parent = "T2"),
            task("T8", "review"),
            task("T9").copy(parent = "T1"),
        )
        val listed = graphPeekParts(parent, parts.reversed(), listOf(question("Q1", "T9")))
        assertEquals(listOf("T2", "T4", "T5", "T8", "T9"), listed.listed.map { it.id })
        assertEquals(1L, listed.done)
        assertEquals(2L, graphPeekParts(parent.copy(subtaskStates = listOf("done", "done")), parts, emptyList()).done)
        assertEquals(3L, graphPeekParts(parent.copy(subtaskCount = BoardSubtaskCount(9, 3)), parts, emptyList()).done)
    }

    @Test fun resultsFoldContinuationLinesBeforeClampingToThreeBullets() {
        assertEquals(listOf("First continued", "Second", "Third"), graphPeekResults("- First\n  continued\n- Second\n- Third\n- Fourth"))
        assertEquals(emptyList<String>(), graphPeekResults(" \n"))
        assertEquals(listOf("A paragraph"), graphPeekResults("A paragraph"))
    }

    @Test fun transcriptBackRestoresWorkerThenGraphWithSelectionBeforeClearingIt() {
        val main = Destination.Chat("demo", "project")
        val panel = Destination.Panel(main, PanelTab.Board)
        val transcript = graphWorkerRoute(main, worker)
        val stack = BackStack(listOf(Destination.Home, main, panel)).push(transcript)
        assertEquals(panel, stack.back().current)
        assertEquals(main, transcript.copy(workerId = null))
        val selectedWorker = GraphNavigation(selected = "T1", highlight = "quiet", worker = graphWorkerKey(worker))
        val graph = graphNavigateBack(selectedWorker)!!
        assertEquals("T1", graph.selected)
        assertEquals("quiet", graph.highlight)
        assertNull(graph.worker)
        assertFalse(graph.sheet)
        assertEquals(GraphNavigation(), graphNavigateBack(graph))
        assertNull(graphNavigateBack(GraphNavigation()))
        assertEquals("garden", graphWorkerRoute(main, worker.copy(threadId = "garden")).threadId)
        assertNull(graphWorkerRoute(main, worker.copy(threadId = "main")).threadId)
        assertNull(graphWorkerRoute(main.copy(highlight = ChatHighlight.Thread("garden")), worker).highlight)
    }
}
