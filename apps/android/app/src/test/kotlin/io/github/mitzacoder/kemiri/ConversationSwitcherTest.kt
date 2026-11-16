package io.github.mitzacoder.kemiri

import io.github.mitzacoder.kemiri.navigation.*
import io.github.mitzacoder.kemiri.protocol.*
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.time.Instant

class ConversationSwitcherTest {
    private val now = Instant.parse("2026-11-17T12:00:00Z").toEpochMilli()
    private fun job(id: String, state: String, age: Int = 0, archived: Boolean = false): ThreadSummary = Json.decodeFromString("""{
        "id":"$id","title":"$id","status":"idle","state":"$state","main":false,"startedBy":"main",
        "scheduleId":null,"conversationId":42,"model":null,"thinkingLevel":null,"onFinish":"record",
        "runningWorkers":0,"ownedTasks":[],"openQuestions":0,"current":null,"summary":null,"failure":null,
        "createdAt":"2026-11-17T09:00:00Z","updatedAt":"${Instant.ofEpochMilli(now - age * 3600000L)}",
        "finishedAt":null,"archived":$archived} """)
    private val jobs get() = listOf(job("old", "finished", 25), job("paused", "paused"), job("working", "working"),
        job("failed", "failed"), job("needs", "needs_you"), job("finished", "finished"), job("stopped", "stopped", 24),
        job("archived", "paused", archived = true), job("main", "working").copy(main = true))

    @Test fun mainFirstAndAttentionOrderWithOnlyOldTerminalJobsFolded() {
        val choices = conversationChoices(jobs, null, now)
        assertEquals(listOf("main", "needs", "failed", "working", "paused", "finished", "stopped", "old"), choices.map { it.id })
        assertEquals(listOf("old"), choices.filter { it.folded }.map { it.id })
        assertEquals(listOf("main"), choices.filter { it.current }.map { it.id })
        assertEquals("You talk here. It hands big jobs to the background and reports back.", MAIN_CHAT_DESCRIPTION)
    }
    @Test fun mainAndJobShowExactlyTheSameListExceptCurrentMarker() {
        val main = conversationChoices(jobs, null, now)
        val job = conversationChoices(jobs, "working", now)
        assertEquals(main.map { it.copy(current = false) }, job.map { it.copy(current = false) })
        assertEquals(listOf("working"), job.filter { it.current }.map { it.id })
        assertTrue(conversationChoices(jobs, "old", now).single { it.id == "old" }.current)
    }
    @Test fun choosingCurrentDismissesWithoutNavigationIncludingMainAlias() {
        val route = Destination.Chat("backend", "project")
        assertNull(conversationChoiceDestination(route, "main"))
        assertNull(conversationChoiceDestination(route.copy(threadId = "main"), "main"))
        assertNull(conversationChoiceDestination(route.copy(threadId = "working"), "working"))
    }
    @Test fun choicesPushAndBackRestoresExactPanelOriginAndConversationHistory() {
        val main = Destination.Chat("backend", "project")
        val origin = Destination.Panel(main, PanelTab.Board)
        val first = conversationChoiceDestination(main, "needs")!!
        val second = conversationChoiceDestination(first, "working")!!
        val stack = BackStack(listOf(origin)).push(first).push(second)
        assertEquals(first, stack.back().current)
        assertEquals(origin, stack.back().back().current)
        val returnMain = conversationChoiceDestination(second, "main")!!
        assertEquals(main, returnMain)
        assertEquals(second, stack.push(returnMain).back().current)
    }
    @Test fun choiceDropsOneShotHighlight() {
        assertNull(conversationChoiceDestination(Destination.Chat("b", "p", highlight = ChatHighlight.Entry(1)), "working")!!.highlight)
    }
    @Test fun headerWiringKeepsCountsInTitleAndRemovesBackgroundAction() {
        val source = File("src/main/kotlin/io/github/mitzacoder/kemiri/navigation/ProjectHeader.kt").readText()
        val title = source.substringBefore("fun RowScope.ProjectHeaderActions")
        val actions = source.substringAfter("fun RowScope.ProjectHeaderActions")
        assertTrue(title.contains("HeaderBadge(background.needsYou.toString()"))
        assertTrue(title.contains("Text(background.working.toString()"))
        assertTrue(title.contains("onClickLabel = \"Switch conversation\""))
        assertTrue(title.contains("stateDescription ="))
        assertFalse(actions.contains("HeaderAction(\"background\""))
        assertFalse(actions.contains("toggle(PanelTab.Threads)"))
    }
}
