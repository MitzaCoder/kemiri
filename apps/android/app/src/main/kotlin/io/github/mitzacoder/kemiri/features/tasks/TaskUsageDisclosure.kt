package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.ConnectionStatus
import io.github.mitzacoder.kemiri.data.HarnessFeature
import io.github.mitzacoder.kemiri.data.request
import io.github.mitzacoder.kemiri.features.usage.UsageAmountRow
import io.github.mitzacoder.kemiri.features.usage.ValueNote
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.UsageTaskRequest
import io.github.mitzacoder.kemiri.protocol.UsageTaskResponse
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.CancellationException

/** Lives with the sheet, not its lazy report item, so fetching starts even when the report is offscreen. */
@Composable
internal fun rememberTaskUsage(context: ProjectScreenContext, taskId: String): UsageTaskResponse? {
    val client = context.backend.client
    val projectId = context.route.projectId
    val connection by client.state.collectAsStateWithLifecycle()
    if (!connection.supports(HarnessFeature.TASK_USAGE)) return null
    var usage by remember(client, projectId, taskId) { mutableStateOf<UsageTaskResponse?>(null) }
    LaunchedEffect(client, projectId, taskId, connection.status, connection.generation) {
        if (connection.status == ConnectionStatus.Ready) {
            try { usage = client.request(UsageTaskRequest(projectId = projectId, taskId = taskId)) }
            catch (cause: CancellationException) { throw cause }
            catch (_: Exception) { /* The report is optional, just as on web. */ }
        }
    }
    return usage
}

@Composable
internal fun TaskUsageDisclosure(usage: UsageTaskResponse?, taskId: String) {
    if (usage == null) return
    val presentation = remember(usage, taskId) { taskUsagePresentation(usage, taskId) } ?: return
    var expanded by rememberSaveable(taskId) { mutableStateOf(false) }
    TaskFold(expanded, onToggle = { expanded = !expanded }, heading = {
        Text(presentation.headline, style = TaskType.xs, color = Jarvis.colors.fgMuted)
    }) {
        Column(Modifier.padding(start = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            UsageAmountRow("This task", usage.own.apiValue)
            UsageAmountRow("Subtasks", (usage.total.apiValue - usage.own.apiValue).coerceAtLeast(0.0))
            presentation.parts.forEach { (part, depth) ->
                UsageAmountRow("${part.taskId} · ${part.title}", part.total.apiValue, Modifier.padding(start = (12 * (depth + 1).coerceAtMost(6)).dp))
            }
            if (usage.subscriptions.isNotEmpty()) {
                TaskHeading("By subscription")
                usage.subscriptions.forEach { subscription ->
                    val note = listOfNotNull(bindingShareText(subscription), "paid for by subscription").joinToString(" · ")
                    UsageAmountRow(subscription.label, subscription.apiValue, note = note)
                }
            }
            if (usage.payAsYouGo.isNotEmpty()) UsageAmountRow("Paid at API prices", usage.payAsYouGo.sumOf { it.cost })
            if (usage.conversations.isNotEmpty()) {
                TaskHeading("By worker or thread")
                usage.conversations.forEach { conversation ->
                    UsageAmountRow(conversation.name, conversation.apiValue, note = "${conversation.kind} · ${conversation.model}")
                }
            }
            presentation.notes.forEach { ValueNote(it) }
        }
    }
}
