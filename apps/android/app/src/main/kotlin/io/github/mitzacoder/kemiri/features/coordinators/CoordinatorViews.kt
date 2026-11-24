package io.github.mitzacoder.kemiri.features.coordinators

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.navigation.*
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.launch

internal val coordinatorColors = linkedMapOf("Slate" to "#7e8ca4", "Violet" to "#9873e1", "Blue" to "#5087dc", "Teal" to "#279c8e", "Amber" to "#ba8036", "Rose" to "#d2688c", "Green" to "#699747")
internal fun coordinatorColor(thread: ThreadSummary?) = Color(0xff000000 or (thread?.color?.takeIf { it in coordinatorColors.values } ?: "#7e8ca4").drop(1).toLong(16))

@Composable internal fun CoordinatorMark(thread: ThreadSummary?, title: String = thread?.title ?: "General") {
    val tone = coordinatorColor(thread)
    Surface(shape = CircleShape, color = tone.copy(alpha = .19f), contentColor = Jarvis.colors.fg, border = BorderStroke(1.dp, tone.copy(alpha = .65f))) {
        Box(Modifier.size(24.dp).clearAndSetSemantics { }, contentAlignment = Alignment.Center) {
            Text(title.trim().let { if (it.isEmpty()) "?" else String(Character.toChars(it.codePointAt(0))).uppercase() }, style = MaterialTheme.typography.labelMedium)
        }
    }
}

@Composable internal fun CoordinatorBadgeMarks(badges: CoordinatorBadges) {
    Row(Modifier.clearAndSetSemantics { }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        if (badges.working) CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp)
        if (badges.needsYou > 0) Surface(shape = CircleShape, color = Jarvis.colors.warning.copy(alpha = .16f)) {
            Text(badges.needsYou.toString(), Modifier.padding(horizontal = 6.dp, vertical = 2.dp), color = Jarvis.colors.warning, style = MaterialTheme.typography.labelMedium)
        }
        if (badges.unread) Surface(Modifier.size(7.dp), shape = CircleShape, color = Jarvis.colors.accent2) { }
        if (badges.paused) Text("Ⅱ", color = Jarvis.colors.fgMuted, style = MaterialTheme.typography.labelMedium)
    }
}

