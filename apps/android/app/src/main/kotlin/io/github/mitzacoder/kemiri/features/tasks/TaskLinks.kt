package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.runtime.*
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.components.TaskStatusBadge
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.HarnessFeature
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.BoardTask

/**
 * What the chat's components need to name a task: whether it is on the board, its title and status (so a chip wears its
 * row's colour), and how to open its sheet. The Android twin of the web's `lib/task-links.svelte.ts`.
 */
@Stable
class TaskLinks(private val tasks: Map<String, BoardTask>, private val previewer: ((String) -> Unit)? = null, private val opener: (String) -> Unit) {
    fun knows(taskId: String): Boolean = taskId in tasks
    /** Null for a task the board does not hold (or has not loaded). */
    fun title(taskId: String): String? = tasks[taskId]?.title
    fun status(taskId: String): String? = tasks[taskId]?.status
    fun task(taskId: String): BoardTask? = tasks[taskId]
    fun open(taskId: String) = opener(taskId)
    fun preview(taskId: String) = (previewer ?: opener)(taskId)
}

/**
 * Null outside a project chat, in a worker's transcript, on a backend without `task-reports` and before the board has
 * loaded; then the chat shows no task links and every line still reads on its own.
 */
val LocalTaskLinks = compositionLocalOf<TaskLinks?> { null }

/** Offers [TaskLinks] from the project's shared board to everything in [content]. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProvideTaskLinks(context: ProjectScreenContext?, content: @Composable () -> Unit) {
    if (context == null || context.route.workerId != null) {
        CompositionLocalProvider(LocalTaskLinks provides null, content = content)
        return
    }
    var previewTaskId by remember(context.route.backendKey, context.route.projectId) { mutableStateOf<String?>(null) }
    val latest by rememberUpdatedState(context)
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    val view by context.board.view.collectAsStateWithLifecycle()
    val supported = connection.supports(HarnessFeature.TASK_REPORTS)
    val links = remember(supported, view.loaded, view.tasks) {
        if (supported && view.loaded) TaskLinks(view.tasks.associateBy { it.id }, previewer = { previewTaskId = it }) { latest.openTask(it) } else null
    }
    CompositionLocalProvider(LocalTaskLinks provides links, LocalPreviewTaskId provides previewTaskId, content = content)
    previewTaskId?.let { id ->
        val task = links?.task(id)
        ModalBottomSheet(onDismissRequest = { previewTaskId = null }, containerColor = Jarvis.colors.bg) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 32.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(id, style = MaterialTheme.typography.labelLarge, color = Jarvis.colors.accent2)
                if (task == null) Text("Task not found.")
                else {
                    Text(task.title, style = MaterialTheme.typography.titleMedium, color = Jarvis.colors.fg)
                    TaskStatusBadge(task.status)
                    TextButton(onClick = { previewTaskId = null; links?.open(id) }) { Text("Open task") }
                }
                TextButton(onClick = { previewTaskId = null }) { Text("Close preview") }
            }
        }
    }
}
