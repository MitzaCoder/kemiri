package io.github.mitzacoder.kemiri.navigation

import io.github.mitzacoder.kemiri.features.coordinators.*

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.features.chat.*
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.components.StatusBadge
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

internal const val MAIN_CHAT_DESCRIPTION = "You talk here. It hands big jobs to the background and reports back."

internal data class ConversationChoice(val id: String, val title: String, val current: Boolean, val thread: ThreadSummary? = null, val folded: Boolean = false)

/** Selection changes only the marker, never the membership or ordering of the list. */
internal fun conversationChoices(threads: List<ThreadSummary>, currentThreadId: String?, now: Long): List<ConversationChoice> =
    listOf(ConversationChoice(MAIN_THREAD_ID, "Main chat", currentThreadId == null || currentThreadId == MAIN_THREAD_ID)) +
        orderedBackgroundJobs(threads.filterNot { it.archived }).map {
            ConversationChoice(it.id, it.title, it.id == currentThreadId, it, foldFinishedJob(it, now))
        }

/** Null means dismiss only. The caller uses the normal push navigation, not replace or Up. */
internal fun conversationChoiceDestination(route: Destination.Chat, id: String): Destination.Chat? {
    if ((route.threadId ?: MAIN_THREAD_ID) == id) return null
    return route.copy(threadId = id.takeUnless { it == MAIN_THREAD_ID }, workerId = null, highlight = null)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ConversationSwitcher(context: ProjectScreenContext, threads: List<ThreadSummary>, now: Long, onCoordinatorPage: (String) -> Unit, dismiss: () -> Unit) {
    val board by context.board.view.collectAsStateWithLifecycle()
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    if (connection.supports("coordinators")) {
        CoordinatorSwitcher(context, threads, now, onCoordinatorPage, dismiss)
        return
    }
    val choices = conversationChoices(threads, context.route.threadId, now)
    var expanded by rememberSaveable { mutableStateOf(false) }
    val folded = choices.filter { it.folded }
    fun choose(choice: ConversationChoice) {
        dismiss()
        conversationChoiceDestination(context.route, choice.id)?.let(context.navigate)
    }
    ModalBottomSheet(onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Jarvis.colors.surface) {
        LazyColumn(Modifier.fillMaxWidth(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item(key = "main") { ConversationChoiceRow(choices.first(), MAIN_CHAT_DESCRIPTION) { choose(choices.first()) } }
            item(key = "heading") { Text("Background jobs", Modifier.padding(horizontal = 24.dp, vertical = 16.dp).semantics { heading() }, style = MaterialTheme.typography.titleSmall) }
            items(choices.drop(1).filterNot { it.folded }, key = { it.id }) { choice ->
                ConversationChoiceRow(choice, threadStateLine(choice.thread!!, board.questions, now)) { choose(choice) }
            }
            if (folded.isNotEmpty()) {
                item(key = "finished") {
                    TextButton(onClick = { expanded = !expanded }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }) {
                        Text("Finished (${folded.size}) ${if (expanded) "▴" else "▾"}" + if (!expanded && folded.any { it.current }) " · You are here" else "")
                    }
                }
                if (expanded) items(folded, key = { it.id }) { choice ->
                    ConversationChoiceRow(choice, threadStateLine(choice.thread!!, board.questions, now)) { choose(choice) }
                }
            }
            item(key = "all") {
                TextButton(onClick = { dismiss(); context.navigate(Destination.Panel(context.route, PanelTab.Threads)) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("All background jobs") }
            }
        }
    }
}

@Composable
private fun ConversationChoiceRow(choice: ConversationChoice, line: String, choose: () -> Unit) {
    Column(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(role = Role.Button, onClickLabel = "Switch conversation", onClick = choose)
        .semantics(mergeDescendants = true) { selected = choice.current }.padding(horizontal = 24.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(choice.title, style = MaterialTheme.typography.titleMedium)
        choice.thread?.let { StatusBadge(threadState(it), domain = "thread") }
        if (line.isNotBlank()) Text(line, style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted)
        if (choice.current) Text("You are here", style = MaterialTheme.typography.labelSmall, color = Jarvis.colors.accent2)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CoordinatorSwitcher(context: ProjectScreenContext, threads: List<ThreadSummary>, now: Long, openPage: (String) -> Unit, dismiss: () -> Unit) {
    val roster = coordinatorRoster(threads)
    val board by context.board.view.collectAsStateWithLifecycle()
    val settings = LocalContext.current
    val openId = context.route.threadId ?: MAIN_THREAD_ID
    var expandedFinished by rememberSaveable { mutableStateOf(emptyList<String>()) }
    var editingArea by rememberSaveable { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val openCoordinator = roster.find { it.id == openId }
    if (editingArea && openCoordinator != null) {
        CoordinatorEditor(context, openCoordinator, dismiss = { editingArea = false }, areaOnly = true)
        return
    }
    val jobsByCoordinator = remember(threads) {
        orderedBackgroundJobs(threads.filter { it.kind != "coordinator" && !it.archived })
            .groupBy { it.parentThreadId ?: MAIN_THREAD_ID }
    }
    fun choose(id: String) {
        dismiss()
        conversationChoiceDestination(context.route, id)?.let(context.navigate)
    }
    ModalBottomSheet(onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Jarvis.colors.surface) {
        Column(Modifier.fillMaxWidth()) {
            Text("Coordinators", Modifier.padding(start = 20.dp, end = 20.dp, bottom = 8.dp).semantics { heading() }, style = MaterialTheme.typography.titleLarge)
            LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = false), state = listState,
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                roster.forEach { coordinator ->
                    val isOpen = coordinator.id == openId
                    item(key = coordinator.id) {
                        val badges = coordinatorBadges(coordinator, if (isOpen) Long.MAX_VALUE else coordinatorSeen(context.route, coordinator.id))
                        CoordinatorSheetRow(coordinator, badges, isOpen, editArea = if (isOpen) ({ editingArea = true }) else null) { choose(coordinator.id) }
                    }
                    val (finished, live) = jobsByCoordinator[coordinator.id].orEmpty().partition(::isFinishedBackgroundJob)
                    items(live, key = { it.id }) { job ->
                        CoordinatorJobRow(job, job.id == openId, board.questions, now) { choose(job.id) }
                    }
                    if (finished.isNotEmpty()) {
                        val expanded = coordinator.id in expandedFinished
                        item(key = "finished:${coordinator.id}") {
                            TextButton(onClick = {
                                expandedFinished = if (expanded) expandedFinished - coordinator.id else expandedFinished + coordinator.id
                            }, modifier = Modifier.padding(start = 16.dp).heightIn(min = 48.dp).semantics {
                                stateDescription = if (expanded) "Expanded" else "Collapsed"
                            }) {
                                LucideGlyph(if (expanded) Lucide.ChevronDown else Lucide.ChevronRight, size = 14.dp)
                                Spacer(Modifier.width(6.dp))
                                Text("Finished ${finished.size}")
                                if (!expanded && finished.any { it.id == openId }) Text(" · You are here", color = Jarvis.colors.accent2)
                            }
                        }
                        if (expanded) items(finished, key = { it.id }) { job ->
                            CoordinatorJobRow(job, job.id == openId, board.questions, now) { choose(job.id) }
                        }
                    }
                    if (coordinator != roster.last()) item(key = "divider:${coordinator.id}") {
                        HorizontalDivider(Modifier.padding(horizontal = 8.dp), color = Jarvis.colors.border)
                    }
                }
            }
            HorizontalDivider(color = Jarvis.colors.border)
            FlowRow(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.SpaceAround) {
                TextButton(onClick = { dismiss(); openPage("new") }, modifier = Modifier.heightIn(min = 48.dp)) { Text("New") }
                TextButton(onClick = {
                    setAllCoordinators(settings, context.route, true)
                    dismiss(); context.navigate(Destination.Panel(context.route, PanelTab.Board))
                }, modifier = Modifier.heightIn(min = 48.dp)) { Text("All tasks") }
                TextButton(onClick = {
                    dismiss(); context.navigate(Destination.Panel(context.route, PanelTab.Threads, allJobs = true))
                }, modifier = Modifier.heightIn(min = 48.dp)) { Text("All jobs") }
                TextButton(onClick = { dismiss(); openPage("manage") }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Manage") }
            }
        }
    }
}

@Composable
private fun CoordinatorSheetRow(coordinator: ThreadSummary, badges: CoordinatorBadges, isOpen: Boolean, editArea: (() -> Unit)?, choose: () -> Unit) {
    val colors = Jarvis.colors
    val detail = listOfNotNull(coordinator.failure ?: coordinator.current,
        "${coordinator.runningWorkers} working".takeIf { coordinator.runningWorkers > 0 },
        "${coordinator.openQuestions} waiting for an answer".takeIf { coordinator.openQuestions > 0 },
        coordinator.openTasks?.let { "$it open tasks" }).joinToString(" · ")
    Surface(shape = RoundedCornerShape(12.dp), color = if (isOpen) coordinatorColor(coordinator).copy(alpha = .12f) else colors.surface) {
        Column(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(role = Role.Button, onClickLabel = "Open coordinator", onClick = choose)
            .semantics(mergeDescendants = true) { selected = isOpen; stateDescription = badges.description() }
            .padding(horizontal = 8.dp, vertical = 6.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                CoordinatorMark(coordinator)
                Text(coordinator.title, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, color = colors.fg,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (isOpen) Text("You are here", style = MaterialTheme.typography.labelSmall, color = colors.accent2)
                Text(badges.state, style = MaterialTheme.typography.labelSmall, color = colors.fgMuted)
                CoordinatorBadgeMarks(badges)
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f).padding(start = 30.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    val area = coordinator.area?.takeIf(String::isNotBlank) ?: if (editArea != null) "No area set" else null
                    area?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = colors.fgMuted, maxLines = 2, overflow = TextOverflow.Ellipsis) }
                    if (detail.isNotBlank()) Text(detail, style = MaterialTheme.typography.labelSmall, color = colors.fgMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (editArea != null) TextButton(onClick = editArea, modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Edit area" }) { Text("Edit") }
            }
        }
    }
}

@Composable
private fun CoordinatorJobRow(job: ThreadSummary, isOpen: Boolean, questions: List<BoardQuestion>, now: Long, choose: () -> Unit) {
    val colors = Jarvis.colors
    val state = threadState(job)
    val tone = when (state) {
        "working" -> colors.accent2
        "needs_you" -> colors.warning
        "failed" -> colors.danger
        "finished" -> colors.success
        else -> colors.fgMuted
    }
    val detail = remember(job, questions) { coordinatorJobPreview(job, questions) }
    val age = coordinatorJobAge(job, now)
    val status = threadStateLabel(state)
    Column(Modifier.fillMaxWidth().padding(start = 20.dp).heightIn(min = 48.dp)
        .clickable(role = Role.Button, onClickLabel = "Open background job", onClick = choose)
        .semantics(mergeDescendants = true) { selected = isOpen }
        .padding(horizontal = 8.dp, vertical = 5.dp), verticalArrangement = Arrangement.Center) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Box(Modifier.size(6.dp).background(tone, CircleShape))
            Text(job.title, Modifier.weight(1f), style = MaterialTheme.typography.labelLarge, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text("$status · $age", style = MaterialTheme.typography.labelSmall, color = tone, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        val preview = if (isOpen) listOfNotNull("You are here", detail.takeIf(String::isNotBlank)).joinToString(" · ") else detail
        if (preview.isNotBlank()) Text(preview, Modifier.padding(start = 12.dp), style = MaterialTheme.typography.bodySmall,
            color = if (isOpen) colors.accent2 else colors.fgMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}
