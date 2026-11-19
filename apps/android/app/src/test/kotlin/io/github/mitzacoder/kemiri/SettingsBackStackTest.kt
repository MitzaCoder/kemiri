package io.github.mitzacoder.kemiri

import io.github.mitzacoder.kemiri.data.wireJson
import io.github.mitzacoder.kemiri.features.settings.*
import io.github.mitzacoder.kemiri.navigation.*
import org.junit.Assert.*
import org.junit.Test

class SettingsBackStackTest {
    private val chat = Destination.Chat("https://backend.example", "p")
    private val index = Destination.ProjectSettings(chat)
    private val coordinator = index.copy(section = ProjectSection.Coordinator)
    private val workers = index.copy(section = ProjectSection.Workers)
    private val projectMcp = index.copy(section = ProjectSection.Mcp)
    private val settings = Destination.Settings()
    private val backends = Destination.Settings(GeneralPage(GeneralSection.Backends))
    private val backend = Destination.Settings(GeneralPage(GeneralSection.Backends, chat.backendKey))
    private val accounts = Destination.Settings(backend.page.copy(accounts = true))
    private val mcp = Destination.Settings(backend.page.copy(mcp = true))
    private fun assertStack(stack: BackStack, vararg entries: Destination) = assertEquals(entries.toList(), stack.entries)

    @Test fun a1ExternalSectionHasChatBackAndReplaceOnlyUp() {
        val linked = settingsLinkStack(coordinator)
        assertStack(linked, chat, coordinator)
        assertStack(linked.back(), chat)
        val up = linked.up(index)
        assertStack(up, chat, index)
        assertStack(up.back(), chat)
        assertStack(up.close(), chat)
    }

    @Test fun a2BackendDrillDownKeepsEveryParentAtAllWidths() {
        val stack = BackStack(listOf(chat)).push(settings).push(backends).push(backend).push(accounts)
        assertStack(stack, chat, settings, backends, backend, accounts)
        assertStack(stack.back(), chat, settings, backends, backend)
        assertStack(stack.up(backend), chat, settings, backends, backend)
        assertStack(stack.up(backends), chat, settings, backends)
        assertStack(stack.close(), chat)
    }

    @Test fun a3CloseDoesNotPushProjectsOrReopenSettings() {
        val stack = BackStack().push(chat).push(settings).push(Destination.Settings(GeneralPage(GeneralSection.Appearance)))
        assertStack(stack.close(), Destination.Home, chat)
        assertStack(stack.close().back(), Destination.Home)
        assertNull(stack.close().settingsVisit)
    }

    @Test fun a4CredentialDetourHasDistinctBackUpAndClose() {
        val stack = BackStack(listOf(chat)).push(index).push(coordinator).push(accounts)
        assertStack(stack.back(), chat, index, coordinator)
        assertStack(stack.up(backend), chat, index, coordinator, backend)
        assertStack(stack.close(), chat)
        assertStack(stack.up(backend).close(), chat)
    }

    @Test fun a5TransientMcpViewsDoNotPutSecretsInSavedNavigation() {
        // MCP sub-views are transient nested targets, not serialized destinations.
        val stack = BackStack(listOf(chat)).push(projectMcp).push(mcp)
        val saved = wireJson.encodeToString(BackStack.serializer(), stack)
        assertEquals(stack, wireJson.decodeFromString(BackStack.serializer(), saved))
        assertStack(stack.back(), chat, projectMcp)
        assertStack(stack.close(), chat)
    }

    @Test fun a6NavigatorIntentIsWidthIndependent() {
        fun replay(): List<List<Destination>> {
            var stack = BackStack(listOf(chat)).push(settings)
            val navigator = SettingsNavigator({ stack = stack.push(it) }, { stack = stack.replaceSibling(it) }, { stack = stack.up(it) }, { stack = stack.close() })
            val states = mutableListOf<List<Destination>>()
            navigator.selectSection(backends, fromIndex = true); states += stack.entries
            navigator.open(backend); states += stack.entries
            navigator.open(accounts); states += stack.entries
            navigator.up(backend); states += stack.entries
            navigator.open(Destination.Settings(backend.page.copy(devices = true))); states += stack.entries
            navigator.close(); states += stack.entries
            return states
        }
        val phone = replay()
        val wide = replay() // Width cannot be passed to SettingsNavigator.
        assertEquals(phone, wide)
        assertEquals(listOf(chat, settings, backends, backend, accounts), wide[2])
        assertEquals(listOf(chat, settings, backends, backend, Destination.Settings(backend.page.copy(devices = true))), wide[4])
        assertEquals(listOf(chat), wide.last())
    }

    @Test fun w1UpPopsPhoneIndexThenBackLeavesSettingsEvenAfterWidening() {
        val stack = BackStack(listOf(chat)).push(index).withSettingsDefault(split = false).push(coordinator)
        // Width is read only on entry, not on restoring or going up to an existing entry.
        val restored = wireJson.decodeFromString(BackStack.serializer(), wireJson.encodeToString(BackStack.serializer(), stack))
        assertStack(restored.back(), chat, index)
        assertStack(restored.up(index), chat, index)
        assertStack(restored.up(index).back(), chat)
    }

