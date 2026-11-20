package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.features.panels.panelData
import io.github.mitzacoder.kemiri.features.tasks.media.ARTIFACT_TAGS_FEATURE
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Data and actions for the open task, kept above the chosen design's composition. */
internal data class TaskSheetState(
    val context: ProjectScreenContext, // Used by shared controls that handle their own navigation or requests.
    val task: BoardTask,
    val tasks: List<BoardTask>,
    val archivedLinks: List<BoardTaskBrief>,
    val previousTaskId: String?,
    val previousTaskTitle: String?,
    val wide: Boolean,
    val bodyState: LazyListState,
    val designId: String,
    val onSelectDesign: (String) -> Unit,
    val onDismiss: () -> Unit,
    val threads: List<ThreadSummary>,
    val workers: List<WorkerSummary>,
    val artifacts: List<Artifact>,
    val artifactsProblem: String?,
    val onRetryArtifacts: () -> Unit,
    val onUpdateArtifactTags: (suspend (Artifact, List<String>) -> Artifact?)?,
    val owner: TaskOwner,
    val now: Long,
    val fields: TaskDetailFields,
    val needsYou: TaskNeedsYou,
    val blockers: List<Blocker>,
    val decisions: List<BoardDecision>,
    val questions: List<BoardQuestion>,
    val activity: BoardTaskActivity?,
    val liveNow: BoardTaskActivity?,
    val liveNews: LiveNewsActions?,
    val liveEnabled: Boolean,
    val staleReport: Boolean,
    val showNow: Boolean,
    val showNext: Boolean,
    val usage: UsageTaskResponse?,
    val record: TaskSheetRecordState,
    val status: TaskSheetStatus,
    val editing: Boolean,
    val onEditChange: (Boolean) -> Unit,
    val reply: TaskReplyState?,
    val onFocusReply: () -> Unit,
)

internal data class TaskSheetStatus(
    val title: String,
    val waitingEnabled: Boolean,
    val workDayStart: String,
    val saving: Boolean,
    val confirmDrop: Boolean,
    val waitingForm: Boolean,
    val problem: String?,
    val onChoose: (String) -> Unit,
    val onSet: (target: String, waitingFor: String?, waitUntil: String?) -> Unit,
    val onCancelDrop: () -> Unit,
    val onCancelWaiting: () -> Unit,
)

internal data class TaskSheetRecordState(
    val linksEnabled: Boolean,
    val timelineGroupsEnabled: Boolean,
    val deliveryEnabled: Boolean,
    val delivery: BoardTaskTimelineResponseDelivery?,
    val decided: List<DecidedRow>?,
    val now: ActivityNow?,
    val timeline: BoardTaskTimelineResponse?,
    val problem: String?,
    val feedbackBusy: Boolean,
    val onSetFeedback: (BoardFeedback, String) -> Unit,
    val onRetryTimeline: () -> Unit,
    val onTimelineKindsChanged: (List<String>?) -> Unit,
    val timelineNewestFirst: Boolean,
    val onToggleTimelineOrder: () -> Unit,
    val folds: Map<String, Boolean>,
    val onFoldChange: (TaskRecordRow, Boolean) -> Unit,
    val writerName: (BoardWriter) -> String,
)

