package io.github.mitzacoder.kemiri.features.changes

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.chat.REVIEW_INTENTS
import io.github.mitzacoder.kemiri.features.chat.reviewCommentCount
import io.github.mitzacoder.kemiri.features.chat.reviewText
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable internal fun CodeCommentSheet(comment: CodeComment, editing: Boolean, problem: String?, cancel: () -> Unit,
                                          canExtend: Boolean, extend: (CodeComment) -> Unit, save: (CodeComment) -> Unit) {
    var intent by rememberSaveable(comment.id, comment.intent) { mutableStateOf(comment.intent) }
    var note by rememberSaveable(comment.id, comment.note) { mutableStateOf(comment.note) }
    var replacement by rememberSaveable(comment.id, comment.replacement) { mutableStateOf(comment.replacement) }
    val patch = remember(comment.anchor, replacement) { suggestedPatch(comment.anchor, replacement) }
    fun edited() = comment.copy(intent = intent, note = reviewText(note, 4000), replacement = replacement)
    ModalBottomSheet(onDismissRequest = cancel, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(if (editing) "Edit comment" else "Comment on code", Modifier.semantics { heading() }, style = MaterialTheme.typography.titleLarge)
            Text(comment.anchor.location() + if (comment.outdated) " · Outdated" else "", style = MaterialTheme.typography.labelLarge)
            Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium) {
                Text(comment.anchor.quotedText, Modifier.fillMaxWidth().heightIn(max = 120.dp).verticalScroll(rememberScrollState()).padding(10.dp), style = changeCodeStyle)
            }
            if (canExtend) TextButton(onClick = { extend(edited()) }, modifier = Modifier.heightIn(min = 48.dp)) { Text("Extend range") }
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (option in REVIEW_INTENTS) FilterChip(selected = intent == option, onClick = { intent = if (intent == option) null else option },
                    label = { Text(option) }, modifier = Modifier.heightIn(min = 48.dp))
            }
            OutlinedTextField(note, { note = it.take(4000) }, label = { Text("Note (optional)") }, modifier = Modifier.fillMaxWidth(), minLines = 2, maxLines = 4)
            Row(verticalAlignment = Alignment.CenterVertically) {
                Switch(checked = replacement != null, onCheckedChange = { replacement = if (it) comment.anchor.quotedText else null },
                    modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).semantics { contentDescription = "Suggest an edit" })
                Text("Suggest an edit", Modifier.padding(start = 12.dp).clearAndSetSemantics {})
            }
            replacement?.let {
                OutlinedTextField(it, { text -> replacement = text.take(MAX_CODE_QUOTE) }, label = { Text("Replacement lines") },
                    modifier = Modifier.fillMaxWidth(), minLines = 2, maxLines = 5, textStyle = changeCodeStyle)
            }
            patch?.let { SuggestionPreview(it) }
            problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = cancel, modifier = Modifier.heightIn(min = 48.dp)) { Text("Cancel") }
                Button(onClick = { save(edited()) }, enabled = intent != null || note.isNotBlank() || patch != null,
                    modifier = Modifier.heightIn(min = 48.dp)) { Text(if (editing) "Save comment" else "Add comment") }
            }
        }
    }
}

@Composable private fun SuggestionPreview(patch: String) {
    val colors = Jarvis.colors
    Text("Suggested edit", style = MaterialTheme.typography.labelLarge)
    Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium) {
        Column(Modifier.fillMaxWidth().heightIn(max = 120.dp).verticalScroll(rememberScrollState()).padding(8.dp)) {
            codeLines(patch).drop(3).forEach { Text(it, style = changeCodeStyle, color = if (it.startsWith("+")) colors.success else colors.danger) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun CodeReviewSheet(taskId: String, review: CodeReview, sending: Boolean, problem: String?, close: () -> Unit,
                                         overall: (String) -> Unit, edit: (CodeComment) -> Unit, remove: (CodeComment) -> Unit,
                                         send: () -> Unit, draft: () -> Unit) {
    ModalBottomSheet(onDismissRequest = close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true,
        confirmValueChange = { !sending || it != SheetValue.Hidden })) {
        Column(Modifier.fillMaxWidth().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text("Review · ${reviewCommentCount(review.comments.size)}", Modifier.semantics { heading() }, style = MaterialTheme.typography.titleLarge)
            Text("Send one message to the agent. It appears under Your notes on $taskId.", color = Jarvis.colors.fgMuted, style = MaterialTheme.typography.bodySmall)
            problem?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            if (review.comments.isEmpty()) Text("Tap a line number in the diff to add a comment.")
            for ((index, comment) in review.comments.withIndex()) Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium) {
                Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text("${index + 1}. ${comment.intent ?: "Note"}" + if (comment.outdated) " · Outdated" else "", style = MaterialTheme.typography.titleSmall)
                    Text(comment.anchor.location() + if (comment.source.kind == "commit") " · ${comment.source.key().take(12)}" else "", style = MaterialTheme.typography.labelMedium)
                    Text(comment.anchor.quotedText, maxLines = 3, style = changeCodeStyle)
                    if (comment.note.isNotEmpty()) Text(comment.note)
                    suggestedPatch(comment.anchor, comment.replacement)?.let { SuggestionPreview(it) }
                    Row {
                        TextButton(onClick = { edit(comment) }, enabled = !sending, modifier = Modifier.heightIn(min = 48.dp)) { Text("Edit comment") }
                        TextButton(onClick = { remove(comment) }, enabled = !sending, modifier = Modifier.heightIn(min = 48.dp)) { Text("Remove") }
                    }
                }
            }
            OutlinedTextField(review.overall, { overall(it.take(4000)) }, enabled = !sending, label = { Text("Overall note (optional)") },
                modifier = Modifier.fillMaxWidth(), maxLines = 4)
            Button(onClick = send, enabled = !sending && review.comments.isNotEmpty(), modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Text(if (sending) "Working…" else "Send ${reviewCommentCount(review.comments.size)}")
            }
            OutlinedButton(onClick = draft, enabled = !sending && review.comments.isNotEmpty(), modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Add to chat draft") }
        }
    }
}
