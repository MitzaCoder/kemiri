package io.github.mitzacoder.kemiri.features.chat

import io.github.mitzacoder.kemiri.features.notifications.LocalNotificationCenter
import androidx.compose.runtime.CompositionLocalProvider
import io.github.mitzacoder.kemiri.features.coordinators.LocalLandingTurn
import io.github.mitzacoder.kemiri.features.coordinators.rememberLandingTurn

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.features.coordinators.*
import io.github.mitzacoder.kemiri.features.tasks.QuestionCard
import io.github.mitzacoder.kemiri.features.tasks.TaskIcons
import io.github.mitzacoder.kemiri.features.tasks.isWarning
import io.github.mitzacoder.kemiri.features.tasks.itemsWaitingLabel
import io.github.mitzacoder.kemiri.features.tasks.questionAskedBy
import io.github.mitzacoder.kemiri.features.tasks.questionPin
import io.github.mitzacoder.kemiri.features.tasks.questionTaskLabel
import io.github.mitzacoder.kemiri.navigation.*
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.components.LucideIcon
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.theme.textStyle

internal fun pinnedQuestions(questions: List<BoardQuestion>, threadId: String?): List<BoardQuestion> =
    questions.filter { it.status == "open" && it.postponed != true && (threadId == null || threadId == "main" || it.threadId == threadId) }

internal fun questionPinSummary(questions: List<BoardQuestion>): String {
    val needsAnswer = questions.filter { it.waitingOn != "agent" }
    val agentCount = questions.size - needsAnswer.size
    return listOfNotNull(itemsWaitingLabel(needsAnswer).takeIf { needsAnswer.isNotEmpty() },
        "$agentCount waiting for the agent".takeIf { agentCount > 0 }).joinToString(" · ")
}

internal fun showPinnedBoardQuestions(activePanel: PanelTab?): Boolean = activePanel != PanelTab.Board

/**
 * The questions and warnings waiting on the user, pinned above the composer so they are answered where the conversation
 * is (web `BoardQuestionPin.svelte`). Main pins every thread's, labelled with the thread that asked; job pages put
 * their own questions in BackgroundJobBand instead. One question is open to answer and the others wait as one-line rows that switch to
 * it. On a phone the pin starts as one line, how many are waiting and which task, in the warning's colour when a
 * warning waits, and opens on a tap.
 */
