package io.github.mitzacoder.kemiri.features.chat

import io.github.mitzacoder.kemiri.ui.rememberAppTime
import io.github.mitzacoder.kemiri.data.supports
import io.github.mitzacoder.kemiri.features.coordinators.CoordinatorEditor
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.features.panels.panelRelativeTime
import io.github.mitzacoder.kemiri.features.tasks.QuestionCard
import io.github.mitzacoder.kemiri.navigation.*
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import java.time.Instant

internal const val JOB_COMPOSER_NOTE = "The main chat does not see what you write here, only the job's report."
internal fun isBackgroundJobPage(route: Destination.Chat) = route.workerId == null && !sameThread(route.threadId, null)
internal fun backgroundJobComposerNote(route: Destination.Chat): String? = JOB_COMPOSER_NOTE.takeIf { isBackgroundJobPage(route) }
internal fun openBackgroundJobLabel(route: Destination.Chat?, threads: List<ThreadSummary>): String? =
    route?.takeIf(::isBackgroundJobPage)?.threadId?.let { id -> "Open: ${threads.find { it.id == id }?.title?.takeIf(String::isNotBlank) ?: id}" }
internal data class BackgroundJobBandText(val origin: String, val outcome: String, val canStop: Boolean)
internal fun backgroundJobBandText(thread: ThreadSummary, now: Long, scheduleName: String? = null, parentTitle: String = "Main chat"): BackgroundJobBandText {
    val starter = when (thread.startedBy) {
        "schedule" -> scheduleName?.let { "schedule $it" } ?: "a schedule"
        "user" -> "you"
        else -> parentTitle
    }
    val instant = Instant.ofEpochMilli(now)
    val ended = panelRelativeTime(thread.finishedAt ?: thread.updatedAt, instant)
    val state = threadState(thread)
    val outcome = when (state) {
        "finished" -> "Finished $ended · its report is in $parentTitle"
        "stopped" -> "Stopped $ended · $parentTitle keeps what it reported so far"
        "failed" -> "Failed $ended · send a message to retry"
        else -> "reports back there when it finishes"
    }
    return BackgroundJobBandText("started by $starter ${panelRelativeTime(thread.createdAt, instant)}", outcome, state !in setOf("finished", "stopped"))
}
internal fun backgroundJobQuestions(questions: List<BoardQuestion>, threadId: String) = questions.filter { it.status == "open" && it.postponed != true && it.threadId == threadId }

@Composable
internal fun BackgroundJobBand(context: ProjectScreenContext, thread: ThreadSummary, projectName: String, scheduleName: String?, parentTitle: String = "Main chat") {
    val now = rememberAppTime(15_000)
    val text = backgroundJobBandText(thread, now, scheduleName, parentTitle)
    val board by context.board.view.collectAsStateWithLifecycle()
    val waiting = backgroundJobQuestions(board.questions, thread.id)
    var chosen by rememberSaveable(thread.id) { mutableStateOf<String?>(null) }
    val linkedQuestion = context.highlight as? ChatHighlight.Question
    LaunchedEffect(linkedQuestion) { if (linkedQuestion != null) chosen = linkedQuestion.questionId }
    val question = waiting.find { it.id == chosen } ?: waiting.firstOrNull()
    var promoting by rememberSaveable(thread.id) { mutableStateOf(false) }
    var stopping by rememberSaveable(thread.id) { mutableStateOf(false) }
    var pending by remember(thread.id) { mutableStateOf(false) }
    val maxHeight = with(LocalDensity.current) { LocalWindowInfo.current.containerSize.height.toDp() * .45f }
    Column(Modifier.fillMaxWidth().heightIn(max = maxHeight).background(Jarvis.colors.accent2.copy(alpha = .06f))
        .verticalScroll(rememberScrollState()).padding(horizontal = 12.dp, vertical = 4.dp)) {
        Text("Background job of $projectName · ${text.origin} · ${text.outcome}", style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            TextButton(onClick = { context.navigate(context.route.copy(threadId = thread.parentThreadId?.takeUnless { it == "main" }, workerId = null, highlight = null)) }, modifier = Modifier.heightIn(min = 48.dp)) { Text("← $parentTitle", maxLines = 1) }
            if (!thread.archived && context.backend.client.supports("coordinator-schedules")) TextButton(onClick = { promoting = true }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Keep as coordinator") }
            if (text.canStop) TextButton(enabled = !pending, onClick = { stopping = true }, modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Stop ${thread.title}" }, colors = ButtonDefaults.textButtonColors(contentColor = Jarvis.colors.danger)) { Text("Stop") }
        }
        if (question != null) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                Text(if (question.waitingOn == "agent") "Waiting for the agent" else if (question.noReplyYet == true) "No reply yet" else "It is waiting for your answer", Modifier.weight(1f), style = MaterialTheme.typography.labelSmall, color = if (question.waitingOn == "agent") Jarvis.colors.fgMuted else Jarvis.colors.warning)
                if (waiting.size > 1) TextButton(onClick = { chosen = waiting[(waiting.indexOf(question) + 1) % waiting.size].id }, modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Show another waiting question" }) { Text("+${waiting.size - 1} more") }
            }
            key(question.id) { QuestionCard(context, question, compact = true, preview = true) }
        }
    }
    if (promoting) CoordinatorEditor(context, thread, dismiss = { promoting = false }, promote = true)
    if (stopping) ThreadStopConfirmation(context, thread, onDismiss = { stopping = false }, onPending = { pending = it }, onStopped = { stopping = false })
}
