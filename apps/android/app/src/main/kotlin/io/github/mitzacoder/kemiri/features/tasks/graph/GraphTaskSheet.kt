package io.github.mitzacoder.kemiri.features.tasks.graph

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.features.chat.markdownText
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

/**
 * Reusable task sheet. Context serves only the list's revision-aware question answer path.
 * [onWorker] receives [graphWorkerKey] for a worker, or `thread:<id>` for a background job.
 * The host owns selection and routes; replacing the watched lists refreshes an open sheet.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun GraphTaskSheet(context: ProjectScreenContext, taskId: String, tasks: List<BoardTask>,
    questions: List<BoardQuestion>, workers: List<WorkerSummary>, threads: List<ThreadSummary>, now: Long,
    activityEnabled: Boolean, freshnessEnabled: Boolean, onDismiss: () -> Unit, onOpenTask: (String) -> Unit,
    onWorker: (String) -> Unit, onShowLinked: () -> Unit, archivedLinks: List<BoardTaskBrief> = emptyList()) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        GraphTaskPeek(taskId, tasks, questions, workers, threads, now, context, activityEnabled, freshnessEnabled, onWorker, onOpenTask,
            onShowLinked, onDismiss, archivedLinks, Modifier.fillMaxWidth().fillMaxHeight(.86f))
    }
}

/** Selection is an ID: watched replacements refresh the sheet without capturing an old task. */
@Composable
private fun GraphTaskPeek(id: String, tasks: List<BoardTask>, questions: List<BoardQuestion>,
    workers: List<WorkerSummary>, threads: List<ThreadSummary>, now: Long, context: ProjectScreenContext,
    activityEnabled: Boolean, freshnessEnabled: Boolean, onWorker: (String) -> Unit,
    onOpen: (String) -> Unit, onShowLinked: () -> Unit, onClose: () -> Unit, archivedLinks: List<BoardTaskBrief> = emptyList(), modifier: Modifier = Modifier) {
    val task = tasks.find { it.id == id }
    val waiting = questions.filter { it.taskId == id && it.status == "open" && it.postponed != true }
    val assignedWorkers = workers.filter { it.taskId == id || (it.taskId == null && it.id in task?.workerIds.orEmpty()) }
    val assignedThreads = threads.filter { !it.main && !it.archived && (it.taskId == id || id in it.ownedTasks || task?.ownerThreadId == it.id) }
    val colors = Jarvis.colors
    Column(modifier.semantics { paneTitle = "Task preview" }.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (task != null) Text(graphTaskLabel(task).mark, color = colors.taskStatus(taskStateTone(task)))
            TaskIdChip(id)
            if (task != null) Text(task.title, color = colors.fg, style = TaskType.rowTitle, modifier = Modifier.weight(1f).semantics { heading() })
            TextButton(onClick = onClose, modifier = Modifier.heightIn(min = 48.dp)) { Text("Close") }
        }
        if (task == null) Text("This task is no longer on the board. The selection is kept until closed.", color = colors.fg)
        else {
            val parts = graphPeekParts(task, tasks, questions)
            val progress = taskPartProgress(task)
            val activity = taskRowActivity(task, activityEnabled) { target -> tasks.find { it.id == target }?.title }
            if (progress != null) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    TaskPartsBar(progress)
                    Text(progress.text, color = colors.fgMuted, style = TaskType.xs, modifier = Modifier.weight(1f))
                }
            } else if (activity != null) TaskActivityView(activity, stateTone = taskStateTone(task))
            else Text(graphTaskLabel(task).label, color = colors.fgMuted, style = TaskType.xs)
            if (parts.listed.isNotEmpty() || parts.done > 0) {
                GraphDetailHeading("Parts")
                parts.listed.forEach { part -> Text("${graphTaskLabel(part).mark} ${part.title} · ${part.id}", color = colors.fg, style = TaskType.xs) }
                if (parts.done > 0) Text("+ ${parts.done} done", color = colors.fgSubtle, style = TaskType.xs)
            }
            waiting.forEach { question ->
                Text("${question.id} · asked ${relativeTime(question.askedAt, now)}", color = colors.fgSubtle, style = TaskType.meta)
                QuestionCard(context, question, compact = true, optionsOnly = true)
            }
            val nowText = taskNowText(task, activityEnabled)
            if (nowText.isNotBlank()) {
                GraphDetailHeading("Now")
                val phase = taskActivity(task, activityEnabled)
                if (phase != null) TaskActivityView(phase) else ReportMarkdown(nowText)
            }
            val results = graphPeekResults(task.report.results)
            if (results.isNotEmpty() || (task.state?.liveWorkSince == null && emptyFinishedResults(task.status, task.report.results))) {
                GraphDetailHeading("Results")
                results.forEach { Text("• $it", color = colors.fg, style = TaskType.xs) }
                if (results.isEmpty()) Text("No results yet · work finished", color = colors.fgSubtle, style = TaskType.xs)
                if (freshnessEnabled) task.report.freshness?.results?.let { ReportSectionFreshness(it, now) }
            }
            if (task.report.next.isNotBlank()) {
                GraphDetailHeading("Next")
                Text(markdownText(task.report.next), maxLines = 2, overflow = TextOverflow.Ellipsis, color = colors.fg, style = TaskType.xs)
                if (freshnessEnabled) task.report.freshness?.next?.let { ReportSectionFreshness(it, now) }
            }
            if (assignedWorkers.isNotEmpty() || assignedThreads.any { !it.main && !it.archived }) GraphDetailHeading("Workers")
            assignedWorkers.forEach { worker ->
                GraphWorkerRow(worker.id, worker.status, relativeTime(worker.updatedAt, now),
                    GraphCrewMember("worker:${worker.id}", worker.status, workerMotion(worker.status, task, waiting), false)) { onWorker(graphWorkerKey(worker)) }
            }
            assignedThreads.filter { !it.main && !it.archived }.forEach { thread ->
                GraphWorkerRow(thread.title, thread.status, "Background job", GraphCrewMember("thread:${thread.id}", thread.status,
                    workerMotion(thread.status, task, waiting), true)) { onWorker("thread:${thread.id}") }
            }
            linkGroups(task, tasks, archivedLinks).filter { it.kind != "subtasks" }.forEach { group ->
                GraphDetailHeading(group.label)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    group.items.forEach { target -> TextButton(onClick = { onOpen(target.id) }, modifier = Modifier.heightIn(min = 48.dp)
                        .semantics { contentDescription = "${group.label} ${target.id}: ${target.title}" }) { Text("${target.id} · ${target.title}") } }
                }
            }
            HorizontalDivider()
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { onOpen(id) }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Open task") }
                OutlinedButton(onClick = onShowLinked, modifier = Modifier.heightIn(min = 48.dp)) { Text("Show linked") }
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
internal fun GraphDetailHeading(text: String) {
    Text(text, color = Jarvis.colors.fgSubtle, style = TaskType.heading, modifier = Modifier.semantics { heading() })
}

@Composable
internal fun GraphWorkerRow(name: String, status: String, age: String, member: GraphCrewMember, onOpen: () -> Unit) {
    TextButton(onClick = onOpen, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
        .semantics { contentDescription = "Show ${if (member.background) "background job" else "worker"} $name, $status, $age" }) {
        GraphCrewMascot(member, false)
        Spacer(Modifier.width(8.dp))
        Text(name, color = Jarvis.colors.fg, style = TaskType.xsMedium, modifier = Modifier.weight(1f))
        Text("$status · $age ›", color = Jarvis.colors.fgSubtle, style = TaskType.meta)
    }
}
