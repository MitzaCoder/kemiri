package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.mitzacoder.kemiri.features.refs.refLinkedText
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.components.TaskStatusBadge
import io.github.mitzacoder.kemiri.ui.theme.TaskStatusTone
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.theme.JetBrainsMono
import io.github.mitzacoder.kemiri.ui.theme.Text as TextStyles

@Composable
internal fun TaskSheetBar(sheet: TaskSheetState, titleInBar: Boolean, onMoveToCoordinator: (() -> Unit)?) {
    val colors = Jarvis.colors
    val status = sheet.status
    var showActions by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().height(48.dp).padding(start = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(sheet.task.id, style = TaskType.xs.copy(fontFamily = JetBrainsMono), color = colors.fgSubtle)
        Spacer(Modifier.width(8.dp))
        val partPage = sheet.partPage
        val tone = if (!status.detailsSupported && sheet.task.state?.liveWorkSince != null) TaskStatusTone.Working else taskStateTone(sheet.task)
        if (status.detailsSupported) {
            BoxWithConstraints(Modifier.weight(1f)) {
                val running = sheet.task.state.additionalRunningWork() != null
                val chipWidth = (maxWidth - (if (running) 70.dp else 0.dp) - (if (partPage != null) 76.dp else 0.dp))
                    .coerceIn(56.dp, 190.dp)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (partPage == null) TaskStatusMenu(status.title, tone, status.waitingEnabled,
                        !status.saving && !sheet.editing, status.onChoose, maxWidth = chipWidth)
                    else {
                        Text(partPage.position, style = TaskType.xs, color = colors.fgMuted)
                        if (partPage.closure == null) TaskStatusBadge(status.title, tone, Modifier.widthIn(max = chipWidth))
                    }
                    if (running) TaskStatusBadge("Working", TaskStatusTone.Working)
                    if (titleInBar || sheet.editing) TaskBarTitle(sheet.task.title, Modifier.weight(1f))
                }
            }
        } else {
            if (partPage == null) TaskStatusMenu(status.title, tone, status.waitingEnabled, !status.saving && !sheet.editing, status.onChoose)
            else Text(partPage.position, style = TaskType.xs, color = colors.fgMuted)
            Box(Modifier.weight(1f).padding(start = 8.dp)) {
                if (titleInBar || sheet.editing) TaskBarTitle(sheet.task.title)
            }
        }
        Box {
            IconButton(onClick = { showActions = true }, enabled = !sheet.editing || TaskViewDesigns.entries.size > 1) {
                LucideGlyph(Lucide.MoreHorizontal, size = 18.dp, contentDescription = "Task actions")
            }
            DropdownMenu(expanded = showActions, onDismissRequest = { showActions = false }, containerColor = colors.surface) {
                if (!sheet.editing) {
                    DropdownMenuItem(text = { Text("Edit") }, onClick = { showActions = false; sheet.onEditChange(true) })
                    if (onMoveToCoordinator != null) DropdownMenuItem(text = { Text("Move to coordinator") }, onClick = {
                        showActions = false
                        onMoveToCoordinator()
                    })
                }
                TaskViewChoices(sheet.designId) { showActions = false; sheet.onSelectDesign(it) }
            }
        }
        IconButton(onClick = sheet.onDismiss) {
            LucideGlyph(Lucide.X, size = 18.dp, contentDescription = sheet.previousTaskId?.let { "Back to $it" } ?: "Close the task")
        }
    }
}

@Composable
private fun TaskBarTitle(title: String, modifier: Modifier = Modifier) {
    Text(title, modifier, color = Jarvis.colors.fg,
        style = TextStyles.sm.copy(fontWeight = FontWeight.SemiBold, lineHeight = 20.sp),
        maxLines = 1, overflow = TextOverflow.Ellipsis)
}

@Composable
internal fun TaskSheetTitle(title: String, modifier: Modifier = Modifier) {
    TaskDetailText(refLinkedText(title), modifier.semantics { heading() },
        style = TextStyles.lg.copy(fontWeight = FontWeight.SemiBold, lineHeight = 24.sp), color = Jarvis.colors.fg)
}
