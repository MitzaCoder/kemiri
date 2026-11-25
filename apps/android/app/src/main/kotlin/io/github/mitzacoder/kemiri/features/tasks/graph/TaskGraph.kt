package io.github.mitzacoder.kemiri.features.tasks.graph

import io.github.mitzacoder.kemiri.data.collectSettings
import io.github.mitzacoder.kemiri.data.projectWorkers
import io.github.mitzacoder.kemiri.data.projectThreads
import io.github.mitzacoder.kemiri.features.coordinators.*

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.request
import io.github.mitzacoder.kemiri.features.tasks.TaskSearchState
import io.github.mitzacoder.kemiri.features.tasks.rememberTaskMinuteNow
import io.github.mitzacoder.kemiri.features.tasks.taskSearchHits
import io.github.mitzacoder.kemiri.features.tasks.graph.bubble.*
import io.github.mitzacoder.kemiri.features.tasks.graph.bubble.graphFoldGroups
import io.github.mitzacoder.kemiri.features.tasks.graph.bubble.graphFoldExpansion
import io.github.mitzacoder.kemiri.navigation.NestedBackHandler
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TaskGraph(context: ProjectScreenContext, search: TaskSearchState, modifier: Modifier = Modifier, onLeave: (() -> Unit)?) {
    val view by context.board.view.collectAsStateWithLifecycle()
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    val backend = context.backend.config.key
    val project = context.route.projectId
    val key = "$backend/$project"
    val mode by context.repository.collectSettings(backend, project) { it.graphMode(backend, project) }
    val linkedTask by context.board.linkedTask.collectAsStateWithLifecycle()
    val workersRead = projectWorkers(context, connection.supports("workers"))
    val threadsRead = projectThreads(context, connection.supports("threads"))
    val coordinatorScope = LocalCoordinatorTaskScope.current
    val scopedTasks = coordinatorScope?.tasks(view.tasks) ?: view.tasks
    val scopedQuestions = coordinatorScope?.questions(view.questions) ?: view.questions
    val threads = threadsRead?.value?.threads.orEmpty().filter { coordinatorScope == null || coordinatorScope.includes(coordinatorOfThread(it.id, coordinatorScope.threads)) }
    val workers = workersRead?.value?.workers.orEmpty().filter { coordinatorScope == null || coordinatorScope.includes(coordinatorOfThread(it.threadId, coordinatorScope.threads)) }
    var selectedId by rememberSaveable(key) { mutableStateOf(linkedTask) }
    var workerSelection by rememberSaveable(key) { mutableStateOf<String?>(null) }
    var sheetOpen by rememberSaveable(key) { mutableStateOf(false) }
    var restingOpen by rememberSaveable(key) { mutableStateOf(false) }
    var showClosed by rememberSaveable(key) { mutableStateOf(false) }
    var showResting by rememberSaveable(key) { mutableStateOf(false) }
    var allLinks by rememberSaveable(key) { mutableStateOf(false) }
    var showLegend by rememberSaveable(key) { mutableStateOf(false) }
    var viewOpen by remember { mutableStateOf(false) }
    var expandedFolds by rememberSaveable(key) { mutableStateOf(emptySet<GraphFoldKind>()) }
    val searching = search.query.isNotBlank()
    val hits = taskSearchHits(context, search, scopedTasks, if (searching) scopedTasks.map { it.id }.toSet() else emptySet())
    val matchedIds = hits.map { it.id }.toSet()
    val graphTasks = if (searching) scopedTasks.filter { it.id in matchedIds } else scopedTasks
    val graph = remember(graphTasks, scopedQuestions, workers, threads, showClosed, showResting) {
        buildTaskGraph(graphTasks, scopedQuestions, workers, threads, showClosed, showResting)
    }
    val folds = remember(graph, view.questions) { graphFoldGroups(graph, view.questions) }
    val shown = remember(graph, folds, mode, expandedFolds, showResting) { liveTaskGraph(graph, folds, mode, expandedFolds, showResting) }
    val counts = remember(graph) { graphCounts(graph) }
    val canvas = remember(key) { BubbleCanvasState(loadGraphCamera(context.repository.settings.value, backend, project)) }
    val scope = rememberCoroutineScope()
    val motionBaseline = remember(key) { BubbleMotionBaseline() }
    var motionBatch by remember(key) { mutableStateOf(BubbleMotionBatch()) }
    val readsComplete = graphReadsComplete(connection.generation, view.generation, workersRead?.generation, threadsRead?.generation)
    LaunchedEffect(graph, workers, threads, readsComplete, connection.generation) {
        if (readsComplete) motionBatch = motionBaseline.read(graph, workers, threads, connection.generation)
    }
    LaunchedEffect(canvas) {
        snapshotFlow { canvas.camera }.filterNotNull().collectLatest { camera ->
            delay(180)
            context.repository.setProjectBubbleCamera(backend, project, camera)
        }
    }
    LaunchedEffect(linkedTask, folds) {
        if (linkedTask != null) {
            selectedId = linkedTask
            expandedFolds = graphFoldExpansion(graph, folds, revealGraphTask(folds, expandedFolds, linkedTask))
        }
    }
    fun openWorker(selection: String) {
        workerSelection = selection; sheetOpen = false; restingOpen = false
    }
    val graphNavigation = GraphNavigation(sheet = sheetOpen, selected = selectedId, worker = workerSelection)
    val previousGraphState = graphNavigateBack(graphNavigation)
    NestedBackHandler(enabled = context.taskOrigin == null && (viewOpen || restingOpen || previousGraphState != null || onLeave != null),
        depth = 50, parentLabel = "Graph") {
        when {
            viewOpen -> viewOpen = false
            restingOpen -> restingOpen = false
            else -> {
                if (previousGraphState == null) onLeave?.invoke()
                else { sheetOpen = previousGraphState.sheet; selectedId = previousGraphState.selected; workerSelection = previousGraphState.worker }
            }
        }
    }
    Column(modifier.fillMaxSize()) {
        BubbleToolbar(counts, mode, { next -> scope.launch { context.repository.setProjectGraphMode(backend, project, next) } },
            viewOpen, { viewOpen = it }, showClosed, { showClosed = !showClosed }, showResting, { showResting = !showResting },
            allLinks, { allLinks = !allLinks }, showLegend, { showLegend = !showLegend })
        if (searching && matchedIds.isEmpty()) Text("No tasks match your search.", style = MaterialTheme.typography.bodySmall)
        view.error?.let { Text(it, modifier = Modifier.padding(12.dp)) }
        BubbleCanvas(canvas, graph, shown, folds, mode, expandedFolds, { kind ->
            expandedFolds = if (kind in expandedFolds) graphFoldExpansion(graph, folds, expandedFolds, closing = kind)
                else graphFoldExpansion(graph, folds, expandedFolds + kind)
        }, selectedId?.let { "task:$it" }, allLinks, showLegend,
            graphMotionAllowed() && !sheetOpen && workerSelection == null && !restingOpen && !viewOpen,
            motionBatch, view.tasks, view.questions, { node ->
                if (node.kind == "task") { selectedId = node.task!!.id; sheetOpen = true }
                else node.worker?.let { openWorker(graphWorkerKey(it)) } ?: node.thread?.let { openWorker("thread:${it.id}") }
            }, { restingOpen = true }, Modifier.weight(1f))
    }
    val now = rememberTaskMinuteNow()
    if (sheetOpen && selectedId != null) GraphTaskSheet(context, selectedId!!, view.tasks, view.questions,
        workers, threads, now, connection.supports("task-activity"), connection.supports("task-freshness"),
        { sheetOpen = false }, context::openTask, ::openWorker,
        { sheetOpen = false; allLinks = true }, view.board?.archivedLinks.orEmpty())
    if (workerSelection != null) {
        val worker = workers.find { graphWorkerKey(it) == workerSelection }
        val thread = threads.find { "thread:${it.id}" == workerSelection }
        val models by context.backend.models.collectAsStateWithLifecycle()
        GraphWorkerSheet(worker?.id, worker?.threadId ?: thread?.id, workers, threads, view.tasks, view.questions,
            models, now, connection.supports("task-activity"), { workerSelection = null }, context::openTask,
            { workerId, threadId ->
                val target = workers.find { it.id == workerId && it.threadId == threadId }
                context.navigate(if (target != null) graphWorkerRoute(context.route, target)
                    else context.route.copy(workerId = workerId, threadId = threadId, highlight = null))
            },
            { threadId -> context.navigate(context.route.copy(threadId = threadId, workerId = null, highlight = null)) }, worker?.conversationId)
    }
    if (restingOpen) ModalBottomSheet(onDismissRequest = { restingOpen = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        GraphRestingSheet(shown.resting, view.tasks, view.questions, now) { openWorker(graphWorkerKey(it)) }
    }
}
