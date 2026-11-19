package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.content.contentReceiver
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.foundation.text.input.setTextAndPlaceCursorAtEnd
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.features.panels.panelData
import io.github.mitzacoder.kemiri.features.tasks.media.ARTIFACT_TAGS_FEATURE
import io.github.mitzacoder.kemiri.features.tasks.media.TaskFiles
import io.github.mitzacoder.kemiri.features.tasks.media.TaskProof
import io.github.mitzacoder.kemiri.features.chat.ChatFile
import io.github.mitzacoder.kemiri.features.chat.FileChips
import io.github.mitzacoder.kemiri.features.chat.INPUT_IMAGE_MIME_TYPES
import io.github.mitzacoder.kemiri.features.chat.readRawImage
import io.github.mitzacoder.kemiri.features.chat.uploadChatFile
import io.github.mitzacoder.kemiri.features.chat.ComposerQuotes
import io.github.mitzacoder.kemiri.features.chat.DraftImage
import io.github.mitzacoder.kemiri.features.chat.INPUT_MAX_IMAGES
import io.github.mitzacoder.kemiri.features.chat.MessageComposer
import io.github.mitzacoder.kemiri.features.chat.attachFiles
import io.github.mitzacoder.kemiri.features.chat.imageBlock
import io.github.mitzacoder.kemiri.features.chat.messageLimitError
import io.github.mitzacoder.kemiri.features.chat.rememberImageIntake
import io.github.mitzacoder.kemiri.features.chat.sha256Hex
import io.github.mitzacoder.kemiri.features.chat.LocalQuoteHandler
import io.github.mitzacoder.kemiri.features.refs.refLinkedText
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.components.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.theme.JetBrainsMono
import io.github.mitzacoder.kemiri.ui.theme.Text as TextStyles
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive

/**
 * A task as a sheet over the chat it was opened from ([io.github.mitzacoder.kemiri.navigation.Destination.Task]; web
 * `TaskSheet.svelte`): the whole screen on a phone, a capped reading column in a side sheet on a tablet.
 * Actions for the reader come first, ahead of results, plans, notes, the record and task facts.
 * The fixed reply box sends to Main chat with the task ID even when opened from a thread.
 */
@Composable
fun TaskSheet(context: ProjectScreenContext, taskId: String, onDismiss: () -> Unit, bodyState: androidx.compose.foundation.lazy.LazyListState, previousTaskId: String? = null) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val view = LocalView.current
        val dark = Jarvis.colors.dark
        SideEffect {
            (view.parent as? DialogWindowProvider)?.window?.let { window ->
                WindowCompat.getInsetsController(window, view).apply {
                    isAppearanceLightStatusBars = !dark
                    isAppearanceLightNavigationBars = !dark
                }
            }
        }
        // Text selected in the sheet can be quoted into the chat under it (not a worker's transcript); the sheet closes so
        // the message can be written.
        val quote: ((String) -> Unit)? = if (context.route.workerId == null) { text -> ComposerQuotes.send(context.route, text); onDismiss() } else null
        CompositionLocalProvider(LocalQuoteHandler provides quote, LocalOpenTaskId provides taskId) {
        BoxWithConstraints(Modifier.fillMaxSize()) {
            // From a tablet's width the sheet is a panel from the end with the chat dimmed beside it; a tap there closes it.
            val wide = maxWidth >= 600.dp
            if (wide) {
                Box(Modifier.fillMaxSize().clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClickLabel = "Close the task", onClick = onDismiss))
                Surface(
                    Modifier.align(Alignment.CenterEnd).fillMaxHeight().width(minOf(1184.dp, maxWidth - 48.dp)),
                    shape = RoundedCornerShape(topStart = 16.dp, bottomStart = 16.dp),
                    color = Jarvis.colors.bg,
                    shadowElevation = 12.dp,
                    border = androidx.compose.foundation.BorderStroke(1.dp, Jarvis.colors.border),
                ) { key(taskId) { TaskSheetContent(context, taskId, wide = true, onDismiss = onDismiss, previousTaskId = previousTaskId, bodyState = bodyState) } }
            } else Surface(Modifier.fillMaxSize(), color = Jarvis.colors.bg) { key(taskId) { TaskSheetContent(context, taskId, wide = false, onDismiss = onDismiss, previousTaskId = previousTaskId, bodyState = bodyState) } }
        }
        }
    }
}

