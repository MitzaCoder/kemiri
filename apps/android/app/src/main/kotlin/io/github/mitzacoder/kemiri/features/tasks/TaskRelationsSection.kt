package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.components.TaskStatusBadge
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.theme.TaskStatusTone

@Composable
internal fun TaskRelations(task: BoardTask, tasks: List<BoardTask>, archived: List<BoardTaskBrief>, blockersInNeedsYou: Set<String>, statusDetails: Boolean, onOpen: (String) -> Unit, onShowLinked: () -> Unit) {
    val groups = linkGroups(task, tasks, archived)
    if (groups.isEmpty()) return
    groups.forEach { group ->
        val shown = if (group.kind == "blockedBy") group.items.filterNot { it.id in blockersInNeedsYou } else group.items
        if (shown.isNotEmpty()) Column {
            TaskHeading(group.label)
            if (group.kind == "subtasks") subtaskProgressText(task)?.let { text ->
                Text(text, Modifier.padding(vertical = 4.dp), style = TaskType.xs, color = Jarvis.colors.fgMuted)
                LinearProgressIndicator(progress = { subtaskFraction(task) ?: 0f }, modifier = Modifier.fillMaxWidth(), color = Jarvis.colors.accent2, trackColor = Jarvis.colors.surface2)
            }
            shown.forEach { target ->
                val relatedTask = tasks.firstOrNull { statusDetails && !target.archived && it.id == target.id && it.state != null }
                val label = if (target.archived) "Archived" else relatedTask?.let { taskStateLabel(it) } ?: target.status?.let(::taskStatusWords)
                TaskFactLink(target.id, target.title, onOpen, label, relatedTask?.let(::taskStateTone))
            }
        }
    }
    TextButton(onClick = onShowLinked, modifier = Modifier.heightIn(min = 48.dp)) { Text("Show with linked") }
}

@Composable
internal fun TaskFactLink(id: String, title: String, onOpen: (String) -> Unit, status: String? = null, tone: TaskStatusTone? = null) {
    val colors = Jarvis.colors
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = "Open $id") { onOpen(id) }.heightIn(min = 48.dp).padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Column(Modifier.weight(1f)) {
            TaskDetailText(title.ifBlank { "Not on the board" }, style = TaskType.sectionTitle, color = colors.fg)
            if (status != null) {
                if (tone != null) TaskStatusBadge(status, tone)
                else Text(status, style = TaskType.meta, color = colors.fgMuted)
            }
        }
        Text(id, Modifier.background(colors.surface2, RoundedCornerShape(5.dp)).padding(horizontal = 6.dp, vertical = 3.dp), style = TaskType.metaMono, color = colors.fgMuted)
    }
}
