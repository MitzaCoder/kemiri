package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.data.collectSettings
import io.github.mitzacoder.kemiri.data.projectThreads
import io.github.mitzacoder.kemiri.features.coordinators.*

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.HarnessFeature
import io.github.mitzacoder.kemiri.data.familyExpansion
import io.github.mitzacoder.kemiri.data.request
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.theme.JetBrainsMono
import io.github.mitzacoder.kemiri.ui.theme.Text as TextStyles
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlin.math.roundToInt

/**
 * The project's tasks, the body of the panels' Tasks tab on a `task-reports` backend (web `TasksPanel.svelte`): every
 * task grouped by what it needs from the user (needs you, ready for review, blocked, working, to do, recently closed). A
 * row opens the task's sheet; the questions and warnings that name no task are answered right here. Decisions and
 * answered questions fold at the bottom.
 */
@Composable
internal fun TasksPanel(context: ProjectScreenContext, search: TaskSearchState, modifier: Modifier = Modifier) =
    LaterActionHost(context, modifier.fillMaxSize()) { TasksPanelContent(context, search) }

@Composable
private fun TasksPanelContent(context: ProjectScreenContext, search: TaskSearchState) {
    val colors = Jarvis.colors
    val board = context.board
    val view by board.view.collectAsStateWithLifecycle()
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    val project = context.route.projectId
    val backendKey = context.backend.config.key
    val expansion by context.repository.collectSettings(backendKey, project) { it.familyExpansion(backendKey, project) }
    val threads = projectThreads(context, connection.supports("threads"))?.value?.threads.orEmpty()
    val stateKey = "${context.backend.config.key}/$project"
    // Sections the user opened or folded against their default.
    var sectionExpansion by rememberSaveable(stateKey) { mutableStateOf(mapOf<String, Boolean>()) }
    var answeredOpen by rememberSaveable(stateKey) { mutableStateOf(false) }
    var decisionsOpen by rememberSaveable(stateKey) { mutableStateOf(false) }
    val taskList = rememberLazyListState()
    val searchResultsList = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val reducedMotion = rememberReducedMotion()
    val now = rememberTaskMinuteNow()

    val loadedBoard = view.board
    val coordinatorScope = LocalCoordinatorTaskScope.current
    val tasks = coordinatorScope?.tasks(view.tasks) ?: view.tasks
    val questions = coordinatorScope?.questions(view.questions) ?: view.questions
    val sections = if (loadedBoard == null) emptyList() else taskSections(filteredTasks(context, tasks), questions, includeArchived = view.showArchived)
    val searching = search.query.isNotBlank()
    val list = if (searching) searchResultsList else taskList
    val eligible = if (searching) sections.flatMap { it.rows }.filter { !isSettled(it.task.status) || sectionExpansion[TaskSectionId.Closed.name] == true }.map { it.task.id }.toSet() else emptySet()
    val searchHits = taskSearchHits(context, search, tasks, eligible)
    val searchRows = sections.flatMap { it.rows }.associateBy { it.task.id }
    val loose = if (loadedBoard == null) emptyList() else looseQuestions(loadedBoard.copy(tasks = tasks, questions = questions))
    val looseGroups = loose.groupBy { it.waitingOn == "agent" }
    val requestsOnly = connection.supports(HarnessFeature.REQUEST_ATTENTION)
    val partsByRequest = if (requestsOnly) taskSections(view.tasks, view.questions, includeArchived = view.showArchived)
        .flatMap { it.rows }.filter { it.task.parent != null }.groupBy { it.task.requestId ?: it.task.parent!! } else null
    val actions = LocalLaterActions.current
    val laterTasks = if (actions == null) emptyList() else filteredTasks(context, tasks).filter { it.parent == null && it.later != null && !it.archived }
        .sortedBy { it.later?.until }
    val laterQuestions = questions.filter { it.taskId == null && it.postponed == true && it.later != null }
    val familySections = if (searching) emptyList() else taskFamilySections(sections, requestsOnly).filter { it.id != TaskSectionId.Later }
    fun onLater(task: BoardTask): (() -> Unit)? = actions?.let { controller -> view.laterTarget(task)?.let { target -> { controller.open(target) } } }
    val needsYouSection = familySections.firstOrNull { it.id == TaskSectionId.NeedsYou }
    val failedTaskIds = (if (searching) searchHits.mapNotNull { searchRows[it.id] } else needsYouSection?.rows.orEmpty())
        .mapNotNull { row -> row.task.state?.takeIf { it.kind == "failed" }?.let { it.fromPartId ?: row.task.id } }.toSet()
    val failures = coordinatorScope?.roster.orEmpty().filter { coordinatorScope?.includes(it.id) == true }
        .flatMap { it.attentionFailures.orEmpty() }.filter { it.taskId !in failedTaskIds }
    val empty = view.loaded && tasks.isEmpty() && loose.isEmpty() && failures.isEmpty()
    // Error or empty messages and loose questions precede the first section.
    val needsYouIndex = familySections.indexOf(needsYouSection) +
        (if (view.error != null) 1 else 0) + (if (!view.loaded || empty) 1 else 0) + looseGroups.size
    var jumpToTask by remember(stateKey) { mutableStateOf<String?>(null) }
    var highlightedTask by remember(stateKey) { mutableStateOf<String?>(null) }
    var needsYouLayout by remember(stateKey) { mutableStateOf<LayoutCoordinates?>(null) }
    val needsYouRowLayouts = remember(stateKey) { mutableStateMapOf<String, LayoutCoordinates>() }
    LaunchedEffect(jumpToTask, needsYouSection, needsYouIndex, reducedMotion) {
        val id = jumpToTask ?: return@LaunchedEffect
        highlightedTask = null
        if (needsYouSection?.rows?.any { it.task.id == id && it.task.state?.group == "needs_you" } == true) {
            if (list.layoutInfo.visibleItemsInfo.none { it.key == "section-${TaskSectionId.NeedsYou.name}" }) {
                list.scrollToItem(needsYouIndex)
            }
            // The section is a single lazy item; align the actual nested row, not just its section heading.
            val layouts = withTimeoutOrNull(750) {
                snapshotFlow {
                    val sectionLayout = needsYouLayout?.takeIf { it.isAttached }
                    val rowLayout = needsYouRowLayouts[id]?.takeIf { it.isAttached }
                    if (sectionLayout != null && rowLayout != null) sectionLayout to rowLayout else null
                }.first { it != null }
            }
            if (layouts != null) {
                val (sectionLayout, rowLayout) = layouts
                val center = rowLayout.positionInRoot().y - sectionLayout.positionInRoot().y + rowLayout.size.height / 2f
                val offset = (center - list.layoutInfo.viewportSize.height / 2f).roundToInt()
                if (reducedMotion) list.scrollToItem(needsYouIndex, offset) else list.animateScrollToItem(needsYouIndex, offset)
                highlightedTask = id
                delay(1_200)
                highlightedTask = null
            }
        }
        jumpToTask = null
    }
    val answered = questions.filter { it.status == "answered" }
    val decisions = loadedBoard?.decisions.orEmpty()
    val requestRows = requestRows(tasks, requestsOnly)
    val archivedShown = if (view.showArchived) requestRows.count { it.archived } else 0

    LazyColumn(Modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        view.error?.let { error ->
            item(key = "error") {
                Text(error, Modifier.fillMaxWidth().background(colors.danger.copy(alpha = .1f), RoundedCornerShape(10.dp)).padding(10.dp), style = TaskType.xs, color = colors.danger)
            }
        }
        if (!view.loaded) {
            item(key = "skeleton") {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Box(Modifier.padding(horizontal = 4.dp).size(width = 96.dp, height = 14.dp).background(colors.surface2, RoundedCornerShape(4.dp)))
                    TaskGroup {
                        TaskRowSkeleton(.75f, .92f)
                        GroupHairline()
                        TaskRowSkeleton(.67f, .8f)
                        GroupHairline()
                        TaskRowSkeleton(.8f, .75f)
                    }
                }
            }
        } else if (empty) {
            item(key = "empty") {
                Text("The coordinator adds a task for each thing you bring up. You can also add one yourself.", Modifier.padding(horizontal = 4.dp), style = TextStyles.sm, color = colors.fgSubtle)
            }
        }
        looseGroups.forEach { (agentWaiting, questions) ->
            item(key = "loose-$agentWaiting") {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    SectionTitle(if (agentWaiting) "Waiting for the agent" else "Waiting for you", questions.size, accent = !agentWaiting)
                    questions.forEach { question ->
                        key(question.id) {
                            QuestionCard(
                                context, question,
                                askedBy = questionAskedBy(question, threads),
                                taskLabel = questionTaskLabel(question, view::task),
                                onOpenTask = question.taskId?.let { id -> { context.openTask(id) } },
                            )
                        }
                    }
                }
            }
        }
        if (searching) item(key = "search-results") {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(checked = sectionExpansion[TaskSectionId.Closed.name] == true, onCheckedChange = { sectionExpansion = sectionExpansion + (TaskSectionId.Closed.name to it) })
                    Text("Show closed", style = TaskType.xs)
                }
                Text("${searchHits.count { !it.context }} matching tasks", style = TaskType.xs, color = colors.fgSubtle)
                if (searchHits.isEmpty()) Text("No tasks match your search.", style = TaskType.xs, color = colors.fgMuted)
                CompositionLocalProvider(LocalTaskSearchHits provides searchHits.associateBy { it.id }) {
                    TaskGroup {
                        searchHits.forEachIndexed { index, hit -> searchRows[hit.id]?.let { row ->
                            if (index > 0) GroupHairline()
                            TaskListRow(TaskFamily(row, TaskFamilyRole.Task, emptyList(), false, true, 0), now, reducedMotion, connection.supports("task-links"), false, loadedBoard?.archivedLinks.orEmpty(), {}, requestView = requestsOnly) { context.openTask(hit.id) }
                        } }
                    }
                }
            }
        }
        if (needsYouSection == null && failures.isNotEmpty()) item(key = "standalone-failures") {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                SectionTitle("Needs you", failures.size, accent = true)
                TaskGroup { FailureRows(context, failures) }
            }
        }
        val laterIndex = familySections.indexOfFirst { it.id in setOf(TaskSectionId.Todo, TaskSectionId.Closed, TaskSectionId.Blocked, TaskSectionId.Review) }
            .takeIf { it >= 0 } ?: familySections.size
        fun LazyListScope.laterGroup() {
            if (actions != null && !searching && (laterTasks.isNotEmpty() || laterQuestions.isNotEmpty())) item(key = "later-group") {
                key(stateKey) { LaterGroup(context, view, laterTasks, laterQuestions) }
            }
        }
        familySections.forEachIndexed { index, section ->
            if (index == laterIndex) laterGroup()
            val open = sectionExpansion[section.id.name] ?: familySectionStartsOpen(section)
            val families = taskFamilies(section, expansion, partsByRequest)
            item(key = "section-${section.id.name}") {
                val needsYou = section.id == TaskSectionId.NeedsYou
                val sectionModifier = if (needsYou) Modifier.onGloballyPositioned { needsYouLayout = it } else Modifier
                Column(sectionModifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (section.collapsedByDefault) FoldHeading(section.label, open, onToggle = {
                        sectionExpansion = sectionExpansion + (section.id.name to !open)
                    }, count = taskFamilyCount(section, requestsOnly), chevronFirst = false, style = TaskType.sectionTitle)
                    else SectionTitle(section.label, taskFamilyCount(section, requestsOnly) + if (needsYou) failures.size else 0, accent = needsYou)
                    if (open) TaskGroup {
                        val previewTask = LocalPreviewTaskId.current
                        CompositionLocalProvider(LocalPreviewTaskId provides (highlightedTask.takeIf { needsYou } ?: previewTask)) {
                            TaskFamilyRows(
                                families.map { TaskFamilyBranch(it, visible = true) }, now, reducedMotion,
                                connection.supports("task-links"), loadedBoard?.archivedLinks.orEmpty(),
                                onToggle = { family -> scope.launch {
                                    context.repository.setTaskFamilyExpanded(context.backend.config.key, project, family.row.task.id, !family.expanded)
                                } }, onOpen = context::openTask, onJump = { jumpToTask = it },
                                onRowLayout = if (needsYou) ({ id, layout ->
                                    if (layout == null) needsYouRowLayouts.remove(id) else needsYouRowLayouts[id] = layout
                                }) else null,
                                shown = sections.flatMap { it.rows }.map { it.task.id }.toSet(),
                                requestQuestions = view.questions.takeIf { requestsOnly }, onOpenAttention = { context.openTask(it.taskId, it.questionId) },
                                onLater = if (needsYou) ::onLater else { _ -> null },
                            )
                        }
                        if (needsYou && failures.isNotEmpty()) {
                            GroupHairline()
                            FailureRows(context, failures)
                        }
                    }
                }
            }
        }
        if (laterIndex == familySections.size) laterGroup()
        if (view.loaded) item(key = "archived") {
            Row(
                Modifier.clip(RoundedCornerShape(8.dp)).clickable(role = Role.Switch) { scope.launch { board.setShowArchived(!view.showArchived) } }
                    .heightIn(min = 40.dp).padding(horizontal = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                LucideGlyph(Lucide.Archive, size = 14.dp, tint = colors.fgSubtle)
                Text(if (view.showArchived) "Hide archived${if (archivedShown > 0) " ($archivedShown)" else ""}" else "Show archived", style = TaskType.xs, color = colors.fgSubtle)
            }
        }
        if (answered.isNotEmpty()) item(key = "answered") {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                FoldHeading("Answered", answeredOpen, onToggle = { answeredOpen = !answeredOpen }, count = answered.size)
                if (answeredOpen) answered.forEach { question ->
                    FoldedCard {
                        Text(question.id, style = TaskType.xs, fontFamily = JetBrainsMono, color = colors.fgSubtle)
                        BoardMarkdown(question.text)
                        BoardMarkdown(question.answer.orEmpty(), Modifier.padding(top = 2.dp))
                    }
                }
            }
        }
        if (decisions.isNotEmpty()) item(key = "decisions") {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                FoldHeading("Decisions", decisionsOpen, onToggle = { decisionsOpen = !decisionsOpen }, count = decisions.size)
                if (decisionsOpen) decisions.forEach { decision -> DecisionCard(decision, now, withTask = true) }
            }
        }
        // Last: below every task, the answered questions and the decisions.
        if (view.loaded) item(key = "loose-workers") { LooseWorkers(context, view.tasks) }
        if (coordinatorScope != null) item(key = "coordinator-footer") { CoordinatorTasksFooter(context) }
    }
}

