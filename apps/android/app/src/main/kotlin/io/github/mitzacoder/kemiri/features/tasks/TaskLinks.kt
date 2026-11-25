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
import io.github.mitzacoder.kemiri.data.ProjectBoard
import io.github.mitzacoder.kemiri.protocol.BoardTask

/**
 * What the chat's components need to name a task: whether it is on the board, its title and status (so a chip wears its
 * row's colour), and how to open its sheet. The Android twin of the web's `lib/task-links.svelte.ts`.
 */
private data class TaskLinkLabel(val title: String, val status: String)

@Stable
class TaskLinks internal constructor(
    private val board: ProjectBoard,
    private val previewer: (String) -> Unit,
    private val opener: (String) -> Unit,
) {
    private var labels by mutableStateOf<Map<String, TaskLinkLabel>>(emptyMap())
    internal var taskIds by mutableStateOf<Set<String>>(emptySet())
        private set

    internal suspend fun collectIndex() {
        board.select { view -> view.tasks.associate { it.id to TaskLinkLabel(it.title, it.status) } }.collect {
            labels = it
            taskIds = it.keys
        }
    }

    fun knows(taskId: String): Boolean = taskId in taskIds
    fun title(taskId: String): String? = labels[taskId]?.title
    fun status(taskId: String): String? = labels[taskId]?.status
    @Composable fun task(taskId: String): BoardTask? = remember(board, taskId) { board.taskFlow(taskId) }
        .collectAsStateWithLifecycle(remember(board, taskId) { board.view.value.task(taskId) }).value
    fun open(taskId: String) = opener(taskId)
    fun preview(taskId: String) = previewer(taskId)
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
    val board = context.board
    val supported = connection.supports(HarnessFeature.TASK_REPORTS)
    val loaded by remember(board) { board.select { it.loaded } }.collectAsStateWithLifecycle(remember(board) { board.view.value.loaded })
    val registry = remember(board) { TaskLinks(board, { previewTaskId = it }) { latest.openTask(it) } }
    LaunchedEffect(registry, supported) { if (supported) registry.collectIndex() }
    val links = registry.takeIf { supported && loaded }
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
