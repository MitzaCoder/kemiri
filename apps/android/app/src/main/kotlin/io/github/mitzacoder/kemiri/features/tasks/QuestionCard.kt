package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.features.coordinators.LocalLandingTurn
import io.github.mitzacoder.kemiri.features.coordinators.otherLandingTurnWaiters

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.data.AnswerOutcome
import io.github.mitzacoder.kemiri.data.ClarifyOutcome
import io.github.mitzacoder.kemiri.data.HarnessFeature
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.BoardQuestion
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.theme.JetBrainsMono
import kotlinx.coroutines.launch

/**
 * One question the coordinator asked (web `BoardQuestionCard.svelte`): its text, suggested answers that
 * send at once, and a free-text answer. Used in the Tasks list, the task sheet and pinned above the composer. An answer
 * goes on the revision the board holds now; when the question moved on meanwhile the card says so and keeps what was
 * typed. A warning looks apart and has no options: the user acknowledges it, with a note if they like.
 *
 * [askedBy] names the background job that asked (null for main); [taskLabel] ("T4 · Fix parser recovery") opens the
 * task with [onOpenTask].
 */
@Composable
fun QuestionCard(
    context: ProjectScreenContext,
    question: BoardQuestion,
    modifier: Modifier = Modifier,
    askedBy: String? = null,
    taskLabel: String? = null,
    onOpenTask: (() -> Unit)? = null,
    compact: Boolean = false,
    readOnly: Boolean = false,
    preview: Boolean = false,
    optionsOnly: Boolean = false,
    plain: Boolean = false,
) {
    val colors = Jarvis.colors
    val warning = isWarning(question)
    val waitingForAgent = question.status == "open" && question.waitingOn == "agent"
    val tone = if (waitingForAgent) colors.fgSubtle else if (warning) colors.warning else colors.accent2
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    val answers = questionAnswers(question, connection.supports(HarnessFeature.TASK_FIELDS))
    val canClarify = questionCanClarify(question, connection.supports("question-clarify"), readOnly)
    val key = "${context.backend.config.key}/${context.route.projectId}/${question.id}"
    var text by rememberSaveable(key) { mutableStateOf("") }
    var busy by remember(key) { mutableStateOf(false) }
    var problem by remember(key) { mutableStateOf<String?>(null) }
    var readingExpanded by rememberSaveable(key) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val latest by rememberUpdatedState(question)
    fun send(answer: String) {
        val trimmed = answer.trim()
        if (trimmed.isEmpty() || busy || !questionCanAnswer(latest, readOnly)) return
        busy = true
        problem = null
        scope.launch {
            val current = latest
            when (val outcome = context.board.answer(current.id, current.revision, trimmed)) {
                is AnswerOutcome.Answered -> { text = ""; readingExpanded = false }
                is AnswerOutcome.Conflict -> problem = when {
                    outcome.newer == null || outcome.newer.status != "open" ->
                        if (warning) "This warning was already acknowledged or withdrawn." else "This question was already answered or withdrawn."
                    else -> "The coordinator changed this question. Read it again and send the answer."
                }
                is AnswerOutcome.Failed -> problem = outcome.message
            }
            busy = false
        }
    }
    fun askBack(draft: String) {
        val trimmed = draft.trim()
        if (trimmed.isEmpty() || busy || !questionCanClarify(latest, connection.supports("question-clarify"), readOnly)) return
        busy = true
        problem = null
        scope.launch {
            val current = latest
            when (val outcome = context.board.clarify(current.id, current.revision, trimmed)) {
                ClarifyOutcome.Sent -> { text = ""; readingExpanded = false }
                is ClarifyOutcome.Conflict -> problem = if (outcome.newer?.status == "open")
                    "The coordinator changed this question. Read it again before asking back."
                    else "This question was already answered or withdrawn."
                is ClarifyOutcome.Failed -> problem = outcome.message
            }
            busy = false
        }
    }
    val onAskBack: ((String) -> Unit)? = if (canClarify) ::askBack else null
    Column(
        modifier.fillMaxWidth().then(if (plain) Modifier else Modifier
            .background(tone.copy(alpha = if (warning) .10f else .08f), RoundedCornerShape(16.dp))
            .border(1.dp, tone.copy(alpha = if (warning) .50f else .40f), RoundedCornerShape(16.dp))
            .padding(horizontal = 12.dp, vertical = 10.dp))
            .semantics(mergeDescendants = false) { contentDescription = "${if (warning) "Warning" else "Question"} ${question.id}" },
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
            LucideGlyph(if (warning) TaskIcons.TriangleAlert else TaskIcons.CircleHelp, Modifier.padding(top = 2.dp), size = 16.dp, tint = tone)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalArrangement = Arrangement.spacedBy(2.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                    askedBy?.let { AskedBy(it) }
                    Text(buildAnnotatedString {
                        if (warning) {
                            withStyle(SpanStyle(color = colors.warning, fontWeight = FontWeight.SemiBold)) { append("Warning") }
                            append(" · ")
                        }
                        withStyle(SpanStyle(fontFamily = JetBrainsMono)) { append(question.id) }
                        if (taskLabel != null && onOpenTask == null) append(" · $taskLabel")
                    }, style = TaskType.xs, color = colors.fgSubtle)
                    if (taskLabel != null && onOpenTask != null) {
                        Text("·", style = TaskType.xs, color = colors.fgSubtle)
                        Text(
                            taskLabel,
                            Modifier.clickableLink("Open $taskLabel", onOpenTask),
                            style = TaskType.xs.copy(textDecoration = androidx.compose.ui.text.style.TextDecoration.Underline),
                            color = colors.fgMuted,
                        )
                    }
                }
                if (preview) Text(io.github.mitzacoder.kemiri.features.chat.markdownText(question.text),
                    style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis)
                else BoardMarkdown(question.text)
                val landing = LocalLandingTurn.current
                if (landing != null && !warning && question.status == "open") {
                    val waiters = otherLandingTurnWaiters(landing.turn, question.threadId, landing.threads)
                    if (waiters.isNotEmpty()) Text("Waiting for the landing turn: ${waiters.joinToString()}", style = TaskType.xs, color = colors.fgMuted)
                }
            }
            if (!optionsOnly) IconButton(onClick = { readingExpanded = true }) {
                LucideGlyph(ExpandQuestionIcon, size = 16.dp, contentDescription = "Expand ${if (warning) "warning" else "question"} ${question.id}")
            }
        }
        if (!optionsOnly) QuestionExchanges(question)
        if (optionsOnly && questionCanAnswer(question, readOnly) && !warning) {
            when (answers) {
                is QuestionAnswers.Choices -> QuestionChoiceButtons(answers.choices, busy, ::send)
                is QuestionAnswers.Options -> answers.options.forEach { option ->
                    OutlinedButton(onClick = { send(option) }, enabled = !busy,
                        modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { contentDescription = "Answer ${question.id}: $option" }) {
                        Text(io.github.mitzacoder.kemiri.features.chat.markdownText(option), style = TaskType.xsMedium)
                    }
                }
            }
            problem?.let { Text(it, color = colors.danger, style = TaskType.xs) }
        }
        if (!optionsOnly && questionCanAnswer(question, readOnly)) QuestionAnswerForm(
            question, answers, text, { text = it }, busy, problem, ::send, compact = compact, onAskBack = onAskBack, warningActionLabel = if (plain) "Got it" else "Acknowledge",
        )
    }
    if (readingExpanded) QuestionReadingDialog(
        question, taskLabel, onDismiss = { readingExpanded = false },
        canAnswer = questionCanAnswerExpanded(question, readOnly),
        hasStructuredChoices = answers is QuestionAnswers.Choices,
        answerFooter = { maxChoicesHeight ->
            QuestionAnswerForm(question, answers, text, { text = it }, busy, problem, ::send, expanded = true, maxChoicesHeight = maxChoicesHeight, onAskBack = onAskBack,
                warningActionLabel = if (plain) "Got it" else "Acknowledge")
        },
    )
}

/** The background job that asked, as a small tinted label. */
@Composable
internal fun AskedBy(name: String) {
    val primary = MaterialTheme.colorScheme.primary
    Row(
        Modifier.background(primary.copy(alpha = .12f), RoundedCornerShape(6.dp)).padding(horizontal = 6.dp, vertical = 1.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        LucideGlyph(Lucide.Layers, size = 12.dp, tint = primary)
        Text(name, style = TaskType.xsMedium, color = primary, maxLines = 1)
    }
}
