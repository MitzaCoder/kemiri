package io.github.mitzacoder.kemiri.features.tasks

import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.clickable
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import io.github.mitzacoder.kemiri.features.coordinators.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.answers.CopyToAnswers
import io.github.mitzacoder.kemiri.features.chat.clockTime
import io.github.mitzacoder.kemiri.features.tasks.media.TaskFiles
import io.github.mitzacoder.kemiri.features.tasks.media.TaskProof
import io.github.mitzacoder.kemiri.features.tasks.media.automaticReportProof
import io.github.mitzacoder.kemiri.ui.components.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.theme.Text as TextStyles

@Composable
internal fun ClassicTaskView(sheet: TaskSheetState) {
    val colors = Jarvis.colors
    val context = sheet.context
    val task = sheet.task
    val taskId = task.id
    val previousTaskId = sheet.previousTaskId
    val onDismiss = sheet.onDismiss
    val bodyState = sheet.bodyState
    val fields = sheet.fields
    val failedChecks = failedCheckLine(fields.checks)
    val needsYou = sheet.needsYou
    val blockers = sheet.blockers
    val threads = sheet.threads
    val workers = sheet.workers
    val artifacts = sheet.artifacts
    val results = sheet.report.results
    val partPage = sheet.partPage
    val actions = taskPageActions(task, partPage)
    val digest = task.partsDigest.takeIf { sheet.requestDigest }
    val derivedNotDone = task.derivedNotDone.takeIf { sheet.requestDigest }.orEmpty()
    val proofPartOrigins = remember(digest, artifacts) {
        if (digest == null) emptyMap() else artifacts.mapNotNull { artifact -> proofPartOrigin(artifact, digest.parts)?.let { artifact.id to it } }.toMap()
    }
    val automaticProof = remember(results, artifacts, proofPartOrigins) {
        automaticReportProof(results, artifacts.filterNot { it.id in proofPartOrigins })
    }
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

    val coordinator = threads.find { it.id == task.coordinator }
    val roster = coordinatorRoster(threads)
    var movingTask by rememberSaveable { mutableStateOf(false) }
    val moveTask: (() -> Unit)? = if (sheet.coordinatorTitle != null && !task.archived && roster.size > 1) { { movingTask = true } } else null
    if (movingTask && moveTask != null) {
        val board by context.board.view.collectAsStateWithLifecycle()
        TaskCoordinatorMoveDialog(context, task, board.tasks, roster) { movingTask = false }
    }

    var titleHeight by remember { mutableIntStateOf(0) }
    val editorScroll = rememberLazyListState()
    val titleInBar by remember(bodyState) { derivedStateOf {
        if (bodyState.firstVisibleItemIndex > 0) true
        else bodyState.layoutInfo.let { layout ->
            val header = layout.visibleItemsInfo.firstOrNull { it.key == "task-header" }
            header != null && titleHeight > 0 && header.offset + titleHeight <= layout.viewportStartOffset
        }
    } }
    LaunchedEffect(status.waitingForm, status.confirmDrop, status.problem) {
        if (status.waitingForm || status.confirmDrop || status.problem != null) bodyState.scrollToItem(0)
    }
    BoxWithConstraints(Modifier.fillMaxSize()) {
        // Bound a growing reply by the inset-adjusted viewport, including in landscape.
        val replyInputMaxHeight = (maxHeight * .30f).coerceIn(40.dp, 136.dp)
        Column(Modifier.widthIn(max = 672.dp).fillMaxSize().align(Alignment.TopCenter)) {
            TaskSheetBar(sheet, titleInBar = titleInBar, onMoveToCoordinator = moveTask)
            HorizontalDivider(color = colors.border)

            LazyColumn(
                state = if (sheet.editing) editorScroll else bodyState,
                modifier = Modifier.weight(1f).fillMaxWidth(),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                if (sheet.editing) item(key = "editor") {
                    val board by context.board.view.collectAsStateWithLifecycle()
                    TaskEditor(context, task, board.tasks, onBack = { sheet.onEditChange(false) }, scrolls = false, editStatus = actions.canClose)
                } else {
                    item(key = "task-header") {
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            TaskSheetTitle(task.title, Modifier.onSizeChanged { titleHeight = it.height })
                            TaskSheetMetadata(task.refs, sheet.coordinatorTitle, coordinator, moveTask)
                            (partPage?.requestId ?: previousTaskId)?.let { id ->
                                val title = if (partPage != null) sheet.tasks.find { it.id == id }?.title ?: sheet.archivedLinks.find { it.id == id }?.title else sheet.previousTaskTitle
                                TextButton(onClick = { if (id == previousTaskId) onDismiss() else context.openTask(id) }) {
                                    TaskDetailText("← $id" + (title?.let { " · $it" } ?: ""), maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            }
                            if (partPage != null && (!status.detailsSupported || partPage.closure != null)) {
                                val closure = partPage.closure
                                val clock = isoMillis(partPage.closedAt).takeIf { it > 0 }?.let(::clockTime)
                                Text(if (closure == null) status.title else listOfNotNull("✓ $closure", clock).joinToString(" · "),
                                    style = TaskType.xs, color = if (closure != null) colors.success else colors.fgMuted)
                            }
                            fields.goal?.let { Text(it, style = TextStyles.task, color = colors.fgMuted) }
                            CopyToAnswers(context, task)
                            if (status.waitingForm) TaskWaitingForm(task.waiting, status.saving, status.workDayStart, { note, until -> status.onSet("waiting", note, until) }, status.onCancelWaiting)
                            else if (status.confirmDrop) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                TaskDetailText("Drop ${task.id}? It will not be done.", style = TaskType.xs, color = colors.fgMuted)
                                Button(onClick = { status.onSet("dropped", null, null) }, enabled = !status.saving, colors = ButtonDefaults.buttonColors(containerColor = colors.danger, contentColor = colors.bg)) { Text("Drop it") }
                                TextButton(onClick = status.onCancelDrop) { Text("Keep") }
                            }
                            status.problem?.let { TaskDetailText(it, style = TaskType.xs, color = colors.danger) }
                        }
                    }
                    sheet.raisedAttention?.let { attention ->
                        item(key = "part-needs-you") {
                            TaskReadingSection("Needs you") {
                                OutlinedButton(onClick = { context.openTask(attention.taskId, attention.questionId) }) { Text(attention.text) }
                            }
                        }
                    }
                    if (needsYou.show) item(key = "needs-you") {
                        TaskNeedsYouSection(context, task, needsYou, sheet.nextPlacement, sheet.report, blockers, threads, status.saving,
                            onCloseTask = if (actions.canClose) ({ status.onSet("done", null, null) }) else null, onFocusReply = sheet.onFocusReply)
                    }
                    val (checkingQuestions, otherAgentQuestions) = needsYou.questionsForAgent.partition { questionCheckingFeedbackId(it) != null }
                    if (checkingQuestions.isNotEmpty()) item(key = "checking-questions") {
                        TaskReadingSection(QUESTION_BEING_CHECKED) {
                            checkingQuestions.forEach { question -> key(question.id) {
                                QuestionCard(context, question, askedBy = questionAskedBy(question, threads), compact = true, plain = true)
                            } }
                        }
                    }
                    if (liveNow != null) item(key = "live") {
                        TaskLive(task.live, liveNow, context.backend.config.key, context.route.projectId, taskId, sheet.liveNews, workers, context::openTaskWorkerTranscript)
                    }
                    item(key = "results") {
                        TaskReadingSection("What you get") {
                            if (fields.showSummary) ReportSection(task, ReportSectionKind.Summary, content = sheet.report.summary)
                            if (sheet.staleReport) StaleTaskReport(context, task.id)
                            if (results.hasContent) ReportSection(task, ReportSectionKind.Results, context, artifacts, sheet.sectionViewsSupported, content = results)
                            else if (!fields.showSummary && failedChecks == null) Text(if (task.state?.liveWorkSince == null && emptyFinishedResults(task.status, task.report.results)) "No results yet · work finished" else "Nothing written yet.", style = TaskType.xs, color = colors.fgMuted)
                            failedChecks?.let { Text(it, style = TextStyles.task, color = colors.danger) }
                            TaskUsageDisclosure(sheet.usage, taskId)
                            TaskProof(context, automaticProof)
                        }
                    }
                    if (digest != null && digest.parts.isNotEmpty()) item(key = "parts-checklist") {
                        PartsChecklist(digest, sheet.partProof, sheet.tasks.takeIf { status.detailsSupported }.orEmpty(), context::openTask)
                    }
                    item(key = "apps") { io.github.mitzacoder.kemiri.features.apps.TaskApps(taskId) }
                    if (artifacts.isNotEmpty()) item(key = "files") {
                        TaskReadingSection("Files") {
                            TaskFiles(context, artifacts, onUpdateTags = sheet.onUpdateArtifactTags, proofPartOrigins = proofPartOrigins)
                        }
                    }
                    if (fields.showNotDone || derivedNotDone.isNotEmpty()) item(key = "not-done") {
                        TaskReadingSection("Not done") {
                            if (fields.showNotDone) ReportSection(task, ReportSectionKind.NotDone, context, artifacts, sheet.sectionViewsSupported, content = sheet.report.notDone)
                            derivedNotDone.forEach { line ->
                                Text(line.text, Modifier.fillMaxWidth().clickable(onClickLabel = "Open dropped part") { context.openTask(line.partId) }
                                    .heightIn(min = 48.dp).padding(vertical = 8.dp), style = TaskType.xs, color = colors.fgMuted)
                            }
                        }
                    }
                    if (sheet.showNow || showNext) item(key = "next") {
                        TaskReadingSection("Next") {
                            if (sheet.showNow) {
                                TaskHeading("Now")
                                if (activity != null) TaskActivityView(activity, inlineAge = true) else ReportMarkdown(task.report.now)
                            }
                            if (showNext) ReportSection(task, ReportSectionKind.Next, content = sheet.report.next)
                        }
                    }
                    if (otherAgentQuestions.isNotEmpty()) item(key = "agent-questions") {
                        TaskReadingSection("Waiting for an agent reply") {
                            otherAgentQuestions.forEach { question -> key(question.id) {
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
                            coordinatorMessages = if (sheet.coordinatorMessagesEnabled) { {
                                TaskCoordinatorMessagesFold(context, taskId, threads, record.folds, record.onFoldChange)
                            } } else null,
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
                                }
                            } } else null,
                        )
                    }
                    if (task.workerIds.isNotEmpty()) item(key = "workers") { TaskRecordWorkers(context, task.workerIds, workers) }
                    item(key = "about") {
                        TaskAbout(context, task, sheet.tasks, sheet.archivedLinks, sheet.owner,
                            legacyDelivery = activity.takeUnless { deliveryEnabled }, delivery = delivery,
                            blockersInNeedsYou = if (needsYou.blocked) blockers.mapTo(mutableSetOf()) { it.id } else emptySet(),
                            now = now, statusDetails = status.detailsSupported)
                    }
                }
            }
            if (status.reopenForm && actions.reopenWithNote) ReopenPartDialog(status.saving, status.problem, status.onCancelReopen, status.onReopen)
            sheet.reply?.let { reply ->
                HorizontalDivider(color = colors.border)
                if (actions.comment) Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (actions.reopenWithNote) TextButton(onClick = status.onShowReopen) { Text("Reopen with a note…", style = TaskType.xs) }
                    TextButton(onClick = sheet.onFocusReply) { Text("Comment", style = TaskType.xs) }
                }
                TaskReplyBox(reply, onDismiss, replyInputMaxHeight)
            }
        }
    }
}
