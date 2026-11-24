package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import io.github.mitzacoder.kemiri.protocol.BoardTaskBrief
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.refs.RefChips
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.components.LucideIcon
import io.github.mitzacoder.kemiri.ui.components.TaskStatusDot
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.theme.Text as TextStyles

/**
 * One task in the Tasks list (web `TasksPanel.svelte` `taskRow`): its status dot (a ⚠ or ? under Needs you), the title
 * on up to two lines, the report line that matters for where it stands, its refs, and on the right the ID alone.
 * Only rows that need the user get a wash: the warning's colour for a warning, the accent for a question. The whole row
 * opens the task's sheet; the ref chips open their own cards.
 */
@Composable
internal fun TaskListRow(
    family: TaskFamily, now: Long, reducedMotion: Boolean, linksEnabled: Boolean,
    nested: Boolean, archived: List<BoardTaskBrief>, onToggle: () -> Unit,
    modifier: Modifier = Modifier, attention: RequestAttention? = null, requestView: Boolean = false, onOpen: () -> Unit,
) {
    val taskLinks = LocalTaskLinks.current
    val row = family.row
    val colors = Jarvis.colors
    val task = row.task
    val searchHit = LocalTaskSearchHits.current[task.id]
    val stateLabel = taskRowStateLabel(task) { taskLinks?.title(it) }
    val needsYou = row.section == TaskSectionId.NeedsYou
    val warned = row.waiting.any(::isWarning)
    val activity = taskRowActivity(task, LocalTaskActivityEnabled.current) { taskLinks?.title(it) }
    val gist = rowGist(row, LocalTaskActivityEnabled.current)
    val partsSummary = taskPartProgress(task)?.text
    val wash = when {
        needsYou && warned -> colors.warning.copy(alpha = .09f)
        needsYou -> colors.accent2.copy(alpha = .08f)
        else -> null
    }
    Row(
        modifier.fillMaxWidth().alpha(if (searchHit?.context == true) .5f else 1f)
            .then(if (wash != null) Modifier.background(wash) else Modifier)
            .taskReferenceHighlight(task.id, reducedMotion)
            .clickable(role = Role.Button, onClickLabel = "Open ${attention?.taskId ?: task.id}", onClick = onOpen)
            .semantics(mergeDescendants = true) {
                contentDescription = listOfNotNull(
                    "${task.id}: ${task.title}", attention?.text ?: activity?.let { activityDescription(it, now) } ?: taskStateLabel(task),
                    task.parent?.takeIf { nested }?.let { "${if (requestView) "Part" else "Subtask"} of $it" },
                    if (partsSummary != null) partsSummary.takeUnless { it == activity?.text } else task.subtaskCount?.takeIf { it.total > 0 }?.let { "${it.done} of ${it.total} subtasks done" },
                ).joinToString(". ")
            }
            .padding(start = 12.dp, end = 10.dp, top = 10.dp, bottom = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Box(Modifier.size(width = 14.dp, height = 20.dp), contentAlignment = Alignment.Center) {
            when {
                task.state != null && task.state.kind != "working" -> {
                    LucideGlyph(taskStateGlyph(task.state.kind), size = 14.dp, tint = colors.taskStatus(taskStateTone(task)))
                }
                task.state != null -> TaskStatusDot(taskStateTone(task), pulse = !reducedMotion)
                needsYou && warned -> LucideGlyph(TaskIcons.TriangleAlert, size = 14.dp, tint = colors.warning)
                needsYou -> LucideGlyph(TaskIcons.CircleHelp, size = 14.dp, tint = colors.accent2)
                else -> TaskStatusDot(taskStateTone(task), pulse = task.status == "in_progress" && !reducedMotion)
            }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(buildAnnotatedString {
                append(task.title)
                searchHit?.ranges?.forEach { range -> addStyle(SpanStyle(background = colors.accent2.copy(alpha = .22f)), range.start, range.end) }
            }, style = TaskType.rowTitle, color = if (row.section == TaskSectionId.Closed) colors.fgMuted else colors.fg, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (requestView && searchHit != null && task.parent != null) {
                val requestId = task.requestId ?: task.parent
                Text("Part of ${taskLinks?.title(requestId) ?: requestId}", style = TaskType.meta, color = colors.fgMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (!searchHit?.snippet.isNullOrEmpty()) Text(searchHit!!.snippet, style = TaskType.xs, color = colors.fgMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val summary = if (!searchHit?.snippet.isNullOrEmpty()) "" else if (task.status == "waiting") waitingSummary(task, now) else gist
            if (attention != null) {
                Text(attention.text, style = TextStyles.taskSm, color = colors.fgMuted)
            } else if (activity != null && (task.state != null || searchHit?.snippet.isNullOrEmpty())) {
                if (!(linksEnabled || requestView) || !taskUsesPartsSentence(task)) TaskActivityView(activity, maxLines = 2, inlineAge = true, stateTone = task.state?.let { taskStateTone(task) })
                if (linksEnabled || requestView) TaskFamilyMeta(family, nested, archived, "", onToggle, requestView = requestView)
            }
            else if (linksEnabled || requestView) TaskFamilyMeta(family, nested, archived, summary, onToggle, requestView = requestView)
            else if (summary.isNotEmpty()) Text(
                summary, style = if (task.status == "waiting") TaskType.xs else TextStyles.taskSm, color = colors.fgMuted,
                maxLines = if (task.status == "waiting") Int.MAX_VALUE else 1, overflow = TextOverflow.Ellipsis,
            )
            if ((stateLabel != null && (task.state != null || needsYou)) || row.waiting.size > 1 || task.refs.isNotEmpty()) {
                FlowRow(
                    Modifier.padding(top = 2.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                    itemVerticalAlignment = Alignment.CenterVertically,
                ) {
                    if (stateLabel != null && (needsYou || task.state != null)) {
                        val tone = colors.taskStatus(taskStateTone(task))
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(stateLabel, style = TaskType.meta.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Medium), color = tone)
                        }
                    }
                    if (row.waiting.size > 1) Text("+${row.waiting.size - 1} more", style = TaskType.meta, color = colors.fgSubtle)
                    RefChips(task.refs, max = 2)
                }
            }
        }
        Column(Modifier.padding(top = 2.dp), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            TaskIdChip(task.id)
        }
    }
}

internal fun taskStateGlyph(kind: String?) = when (kind) {
    "failed" -> TaskIcons.TriangleAlert
    "answer_needed", "clarifying" -> TaskIcons.CircleHelp
    "steps_needed" -> TaskIcons.ListChecks
    "review" -> TaskIcons.Eye
    "paused" -> TaskIcons.Pause
    "blocked_by_task" -> TaskIcons.Lock
    "waiting_outside" -> Lucide.Clock
    "done" -> Lucide.Check
    "dropped" -> TaskIcons.Ban
    else -> TaskIcons.Circle
}

// Lucide git-branch (ISC); see LUCIDE-LICENSE.txt.
private val ParentBranch = LucideIcon("git-branch", "M6 3v12", "M15 6a3 3 0 1 0 6 0a3 3 0 1 0-6 0", "M6 15a3 3 0 1 0 0 6a3 3 0 0 0 0-6", "M18 9a9 9 0 0 1-9 9")

@Composable
internal fun TaskParentHeaderRow(row: TaskRow, onOpen: () -> Unit) {
    val colors = Jarvis.colors
    val task = row.task
    val group = row.section.labelFor(derived = true)
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp)
            .clickable(role = Role.Button, onClickLabel = "Open parent ${task.id}", onClick = onOpen)
            .semantics { contentDescription = "Parent ${task.id}: ${task.title}, $group" }
            .padding(start = 12.dp, end = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        LucideGlyph(ParentBranch, size = 14.dp, tint = colors.fgSubtle)
        Text(task.title, Modifier.weight(1f, fill = false).clearAndSetSemantics {}, style = TaskType.rowTitle, color = colors.fg,
            maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text("· $group", Modifier.clearAndSetSemantics {}, style = TaskType.meta, color = colors.fgMuted, maxLines = 1)
        Box(Modifier.clearAndSetSemantics {}) { TaskIdChip(task.id) }
    }
}

@Composable
internal fun TaskPointerRow(family: TaskFamily, onOpen: () -> Unit, onJump: () -> Unit, onToggle: () -> Unit) {
    val colors = Jarvis.colors
    val task = family.row.task
    val state = taskStateLabel(task)
    val tone = colors.taskStatus(taskStateTone(task))
    Row(
        Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = 4.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(
            Modifier.weight(1f).heightIn(min = 48.dp)
                .clickable(role = Role.Button, onClickLabel = "Open ${task.id}", onClick = onOpen)
                .semantics { contentDescription = "${task.id}: ${task.title}, $state" }
                .padding(horizontal = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            LucideGlyph(taskStateGlyph(task.state?.kind), size = 14.dp, tint = tone)
            Text(task.title, Modifier.weight(1f, fill = false).clearAndSetSemantics {}, style = TaskType.rowTitle,
                color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("· $state", Modifier.clearAndSetSemantics {}, style = TaskType.meta, color = colors.fgMuted, maxLines = 1)
        }
        Box(
            Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp)
                .clickable(role = Role.Button, onClickLabel = "Jump to ${task.id} in Needs you", onClick = onJump)
                .padding(horizontal = 6.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text("In Needs you ↑", style = TaskType.xs, color = colors.accent2, maxLines = 1)
        }
        if (family.canToggle) Box(
            Modifier.size(48.dp)
                .clickable(role = Role.Button, onClickLabel = "${if (family.expanded) "Collapse" else "Expand"} subtasks of ${task.id}", onClick = onToggle)
                .semantics {
                    contentDescription = "Subtasks of ${task.id}"
                    stateDescription = if (family.expanded) "Expanded" else "Collapsed"
                },
            contentAlignment = Alignment.Center,
        ) {
            LucideGlyph(Lucide.ChevronRight, Modifier.rotate(if (family.expanded) 90f else 0f), size = 12.dp, tint = colors.fgSubtle)
        }
    }
}

/** A row's shape while the board loads. */
@Composable
internal fun TaskRowSkeleton(titleWidth: Float, gistWidth: Float) {
    val shade = Jarvis.colors.surface2
    val round = androidx.compose.foundation.shape.RoundedCornerShape(4.dp)
    Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 10.dp, top = 10.dp, bottom = 10.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.size(width = 14.dp, height = 20.dp), contentAlignment = Alignment.Center) { Box(Modifier.size(8.dp).background(shade, androidx.compose.foundation.shape.CircleShape)) }
        Column(Modifier.weight(1f).padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.fillMaxWidth(titleWidth).height(14.dp).background(shade, round))
            Box(Modifier.fillMaxWidth(gistWidth).height(12.dp).background(shade, round))
        }
        Column(Modifier.padding(top = 4.dp), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(width = 36.dp, height = 10.dp).background(shade, round))
            Box(Modifier.size(width = 20.dp, height = 10.dp).background(shade, round))
        }
    }
}
