package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.runtime.Composable
import io.github.mitzacoder.kemiri.data.DEFAULT_TASK_VIEW_DESIGN_ID
import io.github.mitzacoder.kemiri.features.tasks.route.RouteTaskView

internal data class TaskViewDesign(
    val id: String,
    val label: String,
    val description: String,
    val fillsWindow: Boolean = false,
    val content: @Composable (TaskSheetState) -> Unit,
)

internal object TaskViewDesigns {
    val entries = listOf(
        TaskViewDesign(DEFAULT_TASK_VIEW_DESIGN_ID, "Classic", "Read the task in one scrollable column.") { ClassicTaskView(it) },
        TaskViewDesign("route", "Route", "Follow the work from Asked to Done.", fillsWindow = true) { RouteTaskView(it) },
    )
    private val byId = entries.associateBy { it.id }
    private val default = byId.getValue(DEFAULT_TASK_VIEW_DESIGN_ID)

    fun resolve(storedId: String?): TaskViewDesign = byId[storedId] ?: default
}