@Composable
private fun FailureRows(context: ProjectScreenContext, failures: List<AttentionFailure>) {
    val scope = rememberCoroutineScope()
    var dismissing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf(false) }
    failures.forEachIndexed { index, failure ->
        if (index > 0) GroupHairline()
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            val label = when (failure.kind) {
                "worker" -> "A worker failed"
                "job" -> "A job failed"
                else -> "A coordinator failed"
            }
            Row(Modifier.weight(1f).heightIn(min = 48.dp).clickable(role = Role.Button) {
                context.navigate(coordinatorRoute(context.route, failure.threadId).copy(workerId = failure.workerId))
            }, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                LucideGlyph(TaskIcons.TriangleAlert, size = 16.dp, tint = Jarvis.colors.fgMuted)
                Text("$label: ${failure.title}", style = MaterialTheme.typography.bodyMedium)
            }
            TextButton(enabled = !dismissing, onClick = {
                dismissing = true
                error = false
                scope.launch {
                    try { context.backend.client.request(ThreadsAcknowledgeFailureRequest(projectId = context.route.projectId, failureId = failure.id)) }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { error = true }
                    finally { dismissing = false }
                }
            }) { Text("Dismiss") }
        }
    }
    if (error) Text("Could not dismiss the failure. Try again.", Modifier.padding(8.dp), color = Jarvis.colors.danger)
}