@Composable internal fun BoardQuestionPin(context: ProjectScreenContext, coordinatorThreads: List<ThreadSummary>? = null) {
    if (!showPinnedBoardQuestions(context.activePanel)) return
    val colors = Jarvis.colors
    val view by context.board.view.collectAsStateWithLifecycle()
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    val openCoordinator = context.route.threadId ?: MAIN_THREAD_ID
    val waiting = if (coordinatorThreads == null) pinnedQuestions(view.questions, context.route.threadId) else {
        val other = view.questions.filter { it.status == "open" && it.postponed != true && it.waitingOn != "agent" }
            .groupingBy { coordinatorOfThread(it.threadId, coordinatorThreads) }.eachCount()
        val roster = coordinatorRoster(coordinatorThreads)
        if (roster.any { it.id != openCoordinator && (other[it.id] ?: 0) > 0 }) {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 12.dp)) {
                roster.filter { it.id != openCoordinator }.forEach { thread -> other[thread.id]?.let { count ->
                    TextButton(onClick = { context.navigate(coordinatorRoute(context.route, thread.id)) }, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text("$count more ${if (count == 1) "question" else "questions"} in ${thread.title}", style = MaterialTheme.typography.labelSmall)
                    }
                } }
            }
        }
        view.questions.filter { it.status == "open" && it.postponed != true && coordinatorOfThread(it.threadId, coordinatorThreads) == openCoordinator }
    }
    if (waiting.isEmpty()) return
    val tasksView = connection.supports(HarnessFeature.TASK_REPORTS)
    val project = context.route.projectId
    val threads = coordinatorThreads ?: projectThreads(context, connection.supports("threads"))?.value?.threads.orEmpty()
    // The window, not the chat column: the web asks the viewport (48rem).
    val window = with(LocalDensity.current) { LocalWindowInfo.current.containerSize.let { DpSize(it.width.toDp(), it.height.toDp()) } }
    val wide = window.width >= 768.dp
    var expanded by rememberSaveable(context.route) { mutableStateOf(false) }
    var chosen by rememberSaveable(context.route) { mutableStateOf<String?>(null) }
    val linkedQuestion = context.highlight as? ChatHighlight.Question
    LaunchedEffect(linkedQuestion) {
        linkedQuestion?.let { chosen = it.questionId; expanded = true }
    }
    val collapsed = !wide && !expanded
    val pin = questionPin(waiting, chosen)
    val current = pin.current ?: return
    val notifications = LocalNotificationCenter.current
    if (!collapsed) LaunchedEffect(notifications, context.route.backendKey, project, current.id) {
        notifications?.questionOpened(context.route.backendKey, project, current.id)
    }
    val warned = waiting.any { it.waitingOn != "agent" && isWarning(it) }
    val quiet = waiting.all { it.waitingOn == "agent" }
    val summaryTask = current.taskId
    val small = textStyle(0.75f, 1f / 0.75f)
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp).heightIn(max = window.height * .5f).verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (!wide) PinRow(
            icon = if (warned) TaskIcons.TriangleAlert else TaskIcons.CircleHelp,
            tone = if (quiet) colors.fgSubtle else if (warned) colors.warning else colors.accent2,
            modifier = Modifier.semantics { stateDescription = if (expanded) "Open" else "Closed" },
            label = if (expanded) "Hide the questions waiting" else "Show the questions waiting",
            onClick = { expanded = !expanded },
        ) {
            Text(
                questionPinSummary(waiting) + (summaryTask?.let { " · $it" } ?: ""),
                Modifier.weight(1f), style = small, color = if (warned) colors.warning else colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            LucideGlyph(Lucide.ChevronDown, Modifier.rotate(if (expanded) 180f else 0f), size = 14.dp, tint = colors.fgSubtle)
        }
        if (!collapsed) {
            val landing = rememberLandingTurn(context, connection.supports("landing-turn"))
            key(current.id) { CompositionLocalProvider(LocalLandingTurn provides landing) {
                QuestionCard(
                    context, current,
                    askedBy = questionAskedBy(current, threads),
                    taskLabel = questionTaskLabel(current, view::task),
                    onOpenTask = current.taskId?.takeIf { tasksView }?.let { id -> { context.openTask(id) } },
                    compact = true,
                )
            } }
            pin.others.forEach { question ->
                key(question.id) {
                    val warning = isWarning(question)
                    PinRow(
                        icon = if (warning) TaskIcons.TriangleAlert else TaskIcons.CircleHelp,
                        tone = if (question.waitingOn == "agent") colors.fgSubtle else if (warning) colors.warning else colors.accent2,
                        label = "${if (warning) "Acknowledge" else "Answer"} ${question.id}",
                        onClick = { chosen = question.id },
                    ) {
                        Text(questionAskedBy(question, threads) ?: "Main chat", style = small.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.Medium), color = colors.fgMuted, maxLines = 1)
                        Text(markdownText(question.text), Modifier.weight(1f), style = small, color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        LucideGlyph(Lucide.ChevronRight, size = 14.dp, tint = colors.fgSubtle)
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    questionPinSummary(waiting) + if (pin.more > 0) " · ${pin.more} more in ${if (tasksView) "Tasks" else "the Board"}" else "",
                    Modifier.weight(1f), style = small, color = colors.fgSubtle,
                )
                TextButton(onClick = { context.navigate(Destination.Panel(context.route, PanelTab.Board)) }, contentPadding = PaddingValues(horizontal = 8.dp)) {
                    Text(if (tasksView) "Open Tasks" else "Open the Board", style = small)
                }
            }
        }
    }
}

/** A one-line row of the pin, in a question's or a warning's tone. */
@Composable
private fun PinRow(icon: LucideIcon, tone: Color, label: String, onClick: () -> Unit, modifier: Modifier = Modifier, content: @Composable RowScope.() -> Unit) {
    val shape = RoundedCornerShape(12.dp)
    Row(
        modifier.fillMaxWidth().clip(shape).background(tone.copy(alpha = .07f)).border(1.dp, tone.copy(alpha = .35f), shape)
            .clickable(role = Role.Button, onClickLabel = label, onClick = onClick)
            .heightIn(min = 48.dp).padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        LucideGlyph(icon, size = 14.dp, tint = tone)
        content()
    }
}
