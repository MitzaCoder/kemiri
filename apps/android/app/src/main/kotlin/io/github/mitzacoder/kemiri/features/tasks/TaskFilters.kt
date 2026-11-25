package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.HarnessFeature
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.BoardTask

/** Shared list/board focus filter, per project's live board. */
@Composable
internal fun filteredTasks(context: ProjectScreenContext, tasks: List<BoardTask>): List<BoardTask> {
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    val focus by context.board.linkedTask.collectAsStateWithLifecycle()
    return if (connection.supports(HarnessFeature.TASK_LINKS)) applyTaskFilter(tasks, focus) else tasks
}

@Composable
internal fun LinkedTaskFilter(context: ProjectScreenContext) {
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    val focus by context.board.linkedTask.collectAsStateWithLifecycle()
    if (connection.supports(HarnessFeature.TASK_LINKS) && focus != null) {
        InputChip(selected = true, onClick = { context.board.showWithLinked(null) }, label = { Text("Linked to $focus · Clear", style = TaskType.xs) })
    }
}
