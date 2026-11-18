package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.layout.*
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.tasks.media.TaskFiles
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.navigation.PanelTab
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

@Composable
internal fun TaskAbout(
    context: ProjectScreenContext, task: BoardTask, tasks: List<BoardTask>, archived: List<BoardTaskBrief>, owner: TaskOwner,
    legacyDelivery: BoardTaskActivity?, delivery: BoardTaskTimelineResponseDelivery?, blockersInNeedsYou: Set<String>, artifacts: List<Artifact>,
    onUpdateTags: (suspend (Artifact, List<String>) -> Artifact?)?, now: Long,
) {
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        HorizontalDivider(color = Jarvis.colors.border)
        TaskHeading("About this task")
        if (delivery != null) TaskDelivery(delivery)
        else if (legacyDelivery?.kind == "delivery" || (legacyDelivery?.kind == "deploy" && task.status != "in_progress")) {
            TaskReadingSection("Delivery") { TaskActivityView(legacyDelivery, inlineAge = true) }
        }
        if (owner.threadId != null) Column {
            TaskHeading("Owner thread")
            TextButton(onClick = { context.navigate(context.route.copy(threadId = owner.threadId.takeUnless(::isMainThread), workerId = null)) },
                modifier = Modifier.heightIn(min = 48.dp)) { Text(owner.label) }
        } else TaskFact("Owner thread", owner.label)
        if (task.status == "waiting" && task.waiting != null) TaskFact("Waiting details", waitingSummary(task, now))
        if (task.archived) TaskFact("Status", "Archived")
        TaskRelations(task, tasks, archived, blockersInNeedsYou, context::openTask) {
            context.board.showWithLinked(task.id)
            context.navigate(Destination.Panel(context.route, PanelTab.Board))
        }
        if (artifacts.isNotEmpty()) {
            var filesOpen by rememberSaveable { mutableStateOf(false) }
            TaskFold("Files", filesOpen, { filesOpen = !filesOpen }) { TaskFiles(context, artifacts, onUpdateTags) }
        }
        TaskFact("Created", relativeTime(task.createdAt, now))
        TaskFact("Updated", relativeTime(task.updatedAt, now))
        task.settledAt?.let { TaskFact("Closed", relativeTime(it, now)) }
        task.inProgressMinutes?.takeIf { it > 0 }?.let { TaskFact("Time in progress", formatMinutes(it.toDouble())) }
    }
}

@Composable
private fun TaskFact(title: String, text: String) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        TaskHeading(title)
        TaskDetailText(text, style = TaskType.xs, color = Jarvis.colors.fg)
    }
}