@Composable
private fun TaskSheetContent(context: ProjectScreenContext, taskId: String, wide: Boolean, onDismiss: () -> Unit, previousTaskId: String?, bodyState: androidx.compose.foundation.lazy.LazyListState) {
    val deviceSettings by context.repository.settings.collectAsStateWithLifecycle()
    val colors = Jarvis.colors
    val board = context.board
    val view by board.view.collectAsStateWithLifecycle()
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    val project = context.route.projectId
    val liveTask = view.task(taskId)
    // A task the live board does not list may be archived; read once to see.
    var archivedTask by remember { mutableStateOf<BoardTask?>(null) }
    var lookedUp by remember { mutableStateOf(false) }
    LaunchedEffect(view.loaded, liveTask == null) {
        if (!view.loaded || liveTask != null || lookedUp) return@LaunchedEffect
        try { archivedTask = board.findArchived(taskId) } catch (cause: CancellationException) { throw cause } catch (_: Exception) {}
        lookedUp = true
    }
    val task = liveTask ?: archivedTask
    val insets = Modifier.windowInsetsPadding(WindowInsets.safeDrawing.only(if (wide) WindowInsetsSides.Vertical + WindowInsetsSides.End else WindowInsetsSides.Vertical + WindowInsetsSides.Horizontal))
    if (task == null) {
        Column(Modifier.fillMaxSize().then(insets)) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(taskId, Modifier.weight(1f), style = TextStyles.base.copy(fontWeight = FontWeight.SemiBold), color = colors.fg)
                IconButton(onClick = onDismiss) { LucideGlyph(Lucide.X, size = 18.dp, contentDescription = "Close the task") }
            }
            HorizontalDivider(color = colors.border)
            if (!view.loaded || !lookedUp) Column(Modifier.padding(16.dp).semantics { contentDescription = "Loading $taskId" }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(.35f to 20, .25f to 12, .8f to 14, 1f to 14, .9f to 14, .66f to 12).forEach { (width, height) ->
                    Box(Modifier.fillMaxWidth(width).height(height.dp).background(colors.surface2, RoundedCornerShape(4.dp)))
                }
            }
            else Text("$taskId is not on the board any more.", Modifier.padding(16.dp), style = TextStyles.sm, color = colors.fgSubtle)
        }
        return
    }

    val threads = if (connection.supports("threads")) panelData(context, "sheet-threads", { it is ThreadsStateEvent && it.projectId == project }) {
        context.backend.client.request(ThreadsListRequest(projectId = project, includeArchived = true)).threads
    }.value.orEmpty() else emptyList()
    val workers = if (connection.supports("workers")) panelData(context, "sheet-workers", { it is WorkersStateEvent && it.projectId == project }) {
        context.backend.client.request(WorkersListRequest(projectId = project)).workers
    }.value.orEmpty() else emptyList()
    val artifacts = if (connection.supports("artifacts")) panelData(context, "sheet-artifacts-$taskId", { it is ArtifactsChangedEvent && it.projectId == project && it.artifact.taskId == taskId }) {
        context.backend.client.request(ArtifactsListRequest(projectId = project, taskId = taskId)).artifacts
    }.value.orEmpty() else emptyList()
    val now = rememberTaskMinuteNow()

    var editing by rememberSaveable { mutableStateOf(false) }
    var confirmDrop by remember { mutableStateOf(false) }
    var waitingForm by remember(taskId) { mutableStateOf(false) }
    var problem by remember { mutableStateOf<String?>(null) }
    var closing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val linksEnabled = connection.supports(HarnessFeature.TASK_LINKS)
    val timelineGroupsEnabled = connection.supports(HarnessFeature.TASK_TIMELINE_GROUPS)
    val deliveryEnabled = connection.supports(HarnessFeature.TASK_DELIVERY)
    val activity = taskActivity(task, connection.supports("task-activity"))
    // The Live block replaces the Now lines; it needs the backend flag, a working task and a trail.
    val liveEnabled = connection.supports(HarnessFeature.TASK_LIVE)
    val news = if (liveEnabled && connection.supports(HarnessFeature.TASK_LIVE_WATCHER)) LiveNewsActions(
        openWorkLog = { line, entryId -> liveWorkLogRoute(context.route, workers, line, entryId)?.let { route -> { context.navigate(route) } } },
        markWrong = { lineId -> context.backend.client.markLiveLineWrong(project, task.id, lineId) },
    ) else null
    val liveNow = taskLiveNow(task, liveEnabled, activity, watcher = news != null)
    var timelineKinds by rememberSaveable(taskId) { mutableStateOf<List<String>?>(null) }
    var timeline by remember(taskId) { mutableStateOf<BoardTaskTimelineResponse?>(null) }
    var timelineProblem by remember(taskId) { mutableStateOf<String?>(null) }
    var feedbackBusy by remember(taskId) { mutableStateOf(false) }
    var timelineRefresh by remember(taskId) { mutableIntStateOf(0) }
    LaunchedEffect(linksEnabled, timelineGroupsEnabled, timelineKinds, connection.status, task.timelineRevision, task.feedback,
        task.status, task.report.revision, timelineRefresh, deliveryEnabled, activity?.kind.takeIf { deliveryEnabled }) {
        if (!linksEnabled) return@LaunchedEffect
        try {
            val kinds = timelineKinds.takeUnless { deliveryEnabled }
            val response = context.backend.client.readTaskTimeline(project, taskId, kinds, grouped = timelineGroupsEnabled, delivery = deliveryEnabled)
            // Empty legacy wire kinds means no server filter; all chips off means no matching groups in the UI.
            timeline = if (timelineGroupsEnabled && kinds?.isEmpty() == true && response.groups != null) response.copy(groups = emptyList()) else response
            timelineProblem = null
        } catch (cause: CancellationException) { throw cause }
        catch (cause: Exception) { timelineProblem = cause.message ?: "Could not read timeline" }
    }
    fun setFeedback(entry: BoardFeedback, state: String) {
        if (feedbackBusy) return
        feedbackBusy = true
        scope.launch {
            try {
                val updated = context.backend.client.setFeedbackState(project, taskId, entry.id, state)
                timeline = timeline?.let { it.copy(feedback = it.feedback.map { old -> if (old.id == updated.id) updated else old }) }
                timelineRefresh++
            } catch (cause: CancellationException) { throw cause }
            catch (cause: Exception) { timelineProblem = cause.message ?: "Could not change feedback" }
            finally { feedbackBusy = false }
        }
    }
    val decisions = decisionsFor(view.board?.decisions.orEmpty(), task.id)
    val blockers = blockersOf(task, view.tasks).filterNot { it.settled }
    val needsYou = taskNeedsYou(task, view.questions, blockers.isNotEmpty(), connection.supports(HarnessFeature.TASK_STEPS))
    val delivery = timeline?.delivery?.takeIf { deliveryEnabled && it.commits.isNotEmpty() }
    val taskQuestions = view.questions.filter { it.taskId == task.id }
    val decided = if (deliveryEnabled) taskDecided(task.id, decisions, taskQuestions) else null
    val recordNow = if (deliveryEnabled && liveNow == null) taskRecordNow(task, activity, taskQuestions, delivery != null) else null
    val showNow = !deliveryEnabled && liveNow == null && showTaskNow(task, activity)
    val showNext = !needsYou.review && task.report.next.isNotBlank()
    val showPlan = showNow || showNext
    val fields = taskDetailFields(task, connection.supports(HarnessFeature.TASK_FIELDS))
    val failedChecks = failedCheckLine(fields.checks)
    val showAgentQuestions = needsYou.questionsForAgent.isNotEmpty()

    val staleReport = taskReportIsStale(connection.supports("task-freshness"), task.report)
    val owner = taskOwner(task, threads)
    val replyFocus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    fun writerName(writer: BoardWriter) = shortWriterLabel(writer, threads)

    fun setStatus(target: String, waitingFor: String? = null, waitUntil: String? = null) {
        if (closing) return
        closing = true
        problem = null
        confirmDrop = false
        scope.launch {
            // No refs: a status change keeps the task's own.
            val input = task.editorDraft().toInput(baseRefs = task.refs).copy(status = target, waitingFor = waitingFor, waitUntil = waitUntil)
            when (val outcome = board.saveTask(input, task.id, task.revision)) {
                SaveOutcome.Cancelled -> Unit
                is SaveOutcome.Saved -> { waitingForm = false; if (archivedTask?.id == task.id) archivedTask = outcome.task }
                is SaveOutcome.Conflict -> problem = "${task.id} changed while you were looking. Check it and try again."
                is SaveOutcome.Failed -> problem = outcome.message
            }
            closing = false
        }
    }

    val taskUsage = rememberTaskUsage(context, taskId)

    // Budget from the space ABOVE the IME, not the full display. Non-weighted headers used to consume all
    // Column constraints before the reply was measured, leaving a focused but invisible input/send button.
    BoxWithConstraints(Modifier.fillMaxSize().then(insets).imePadding()) {
    val headerMaxHeight = minOf(360.dp, maxHeight * .35f, (maxHeight - 220.dp).coerceAtLeast(56.dp))
    val refsMaxHeight = minOf(240.dp, maxHeight * .25f)
    val replyInputMaxHeight = (maxHeight * .20f).coerceIn(40.dp, 160.dp)
    val shortViewport = maxHeight < 400.dp
    Column(Modifier.widthIn(max = 672.dp).fillMaxSize().align(Alignment.TopCenter)) {
        previousTaskId?.let { id ->
            val title = view.tasks.firstOrNull { it.id == id }?.title
            TextButton(onClick = onDismiss, modifier = Modifier.fillMaxWidth()) {
                TaskDetailText("← $id" + (title?.let { " · $it" } ?: ""), maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
            }
        }
        // The header keeps state and actions visible while the reading column scrolls.
        Column(Modifier.fillMaxWidth().heightIn(max = headerMaxHeight).verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 4.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(task.id, style = TaskType.xs.copy(fontFamily = JetBrainsMono), color = colors.fgSubtle)
                Box(Modifier.weight(1f)) {
                    TaskStatusMenu(task, taskDetailState(task.status, needsYou, task.state?.kind), connection.supports("task-waiting"), !closing) { status ->
                        confirmDrop = status == "dropped"
                        waitingForm = status == "waiting"
                        if (!confirmDrop && !waitingForm) setStatus(status)
                    }
                }
                if (!editing) IconButton(onClick = { editing = true }) { LucideGlyph(TaskIcons.Pencil, size = 18.dp, contentDescription = "Edit ${task.id}") }
                IconButton(onClick = onDismiss) { LucideGlyph(Lucide.X, size = 18.dp, contentDescription = if (previousTaskId == null) "Close the task" else "Back to $previousTaskId") }
            }
            Column(Modifier.padding(end = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                TaskDetailText(refLinkedText(task.title), Modifier.semantics { heading() }, style = TextStyles.lg.copy(fontWeight = FontWeight.SemiBold), color = colors.fg)
                fields.goal?.let { Text(it, style = TextStyles.task, color = colors.fgMuted) }
                if (task.refs.isNotEmpty()) TaskRefs(task.refs, refsMaxHeight)
                if (waitingForm) TaskWaitingForm(task.waiting, closing, deviceSettings.workDayStart, { note, until -> setStatus("waiting", note, until) }, { waitingForm = false })
                else if (confirmDrop) FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TaskDetailText("Drop ${task.id}? It will not be done.", style = TaskType.xs, color = colors.fgMuted)
                    Button(onClick = { setStatus("dropped") }, enabled = !closing, colors = ButtonDefaults.buttonColors(containerColor = colors.danger, contentColor = colors.bg)) { Text("Drop it") }
                    TextButton(onClick = { confirmDrop = false }) { Text("Keep") }
                }
                problem?.let { TaskDetailText(it, style = TaskType.xs, color = colors.danger) }
            }
        }
        HorizontalDivider(color = colors.border)

        LazyColumn(
            state = bodyState, modifier = Modifier.weight(1f).fillMaxWidth(),
            contentPadding = PaddingValues(if (shortViewport) 8.dp else 16.dp), verticalArrangement = Arrangement.spacedBy(24.dp),
        ) {
            if (editing) item(key = "editor") { TaskEditor(context, task, view.tasks, onBack = { editing = false }, scrolls = false) }
            else {
                if (needsYou.show) item(key = "needs-you") {
                    TaskNeedsYouSection(context, task, needsYou, blockers, threads, closing, onCloseTask = { setStatus("done") }, onFocusReply = {
                        if (replyFocus.requestFocus()) keyboard?.show()
                    })
                }
                if (liveNow != null && task.live != null) item(key = "live") {
                    TaskLive(task.live, liveNow, context.backend.config.key, project, taskId, news)
                }
                item(key = "results") {
                    TaskReadingSection("What you get") {
                        fields.summary?.let { Text(it, style = TextStyles.task.copy(fontWeight = FontWeight.Medium), color = colors.fg) }
                        if (staleReport) StaleTaskReport(context, task.id)
                        if (task.report.results.isNotBlank()) ReportMarkdown(task.report.results)
                        else if (fields.summary == null && failedChecks == null) Text(if (emptyFinishedResults(task.status, task.report.results)) "No results yet · work finished" else "Nothing written yet.", style = TaskType.xs, color = colors.fgMuted)
                        failedChecks?.let { Text(it, style = TextStyles.task, color = colors.danger) }
                        TaskUsageDisclosure(taskUsage, taskId)
                        TaskProof(context, artifacts)
                    }
                }
                if (artifacts.isNotEmpty()) item(key = "files") {
                    TaskReadingSection("Files") {
                        TaskFiles(context, artifacts, onUpdateTags = if (connection.supports(ARTIFACT_TAGS_FEATURE)) { artifact, tags ->
                            context.backend.client.request(ArtifactsUpdateRequest(projectId = project, artifactId = artifact.id, tags = tags)).artifact
                        } else null)
                    }
                }
                fields.notDoneMarkdown?.let { notDone ->
                    item(key = "not-done") { TaskReadingSection("Not done") { ReportMarkdown(notDone) } }
                }
                if (showPlan) item(key = "next") {
                    TaskReadingSection("Next") {
                        if (showNow) {
                            TaskHeading("Now")
                            if (activity != null) TaskActivityView(activity, inlineAge = true) else ReportMarkdown(task.report.now)
                        }
                        if (showNext) ReportMarkdown(task.report.next)
                    }
                }
                if (showAgentQuestions) item(key = "agent-questions") {
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
                            TextButton(onClick = { timelineRefresh++ }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Retry") }
                        }
                        timeline?.let {
                            TaskFeedback(it.feedback, feedbackBusy, now, { id -> threadName(id, threads) }, ::setFeedback)
                        }
                        if (timeline == null && timelineProblem == null) Text("Loading notes…", style = TaskType.xs, color = colors.fgMuted)
                    }
                }
                item(key = "record") {
                    TaskRecord(task, decisions, fields.checks, now, deviceSettings.taskRecordFolds,
                        onFoldChange = { row, expanded -> scope.launch { context.repository.setTaskRecordFold(row, expanded) } },
                        decided = decided, threadLabel = { threadName(it, threads) },
                        activityContent = if (linksEnabled || task.snapshots > 0 || task.workerIds.isNotEmpty() || recordNow != null) { {
                            val toggleOrder: () -> Unit = { scope.launch { context.repository.setTimelineNewestFirst(!deviceSettings.timelineNewestFirst) } }
                            if (deliveryEnabled) {
                                val workersById = workers.associateBy { it.id }
                                val sources = ActivitySources(entries = timeline?.entries.orEmpty(), groups = timeline?.groups.takeIf { timelineGroupsEnabled },
                                    questions = taskQuestions, decisions = decided.orEmpty(), feedback = timeline?.feedback.orEmpty(),
                                    workers = task.workerIds.associateWith { workersById[it] }, now = recordNow, deliveryShown = delivery != null,
                                    taskLiveEnabled = connection.supports(HarnessFeature.TASK_LIVE))
                                TaskRecordActivity(context, task, sources, workersById, linksEnabled && timeline == null && timelineProblem == null,
                                    timelineProblem, deviceSettings.timelineNewestFirst, toggleOrder, now, ::writerName, news)
                            } else {
                                if (linksEnabled) TaskTimeline(timeline?.entries.orEmpty(), deviceSettings.timelineNewestFirst, toggleOrder, ::writerName, now,
                                    groups = timeline?.groups.takeIf { timelineGroupsEnabled }, onKindsChanged = { timelineKinds = it })
                                if (task.snapshots > 0) TaskReadingSection("History") { TaskHistory(context, task, ::writerName) }
                                if (task.workerIds.isNotEmpty()) TaskRecordWorkers(context, task.workerIds, workers)
                            }
                        } } else null,
                    )
                }
                item(key = "about") {
                    TaskAbout(context, task, view.tasks, view.board?.archivedLinks.orEmpty(), owner,
                        legacyDelivery = activity.takeUnless { deliveryEnabled }, delivery = delivery,
                        blockersInNeedsYou = if (needsYou.blocked) blockers.mapTo(mutableSetOf()) { it.id } else emptySet(),
                        now = now)
                }
            }
        }
        if (!editing) {
            HorizontalDivider(color = colors.border)
            ReplyBox(context, task, owner, onDismiss, replyInputMaxHeight, replyFocus)
        }
    }
    }
}