    @Test fun wideOpenReplacesTheIndexAndPreservesBackCloseAndUp() {
        val appearance = Destination.Settings(GeneralPage(GeneralSection.Appearance))
        val general = index.copy(section = ProjectSection.General)
        for ((requested, expected) in listOf(settings to appearance, index to general)) {
            val stack = BackStack(listOf(chat)).push(requested).withSettingsDefault(split = true)
            assertStack(stack, chat, expected)
            assertStack(stack.back(), chat)
            assertStack(stack.close(), chat)
            assertStack(stack.up(requested), chat, requested)
            assertStack(stack.up(requested).back(), chat)
        }
        val linked = settingsLinkStack(index).withSettingsDefault(split = true)
        assertStack(linked, chat, general)
        assertStack(linked.close(), chat)
    }

    @Test fun wideOpenDoesNotChangeLinksToContentOrUnavailableSections() {
        for (section in listOf(coordinator, backends, backend, accounts, mcp,
            index.copy(section = ProjectSection.Schedules, scheduleId = "example"),
            index.copy(unavailableSection = "example"), Destination.Settings(GeneralPage(unavailableSection = "example")))) {
            val stack = settingsLinkStack(section)
            assertEquals(stack, stack.withSettingsDefault(split = true))
        }
    }

    @Test fun w2SiblingSectionsReplaceThenCloseDiscardsVisit() {
        var stack = BackStack().push(chat).push(index)
        val navigator = SettingsNavigator({ stack = stack.push(it) }, { stack = stack.replaceSibling(it) }, { stack = stack.up(it) }, { stack = stack.close() })
        navigator.selectSection(coordinator, fromIndex = true)
        navigator.selectSection(workers, fromIndex = false)
        assertStack(stack, Destination.Home, chat, index, workers)
        navigator.close()
        assertStack(stack, Destination.Home, chat)
        assertStack(stack.back(), Destination.Home)
    }

    @Test fun w3ColdAccountsUpReplacesAndCloseFallsBackHome() {
        val cold = BackStack(listOf(accounts))
        assertStack(cold.up(backend), backend)
        assertStack(cold.up(backend).up(backends), backends)
        assertStack(cold.close(), Destination.Home)
        assertStack(cold.up(backend).close(), Destination.Home)
    }

    @Test fun w4BackendMcpDetourKeepsBackgroundTaskOrigin() {
        val origin = Destination.Task(chat.copy(threadId = "background"), "T1")
        val stack = BackStack(listOf(chat, origin)).push(index).push(projectMcp).push(mcp)
        assertStack(stack.back(), chat, origin, index, projectMcp)
        assertStack(stack.close(), chat, origin)
        assertStack(stack.up(backend).close(), chat, origin)
    }

    @Test fun usageAndTerminalPopToExactOrigin() {
        val origin = Destination.Panel(chat.copy(threadId = "background"), PanelTab.Memory)
        val stack = BackStack(listOf(chat, origin))
        assertStack(stack.push(Destination.Usage).back(), chat, origin)
        assertStack(stack.push(Destination.Terminal(chat.backendKey, chat.projectId)).back(), chat, origin)
        assertStack(stack.push(Destination.Usage).push(accounts).back(), chat, origin, Destination.Usage)
        assertStack(stack.push(Destination.Usage).push(accounts).close(), chat, origin, Destination.Usage)
    }

    @Test fun upCannotFindAParentInAnEarlierVisit() {
        val stack = BackStack(listOf(settings, chat)).push(accounts)
        assertStack(stack.up(settings), settings, chat, settings)
        assertStack(stack.up(settings).close(), settings, chat)
    }

    @Test fun activityRecreationRetainsOriginAndCrossTreeFallback() {
        val origin = Destination.Panel(chat.copy(threadId = "background"), PanelTab.Threads)
        val stack = BackStack(listOf(chat, origin)).push(index).push(projectMcp).push(mcp)
        val restored = wireJson.decodeFromString(BackStack.serializer(), wireJson.encodeToString(BackStack.serializer(), stack))
        assertEquals(stack, restored)
        assertStack(restored.close(), chat, origin)
    }

    @Test fun capDuplicateTopAndLostOriginAreSafe() {
        var stack = BackStack(listOf(chat)).push(index)
        assertEquals(stack, stack.push(index))
        repeat(40) { stack = stack.push(index.copy(scheduleId = "s$it")) }
        assertEquals(30, stack.entries.size)
        assertNull(stack.settingsVisit!!.originIndex)
        assertStack(stack.close(), chat)
        assertFalse(BackStack().canGoBack)
        assertEquals(BackStack(), BackStack().back())
    }

    @Test fun coldProjectDetourKeepsProjectFallbackRatherThanTreatingSettingsAsOrigin() {
        val cold = BackStack(listOf(projectMcp))
        assertStack(cold.push(mcp).close(), chat)
        assertStack(cold.replaceSibling(mcp).close(), chat)
    }

    @Test fun coldProjectCloseUsesMainChatNotThread() {
        val cold = BackStack(listOf(index.copy(chat = chat.copy(threadId = "background"))))
        assertStack(cold.close(), chat)
        assertStack(cold.up(index).close(), chat)
    }
}
