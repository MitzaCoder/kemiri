package io.github.mitzacoder.kemiri.features.tasks

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.chat.markdownText
import io.github.mitzacoder.kemiri.protocol.BoardFeedback
import io.github.mitzacoder.kemiri.ui.theme.Jarvis

@Composable
internal fun TaskFeedback(
    entries: List<BoardFeedback>, busy: Boolean, now: Long, threadName: (String) -> String,
    onSetState: (BoardFeedback, String) -> Unit, linkedFeedbackId: String?, revealLinkedNote: Boolean, onRevealed: () -> Unit,
) {
    val colors = Jarvis.colors
    Column {
        sortedFeedback(entries).forEach { entry -> key(entry.id) {
            val linked = entry.id == linkedFeedbackId
            val requester = remember { BringIntoViewRequester() }
            var measured by remember { mutableStateOf(false) }
            LaunchedEffect(linked, revealLinkedNote, measured) {
                if (linked && revealLinkedNote && measured) {
                    // Reveal the start even when the note itself is taller than the viewport.
                    requester.bringIntoView(Rect(0f, 0f, 1f, 1f))
                    onRevealed()
                }
            }
            Column(if (linked) Modifier.fillMaxWidth().bringIntoViewRequester(requester).onSizeChanged { measured = it.height > 0 }
                .background(colors.accent2.copy(alpha = .07f), RoundedCornerShape(8.dp))
                .semantics { stateDescription = "Linked note" }
                .padding(horizontal = 8.dp) else Modifier.fillMaxWidth()) {
                val settled = entry.state == "addressed" || entry.state == "dismissed"
                if (settled) {
                    var expanded by rememberSaveable(linked) { mutableStateOf(linked) }
                    TaskFold(expanded, { expanded = !expanded }, heading = {
                        TaskDetailText(markdownText(entry.text).ifBlank { "Note with attachment" }, Modifier.weight(1f), style = TaskType.sectionTitle,
                            color = colors.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(feedbackStateWords(entry.state), style = TaskType.meta, color = colors.fgMuted)
                    }) { TaskNote(entry, settled = true, busy, now, threadName, onSetState) }
                } else {
                    HorizontalDivider(color = colors.border)
                    Box(Modifier.padding(top = 8.dp)) { TaskNote(entry, settled = false, busy, now, threadName, onSetState) }
                }
            }
        } }
    }
}

@Composable
private fun TaskNote(entry: BoardFeedback, settled: Boolean, busy: Boolean, now: Long, threadName: (String) -> String, onSetState: (BoardFeedback, String) -> Unit) {
    val colors = Jarvis.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(listOfNotNull(feedbackStateWords(entry.state).takeUnless { settled }, relativeTime(entry.at, now),
            entry.threadId.takeUnless(::isMainThread)?.let(threadName)).joinToString(" · "), style = TaskType.meta, color = colors.fgMuted)
        ReportMarkdown(entry.text)
        entry.images?.takeIf { it > 0 }?.let { Text("$it image${if (it == 1L) "" else "s"}", style = TaskType.xs, color = colors.fgMuted) }
        entry.note?.takeIf { it.isNotBlank() }?.let { note ->
            Column(Modifier.drawBehind {
                val inset = 1.dp.toPx()
                drawLine(colors.borderStrong, Offset(inset, 0f), Offset(inset, size.height), strokeWidth = inset * 2)
            }.padding(start = 12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                TaskHeading("Reply")
                ReportMarkdown(note)
            }
        }
        TextButton(onClick = { onSetState(entry, if (settled) "open" else "dismissed") }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) {
            Text(if (settled) "Reopen note" else "Dismiss note")
        }
    }
}