/**
 * Talk about the task: the message goes to the coordinator in main's chat with the task's ID (the server writes
 * `[task T4] ` before it), whichever chat the sheet sits on; main passes it on to a thread that holds the task.
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun ReplyBox(context: ProjectScreenContext, task: BoardTask, owner: TaskOwner, onDismiss: () -> Unit, inputMaxHeight: androidx.compose.ui.unit.Dp, focus: FocusRequester) {
    val colors = Jarvis.colors
    // Typed in a text field's own state, so the field can take pasted and keyboard images; kept per task.
    val reply = key(task.id) { rememberTextFieldState() }
    var sending by remember { mutableStateOf(false) }
    var sent by remember { mutableStateOf(false) }
    var replyProblem by remember { mutableStateOf<String?>(null) }
    // Images wait here, in memory only (the reply has no draft), until the message is sent.
    var images by remember(task.id) { mutableStateOf(listOf<DraftImage>()) }
    var attachments by remember(task.id) { mutableStateOf(listOf<ChatFile>()) }
    val android = androidx.compose.ui.platform.LocalContext.current
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    var attaching by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    // Typing again after a send clears "Sent".
    LaunchedEffect(reply) { snapshotFlow { reply.text.toString() }.collect { if (it.isNotEmpty()) sent = false } }
    suspend fun addImages(files: List<Pair<io.github.mitzacoder.kemiri.features.chat.RawImage?, String?>>) {
            replyProblem = attachFiles(files) { image ->
                val id = sha256Hex(image.bytes)
                when {
                    images.any { it.ref.id == id } -> null
                    else -> messageLimitError(images.size, images.sumOf { it.bytes?.size ?: 0 }, image.bytes.size, image.name) ?: run {
                        images = images + DraftImage(DraftAttachment(id = id, mimeType = image.mimeType, size = image.bytes.size.toLong(), name = image.name), image.bytes)
                        null
                    }
                }
            }
    }
    val intake = rememberImageIntake { files ->
        attaching = true
        try { addImages(files) } finally { attaching = false }
    }
    val filePicker = androidx.activity.compose.rememberLauncherForActivityResult(androidx.activity.result.contract.ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) scope.launch {
            attaching = true; replyProblem = null
            try {
                for (uri in uris) {
                    if (images.size + attachments.size >= INPUT_MAX_IMAGES) { replyProblem = "A message holds at most 8 attachments"; break }
                    try {
                        if (android.contentResolver.getType(uri) in INPUT_IMAGE_MIME_TYPES) {
                            val raw = kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { readRawImage(android.contentResolver, uri) }
                            addImages(listOf(raw to null))
                        } else attachments = attachments + uploadChatFile(context.backend.client, android.contentResolver, context.route.projectId, null, uri)
                    } catch (cause: CancellationException) { throw cause }
                    catch (cause: Exception) { replyProblem = cause.message ?: "Could not attach file" }
                }
            } finally { attaching = false }
        }
    }
    fun send() {
        val text = reply.text.toString().trim()
        if ((text.isEmpty() && images.isEmpty() && attachments.isEmpty()) || sending || attaching) return
        sending = true
        replyProblem = null
        val sentImages = images
        val sentAttachments = attachments
        scope.launch {
            try {
                val blocks = sentImages.mapNotNull { image -> image.bytes?.let { imageBlock(image.ref.mimeType, it) } }
                context.backend.client.request(ConversationSubmitRequest(
                    projectId = context.route.projectId, threadId = null, requestId = java.util.UUID.randomUUID().toString(),
                    content = if (blocks.isEmpty()) JsonPrimitive(text) else kotlinx.serialization.json.buildJsonArray {
                        if (text.isNotEmpty()) add(kotlinx.serialization.json.buildJsonObject { put("type", JsonPrimitive("text")); put("text", JsonPrimitive(text)) })
                        blocks.forEach { add(it) }
                    },
                    whenBusy = "steer", taskId = task.id, fileIds = sentAttachments.map { it.id },
                ))
                reply.setTextAndPlaceCursorAtEnd("")
                // What was sent goes; images added while the request was out stay.
                images = images.filterNot { image -> sentImages.any { it.ref.id == image.ref.id } }
                attachments = attachments.filterNot { file -> sentAttachments.any { it.id == file.id } }
                sent = true
            } catch (cause: CancellationException) { throw cause }
            catch (cause: Exception) { replyProblem = cause.message ?: "Could not send" }
            finally { sending = false }
        }
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        MessageComposer(
            textState = reply,
            hint = "To main · about ${task.id}" + if (owner.claimed && !owner.main) " · ${owner.label}" else "",
            hintMaxLines = 1,
            images = images,
            onRemoveImage = { id -> images = images.filterNot { it.ref.id == id } },
            attaching = attaching,
            attachEnabled = !attaching && !sending && images.size + attachments.size < INPUT_MAX_IMAGES,
            attachLabel = if (connection.supports("chat-files-v1")) "Attach files" else "Attach images",
            onAttach = if (connection.supports("chat-files-v1")) ({ filePicker.launch(arrayOf("*/*")) }) else intake.pick,
            beforeInput = { if (attachments.isNotEmpty()) FileChips(attachments, onRemove = { id -> attachments = attachments.filterNot { it.id == id } }) },
            sendLabel = if (sending) "Sending" else "Send to the coordinator about ${task.id}",
            sendEnabled = !sending && !attaching && (reply.text.isNotBlank() || images.isNotEmpty() || attachments.isNotEmpty()),
            onSend = ::send,
            modifier = Modifier.fillMaxWidth(),
            fieldModifier = Modifier.focusRequester(focus).heightIn(max = inputMaxHeight).contentReceiver(intake.receiver).semantics { contentDescription = "Message about ${task.id}" },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
        )
        when {
            replyProblem != null -> Text(replyProblem.orEmpty(), style = TaskType.xs, color = colors.danger)
            sent -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Sent. The answer appears in the chat.", style = TaskType.xs, color = colors.fgMuted)
                Text("Back to the chat", Modifier.clickableLink("Back to the chat", onDismiss).padding(vertical = 4.dp),
                    style = TaskType.xs.copy(textDecoration = androidx.compose.ui.text.style.TextDecoration.Underline), color = colors.fgMuted)
            }
        }
    }
}
