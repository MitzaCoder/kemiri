package io.github.mitzacoder.kemiri.features.tasks.graph

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.chat.markdownText
import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.navigation.modelLabel
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

/** Reusable worker/job sheet. A worker in a background job keeps both IDs in the transcript callback. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun GraphWorkerSheet(workerId: String?, threadId: String?, workers: List<WorkerSummary>,
    threads: List<ThreadSummary>, tasks: List<BoardTask>, questions: List<BoardQuestion>, models: List<ModelInfo>,
    now: Long, activityEnabled: Boolean, onDismiss: () -> Unit, onOpenTask: (String) -> Unit,
    onOpenTranscript: (String, String?) -> Unit, onOpenChat: (String) -> Unit, conversationId: Long? = null) {
    val worker = workers.find { it.id == workerId && (it.threadId ?: "main") == (threadId ?: "main") &&
        (conversationId == null || it.conversationId == conversationId) }
    val thread = if (workerId == null) threads.find { it.id == threadId } else null
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        GraphWorkerPeek(worker, thread, tasks, questions, models, now, activityEnabled, onDismiss, onOpenTask,
            onOpenTranscript, onOpenChat, Modifier.fillMaxWidth().fillMaxHeight(.86f))
    }
}

@Composable
private fun GraphWorkerPeek(worker: WorkerSummary?, thread: ThreadSummary?, tasks: List<BoardTask>,
    questions: List<BoardQuestion>, models: List<ModelInfo>, now: Long, activityEnabled: Boolean,
    onClose: () -> Unit, onOpenTask: (String) -> Unit, onOpenTranscript: (String, String?) -> Unit,
    onOpenChat: (String) -> Unit, modifier: Modifier = Modifier) {
    val colors = Jarvis.colors
    Column(modifier.semantics { paneTitle = if (thread != null) "Background job preview" else "Worker preview" }
        .verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            GraphDetailHeading(if (thread != null) "Background job" else "Worker")
            Spacer(Modifier.weight(1f))
            TextButton(onClick = onClose, modifier = Modifier.heightIn(min = 48.dp)) { Text("Back to graph") }
        }
        if (worker == null && thread == null) Text("This worker is no longer available. The graph selection is kept.", color = colors.fg)
        else {
            val id = worker?.id ?: thread!!.id
            val title = worker?.title ?: thread!!.title
            val status = worker?.status ?: thread!!.status
            val updatedAt = worker?.updatedAt ?: thread!!.updatedAt
            val createdAt = worker?.createdAt ?: thread!!.createdAt
            val taskId = worker?.taskId ?: thread?.taskId
            val task = tasks.find { it.id == taskId }
            val report = worker?.lastReport ?: thread?.summary
            val failure = worker?.failure ?: thread?.failure
            val activity = worker?.let { graphWorkerActivity(it, task, activityEnabled) }
            val doingNow = worker?.let { graphWorkerDoingNow(it, task, activityEnabled) } ?: thread?.current
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                GraphCrewMascot(GraphCrewMember(worker?.let(::graphWorkerKey) ?: "thread:${thread?.id}", status, workerMotion(status, task, questions.filter { it.taskId == taskId }), thread != null), false, mascotSize = 40.dp)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(id, color = colors.fg, style = TaskType.rowTitle, modifier = Modifier.semantics { heading() })
                    Text(title, color = colors.fgMuted, style = TaskType.xs)
                    Text("$status · ${activityDuration(updatedAt, now)}", color = colors.fgSubtle, style = TaskType.xs)
                }
            }
            if (!doingNow.isNullOrBlank()) {
                GraphDetailHeading("Doing now")
                if (activity != null) TaskActivityView(activity) else Text(markdownText(doingNow), color = colors.fg, style = TaskType.xs)
            }
            if (!report.isNullOrBlank()) {
                GraphDetailHeading("Last report · ${relativeTime(thread?.finishedAt ?: updatedAt, now)}")
                Text(markdownText(report), color = colors.fg, style = TaskType.xs, maxLines = 4, overflow = TextOverflow.Ellipsis)
            }
            if (!failure.isNullOrBlank()) Column(Modifier.fillMaxWidth().background(colors.danger.copy(alpha = .08f), RoundedCornerShape(12.dp)).padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                GraphDetailHeading("Why it failed")
                Text(failure, color = colors.fg, style = TaskType.xs)
            }
            GraphDetailHeading("Task")
            if (taskId == null) Text("No task", color = colors.fgSubtle, style = TaskType.xs)
            else TextButton(onClick = { onOpenTask(taskId) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                .semantics { contentDescription = "Open task $taskId: ${task?.title ?: "Unavailable"}" }) { Text("$taskId · ${task?.title ?: "Open task"}", Modifier.fillMaxWidth()) }
            GraphDetailHeading("Model")
            Text("${modelLabel(worker?.model ?: thread?.model, models)} · thinking ${worker?.thinkingLevel ?: thread?.thinkingLevel ?: "default"}", color = colors.fg, style = TaskType.xs)
            GraphDetailHeading("Runs in")
            Text(if (worker?.isolation == "shared") "shared checkout" else "its own workspace", color = colors.fg, style = TaskType.xs)
            GraphDetailHeading("Started")
            Text(relativeTime(createdAt, now), color = colors.fg, style = TaskType.xs)
            HorizontalDivider()
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { if (worker != null) onOpenTranscript(worker.id, worker.threadId?.takeUnless { it == "main" })
                    else onOpenChat(thread!!.id) }, modifier = Modifier.heightIn(min = 48.dp)) {
                    Text(if (thread != null) "Open chat" else "Open transcript")
                }
                if (taskId != null) OutlinedButton(onClick = { onOpenTask(taskId) }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Open task") }
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}
