package io.github.mitzacoder.kemiri.tasks

import io.github.mitzacoder.kemiri.navigation.*
import org.junit.Assert.*
import org.junit.Test

class LinkedTaskNavigationTest {
    @Test fun workerDetourAndRepeatedDrillDownPopToExactOrigins() {
        val chat = Destination.Chat("backend", "p")
        val panel = Destination.Panel(chat, PanelTab.Board)
        val parent = Destination.Task(chat, "T12")
        val child = Destination.Task(chat, "T13")
        val grandchild = Destination.Task(chat, "T14")
        val origin = BackStack(listOf(chat, panel, parent))
        val drilled = origin.push(child).push(grandchild)
        assertEquals(child, drilled.back().current)
        assertEquals(parent, drilled.back().back().current)
        assertEquals(panel, drilled.back().back().back().current)
        val worker = chat.copy(workerId = "reader")
        assertEquals(origin, origin.push(worker).back())
        assertEquals(drilled, drilled.push(Destination.ProjectSettings(chat)).close())
    }

    @Test fun aFreshTaskHasNoTaskReturnTarget() {
        val chat = Destination.Chat("backend", "p")
        val fresh = BackStack(listOf(chat)).push(Destination.Task(chat, "T20"))
        assertTrue(fresh.entries[fresh.entries.lastIndex - 1] is Destination.Chat)
    }

    @Test fun linkedTasksKeepTheirPanelBehindThemWhenOpeningAndGoingBack() {
        val chat = Destination.Chat("backend", "p")
        val panel = Destination.Panel(chat, PanelTab.Board)
        val parent = Destination.Task(chat, "T1")
        val child = Destination.Task(chat, "T2")
        assertEquals(panel, panelBehindTask(listOf(chat, panel), parent))
        assertEquals(panel, panelBehindTask(listOf(chat, panel, parent), child))
        assertNull(panelBehindTask(listOf(panel, chat), child))
        assertNull(panelBehindTask(listOf(Destination.Panel(chat.copy(projectId = "other"))), child))
    }
}
