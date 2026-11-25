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
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.refs.LocalRefLinks
import io.github.mitzacoder.kemiri.features.refs.summarizeTaskRefs
import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.protocol.BoardTaskActivity
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.components.LucideIcon
import io.github.mitzacoder.kemiri.ui.components.TaskStatusDot
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.theme.JetBrainsMono
import io.github.mitzacoder.kemiri.ui.theme.TaskStatusTone
import io.github.mitzacoder.kemiri.ui.theme.Text as TextStyles

/**
 * One task in the Tasks list (web `TasksPanel.svelte` `taskRow`): its status dot (a ⚠ or ? under Needs you), the title
 * on up to three lines, and a status line with the ID and refs. Only rows that need the owner get a wash.
 * The row opens the task sheet, where the refs can be opened.
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
    val stateLabel = taskStateLabel(task) { taskLinks?.title(it) }
    val needsYou = row.section == TaskSectionId.NeedsYou
    val warned = row.waiting.any(::isWarning)
    val runningWork = task.state.additionalRunningWork()
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
                    task.title,
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
            }, Modifier.clearAndSetSemantics {}, style = TaskType.rowTitle, color = if (row.section == TaskSectionId.Closed) colors.fgMuted else colors.fg, maxLines = 3, overflow = TextOverflow.Ellipsis)
            if (requestView && searchHit != null && task.parent != null) {
                val requestId = task.requestId ?: task.parent
                Text("Part of ${taskLinks?.title(requestId) ?: requestId}", style = TaskType.meta, color = colors.fgMuted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (!searchHit?.snippet.isNullOrEmpty()) Text(searchHit!!.snippet, style = TaskType.xs, color = colors.fgMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val summary = if (!searchHit?.snippet.isNullOrEmpty()) "" else if (task.status == "waiting") waitingSummary(task, now) else gist
            val showActivity = activity != null && (task.state != null || searchHit?.snippet.isNullOrEmpty())
            TaskRowStatus(
                task, stateLabel,
                activity = activity.takeIf { showActivity && (!(linksEnabled || requestView) || !taskUsesPartsSentence(task)) },
                attention = attention,
                extraWaiting = (row.waiting.size - 1).coerceAtLeast(0),
            )
            if (attention == null) {
                if (linksEnabled || requestView) {
                    TaskFamilyMeta(family, nested, archived, if (showActivity) "" else summary, onToggle, requestView = requestView)
                } else if (!showActivity && summary.isNotEmpty()) {
                    Text(summary, style = if (task.status == "waiting") TaskType.xs else TextStyles.taskSm, color = colors.fgMuted,
                        maxLines = if (task.status == "waiting") Int.MAX_VALUE else 1, overflow = TextOverflow.Ellipsis)
                }
            }
            runningWork?.let { TaskActivityView(it, maxLines = 2, inlineAge = true, stateTone = TaskStatusTone.Working) }
        }
    }
}

/** Quiet metadata. Wrap between items so a long state sentence doesn't hide the task ID or refs. */
@Composable
internal fun TaskRowStatus(
    task: BoardTask,
    stateLabel: String,
    activity: BoardTaskActivity? = null,
    attention: RequestAttention? = null,
    extraWaiting: Int = 0,
    maxRefs: Int = 2,
    elapsed: String? = null,
    elapsedDescription: String? = null,
) {
    val colors = Jarvis.colors
    val links = LocalRefLinks.current
    val refs = summarizeTaskRefs(task.refs, maxRefs, links?.links) { links?.status(it) }
    val stateActivity = activity.takeIf { attention == null }
    val status = attention?.text ?: stateActivity?.text ?: stateLabel
    val now = if (stateActivity != null) rememberTaskMinuteNow() else 0L
    val age = stateActivity?.let { activityAge(it, now) }.orEmpty()
    val agePrefix = stateActivity?.agePrefix?.takeUnless { it == " · " }
    val waiting = extraWaiting.takeIf { it > 0 }?.let { "$it more waiting" }
    val moreRefs = refs.hiddenCount.takeIf { it > 0 }?.let { "$it more ${if (it == 1) "reference" else "references"}" }
    val description = listOfNotNull(
        stateActivity?.let { activityDescription(it, now) } ?: status,
        task.id,
        waiting,
        *refs.visible.map { it.description }.toTypedArray(),
        moreRefs,
        elapsedDescription,
    ).joinToString(". ")
    FlowRow(
        Modifier.clearAndSetSemantics { contentDescription = description },
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalArrangement = Arrangement.spacedBy(2.dp),
        itemVerticalAlignment = Alignment.CenterVertically,
    ) {
        Text(buildAnnotatedString {
            append(status)
            if (agePrefix != null && age.isNotEmpty()) {
                withStyle(SpanStyle(color = colors.fgSubtle)) { append(agePrefix + age) }
            }
        }, style = TaskType.meta, color = colors.fgMuted,
            maxLines = if (attention != null) Int.MAX_VALUE else 2, overflow = TextOverflow.Ellipsis)
        TaskStatusItem(task.id, mono = true)
        refs.visible.forEach { TaskStatusItem(it.label, mono = true, tone = it.tone) }
        if (moreRefs != null) TaskStatusItem("+${refs.hiddenCount}", mono = true)
        if (waiting != null) TaskStatusItem(waiting)
        if (agePrefix == null && age.isNotEmpty()) TaskStatusItem(age)
        if (elapsed != null) TaskStatusItem(elapsed)
    }
}

@Composable
private fun TaskStatusItem(label: String, mono: Boolean = false, tone: TaskStatusTone? = null) {
    val colors = Jarvis.colors
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("·", style = TaskType.meta, color = colors.fgMuted)
        tone?.let { TaskStatusDot(it, Modifier.size(6.dp)) }
        Text(label, Modifier.weight(1f, fill = false), style = TaskType.meta,
            fontFamily = if (mono) JetBrainsMono else null, color = colors.fgMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
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
            .semantics { contentDescription = "Parent: ${task.title}" }
            .padding(start = 12.dp, end = 10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
    ) {
        LucideGlyph(ParentBranch, size = 14.dp, tint = colors.fgSubtle)
        Column(Modifier.weight(1f).padding(vertical = 4.dp)) {
            Text(task.title, Modifier.clearAndSetSemantics {}, style = TaskType.rowTitle, color = colors.fg,
                maxLines = 3, overflow = TextOverflow.Ellipsis)
            TaskRowStatus(task, group)
        }
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
                .padding(horizontal = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            LucideGlyph(taskStateGlyph(task.state?.kind), size = 14.dp, tint = tone)
            Column(Modifier.weight(1f).padding(vertical = 4.dp)) {
                Text(task.title, style = TaskType.rowTitle, color = colors.fg, maxLines = 3, overflow = TextOverflow.Ellipsis)
                TaskRowStatus(task, state)
            }
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
    }
}
