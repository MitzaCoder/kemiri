package io.github.mitzacoder.kemiri.features.chat

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.tasks.*
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.BoardQuestion
import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.components.TaskStatusDot
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

internal data class ReplyTaskKey(val conversationId: Long, val entryId: Long, val taskId: String) {
    constructor(reply: CommittedReply, taskId: String) : this(reply.conversationId, reply.entryId, taskId)
}

internal sealed interface ReplyKeepStatus {
    data object Keeping : ReplyKeepStatus
    data class Kept(val feedbackId: String) : ReplyKeepStatus
    data class Failed(val message: String) : ReplyKeepStatus
}

@Composable
internal fun ReplyTaskCards(
    reply: CommittedReply,
    context: ProjectScreenContext,
    tasks: Map<String, BoardTask>,
    questions: List<BoardQuestion>,
    stepsSupported: Boolean,
    keepSupported: Boolean,
    keepStatuses: Map<ReplyTaskKey, ReplyKeepStatus>,
    onKeep: (BoardTask) -> Unit,
) {
    val ids = remember(reply) { replyTaskIds(reply) }
    val cards = openReplyTasks(ids, tasks)
    if (cards.isEmpty()) return
    var showMore by rememberSaveable { mutableStateOf(false) }
    val more = cards.size - REPLY_TASK_CARD_LIMIT
    Column(Modifier.padding(top = 10.dp).widthIn(max = 560.dp).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        cards.take(REPLY_TASK_CARD_LIMIT).forEach { task -> key(task.id) {
            ReplyTaskCard(task, context, tasks, questions, stepsSupported, keepSupported, keepStatuses[ReplyTaskKey(reply, task.id)]) { onKeep(task) }
        } }
        if (more > 0) {
            TextButton(onClick = { showMore = !showMore }, modifier = Modifier.heightIn(min = 48.dp).semantics {
                stateDescription = if (showMore) "Expanded" else "Collapsed"
            }) { Text(if (showMore) "Show fewer tasks" else "+$more more") }
            if (showMore) cards.drop(REPLY_TASK_CARD_LIMIT).forEach { task -> key(task.id) {
                ReplyTaskCard(task, context, tasks, questions, stepsSupported, keepSupported, keepStatuses[ReplyTaskKey(reply, task.id)]) { onKeep(task) }
            } }
        }
    }
}

@Composable
private fun ReplyTaskCard(
    task: BoardTask,
    context: ProjectScreenContext,
    tasks: Map<String, BoardTask>,
    questions: List<BoardQuestion>,
    stepsSupported: Boolean,
    keepSupported: Boolean,
    status: ReplyKeepStatus?,
    onKeep: () -> Unit,
) {
    val colors = Jarvis.colors
    val hasBlockers = task.blockedBy.any { id -> tasks[id]?.let { !isSettled(it.status) && !it.archived } == true }
    val needs = taskNeedsYou(task, questions, hasBlockers, stepsSupported)
    Surface(shape = RoundedCornerShape(12.dp), color = colors.surface, border = BorderStroke(1.dp, colors.border)) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(
                    Modifier.weight(1f).clickable(role = Role.Button, onClickLabel = "Open ${task.id}") { context.openTask(task.id) }
                        .heightIn(min = 48.dp).padding(horizontal = 4.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                            Text(task.title, color = colors.fg, style = TaskType.rowTitle)
                            TaskIdChip(task.id)
                        }
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            TaskStatusDot(taskStateTone(task))
                            Text(taskDetailState(task.status, needs, task.state?.kind), color = colors.fgMuted, style = TaskType.xs)
                        }
                    }
                    LucideGlyph(Lucide.ChevronRight, size = 14.dp, tint = colors.fgMuted)
                }
                if (status is ReplyKeepStatus.Kept) {
                    TextButton(onClick = { context.openTaskNote(task.id, status.feedbackId) }, modifier = Modifier.heightIn(min = 48.dp)
                        .semantics { liveRegion = LiveRegionMode.Polite }) {
                        LucideGlyph(Lucide.Check, size = 14.dp)
                        Spacer(Modifier.width(4.dp))
                        Text("Kept on task", style = TaskType.xsMedium)
                    }
                } else if (canKeepOnTask(keepSupported, task)) {
                    TextButton(onClick = onKeep, enabled = status != ReplyKeepStatus.Keeping, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text(if (status == ReplyKeepStatus.Keeping) "Keeping…" else "Keep on task", style = TaskType.xs.copy(fontWeight = FontWeight.SemiBold))
                    }
                }
            }
            if (status is ReplyKeepStatus.Failed) Text(status.message, Modifier.padding(4.dp).semantics { liveRegion = LiveRegionMode.Polite },
                color = colors.danger, style = TaskType.xs)
        }
    }
}
