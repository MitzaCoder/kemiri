package io.github.mitzacoder.kemiri.features.tasks.graph

import io.github.mitzacoder.kemiri.navigation.NestedBackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.ConnectionStatus
import io.github.mitzacoder.kemiri.data.request
import io.github.mitzacoder.kemiri.features.panels.panelData
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.launch

private val graphSessions = java.util.WeakHashMap<Any, GraphLive>()
@Composable
fun TaskGraph(context: ProjectScreenContext, modifier: Modifier = Modifier, viewSwitch: @Composable () -> Unit, onLeave: () -> Unit) {
    MaterialTheme(colorScheme = MaterialTheme.colorScheme.copy(primary = Jarvis.colors.fgMuted, onPrimary = Jarvis.colors.bg)) {
        TaskGraphContent(context, modifier, viewSwitch, onLeave)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TaskGraphContent(context: ProjectScreenContext, modifier: Modifier, viewSwitch: @Composable () -> Unit, onLeave: () -> Unit) {
    val view by context.board.view.collectAsStateWithLifecycle()
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    val project = context.route.projectId
    val settings by context.repository.settings.collectAsStateWithLifecycle()
    val mode = settings.graphMode(context.backend.config.key, project)
    val linkedTask by context.board.linkedTask.collectAsStateWithLifecycle()
    val workersRead = if (connection.supports("workers")) panelData(context, "graph-workers", { it is WorkersStateEvent && it.projectId == project }) {
        context.backend.client.request(WorkersListRequest(projectId = project)).workers
    } else null
    val threadsRead = if (connection.supports("threads")) panelData(context, "graph-threads", { it is ThreadsStateEvent && it.projectId == project }) {
        context.backend.client.request(ThreadsListRequest(projectId = project, includeArchived = true)).threads
    } else null
    val workers = workersRead?.value.orEmpty(); val threads = threadsRead?.value.orEmpty()
    val live = remember(context.board) { graphSessions.getOrPut(context.board) { GraphLive() } }
    val now = graphDisplayTime(live)
    val motion = graphMotionAllowed()
    val model = remember(view.tasks, view.questions, workers, threads, now / 30_000) { buildGraphModel(view.tasks, view.questions, workers, threads, now) }
    val snapshot = remember(view.tasks, view.questions, workers, threads) { graphSnapshot(view.tasks, view.questions, workers, threads) }
    val authoritative = connection.status == ConnectionStatus.Ready && graphReadsComplete(connection.generation, view.generation, workersRead?.generation, threadsRead?.generation)
    LaunchedEffect(snapshot, authoritative, connection.generation) {
        if (authoritative) live.read(snapshot, connection.generation, System.currentTimeMillis()) else live.disconnected()
    }
    DisposableEffect(live) { onDispose { live.disconnected() } }
    val key = "${context.backend.config.key}/$project"
    var familyId by rememberSaveable(key) { mutableStateOf<String?>(null) }
    var selectedId by rememberSaveable(key) { mutableStateOf(linkedTask) }
    var workerSelection by rememberSaveable(key) { mutableStateOf<String?>(null) }
    var sheetOpen by rememberSaveable(key) { mutableStateOf(false) }
    var highlight by rememberSaveable(key) { mutableStateOf<String?>(null) }
    var showClosed by rememberSaveable(key) { mutableStateOf(false) }
    var searchOpen by rememberSaveable(key) { mutableStateOf(false) }
    var pickerOpen by rememberSaveable(key) { mutableStateOf(false) }
    var changesOpen by rememberSaveable(key) { mutableStateOf(false) }
    var restingOpen by rememberSaveable(key) { mutableStateOf(false) }
    var canvas by rememberSaveable(key) { mutableStateOf(false) }
    var query by rememberSaveable(key) { mutableStateOf("") }
    var scrollTo by rememberSaveable(key) { mutableStateOf<String?>(null) }
    val canvasState = remember(key) { GraphCanvasState() }
    val families = remember(model, showClosed, selectedId, live.linger.keys.toSet()) { model.families(showClosed, selectedId, live.linger.keys.toSet()) }
    val allTaskIds = families.flatMap { it.cards }.map { it.id }.toSet()
    val folds = remember(model, allTaskIds) { graphFoldGroups(model, allTaskIds) }
    var expandedFolds by remember(key) { mutableStateOf(emptySet<GraphFoldKind>()) }
    var pendingReveal by remember(key) { mutableStateOf(selectedId) }
    LaunchedEffect(folds, pendingReveal) {
        if (pendingReveal in model.details) {
            expandedFolds = graphFoldExpansion(model, folds, revealGraphTask(folds, expandedFolds, pendingReveal))
            pendingReveal = null
        }
    }
    LaunchedEffect(linkedTask) { if (linkedTask != null) pendingReveal = linkedTask }
    val shownTaskIds = graphShownTaskIds(model, allTaskIds, folds, mode, expandedFolds)
    val resting = model.restingWorkers(shownTaskIds)
    val family = families.find { it.id == familyId } ?: families.find { it.id == initialGraphFamily(families, selectedId?.let(model.details::get)) }
    val scope = rememberCoroutineScope(); val list = rememberLazyListState(); val colors = Jarvis.colors
    LaunchedEffect(family?.id, authoritative) { if (familyId == null && family != null && authoritative) familyId = family.id }
    LaunchedEffect(changesOpen, live.serial) { if (changesOpen) live.markSeen() }
    fun select(id: String) {
        expandedFolds = graphFoldExpansion(model, folds, revealGraphTask(folds, expandedFolds, id))
        selectedId = id; model.details[id]?.let { familyId = it.familyId }
        sheetOpen = true; scrollTo = id; searchOpen = false; changesOpen = false
    }
    fun switchFamily(id: String) {
        families.find { it.id == id }?.cards?.firstOrNull()?.id?.let { taskId ->
            expandedFolds = graphFoldExpansion(model, folds, revealGraphTask(folds, expandedFolds, taskId))
        }
        familyId = id; scope.launch { list.scrollToItem(0) }
    }
    fun toggleFold(kind: GraphFoldKind) {
        expandedFolds = if (kind in expandedFolds) graphFoldExpansion(model, folds, expandedFolds, closing = kind)
            else graphFoldExpansion(model, folds, expandedFolds + kind)
    }
    fun enterCanvas(pinch: Boolean = false) { canvasState.entryZoom = if (pinch) .80f else 1f; canvasState.camera = null; canvas = true }
    LaunchedEffect(scrollTo, family?.id, canvas) {
        val index = family?.cards?.indexOfFirst { it.id == scrollTo } ?: -1
        if (!canvas && index >= 0) { list.scrollToItem(index + 2); scrollTo = null }
    }
    fun openWorker(selection: String) {
        workerSelection = selection; sheetOpen = false; restingOpen = false
    }
    NestedBackHandler(enabled = context.taskOrigin == null, depth = 50, parentLabel = "Graph") {
        when {
            searchOpen -> searchOpen = false
            pickerOpen -> pickerOpen = false
            changesOpen -> changesOpen = false
            restingOpen -> restingOpen = false
            else -> {
                val next = graphNavigateBack(GraphNavigation(sheetOpen, selectedId, highlight, canvas, workerSelection))
                if (next == null) onLeave() else { sheetOpen = next.sheet; selectedId = next.selected; highlight = next.highlight; canvas = next.canvas; workerSelection = next.worker }
            }
        }
    }
    Box(modifier.fillMaxSize()) {
        val decorativeMotion = motion && !searchOpen && !changesOpen && !pickerOpen && !restingOpen && workerSelection == null && !sheetOpen
        Row(Modifier.fillMaxSize()) {
            Column(Modifier.weight(1f).fillMaxHeight()) {
                GraphChrome(viewSwitch, model, highlight, { highlight = it }, { searchOpen = true }, { changesOpen = true }, live.unseen,
                    showClosed, { showClosed = !showClosed }, canvas, { if (canvas) canvas = false else enterCanvas() },
                    connection.status.name, live.lastDataAt, now, resting.size, { restingOpen = true })
                GraphFoldControls(mode, { next -> scope.launch { context.repository.setProjectGraphMode(context.backend.config.key, project, next) } },
                    folds, expandedFolds, ::toggleFold)
                view.error?.let { Text(it, color = colors.fg) }
                if (highlight != null) {
                    val matching = families.filter { f -> f.cards.any { model.matches(it.id, highlight) } }
                    if (matching.isEmpty()) Text("No matches. Try another counter or Show closed.", color = colors.fg)
                    else TextButton(onClick = { val index = matching.indexOfFirst { it.id == family?.id }; switchFamily(matching[(index + 1) % matching.size].id); canvas = false }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Next family with a match (${matching.size})") }
                }
                if (canvas) GraphCanvas(canvasState, model, families, family?.id, selectedId, highlight, live, now, decorativeMotion, shownTaskIds, ::select, { switchFamily(it); canvas = false }, { taskId, crewId -> model.crewSelection(taskId, crewId)?.let(::openWorker) }, Modifier.weight(1f))
                else LazyColumn(Modifier.weight(1f).fillMaxWidth().graphPinchOut { enterCanvas(true) }.semantics { isTraversalGroup = true }, state = list,
                    contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    item(key = "switcher") {
                        if (families.isNotEmpty()) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            val index = families.indexOfFirst { it.id == family?.id }.coerceAtLeast(0)
                            TextButton(onClick = { switchFamily(families[(index - 1 + families.size) % families.size].id) }, modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).semantics { contentDescription = "Previous family" }) { Text("‹") }
                            TextButton(onClick = { pickerOpen = true }, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text("Family ${index + 1} of ${families.size} ▾") }
                            TextButton(onClick = { switchFamily(families[(index + 1) % families.size].id) }, modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).semantics { contentDescription = "Next family" }) { Text("›") }
                        }
                    }
                    item(key = "family-header") {
                        when {
                            !view.loaded -> { CircularProgressIndicator(); Text("Loading tasks…", color = colors.fg) }
                            model.details.isEmpty() -> Text("No tasks yet. Use List to add work or answer unassigned questions.", color = colors.fg)
                            family == null -> Text("All tasks are closed. Show closed to read them.", color = colors.fg)
                            else -> GraphFamilyHeader(family, model)
                        }
                    }
                    if (family != null && family.cards.none { it.id in shownTaskIds }) item(key = "folded-family") {
                        Text("This family is folded in Live. Open a chip above or choose All to show it.", color = colors.fg, modifier = Modifier.padding(12.dp))
                    }
                    items(family?.cards.orEmpty().filter { it.id in shownTaskIds }, key = { it.id }) { card ->
                        val d = model.details.getValue(card.id)
                        GraphTaskCard(d, card.depth, selectedId == card.id, model.matches(card.id, highlight), model.holdsUp(card.id).total, now,
                            live.glows[card.id]?.let { it > now } == true, decorativeMotion, live.reports.keys,
                            graphLoopingWorkers(family?.cards.orEmpty().flatMap { c ->
                                graphTaskCrew(model.details.getValue(c.id)).take(3).map { GraphMotionCandidate(it.id, it.state, list.layoutInfo.visibleItemsInfo.any { item -> item.key == c.id }) }
                            }, 1f, decorativeMotion), { crewId -> model.crewSelection(card.id, crewId)?.let(::openWorker) }) { select(card.id) }
                    }
                    item(key = "overview") { TextButton(onClick = { enterCanvas() }, modifier = Modifier.heightIn(min = 48.dp)) { Text("All families") } }
                }
            }
        }
    }
    if (sheetOpen && selectedId != null) GraphTaskSheet(context, selectedId!!, view.tasks, view.questions,
        workers, threads, now, connection.supports("task-activity"), connection.supports("task-freshness"),
        { sheetOpen = false }, context::openTask, ::openWorker,
        { sheetOpen = false; context.board.showWithLinked(selectedId!!); onLeave() }, view.board?.archivedLinks.orEmpty())
    if (workerSelection != null) {
        val worker = workers.find { graphWorkerKey(it) == workerSelection }
        val thread = threads.find { "thread:${it.id}" == workerSelection }
        val models by context.backend.models.collectAsStateWithLifecycle()
        GraphWorkerSheet(worker?.id, worker?.threadId ?: thread?.id, workers, threads, view.tasks, view.questions,
            models, now, connection.supports("task-activity"), { workerSelection = null }, context::openTask,
            { workerId, threadId -> context.navigate(context.route.copy(workerId = workerId, threadId = threadId, highlight = null)) },
            { threadId -> context.navigate(context.route.copy(threadId = threadId, workerId = null, highlight = null)) }, worker?.conversationId)
    }
    if (restingOpen) ModalBottomSheet(onDismissRequest = { restingOpen = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        GraphRestingSheet(resting, model, now, { worker ->
            openWorker(graphWorkerKey(worker))
        })
    }
    if (searchOpen) GraphSearchDialog(model, query, { query = it }, ::select, { searchOpen = false })
    if (changesOpen) GraphChangesDialog(live.entries, now, ::select, { changesOpen = false })
    if (pickerOpen) AlertDialog(onDismissRequest = { pickerOpen = false }, title = { Text("Choose family") }, text = {
        LazyColumn { items(families, key = { it.id }) { f -> TextButton(onClick = { switchFamily(f.id); pickerOpen = false }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("${f.title} · ${f.needsYou} need you") } } }
    }, confirmButton = { TextButton(onClick = { pickerOpen = false }) { Text("Close") } })
}