/** Fold quiet branches independently so pinned parts never disappear during the transition. */
@Composable
private fun TaskFamilyRows(
    branches: List<TaskFamilyBranch>, now: Long, reducedMotion: Boolean, linksEnabled: Boolean,
    archived: List<BoardTaskBrief>, onToggle: (TaskFamily) -> Unit, onOpen: (String) -> Unit,
    onJump: (String) -> Unit, onRowLayout: ((String, LayoutCoordinates?) -> Unit)?, depth: Int = 0, shown: Set<String> = emptySet(),
    requestQuestions: List<BoardQuestion>? = null, onOpenAttention: (RequestAttention) -> Unit,
    onLater: (BoardTask) -> (() -> Unit)?,
) {
    val guide = Jarvis.colors.border
    val firstVisible = branches.indexOfFirst { it.visible }
    Column {
        branches.forEachIndexed { index, branch ->
            val family = branch.family
            val id = family.row.task.id
            key(id) {
                val rowContent: @Composable () -> Unit = {
                    // The first visible part has no separator above it.
                    if (index > firstVisible.coerceAtLeast(0)) GroupHairline()
                    when (family.role) {
                        TaskFamilyRole.ParentHeader -> TaskParentHeaderRow(family.row) { onOpen(id) }
                        TaskFamilyRole.Pointer -> TaskPointerRow(family, onOpen = { onOpen(id) }, onJump = { onJump(id) }, onToggle = { onToggle(family) })
                        TaskFamilyRole.Task -> {
                            val rowModifier = if (onRowLayout == null) Modifier else {
                                DisposableEffect(id) { onDispose { onRowLayout(id, null) } }
                                Modifier.onGloballyPositioned { onRowLayout(id, it) }
                            }
                            val attention = requestQuestions?.takeIf { depth == 0 }?.let { requestAttention(family.row.task, it) }
                            TaskListRow(family, now, reducedMotion, linksEnabled, depth > 0, archived, { onToggle(family) },
                                rowModifier, attention, requestView = requestQuestions != null, onLater = onLater(family.row.task)) {
                                if (attention == null) onOpen(id) else onOpenAttention(attention)
                            }
                        }
                    }
                    TaskCoordinatorMark(family.row.task)
                    if (requestQuestions == null) ExternalTaskFamily(family.row.task, shown, onOpen, showParts = family.role != TaskFamilyRole.Pointer)
                    if (family.branches.isNotEmpty() || family.doneParts > 0) Box(
                        Modifier.padding(start = if (depth < 3) 14.dp else 0.dp)
                            .drawBehind { drawLine(guide, Offset.Zero, Offset(0f, size.height), strokeWidth = 1.dp.toPx()) },
                    ) {
                        Column {
                            TaskFamilyRows(family.branches, now, reducedMotion, linksEnabled, archived, onToggle, onOpen, onJump,
                                onRowLayout, depth + 1, shown, requestQuestions, onOpenAttention, onLater)
                            if (family.doneParts > 0) {
                                if (family.branches.isNotEmpty()) GroupHairline()
                                Text("✓ ${family.doneParts} done ${if (family.doneParts == 1) "part" else "parts"}",
                                    Modifier.padding(start = 12.dp, top = 8.dp, bottom = 8.dp), style = TaskType.xs, color = Jarvis.colors.fgMuted)
                            }
                        }
                    }
                }
                if (depth == 0 || reducedMotion) {
                    if (branch.visible) rowContent()
                } else AnimatedVisibility(
                    visible = branch.visible,
                    enter = expandVertically(tween(160), expandFrom = Alignment.Top) + fadeIn(tween(160)),
                    exit = shrinkVertically(tween(160), shrinkTowards = Alignment.Top) + fadeOut(tween(160)),
                ) { Column { rowContent() } }
            }
        }
    }
}

