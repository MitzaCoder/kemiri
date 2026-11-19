package io.github.mitzacoder.kemiri.features.settings

import io.github.mitzacoder.kemiri.data.HarnessFeature
import io.github.mitzacoder.kemiri.protocol.ProjectSummaryTaskWatcherStatus
import io.github.mitzacoder.kemiri.protocol.ProjectsConfigureRequest
import io.github.mitzacoder.kemiri.protocol.ProjectsConfigureRequestReportAudit

internal val DEFAULT_TASK_WATCHER_SETTINGS = ProjectsConfigureRequestReportAudit(mode = "auto", dailyTokens = 65_000)

internal fun taskWatcherVisible(features: Collection<String>?): Boolean =
    features != null && HarnessFeature.TASK_LIVE in features && HarnessFeature.TASK_LIVE_WATCHER in features

internal fun taskWatcherConfiguration(projectId: String, settings: ProjectsConfigureRequestReportAudit) =
    ProjectsConfigureRequest(projectId = projectId, taskWatcher = settings)

internal fun taskWatcherStatusWords(settings: ProjectsConfigureRequestReportAudit, status: ProjectSummaryTaskWatcherStatus?): String =
    when (settings.mode) {
        "auto" -> "Uses recorded steps without a model."
        "off" -> "Live news lines are disabled."
        else -> {
            val reason = status?.reason?.takeIf { it.isNotBlank() } ?: when (status?.state) {
                "checked" -> "The model picked from recorded actions."
                "budget" -> "Daily token budget spent. Using Automatic."
                "unavailable" -> "The chosen model is unavailable."
                "error" -> "The model could not pick a live news line."
                else -> "Uses the chosen model to pick from recorded actions."
            }
            "$reason\n${reportAuditUsage(status?.tokensUsed ?: 0, settings.dailyTokens)}."
        }
    }
