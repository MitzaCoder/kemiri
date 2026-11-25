package io.github.mitzacoder.kemiri.features.coordinators

import io.github.mitzacoder.kemiri.data.projectThreads
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.data.request
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

internal data class LandingTurnCoordinator(val id: String, val title: String, val thread: ThreadSummary?)
internal data class LandingTurnPresentation(val holder: LandingTurnCoordinator?, val taskId: String?, val waiting: List<LandingTurnCoordinator>)

internal fun landingTurnPresentation(turn: LandingTurn?, threads: List<ThreadSummary>): LandingTurnPresentation? = turn?.let {
    fun coordinator(id: String): LandingTurnCoordinator {
        val thread = threads.find { it.id == id }
        return LandingTurnCoordinator(id, thread?.title ?: if (id == MAIN_THREAD_ID) "General" else id, thread)
    }
    LandingTurnPresentation(it.holder?.let { holder -> coordinator(holder.coordinatorId) }, it.holder?.taskId,
        it.queue.map { waiter -> coordinator(waiter.coordinatorId) })
}

internal fun otherLandingTurnWaiters(turn: LandingTurnPresentation?, askingThread: String?, threads: List<ThreadSummary>): List<String> {
    val coordinator = coordinatorOfThread(askingThread, threads)
    if (turn == null || (turn.holder?.id != coordinator && turn.waiting.none { it.id == coordinator })) return emptyList()
    return turn.waiting.filter { it.id != coordinator }.map { it.title }
}

internal data class LandingTurnSnapshot(val turn: LandingTurnPresentation?, val threads: List<ThreadSummary>)
internal val LocalLandingTurn = staticCompositionLocalOf<LandingTurnSnapshot?> { null }

@Composable internal fun rememberLandingTurn(context: ProjectScreenContext, enabled: Boolean): LandingTurnSnapshot? {
    if (!enabled) return null
    val snapshot = projectThreads(context)?.value ?: return null
    val threads = snapshot.threads.filterNot { it.archived }
    return LandingTurnSnapshot(landingTurnPresentation(snapshot.landingTurn, threads), threads)
}

@Composable internal fun LandingTurnLine(turn: LandingTurnPresentation) {
    FlowRow(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp), verticalArrangement = Arrangement.spacedBy(4.dp),
        itemVerticalAlignment = Alignment.CenterVertically) {
        @Composable fun label(text: String) = Text(text, style = MaterialTheme.typography.labelSmall, color = Jarvis.colors.fgMuted)
        label("Landing turn:")
        val holder = turn.holder
        if (holder == null) label("Free") else Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            CoordinatorMark(holder.thread, holder.title)
            label(holder.title + (turn.taskId?.let { " ($it)" } ?: ""))
        }
        if (turn.waiting.isNotEmpty()) label("· waiting:")
        turn.waiting.forEachIndexed { index, waiter ->
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                CoordinatorMark(waiter.thread, waiter.title)
                label(waiter.title + if (index < turn.waiting.lastIndex) "," else "")
            }
        }
    }
}
