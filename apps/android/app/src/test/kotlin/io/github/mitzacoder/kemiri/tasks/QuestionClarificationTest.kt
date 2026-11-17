package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.data.BoardView
import io.github.mitzacoder.kemiri.features.chat.agentWaitingForUser
import io.github.mitzacoder.kemiri.features.chat.pinnedQuestions
import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.features.tasks.board.needsYouCount
import io.github.mitzacoder.kemiri.features.tasks.graph.graphTaskStatus
import io.github.mitzacoder.kemiri.protocol.*
import org.junit.Assert.*
import org.junit.Test

class QuestionClarificationTest {
    @Test fun capabilityAndApprovalGuardEveryAskBack() {
        val open = question("Q1", "T1")
        assertTrue(questionCanClarify(open, true))
        assertTrue(questionCanClarify(open.copy(kind = "warning"), true))
        assertFalse(questionCanClarify(open, false))
        assertFalse(questionCanClarify(open, true, readOnly = true))
        assertFalse(questionCanClarify(open.copy(mcpApproval = true), true))
        for (status in listOf("answered", "withdrawn")) assertFalse(questionCanClarify(open.copy(status = status), true))
    }

    @Test fun questionMarkHighlightsWithoutChangingTheSendMeaning() {
        assertTrue(askBackIsPrimary("Why?  \n"))
        assertFalse(askBackIsPrimary("Use active rows."))
        assertFalse(askBackIsPrimary(""))
        assertFalse(askBackIsPrimary("Why? Use both."))
    }

    @Test fun noReplyRetriesTheLastAskOrAnEditedDraft() {
        val open = question("Q1", null).copy(noReplyYet = true, exchanges = listOf(
            BoardQuestionExchange(BoardWriter(author = "user", threadId = null, workerId = null), "How many rows?", "2026-01-01T09:00:00Z"),
            BoardQuestionExchange(BoardWriter(author = "coordinator", threadId = "main", workerId = null), "240", "2026-01-01T09:01:00Z"),
        ))
        assertEquals("How many rows?", askBackText(open, ""))
        assertEquals("What about speed?", askBackText(open, " What about speed? "))
        assertEquals("", askBackText(open.copy(noReplyYet = false), ""))
        assertEquals("No reply yet", questionWaitingLabel(open))
        assertNull(questionWaitingLabel(open.copy(status = "answered")))
        assertEquals("You", questionExchangeAuthor(BoardWriter(author = "user", threadId = null, workerId = null)))
    }

    @Test fun agentWaitingLeavesAttentionButKeepsTheCardAndAnswerActions() {
        val waiting = question("Q1", "T1").copy(waitingOn = "agent", threadId = "main")
        val loose = waiting.copy(id = "Q2", taskId = null)
        val task = task("T1", "in_progress").copy(state = BoardTaskState("in_progress", "clarifying", "2026-01-01T09:00:00Z", listOf("Q1")))
        val board = Board(listOf(task), questions = listOf(waiting, loose), decisions = emptyList(), updatedAt = null)
        assertEquals(0, BoardView(board).openQuestionCount)
        assertEquals(0, needsYouCount(board.tasks, board.questions))
        assertTrue(waitingOn(board.questions, "T1").isEmpty())
        assertTrue(looseWaiting(board).isEmpty())
        assertEquals(listOf(loose), looseQuestions(board))
        assertEquals(board.questions, pinnedQuestions(board.questions, null))
        assertFalse(agentWaitingForUser(board.questions))
        assertTrue(questionCanAnswer(waiting))
        assertTrue(questionCanAnswerExpanded(waiting))
        assertTrue(questionCanClarify(waiting, true))
        assertEquals("Waiting for the agent", questionWaitingLabel(waiting))
        assertEquals("Clarifying", taskStateLabel(task))
        assertEquals("in_progress", graphTaskStatus(task))
        assertEquals(TaskSectionId.Working, derivedTaskSection(task))
        assertEquals("Clarifying", taskRowActivity(task, false)?.text)
        val returned = board.copy(questions = listOf(waiting.copy(waitingOn = "user", noReplyYet = true)))
        assertEquals(1, BoardView(returned).openQuestionCount)
    }
}
