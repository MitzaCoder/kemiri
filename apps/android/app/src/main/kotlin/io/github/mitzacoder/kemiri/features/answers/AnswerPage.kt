package io.github.mitzacoder.kemiri.features.answers

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.ConnectionStatus
import io.github.mitzacoder.kemiri.data.request
import io.github.mitzacoder.kemiri.features.chat.RichMarkdown
import io.github.mitzacoder.kemiri.navigation.ChatHighlight
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
internal fun AnswerPage(context: ProjectScreenContext, answerId: String, onDelete: () -> Unit, modifier: Modifier = Modifier) {
    val client = context.backend.client
    val projectId = context.route.projectId
    val catalogue = context.backend.answers(projectId)
    val full by catalogue.catalogue.collectAsStateWithLifecycle()
    val connection by client.state.collectAsStateWithLifecycle()
    val ready = connection.status == ConnectionStatus.Ready
    val answer = full.answers?.firstOrNull { it.id == answerId }
    // Delete may invalidate the catalogue before its response arrives. Keep the action alive until the page leaves.
    val scope = rememberCoroutineScope()
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        if (!ready) AnswerHint("Offline · showing last loaded data")
        full.error?.let {
            AnswerHint(it, isError = true)
            TextButton(onClick = catalogue::refresh, enabled = ready) { Text("Retry loading answer") }
        }
        if (answer == null) {
            when {
                full.answers != null -> AnswerHint("This answer is no longer available.")
                ready && full.error == null -> LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        } else key(answer.id) {
            var readError by remember { mutableStateOf<String?>(null) }
            var retryRead by remember { mutableIntStateOf(0) }
            val pending = answer.working != null
            LaunchedEffect(client, ready, connection.generation, answer.at, answer.entryId, answer.read, pending, retryRead) {
                if (answer.read || pending) readError = null
                if (ready && !answer.read && !pending) {
                    readError = null
                    try { client.request(AnswersUpdateRequest(projectId = projectId, answerId = answerId, read = true)) }
                    catch (error: CancellationException) { throw error }
                    catch (error: Exception) { readError = answerError(error) }
                }
            }
            var followUp by rememberSaveable { mutableStateOf(false) }
            var question by rememberSaveable { mutableStateOf("") }
            var confirmDelete by rememberSaveable { mutableStateOf(false) }
            var acting by remember { mutableStateOf(false) }
            var feedback by rememberSaveable { mutableStateOf<String?>(null) }
            var actionError by remember { mutableStateOf<String?>(null) }
            var lastAskId by rememberSaveable { mutableStateOf<String?>(null) }
            var lastAskQuestion by rememberSaveable { mutableStateOf<String?>(null) }
            fun act(action: suspend () -> Unit) {
                if (!ready || acting) return
                acting = true
                actionError = null
                feedback = null
                scope.launch {
                    try { action() }
                    catch (error: CancellationException) { throw error }
                    catch (error: Exception) { actionError = answerError(error) }
                    finally { acting = false }
                }
            }
            fun ask(text: String?) = act {
                val requestId = lastAskId?.takeIf { lastAskQuestion == text } ?: UUID.randomUUID().toString()
                lastAskId = requestId
                lastAskQuestion = text
                client.request(AnswersAskRequest(projectId = projectId, answerId = answerId, requestId = requestId, question = text))
                lastAskId = null
                followUp = false
                question = ""
                feedback = "Sent to ${answer.coordinatorTitle}. The new reply will appear here when it is ready."
            }
            val enabled = ready && !acting
            val (today, zone) = rememberAnswerDay()
            val whenAnswered = answerWhen(answer.at, today, zone)
            val taskIds = (answer.related + listOfNotNull(answer.taskId)).distinct()
            Column(Modifier.widthIn(max = 680.dp).fillMaxWidth().verticalScroll(rememberScrollState()).imePadding().padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Answer · ${answer.id}", style = MaterialTheme.typography.labelMedium, color = Jarvis.colors.fgMuted)
                Text(answer.title, Modifier.semantics { heading() }, style = MaterialTheme.typography.headlineSmall)
                val work = answer.working?.let { rememberAnswerWorkStatus(it, answer.at) }
                if (work == null) {
                    Text("Answered $whenAnswered · by ${answer.coordinatorTitle}", style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted)
                } else Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    AnswerWorkGlyph(work.indicator)
                    Text(work.label, style = MaterialTheme.typography.bodySmall, color = answerWorkColor(work.indicator))
                }
                HorizontalDivider()
                if (pending) Text(answer.question) else RichMarkdown(answer.answer, Modifier.fillMaxWidth())
                if (taskIds.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    taskIds.forEach { id -> AnswerTaskChip(id, true) { context.openTask(id) } }
                }
                if (!pending) Text("A snapshot from $whenAnswered. It does not update itself.", style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    if (!pending) {
                        OutlinedButton(onClick = { ask(null) }, enabled = enabled) { Text("Ask again") }
                        OutlinedButton(onClick = { followUp = !followUp }, enabled = enabled) { Text("Ask a follow-up…") }
                        if (answer.taskId == null) OutlinedButton(onClick = {
                            act {
                                val task = client.request(AnswersTurnIntoTaskRequest(projectId = projectId, answerId = answerId))
                                context.openTask(task.taskId)
                            }
                        }, enabled = enabled) { Text("Turn into a task") }
                    }
                    TextButton(onClick = {
                        act { client.request(AnswersUpdateRequest(projectId = projectId, answerId = answerId, pinned = !answer.pinned)) }
                    }, enabled = enabled) { Text(if (answer.pinned) "Unpin" else "Pin") }
                    answer.entryId?.let { entry ->
                        TextButton(onClick = {
                            context.navigate(context.route.copy(threadId = answer.coordinatorId.takeUnless { it == MAIN_THREAD_ID },
                                workerId = null, highlight = ChatHighlight.Entry(entry)))
                        }) { Text("Show in chat") }
                    }
                    TextButton(onClick = { confirmDelete = true }, enabled = enabled) {
                        Text("Delete", color = if (enabled) MaterialTheme.colorScheme.error else androidx.compose.ui.graphics.Color.Unspecified)
                    }
                }
                if (followUp && !pending) {
                    OutlinedTextField(question, { question = it }, Modifier.fillMaxWidth(), label = { Text("Follow-up question") },
                        enabled = !acting, minLines = 2)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button(onClick = { ask(question.trim()) }, enabled = enabled && question.isNotBlank()) { Text("Send follow-up") }
                        TextButton(onClick = { followUp = false }, enabled = !acting) { Text("Cancel") }
                    }
                }
                feedback?.let { Text(it, Modifier.semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.bodySmall) }
                actionError?.let { AnswerHint(it, isError = true) }
                readError?.let {
                    AnswerHint(it, isError = true)
                    TextButton(onClick = { retryRead++ }, enabled = ready) { Text("Retry marking read") }
                }
                if (answer.exchanges.isNotEmpty()) {
                    HorizontalDivider()
                    Text("Earlier replies", Modifier.semantics { heading() }, style = MaterialTheme.typography.titleMedium)
                    answer.exchanges.forEach { exchange ->
                        Text(exchange.question, style = MaterialTheme.typography.titleSmall)
                        Text("Answered ${answerWhen(exchange.at, today, zone)} · by ${exchange.coordinatorTitle}",
                            style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted)
                        RichMarkdown(exchange.answer, Modifier.fillMaxWidth())
                        HorizontalDivider()
                    }
                }
            }
            if (confirmDelete) AlertDialog(
                onDismissRequest = { confirmDelete = false }, title = { Text("Delete answer?") },
                text = { Text("This deletes the answer and its earlier replies from Answers. The chat and linked tasks will stay.") },
                confirmButton = { TextButton(onClick = {
                    confirmDelete = false
                    act { client.request(AnswersDeleteRequest(projectId = projectId, answerId = answerId)); onDelete() }
                }, enabled = enabled) { Text("Delete answer") } },
                dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("Cancel") } },
            )
        }
    }
}
