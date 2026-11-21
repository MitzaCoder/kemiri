package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.refs.refLinkedText
import io.github.mitzacoder.kemiri.features.tasks.media.TaskFiles
import io.github.mitzacoder.kemiri.features.tasks.media.TaskProof
import io.github.mitzacoder.kemiri.features.tasks.media.automaticReportProof
import io.github.mitzacoder.kemiri.ui.components.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.theme.JetBrainsMono
import io.github.mitzacoder.kemiri.ui.theme.Text as TextStyles

@Composable
internal fun ClassicTaskView(sheet: TaskSheetState) {
    val colors = Jarvis.colors
    val context = sheet.context
    val task = sheet.task
    val taskId = task.id
    val previousTaskId = sheet.previousTaskId
    val onDismiss = sheet.onDismiss
    val insets = Modifier.windowInsetsPadding(taskSheetInsets(sheet.wide))
    val bodyState = sheet.bodyState
    val fields = sheet.fields
    val failedChecks = failedCheckLine(fields.checks)
    val needsYou = sheet.needsYou
    val blockers = sheet.blockers
    val threads = sheet.threads
    val workers = sheet.workers
    val artifacts = sheet.artifacts
    val results = remember(task.report) { readReportSection(task.report, ReportSectionKind.Results) }
    val automaticProof = remember(results, artifacts) { automaticReportProof(results, artifacts) }
    val showNext = sheet.nextPlacement == ReportNextPlacement.Next
    val now = sheet.now
    val activity = sheet.activity
    val liveNow = sheet.liveNow
    val status = sheet.status
    val record = sheet.record
    val linksEnabled = record.linksEnabled
    val timelineGroupsEnabled = record.timelineGroupsEnabled
    val deliveryEnabled = record.deliveryEnabled
    val delivery = record.delivery
    val timeline = record.timeline
    val timelineProblem = record.problem

    // Budget from the space ABOVE the IME, not the full display. Non-weighted headers used to consume all
    // Column constraints before the reply was measured, leaving a focused but invisible input/send button.
    BoxWithConstraints(Modifier.fillMaxSize().then(insets).imePadding()) {
    val headerMaxHeight = minOf(360.dp, maxHeight * .35f, (maxHeight - 220.dp).coerceAtLeast(56.dp))
    val refsMaxHeight = minOf(240.dp, maxHeight * .25f)
    val replyInputMaxHeight = (maxHeight * .20f).coerceIn(40.dp, 160.dp)
    val shortViewport = maxHeight < 400.dp
    Column(Modifier.widthIn(max = 672.dp).fillMaxSize().align(Alignment.TopCenter)) {
        previousTaskId?.let { id ->
            val title = sheet.previousTaskTitle
            TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) {
                TaskDetailText("← $id" + (title?.let { " · $it" } ?: ""), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        // The header keeps state and actions visible while the reading column scrolls.
        Column(Modifier.fillMaxWidth().heightIn(max = headerMaxHeight).verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 4.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(task.id, style = TaskType.xs.copy(fontFamily = JetBrainsMono), color = colors.fgSubtle)
                Box(Modifier.weight(1f)) {
                    TaskStatusMenu(task, status.title, status.waitingEnabled, !status.saving, status.onChoose)
                }
                if (!sheet.editing) IconButton(onClick = { sheet.onEditChange(true) }) { LucideGlyph(TaskIcons.Pencil, size = 18.dp, contentDescription = "Edit ${task.id}") }
                TaskViewMenu(sheet.designId, sheet.onSelectDesign)
                IconButton(onClick = onDismiss) { LucideGlyph(Lucide.X, size = 18.dp, contentDescription = if (previousTaskId == null) "Close the task" else "Back to $previousTaskId") }
            }
            Column(Modifier.padding(end = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                TaskDetailText(refLinkedText(task.title), Modifier.semantics { heading() }, style = TextStyles.lg.copy(fontWeight = FontWeight.SemiBold), color = colors.fg)
                fields.goal?.let { Text(it, style = TextStyles.task, color = colors.fgMuted) }
                if (task.refs.isNotEmpty()) TaskRefs(task.refs, refsMaxHeight)
                if (status.waitingForm) TaskWaitingForm(task.waiting, status.saving, status.workDayStart, { note, until -> status.onSet("waiting", note, until) }, status.onCancelWaiting)
                else if (status.confirmDrop) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TaskDetailText("Drop ${task.id}? It will not be done.", style = TaskType.xs, color = colors.fgMuted)
                    Button(onClick = { status.onSet("dropped", null, null) }, enabled = !status.saving, colors = ButtonDefaults.buttonColors(containerColor = colors.danger, contentColor = colors.bg)) { Text("Drop it") }
                    TextButton(onClick = status.onCancelDrop) { Text("Keep") }
                }
                status.problem?.let { TaskDetailText(it, style = TaskType.xs, color = colors.danger) }
            }
        }
        HorizontalDivider(color = colors.border)

        LazyColumn(
            state = bodyState, modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(if (shortViewport) 8.dp else 16.dp), verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            if (sheet.editing) item(key = "editor") { TaskEditor(context, task, sheet.tasks, onBack = { sheet.onEditChange(false) }, scrolls = false) }
            else {
                if (needsYou.show) item(key = "needs-you") {
                    TaskNeedsYouSection(context, task, needsYou, sheet.nextPlacement, blockers, threads, status.saving,
                        onCloseTask = { status.onSet("done", null, null) }, onFocusReply = sheet.onFocusReply)
                }
                if (liveNow != null && task.live != null) item(key = "live") {
                    TaskLive(task.live, liveNow, context.backend.config.key, context.route.projectId, taskId, sheet.liveNews)
                }
                item(key = "results") {
                    TaskReadingSection("What you get") {
                        if (fields.showSummary) ReportSection(task, ReportSectionKind.Summary)
                        if (sheet.staleReport) StaleTaskReport(context, task.id)
                        if (results.hasContent) ReportSection(task, ReportSectionKind.Results, context, artifacts, sheet.sectionViewsSupported)
                        else if (!fields.showSummary && failedChecks == null) Text(if (emptyFinishedResults(task.status, task.report.results)) "No results yet · work finished" else "Nothing written yet.", style = TaskType.xs, color = colors.fgMuted)
                        failedChecks?.let { Text(it, style = TextStyles.task, color = colors.danger) }
                        TaskUsageDisclosure(sheet.usage, taskId)
                        TaskProof(context, automaticProof)
                    }
                }
                item(key = "apps") { io.github.mitzacoder.kemiri.features.apps.TaskApps(taskId) }
                if (artifacts.isNotEmpty()) item(key = "files") {
                    TaskReadingSection("Files") {
                        TaskFiles(context, artifacts, onUpdateTags = sheet.onUpdateArtifactTags)
                    }
                }
                if (fields.showNotDone) item(key = "not-done") {
                    TaskReadingSection("Not done") { ReportSection(task, ReportSectionKind.NotDone, context, artifacts, sheet.sectionViewsSupported) }
                }
                if (sheet.showNow || showNext) item(key = "next") {
                    TaskReadingSection("Next") {
                        if (sheet.showNow) {
                            TaskHeading("Now")
                            if (activity != null) TaskActivityView(activity, inlineAge = true) else ReportMarkdown(task.report.now)
                        }
                        if (showNext) ReportSection(task, ReportSectionKind.Next)
                    }
                }
                if (needsYou.questionsForAgent.isNotEmpty()) item(key = "agent-questions") {
                    TaskReadingSection("Waiting for an agent reply") {
                        needsYou.questionsForAgent.forEach { question -> key(question.id) {
                            QuestionCard(context, question, askedBy = questionAskedBy(question, threads), compact = true, plain = true)
                        } }
                    }
                }
                if (linksEnabled && (timeline?.feedback?.isNotEmpty() == true || openFeedbackCount(task) > 0 || timelineProblem != null)) item(key = "notes") {
                    TaskReadingSection("Your notes") {
                        timelineProblem?.let {
                            Text(it, style = TaskType.xs, color = colors.danger)
                            TextButton(onClick = record.onRetryTimeline, modifier = Modifier.heightIn(min = 48.dp)) { Text("Retry") }
                        }
                        timeline?.let {
                            TaskFeedback(it.feedback, record.feedbackBusy, now, { id -> threadName(id, threads) }, record.onSetFeedback)
                        }
                        if (timeline == null && timelineProblem == null) Text("Loading notes…", style = TaskType.xs, color = colors.fgMuted)
                    }
                }
                item(key = "record") {
                    TaskRecord(task, sheet.decisions, fields.checks, now, record.folds,
                        onFoldChange = record.onFoldChange,
                        decided = record.decided, threadLabel = { threadName(it, threads) },
                        activityContent = if (linksEnabled || task.snapshots > 0 || task.workerIds.isNotEmpty() || record.now != null) { {
                            if (deliveryEnabled) {
                                val workersById = workers.associateBy { it.id }
                                val sources = ActivitySources(entries = timeline?.entries.orEmpty(), groups = timeline?.groups.takeIf { timelineGroupsEnabled },
                                    questions = sheet.questions, decisions = record.decided.orEmpty(), feedback = timeline?.feedback.orEmpty(),
                                    workers = task.workerIds.associateWith { workersById[it] }, now = record.now, deliveryShown = delivery != null,
                                    taskLiveEnabled = sheet.liveEnabled)
                                TaskRecordActivity(context, task, sources, workersById, linksEnabled && timeline == null && timelineProblem == null,
                                    timelineProblem, record.timelineNewestFirst, record.onToggleTimelineOrder, now, record.writerName, sheet.liveNews)
                            } else {
                                if (linksEnabled) TaskTimeline(timeline?.entries.orEmpty(), record.timelineNewestFirst, record.onToggleTimelineOrder, record.writerName, now,
                                    groups = timeline?.groups.takeIf { timelineGroupsEnabled }, onKindsChanged = record.onTimelineKindsChanged)
                                if (task.snapshots > 0) TaskReadingSection("History") { TaskHistory(context, task, record.writerName) }
                                if (task.workerIds.isNotEmpty()) TaskRecordWorkers(context, task.workerIds, workers)
                            }
                        } } else null,
                    )
                }
                item(key = "about") {
                    TaskAbout(context, task, sheet.tasks, sheet.archivedLinks, sheet.owner,
                        legacyDelivery = activity.takeUnless { deliveryEnabled }, delivery = delivery,
                        blockersInNeedsYou = if (needsYou.blocked) blockers.mapTo(mutableSetOf()) { it.id } else emptySet(),
                        now = now)
                }
            }
        }
        sheet.reply?.let { reply ->
            HorizontalDivider(color = colors.border)
            TaskReplyBox(reply, onDismiss, replyInputMaxHeight)
        }
    }
    }
}
