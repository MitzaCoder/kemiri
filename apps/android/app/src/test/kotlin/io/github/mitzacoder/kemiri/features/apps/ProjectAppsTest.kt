package io.github.mitzacoder.kemiri.features.apps

import io.github.mitzacoder.kemiri.features.chat.ChatPart
import io.github.mitzacoder.kemiri.protocol.AppPublisher
import io.github.mitzacoder.kemiri.protocol.ProjectApp
import org.junit.Assert.*
import org.junit.Test

class ProjectAppsTest {
    private val live = ProjectApp(appId = "form", projectId = "bakery", name = "Order form", port = 5173,
        path = "/", url = "http://oven.example.test:5173/", state = "live", taskId = "T1",
        publishedBy = AppPublisher("main", "coordinator", "main", 1), createdAt = "2026-01-02T00:00:00Z", mode = "template")

    @Test fun onlyPublishedRowsAreVisibleAndOnlyLiveAppsCount() {
        val stopped = live.copy(appId = "stopped", state = "stopped")
        val pending = live.copy(appId = "pending", taskId = "T2", state = "pending")
        val rows = listOf(live, stopped, pending, live.copy(state = "unpublished"))
        assertEquals(listOf(live, stopped, pending), visibleApps(rows))
        assertEquals(listOf(live, stopped), visibleApps(rows, "T1"))
        assertEquals("1 app running · 1 pending", appCountLabel(rows))
    }

    @Test fun stoppedAndPendingAppsCannotOpenHistoricalLinks() {
        assertEquals("Live", appStateLabel(live))
        assertEquals(live.url, appLink(live))
        val stopped = live.copy(state = "stopped")
        assertEquals("Stopped · nothing listens on port 5173 any more", appStateLabel(stopped))
        assertNull(appLink(stopped))
        assertNull(appLink(live.copy(state = "pending")))
        assertNull(appLink(live.copy(url = "http://name@oven.example.test:5173/")))
        assertEquals("No address configured", appStateLabel(live.copy(url = null)))
    }

    @Test fun projectionUsesReceiptIdentityNotItsAddress() {
        val part = ChatPart("call", "tool", text = """{"appId":"form","url":"http://oven.example.test:5173/"}""",
            name = "app_publish", status = "done")
        assertEquals("form", appIdFromCall(part))
        assertNull(appIdFromCall(part.copy(status = "error")))
    }
}
