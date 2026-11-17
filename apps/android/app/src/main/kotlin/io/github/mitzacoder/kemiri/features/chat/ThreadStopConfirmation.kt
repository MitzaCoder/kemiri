package io.github.mitzacoder.kemiri.features.chat

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.panels.panelError
import io.github.mitzacoder.kemiri.data.request
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.ThreadSummary
import io.github.mitzacoder.kemiri.protocol.ThreadsStopRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** The panel and job band share the confirmation, pending guard and stop request. */
@Composable
internal fun ThreadStopConfirmation(context: ProjectScreenContext, thread: ThreadSummary, onDismiss: () -> Unit, onStopped: () -> Unit, onPending: (Boolean) -> Unit = {}) {
    var pending by remember(thread.id) { mutableStateOf(false) }
    var problem by remember(thread.id) { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    AlertDialog(onDismissRequest = { if (!pending) onDismiss() }, title = { Text("Stop ${thread.title.ifEmpty { "this background job" }}?") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Its running turn and its workers are aborted, and it does no more work. Main chat keeps what it reported so far.")
            problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }, confirmButton = {
        TextButton(enabled = !pending, modifier = Modifier.heightIn(min = 48.dp), colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error), onClick = {
            if (!pending) {
                pending = true; onPending(true); problem = null
                scope.launch {
                    try { context.backend.client.request(ThreadsStopRequest(projectId = context.route.projectId, threadId = thread.id)); onStopped() }
                    catch (error: CancellationException) { throw error }
                    catch (error: Exception) { problem = panelError(error) }
                    finally { pending = false; onPending(false) }
                }
            }
        }) { Text(if (pending) "Stopping…" else "Stop") }
    }, dismissButton = { TextButton(enabled = !pending, onClick = onDismiss, modifier = Modifier.heightIn(min = 48.dp)) { Text("Keep it running") } })
}
