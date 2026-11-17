package io.github.mitzacoder.kemiri.features.tasks.graph

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.request
import io.github.mitzacoder.kemiri.features.panels.panelData
import io.github.mitzacoder.kemiri.features.tasks.rememberTaskMinuteNow
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
fun TaskGraph(context: ProjectScreenContext, modifier: Modifier = Modifier, viewSwitch: @Composable () -> Unit, onLeave: () -> Unit) {
    val view by context.board.view.collectAsStateWithLifecycle()
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    val settings by context.repository.settings.collectAsStateWithLifecycle()
    val backend = context.backend.config.key
    val project = context.route.projectId
    val key = "$backend/$project"
    val mode = settings.graphMode(backend, project)
    val linkedTask by context.board.linkedTask.collectAsStateWithLifecycle()
    val workersRead = if (connection.supports("workers")) panelData(context, "graph-workers", { it is WorkersStateEvent && it.projectId == project }) {
        context.backend.client.request(WorkersListRequest(projectId = project)).workers
    } else null
    val threadsRead = if (connection.supports("threads")) panelData(context, "graph-threads", { it is ThreadsStateEvent && it.projectId == project }) {
        context.backend.client.request(ThreadsListRequest(projectId = project, includeArchived = true)).threads
    } else null
    val workers = workersRead?.value.orEmpty()
    val threads = threadsRead?.value.orEmpty()
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
    val graph = remember(view.tasks, view.questions, workers, threads, showClosed, showResting) {
        buildTaskGraph(view.tasks, view.questions, workers, threads, showClosed, showResting)
    }
    val folds = remember(graph, view.questions) { graphFoldGroups(graph, view.questions) }
    val shown = remember(graph, folds, mode, expandedFolds, showResting) { liveTaskGraph(graph, folds, mode, expandedFolds, showResting) }
    val counts = remember(graph) { graphCounts(graph) }
    val canvas = remember(key) { BubbleCanvasState(loadGraphCamera(settings, backend, project)) }
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
    NestedBackHandler(enabled = context.taskOrigin == null, depth = 50, parentLabel = "Graph") {
        when {
            viewOpen -> viewOpen = false
            restingOpen -> restingOpen = false
            else -> {
                val next = graphNavigateBack(GraphNavigation(sheet = sheetOpen, selected = selectedId, worker = workerSelection))
                if (next == null) onLeave() else { sheetOpen = next.sheet; selectedId = next.selected; workerSelection = next.worker }
            }
        }
    }
    Column(modifier.fillMaxSize()) {
        BubbleToolbar(viewSwitch, counts, mode, { next -> scope.launch { context.repository.setProjectGraphMode(backend, project, next) } },
            viewOpen, { viewOpen = it }, showClosed, { showClosed = !showClosed }, showResting, { showResting = !showResting },
            allLinks, { allLinks = !allLinks }, showLegend, { showLegend = !showLegend })
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