@Composable
internal fun rememberTaskSheetState(
    context: ProjectScreenContext,
    task: BoardTask,
    view: BoardView,
    deviceSettings: DeviceSettings,
    wide: Boolean,
    previousTaskId: String?,
    bodyState: LazyListState,
    onDismiss: () -> Unit,
    designId: String,
    onSelectDesign: (String) -> Unit,
    onTaskSaved: (BoardTask) -> Unit,
): TaskSheetState {
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    val project = context.route.projectId
    val taskId = task.id
    val board = context.board
    val threads = if (connection.supports("threads")) panelData(context, "sheet-threads", { it is ThreadsStateEvent && it.projectId == project }) {
        context.backend.client.request(ThreadsListRequest(projectId = project, includeArchived = true)).threads
    }.value.orEmpty() else emptyList()
    val workers = if (connection.supports("workers")) panelData(context, "sheet-workers", { it is WorkersStateEvent && it.projectId == project }) {
        context.backend.client.request(WorkersListRequest(projectId = project)).workers
    }.value.orEmpty() else emptyList()
    val artifactFeed = if (connection.supports("artifacts")) panelData(context, "sheet-artifacts-$taskId", { it is ArtifactsChangedEvent && it.projectId == project && it.artifact.taskId == taskId }) {
        context.backend.client.request(ArtifactsListRequest(projectId = project, taskId = taskId)).artifacts
    } else null
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
    val fields = taskDetailFields(task, connection.supports(HarnessFeature.TASK_FIELDS))

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
                is SaveOutcome.Saved -> { waitingForm = false; onTaskSaved(outcome.task) }
                is SaveOutcome.Conflict -> problem = "${task.id} changed while you were looking. Check it and try again."
                is SaveOutcome.Failed -> problem = outcome.message
            }
            closing = false
        }
    }

    val taskUsage = rememberTaskUsage(context, taskId)

    val reply = if (editing) null else rememberTaskReply(context, task, owner, replyFocus)
    return TaskSheetState(
        context = context, task = task, tasks = view.tasks, archivedLinks = view.board?.archivedLinks.orEmpty(),
        previousTaskId = previousTaskId, previousTaskTitle = view.task(previousTaskId.orEmpty())?.title,
        wide = wide, bodyState = bodyState, designId = designId, onSelectDesign = onSelectDesign, onDismiss = onDismiss,
        threads = threads, workers = workers, artifacts = artifactFeed?.value.orEmpty(),
        artifactsProblem = artifactFeed?.error, onRetryArtifacts = { artifactFeed?.refresh?.trySend(Unit) },
        onUpdateArtifactTags = if (connection.supports(ARTIFACT_TAGS_FEATURE)) { artifact, tags ->
            context.backend.client.request(ArtifactsUpdateRequest(projectId = project, artifactId = artifact.id, tags = tags)).artifact
        } else null,
        owner = owner, now = now, fields = fields, needsYou = needsYou, blockers = blockers, decisions = decisions,
        questions = taskQuestions, activity = activity, liveNow = liveNow, liveNews = news, liveEnabled = liveEnabled,
        staleReport = staleReport, showNow = showNow, showNext = showNext, usage = taskUsage,
        record = TaskSheetRecordState(
            linksEnabled, timelineGroupsEnabled, deliveryEnabled, delivery, decided, recordNow, timeline, timelineProblem,
            feedbackBusy, ::setFeedback, { timelineRefresh++ }, { timelineKinds = it }, deviceSettings.timelineNewestFirst,
            { scope.launch { context.repository.setTimelineNewestFirst(!deviceSettings.timelineNewestFirst) } },
            deviceSettings.taskRecordFolds, { row, expanded -> scope.launch { context.repository.setTaskRecordFold(row, expanded) } },
            ::writerName,
        ),
        status = TaskSheetStatus(
            title = taskDetailState(task.status, needsYou, task.state?.kind), waitingEnabled = connection.supports("task-waiting"),
            workDayStart = deviceSettings.workDayStart, saving = closing, confirmDrop = confirmDrop, waitingForm = waitingForm,
            problem = problem,
            onChoose = { status ->
                confirmDrop = status == "dropped"
                waitingForm = status == "waiting"
                if (!confirmDrop && !waitingForm) setStatus(status)
            },
            onSet = ::setStatus, onCancelDrop = { confirmDrop = false }, onCancelWaiting = { waitingForm = false },
        ),
        editing = editing, onEditChange = { editing = it }, reply = reply,
        onFocusReply = { if (replyFocus.requestFocus()) keyboard?.show() },
    )
}
