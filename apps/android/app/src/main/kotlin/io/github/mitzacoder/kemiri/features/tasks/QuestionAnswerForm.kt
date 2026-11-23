package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.chat.markdownText
import io.github.mitzacoder.kemiri.protocol.BoardQuestion
import io.github.mitzacoder.kemiri.protocol.BoardQuestionChoice
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import io.github.mitzacoder.kemiri.ui.theme.mix
import io.github.mitzacoder.kemiri.ui.theme.Text as TextStyles

internal fun questionCanAnswer(question: BoardQuestion, readOnly: Boolean = false): Boolean = question.status == "open" && !readOnly
internal fun questionCanAnswerExpanded(question: BoardQuestion, readOnly: Boolean = false): Boolean = questionCanAnswer(question, readOnly)
internal fun questionCanClarify(question: BoardQuestion, supported: Boolean, readOnly: Boolean = false): Boolean =
    supported && questionCanAnswer(question, readOnly) && question.mcpApproval != true && question.outsideModelApproval != true && question.usageDrainIncident == null
internal fun askBackIsPrimary(text: String): Boolean = text.trimEnd().endsWith("?")
internal fun askBackText(question: BoardQuestion, draft: String): String =
    draft.trim().ifEmpty { if (question.noReplyYet == true) question.exchanges.orEmpty().lastOrNull { it.author.author == "user" }?.text.orEmpty() else "" }

/** Both presentations share the card's draft and guarded answer / Ask back actions. */
@Composable
internal fun QuestionAnswerForm(
    question: BoardQuestion,
    answers: QuestionAnswers,
    text: String,
    onTextChange: (String) -> Unit,
    busy: Boolean,
    problem: String?,
    onSend: (String) -> Unit,
    compact: Boolean = false,
    expanded: Boolean = false,
    maxChoicesHeight: Dp = 112.dp,
    choiceMinHeight: Dp = 48.dp,
    onAskBack: ((String) -> Unit)? = null,
    warningActionLabel: String = "Acknowledge",
) {
    val colors = Jarvis.colors
    val warning = isWarning(question)
    val hasSuggestions = when (answers) {
        is QuestionAnswers.Choices -> answers.choices.isNotEmpty()
        is QuestionAnswers.Options -> answers.options.isNotEmpty()
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (hasSuggestions) {
            val suggestionsScroll = if (expanded) Modifier.heightIn(max = maxChoicesHeight).verticalScroll(rememberScrollState()) else Modifier
            Column(suggestionsScroll.semantics { contentDescription = "Suggested answers" }) {
                when (answers) {
                    is QuestionAnswers.Choices -> QuestionChoiceButtons(answers.choices, busy, onSend)
                    is QuestionAnswers.Options -> FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        answers.options.forEach { option ->
                            Surface(
                                onClick = { onSend(option) },
                                enabled = !busy,
                                shape = RoundedCornerShape(50),
                                color = colors.surface,
                                border = BorderStroke(1.dp, colors.border),
                                modifier = Modifier.heightIn(min = choiceMinHeight),
                            ) {
                                Box(Modifier.padding(horizontal = 12.dp, vertical = 6.dp), contentAlignment = Alignment.CenterStart) {
                                    TaskDetailText(markdownText(option), style = TaskType.xsMedium, color = colors.fg)
                                }
                            }
                        }
                    }
                }
            }
        }
        if (question.outsideModelApproval != true && question.usageDrainIncident == null) Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            OutlinedTextField(
                value = text,
                onValueChange = onTextChange,
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = if (warning) "Note for ${question.id}" else "Answer to ${question.id}" },
                placeholder = { Text(if (warning) "Add a note (optional)" else if (hasSuggestions) "Or answer in your own words" else "Your answer", style = TaskType.xs) },
                textStyle = if (expanded) TextStyles.base else TextStyles.sm,
                minLines = if (expanded || compact) 1 else 2,
                maxLines = if (expanded) 2 else 5,
                enabled = !busy,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                shape = RoundedCornerShape(10.dp),
            )
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp, Alignment.End), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                val askPrimary = onAskBack != null && askBackIsPrimary(text)
                if (onAskBack != null) {
                    val label = if (question.noReplyYet == true) "Ask again" else "Ask back"
                    val askText = askBackText(question, text)
                    val askModifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "$label about ${question.id}" }
                    if (askPrimary) Button(onClick = { onAskBack(askText) }, enabled = !busy && askText.isNotBlank(), modifier = askModifier) { Text(label) }
                    else OutlinedButton(onClick = { onAskBack(askText) }, enabled = !busy && askText.isNotBlank(), modifier = askModifier) { Text(label) }
                }
                if (warning) {
                    if (askPrimary) OutlinedButton(onClick = { onSend(text.trim().ifEmpty { "Acknowledged" }) }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text(warningActionLabel) }
                    else Button(onClick = { onSend(text.trim().ifEmpty { "Acknowledged" }) }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) { Text(warningActionLabel) }
                } else {
                    val sendModifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Send the answer to ${question.id}" }
                    if (askPrimary) OutlinedButton(onClick = { onSend(text) }, enabled = !busy && text.isNotBlank(), modifier = sendModifier) { Text("Send answer") }
                    else Button(onClick = { onSend(text) }, enabled = !busy && text.isNotBlank(), modifier = sendModifier) { Text("Send answer") }
                }
            }
        }
        problem?.let {
            val errorScroll = if (expanded) Modifier.heightIn(max = 48.dp).verticalScroll(rememberScrollState()) else Modifier
            Text(it, errorScroll, style = TaskType.xs, color = colors.danger)
        }
    }
}

/** The displayed effect and recommendation are context; the stored label is the answer. */
@Composable
internal fun QuestionChoiceButtons(choices: List<BoardQuestionChoice>, busy: Boolean, onSend: (String) -> Unit) {
    val colors = Jarvis.colors
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        choices.forEach { choice ->
            val label = markdownText(choice.label)
            val effect = choice.effect?.takeIf { it.isNotBlank() }?.let(::markdownText)
            val recommended = choice.recommended == true
            Surface(
                onClick = { onSend(choice.label) }, enabled = !busy,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics {
                    role = Role.Button
                    contentDescription = listOfNotNull(label, "Recommended".takeIf { recommended }, effect).joinToString(". ")
                },
                shape = RoundedCornerShape(8.dp),
                color = if (recommended) colors.accent2.mix(colors.surface, 10f) else colors.surface,
                border = BorderStroke(1.dp, if (recommended) colors.accent2 else colors.borderStrong),
            ) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(2.dp),
                        itemVerticalAlignment = Alignment.CenterVertically) {
                        TaskDetailText(label, style = TextStyles.sm.copy(fontWeight = FontWeight.SemiBold), color = colors.fg)
                        if (recommended) Surface(shape = RoundedCornerShape(50), color = colors.surface,
                            border = BorderStroke(1.dp, colors.accent2.copy(alpha = .5f))) {
                            Text("Recommended", Modifier.padding(horizontal = 6.dp, vertical = 1.dp), style = TaskType.meta, color = colors.fg)
                        }
                    }
                    effect?.let { TaskDetailText(it, style = TaskType.xs, color = colors.fgMuted) }
                }
            }
        }
    }
}
