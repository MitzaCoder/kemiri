package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.components.StatusBadge
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import java.text.NumberFormat

@Composable
internal fun TaskRecord(task: BoardTask, decisions: List<BoardDecision>, checks: List<BoardReportCheck>, now: Long, savedFolds: Map<String, Boolean>, onFoldChange: (TaskRecordRow, Boolean) -> Unit, activityContent: (@Composable ColumnScope.() -> Unit)?) {
    Column {
        TaskHeading("The record", Modifier.padding(bottom = 8.dp))
        val requestOpen = readTaskRecordFold(TaskRecordRow.Request, savedFolds)
        TaskFold(TaskRecordRow.Request.title, requestOpen, { onFoldChange(TaskRecordRow.Request, !requestOpen) }) {
            if (task.description.isNotBlank()) ReportMarkdown(task.description)
            else if (task.acceptance.isNullOrBlank()) Text("No request written.", style = TaskType.xs, color = Jarvis.colors.fgMuted)
            task.acceptance?.takeIf { it.isNotBlank() }?.let { acceptance ->
                TaskReadingSection("Done when") { ReportMarkdown(acceptanceMarkdown(acceptance)) }
            }
        }
        if (checks.isNotEmpty()) {
            val checksOpen = readTaskRecordFold(TaskRecordRow.Checks, savedFolds)
            TaskFold(TaskRecordRow.Checks.title, checksOpen, { onFoldChange(TaskRecordRow.Checks, !checksOpen) }) {
                checks.forEach { TaskCheck(it) }
            }
        }
        if (decisions.isNotEmpty()) {
            val decidedOpen = readTaskRecordFold(TaskRecordRow.Decided, savedFolds)
            TaskFold(TaskRecordRow.Decided.title, decidedOpen, { onFoldChange(TaskRecordRow.Decided, !decidedOpen) }) {
                decisions.forEach { decision ->
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("${decision.id} · ${relativeTime(decision.at, now)}", style = TaskType.meta, color = Jarvis.colors.fgMuted)
                        ReportMarkdown(decision.text)
                        decision.why?.takeIf { it.isNotBlank() }?.let { ReportMarkdown(it) }
                    }
                }
            }
        }
        if (activityContent != null) {
            val activityOpen = readTaskRecordFold(TaskRecordRow.Activity, savedFolds)
            TaskFold(TaskRecordRow.Activity.title, activityOpen, { onFoldChange(TaskRecordRow.Activity, !activityOpen) }, content = activityContent)
        }
    }
}

@Composable
private fun TaskCheck(check: BoardReportCheck) {
    val colors = Jarvis.colors
    val passed = check.result == "passed"
    val result = if (passed) "Passed" else "Failed"
    Row(
        Modifier.fillMaxWidth().semantics(mergeDescendants = true) { contentDescription = result },
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        LucideGlyph(if (passed) Lucide.Check else Lucide.X, Modifier.padding(top = 2.dp), size = 16.dp,
            tint = if (passed) colors.success else colors.danger)
        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
            val count = check.count?.let { " · ${NumberFormat.getIntegerInstance().format(it)}" }.orEmpty()
            Text(check.name + count, style = TaskType.sectionTitle, color = colors.fg)
            check.note?.trim()?.takeIf { it.isNotEmpty() }?.let { Text(it, style = TaskType.xs, color = colors.fgMuted) }
        }
    }
}

@Composable
internal fun TaskRecordWorkers(context: ProjectScreenContext, workerIds: List<String>, workers: List<WorkerSummary>) {
    Column {
        TaskHeading("Workers")
        workerIds.forEach { id ->
            val worker = workers.firstOrNull { it.id == id }
            if (worker == null) Text("$id · Worker no longer available", Modifier.padding(vertical = 6.dp), style = TaskType.xs, color = Jarvis.colors.fgMuted)
            else {
                val title = worker.title.ifBlank { worker.id }
                Row(
                    Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = "Read $title") {
                        context.navigate(context.route.copy(threadId = worker.threadId, workerId = worker.id))
                    }.heightIn(min = 48.dp).padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    TaskDetailText(title, Modifier.weight(1f), style = TaskType.sectionTitle, color = Jarvis.colors.fg)
                    StatusBadge(worker.status, domain = "worker")
                }
            }
        }
    }
}
