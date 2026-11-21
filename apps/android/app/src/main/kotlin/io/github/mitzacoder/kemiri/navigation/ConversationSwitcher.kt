package io.github.mitzacoder.kemiri.navigation

import io.github.mitzacoder.kemiri.features.coordinators.*

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.features.chat.*
import io.github.mitzacoder.kemiri.protocol.*
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
    val settings = androidx.compose.ui.platform.LocalContext.current
    val openId = context.route.threadId ?: MAIN_THREAD_ID
    ModalBottomSheet(onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = Jarvis.colors.surface) {
        LazyColumn(Modifier.fillMaxWidth(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item { Text("Coordinators", Modifier.padding(horizontal = 20.dp, vertical = 8.dp).semantics { heading() }, style = MaterialTheme.typography.headlineSmall) }
            roster.forEach { thread ->
                item(key = thread.id) {
                    val selected = thread.id == openId
                    val badges = coordinatorBadges(thread, if (selected) Long.MAX_VALUE else coordinatorSeen(context.route, thread.id))
                    Column(Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(role = Role.Button) {
                        dismiss(); conversationChoiceDestination(context.route, thread.id)?.let(context.navigate)
                    }.semantics(mergeDescendants = true) { this.selected = selected; stateDescription = badges.description() }
                        .padding(horizontal = 20.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            CoordinatorMark(thread)
                            Text(thread.title, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                            Text(badges.state, style = MaterialTheme.typography.labelSmall, color = Jarvis.colors.fgMuted)
                            CoordinatorBadgeMarks(badges)
                        }
                        thread.area?.takeIf(String::isNotBlank)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted,
                            maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis) }
                        val detail = listOfNotNull(thread.failure ?: thread.current,
                            "${thread.runningWorkers} working".takeIf { thread.runningWorkers > 0 },
                            "${thread.openQuestions} waiting for an answer".takeIf { thread.openQuestions > 0 },
                            thread.openTasks?.let { "$it open tasks" }).joinToString(" · ")
                        if (detail.isNotBlank()) Text(detail, style = MaterialTheme.typography.labelSmall, color = Jarvis.colors.fgSubtle, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                    }
                    HorizontalDivider(Modifier.padding(horizontal = 20.dp), color = Jarvis.colors.border)
                }
                val jobs = orderedBackgroundJobs(threads.filter { it.kind != "coordinator" && !it.main && !it.archived && (it.parentThreadId ?: MAIN_THREAD_ID) == thread.id })
                items(jobs, key = { it.id }) { job ->
                    Box(Modifier.padding(start = 24.dp)) {
                        ConversationChoiceRow(ConversationChoice(job.id, job.title, job.id == openId, job), threadStateLine(job, board.questions, now)) {
                            dismiss(); conversationChoiceDestination(context.route, job.id)?.let(context.navigate)
                        }
                    }
                }
            }
            item {
                FlowRow(Modifier.fillMaxWidth().padding(horizontal = 12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(onClick = { dismiss(); openPage("new") }, modifier = Modifier.heightIn(min = 48.dp)) { Text("New coordinator") }
                    TextButton(onClick = {
                        setAllCoordinators(settings, context.route, true)
                        dismiss(); context.navigate(Destination.Panel(context.route, PanelTab.Board))
                    }, modifier = Modifier.heightIn(min = 48.dp)) { Text("All tasks") }
                    TextButton(onClick = { dismiss(); openPage("manage") }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Manage") }
                }
            }
        }
    }
}