@Composable internal fun CoordinatorChipRow(context: ProjectScreenContext, roster: List<ThreadSummary>, selectedId: String, onNew: () -> Unit) {
    if (roster.size < 2) return
    val scroll = rememberScrollState()
    Row(Modifier.fillMaxWidth().horizontalScroll(scroll).padding(horizontal = 12.dp, vertical = 3.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        roster.forEach { thread ->
            val selected = thread.id == selectedId
            val badges = coordinatorBadges(thread, if (selected) Long.MAX_VALUE else coordinatorSeen(context.route, thread.id))
            Surface(onClick = { if (!selected || context.route.threadId != thread.id && !thread.main) context.navigate(coordinatorRoute(context.route, thread.id)) },
                modifier = Modifier.heightIn(min = 48.dp).semantics { this.selected = selected; stateDescription = badges.description() },
                shape = RoundedCornerShape(16.dp), color = if (selected) coordinatorColor(thread).copy(alpha = .13f) else Jarvis.colors.surface,
                border = BorderStroke(1.dp, if (selected) coordinatorColor(thread) else Jarvis.colors.border)) {
                Row(Modifier.padding(horizontal = 9.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(7.dp), verticalAlignment = Alignment.CenterVertically) {
                    CoordinatorMark(thread)
                    Text(thread.title, Modifier.widthIn(max = 132.dp), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelLarge)
                    CoordinatorBadgeMarks(badges)
                }
            }
        }
        TextButton(onClick = onNew, modifier = Modifier.heightIn(min = 48.dp)) { Text("+ New") }
    }
}

@Composable internal fun CoordinatorArea(context: ProjectScreenContext, thread: ThreadSummary) {
    var editing by rememberSaveable(thread.id) { mutableStateOf(false) }
    val tone = coordinatorColor(thread)
    if (!thread.area.isNullOrBlank() || !thread.archived) Surface(color = tone.copy(alpha = .09f)) {
        Row(Modifier.fillMaxWidth().padding(start = 14.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(thread.area ?: "No area set", Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted)
            if (!thread.archived) TextButton(onClick = { editing = true }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Edit area") }
        }
    }
    if (editing) CoordinatorEditor(context, thread, dismiss = { editing = false }, areaOnly = true)
}

@Composable internal fun CoordinatorMessageCard(context: ProjectScreenContext, row: ThreadsMessagesResponseMessagesItem, threads: List<ThreadSummary>, viewing: String? = null) {
    fun thread(id: String) = threads.find { it.id == id }
    fun title(id: String) = thread(id)?.title ?: if (id == MAIN_THREAD_ID) "General" else id
    val outgoing = viewing == row.from
    val peer = if (viewing == row.from) row.to else row.from
    val heading = when {
        viewing == null -> "${title(row.from)} → ${title(row.to)}"
        !outgoing -> "From ${title(peer)}"
        row.kind == "request" -> "You asked ${title(peer)}"
        row.kind == "reply" -> "You replied to ${title(peer)}"
        else -> "You left a note for ${title(peer)}"
    }
    val status = if (row.kind == "request" && row.awaitReply == true && (outgoing || viewing == null)) {
        if (row.replied == true) "Answered" else "Awaiting reply"
    } else null
    Surface(color = Jarvis.colors.surface, shape = RoundedCornerShape(12.dp), border = BorderStroke(1.dp, coordinatorColor(thread(peer)).copy(alpha = .65f))) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 4.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                CoordinatorMark(thread(peer), title(peer))
                TextButton(onClick = { context.navigate(coordinatorRoute(context.route, peer, ChatHighlight.PeerMessage(row.id))) },
                    modifier = Modifier.weight(1f, fill = false).heightIn(min = 48.dp), contentPadding = PaddingValues(horizontal = 4.dp)) {
                    Text(listOfNotNull(heading, status).joinToString(" · "), style = MaterialTheme.typography.labelLarge)
                }
                row.taskId?.let { id -> TextButton(onClick = { context.openTask(id) }, modifier = Modifier.heightIn(min = 48.dp), contentPadding = PaddingValues(horizontal = 6.dp)) { Text(id) } }
            }
            Text(row.text, Modifier.padding(start = 4.dp, end = 4.dp, bottom = 8.dp), style = MaterialTheme.typography.bodyMedium, color = Jarvis.colors.fg)
        }
    }
}

@Composable internal fun CoordinatorMessageFeed(context: ProjectScreenContext, threads: List<ThreadSummary>) {
    val feed = rememberCoordinatorMessages(context, true)
    var expanded by rememberSaveable { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        TextButton(onClick = { expanded = !expanded }, modifier = Modifier.heightIn(min = 48.dp).semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }) {
            Text("Between coordinators")
        }
        if (expanded) CoordinatorMessageList(context, threads, feed)
    }
}

@Composable
internal fun CoordinatorMessageList(context: ProjectScreenContext, threads: List<ThreadSummary>, feed: CoordinatorMessages, taskId: String? = null) {
    val scope = rememberCoroutineScope()
    feed.messages.values.sortedWith(compareByDescending<ThreadsMessagesResponseMessagesItem> { it.at }.thenByDescending { it.id }).forEach { row ->
        key(row.id) { CoordinatorMessageCard(context, row, threads) }
    }
    if (feed.loading) Text("Loading messages…", style = MaterialTheme.typography.bodySmall)
    else if (feed.error != null) {
        Text(feed.error.orEmpty(), color = MaterialTheme.colorScheme.error)
        TextButton(onClick = { scope.launch { feed.read(context.backend.client, context.route.projectId, taskId, feed.before) } }) { Text("Retry") }
    } else if (feed.messages.isEmpty()) Text("No coordinator messages yet.", style = MaterialTheme.typography.bodySmall)
    if (!feed.loading && feed.error == null && feed.before != null) TextButton(onClick = {
        scope.launch { feed.read(context.backend.client, context.route.projectId, taskId, feed.before) }
    }) { Text("Earlier messages") }
}
