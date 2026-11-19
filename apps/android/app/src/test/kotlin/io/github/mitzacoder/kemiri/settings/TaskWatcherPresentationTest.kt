package io.github.mitzacoder.kemiri.settings

import io.github.mitzacoder.kemiri.features.settings.*
import io.github.mitzacoder.kemiri.protocol.ModelRef
import io.github.mitzacoder.kemiri.protocol.ProjectSummaryTaskWatcherStatus
import io.github.mitzacoder.kemiri.protocol.ProjectSummaryTaskWatcherStatusTotals
import org.junit.Assert.*
import org.junit.Test

class TaskWatcherPresentationTest {
    @Test fun needsBothLiveFeaturesButNotReportCheck() {
        assertFalse(taskWatcherVisible(null))
        assertFalse(taskWatcherVisible(listOf("task-live")))
        assertFalse(taskWatcherVisible(listOf("task-live-watcher", "report-audit")))
        assertTrue(taskWatcherVisible(listOf("task-live", "task-live-watcher")))
    }

    @Test fun defaultsToAutomaticAndSavesOnlyTheWatcherField() {
        val defaults = DEFAULT_TASK_WATCHER_SETTINGS
        assertEquals("auto", defaults.mode)
        assertNull(defaults.model)
        assertEquals(65_000L, defaults.dailyTokens)
        for (settings in listOf(defaults, defaults.copy(mode = "off"),
            defaults.copy(mode = "model", model = ModelRef(provider = "faux", modelId = "faux-1"), dailyTokens = 0))) {
            val request = taskWatcherConfiguration("bakery", settings)
            assertEquals("bakery", request.projectId)
            assertEquals(settings, request.taskWatcher)
            assertNull(request.reportAudit)
        }
    }

    @Test fun showsTheEffectiveModeAndTheModelReasonAndUsage() {
        val defaults = DEFAULT_TASK_WATCHER_SETTINGS
        assertEquals("Uses recorded steps without a model.", taskWatcherStatusWords(defaults, null))
        assertEquals("Live news lines are disabled.", taskWatcherStatusWords(defaults.copy(mode = "off"), null))
        val status = ProjectSummaryTaskWatcherStatus(effectiveModel = null, day = "2026-06-01", tokensUsed = 1_250,
            lastRunAt = null, state = "unavailable", reason = "No account. Using Automatic.",
            totals = ProjectSummaryTaskWatcherStatusTotals(written = 0, wrong = 0), byPicker = emptyMap())
        assertEquals("No account. Using Automatic.\n1,250 of 65,000 tokens today.", taskWatcherStatusWords(defaults.copy(mode = "model"), status))
    }
}
