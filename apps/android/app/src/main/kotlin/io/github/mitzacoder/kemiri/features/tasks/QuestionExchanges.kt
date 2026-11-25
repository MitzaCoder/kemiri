package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.protocol.BoardQuestion
import io.github.mitzacoder.kemiri.protocol.BoardWriter
import io.github.mitzacoder.kemiri.protocol.BoardQuestionExchangePreviousWording
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

internal fun questionExchangeAuthor(writer: BoardWriter): String =
    if (writer.author == "user") "You" else shortWriterLabel(writer)

internal fun questionCheckingFeedbackId(question: BoardQuestion): String? =
    question.exchanges?.lastOrNull()?.feedbackId?.takeIf { question.status == "open" && question.waitingOn == "agent" }

internal fun questionWaitingLabel(question: BoardQuestion): String? = when {
    question.status != "open" -> null
    question.waitingOn == "agent" -> "Waiting for the agent"
    question.noReplyYet == true -> "No reply yet"
    else -> null
}

/** The same exchange and revision history in cards and the full reader. */
@Composable
internal fun QuestionExchanges(question: BoardQuestion) {
    val colors = Jarvis.colors
    val exchanges = question.exchanges.orEmpty()
    var earlier by rememberSaveable(question.id) { mutableStateOf(false) }
    val lastRevisionIndex = exchanges.indexOfLast { it.previousWording != null }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        questionWaitingLabel(question)?.let { Text(it, style = TaskType.xsMedium, color = colors.fgMuted) }
        if (question.reopened == true) Text("Reopened", style = TaskType.xs, color = colors.fgSubtle)
        val earlierAction: @Composable () -> Unit = {
            if (exchanges.size > 2) TextButton(onClick = { earlier = !earlier }, modifier = Modifier.heightIn(min = 48.dp)) {
                Text(if (earlier) "Hide earlier exchanges" else "Earlier (${exchanges.size - 2})")
            }
        }
        val previousWording = exchanges.getOrNull(lastRevisionIndex)?.previousWording
        if (previousWording != null) QuestionEarlierWording(question.id, previousWording, earlierAction)
        else earlierAction()
        val start = if (earlier) 0 else maxOf(0, exchanges.size - 2)
        exchanges.drop(start).forEachIndexed { index, exchange ->
            key(question.id, start + index) {
                var answer by rememberSaveable { mutableStateOf(false) }
                HorizontalDivider(color = colors.border)
                val time = runCatching { DateTimeFormatter.ofLocalizedDateTime(FormatStyle.SHORT).withZone(ZoneId.systemDefault()).format(Instant.parse(exchange.at)) }.getOrDefault(exchange.at)
                Text("${questionExchangeAuthor(exchange.author)} · $time", Modifier.semantics { contentDescription = "${questionExchangeAuthor(exchange.author)}, ${exchange.at}" }, style = TaskType.xs, color = colors.fgSubtle)
                BoardMarkdown(exchange.text)
                if (start + index != lastRevisionIndex) exchange.previousWording?.let { QuestionEarlierWording(question.id, it) }
                exchange.previousAnswer?.let { previous ->
                    TextButton(onClick = { answer = !answer }, modifier = Modifier.heightIn(min = 48.dp)) { Text(if (answer) "Hide earlier answer" else "Earlier answer") }
                    if (answer) {
                        Text("You · ${previous.at}", style = TaskType.xs, color = colors.fgSubtle)
                        BoardMarkdown(previous.text)
                    }
                }
            }
        }
    }
}

@Composable
private fun QuestionEarlierWording(questionId: String, previous: BoardQuestionExchangePreviousWording, additionalActions: @Composable () -> Unit = {}) {
    var wording by rememberSaveable(questionId, previous.revision) { mutableStateOf(false) }
    FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        TextButton(onClick = { wording = !wording }, modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Revised $questionId. ${if (wording) "Hide" else "Show"} earlier wording, revision ${previous.revision}" }) {
            Text(if (wording) "Revised · Hide earlier wording" else "Revised · Earlier wording")
        }
        additionalActions()
    }
    if (wording) {
        BoardMarkdown(previous.text)
        previous.options.forEach { TaskDetailText("• $it", style = TaskType.xs, color = Jarvis.colors.fgMuted) }
    }
}