/** A section's title with its count, in the accent when it needs the user. */
@Composable
internal fun SectionTitle(title: String, count: Int? = null, accent: Boolean = false) {
    val colors = Jarvis.colors
    Row(Modifier.padding(horizontal = 4.dp).semantics { heading() }, horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = TaskType.sectionTitle, color = if (accent) colors.accent2 else colors.fgMuted)
        count?.let { CountPill(it, accent) }
    }
}

/** A section's rows as one inset-grouped card, split by hairlines that start where the text does. */
@Composable
internal fun TaskGroup(content: @Composable ColumnScope.() -> Unit) {
    val colors = Jarvis.colors
    val shape = RoundedCornerShape(14.dp)
    Column(
        Modifier.fillMaxWidth().clip(shape).background(colors.surface.copy(alpha = .55f)).border(1.dp, colors.border.copy(alpha = .8f), shape),
        content = content,
    )
}

@Composable
internal fun GroupHairline() = HorizontalDivider(Modifier.padding(start = 36.dp), color = Jarvis.colors.border.copy(alpha = .85f))

@Composable
internal fun FoldedCard(content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(12.dp)
    Column(Modifier.fillMaxWidth().border(1.dp, Jarvis.colors.border.copy(alpha = .6f), shape).padding(horizontal = 10.dp, vertical = 8.dp), content = content)
}

/** A decision: its ID and text, why, and when (with the task it is about, in the list). */
@Composable
internal fun DecisionCard(decision: BoardDecision, now: Long, withTask: Boolean) {
    val colors = Jarvis.colors
    FoldedCard {
        Text(decision.id, style = TaskType.xs, fontFamily = JetBrainsMono, color = colors.fgSubtle)
        BoardMarkdown(decision.text)
        decision.why?.takeIf { it.isNotBlank() }?.let { BoardMarkdown(it, Modifier.padding(top = 4.dp)) }
        Text(
            listOfNotNull(decision.taskId?.takeIf { withTask }, relativeTime(decision.at, now)).joinToString(" · "),
            Modifier.padding(top = 2.dp), style = TaskType.meta, color = colors.fgSubtle,
        )
    }
}
