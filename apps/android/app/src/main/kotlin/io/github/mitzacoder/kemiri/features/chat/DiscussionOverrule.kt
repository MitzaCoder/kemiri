package io.github.mitzacoder.kemiri.features.chat

import android.content.Context
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.features.tasks.editorDraft
import io.github.mitzacoder.kemiri.features.tasks.toInput
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive

private enum class DiscussionChoice(val label: String, val question: String) {
    Reopen("Reopen the old task instead", "Reopen the old task and drop its follow-up, if there is one?"),
    Answer("Only answer here", "Ask for an answer here and drop the follow-up, if there is one?"),
}

@Composable
internal fun DiscussionOverrule(context: ProjectScreenContext, reference: DiscussionReference, details: DiscussionDetails?, homeId: String, messageKey: String, sentAt: Long) {
    val android = LocalContext.current
    val prefs = remember(android) { android.getSharedPreferences("discussion-actions", Context.MODE_PRIVATE) }
    val project = context.route.projectId
    val scope = rememberCoroutineScope()
    val client = context.backend.client
    val connection by client.state.collectAsStateWithLifecycle()
    val board by context.board.view.collectAsStateWithLifecycle()
    val task = board.tasks.find { it.id == homeId }
    val folder = details?.home
    val relevant = settledDiscussionTask(task?.status ?: folder?.status, if (task != null) task.settledAt else folder?.settledAt, sentAt)
    val storageKey = "${context.backend.config.key}|$project|$messageKey"
    var result by remember(storageKey) { mutableStateOf(prefs.getString(storageKey, null)) }
    var choice by rememberSaveable(storageKey) { mutableStateOf<DiscussionChoice?>(null) }
    var reopened by rememberSaveable(storageKey) { mutableStateOf(false) }
    var dropped by rememberSaveable(storageKey) { mutableStateOf<String?>(null) }
    var submittingNote by rememberSaveable(storageKey) { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var problem by rememberSaveable(storageKey) { mutableStateOf<String?>(null) }
    val confirmed = choice
    if (result != null) Text(result.orEmpty(), color = Jarvis.colors.fgMuted, style = MaterialTheme.typography.bodySmall)
    else if (relevant || confirmed != null) Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        DiscussionChoice.entries.forEach { action ->
            OutlinedButton(onClick = { choice = action }, enabled = confirmed == null && connection.status == ConnectionStatus.Ready) { Text(action.label) }
        }
    }
    if (confirmed != null && result == null) {
        val canDismiss = !busy && !reopened && dropped == null && !submittingNote
        fun dismiss() { if (canDismiss) { choice = null; problem = null } }
        AlertDialog(onDismissRequest = ::dismiss, title = { Text(confirmed.label) }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(confirmed.question)
                problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        }, dismissButton = { if (canDismiss) TextButton(onClick = ::dismiss) { Text("Cancel") } }, confirmButton = {
            TextButton(enabled = !busy && connection.status == ConnectionStatus.Ready, onClick = {
                if (busy) return@TextButton
                busy = true
                problem = null
                scope.launch {
                    try {
                        if (!submittingNote) {
                            val latest = client.request(BoardGetRequest(projectId = project, includeArchived = true)).board
                            val home = latest.tasks.find { it.id == homeId } ?: error("The old task is no longer available.")
                            check(reopened || settledDiscussionTask(home.status, home.settledAt, sentAt)) { "The old task has changed. No more changes were made." }
                            val followUp = newestDiscussionFollowUp(latest.tasks, homeId, sentAt)
                            suspend fun move(row: BoardTask, status: String) {
                                client.request(BoardTaskSaveRequest(projectId = project, taskId = row.id, expectedRevision = row.revision,
                                    task = row.editorDraft().copy(status = status).toInput(baseRefs = row.refs)))
                            }
                            if (confirmed == DiscussionChoice.Reopen && !reopened) { move(home, "in_progress"); reopened = true }
                            if (dropped == null && followUp != null && followUp.status != "dropped") { move(followUp, "dropped"); dropped = followUp.id }
                            submittingNote = true
                        }
                        val title = reference.title.replace('"', '′')
                        val text = if (confirmed == DiscussionChoice.Reopen) "I reopened $homeId for my discussion of \"$title\". Continue on that task instead of starting a follow-up."
                            else "Only answer here about \"$title\". Do not reopen $homeId or start a follow-up."
                        client.request(ConversationSubmitRequest(projectId = project, content = JsonPrimitive(text), whenBusy = "steer", keepDraft = true,
                            requestId = "discuss-overrule-$messageKey", taskId = homeId.takeIf { confirmed == DiscussionChoice.Reopen }))
                        val outcome = (if (confirmed == DiscussionChoice.Reopen) "Reopened $homeId." else "Asked for an answer here.") +
                            (dropped?.let { " Dropped follow-up $it." } ?: "")
                        prefs.edit().putString(storageKey, outcome).apply()
                        result = outcome
                        choice = null
                    } catch (e: CancellationException) { throw e }
                    catch (e: Exception) {
                        problem = listOfNotNull("Reopened $homeId.".takeIf { reopened }, dropped?.let { "Dropped follow-up $it." }, e.message ?: "Could not apply the change.").joinToString(" ")
                    } finally { busy = false }
                }
            }) { Text(if (busy) "Applying…" else if (problem != null) "Retry" else "Confirm") }
        })
    }
}
