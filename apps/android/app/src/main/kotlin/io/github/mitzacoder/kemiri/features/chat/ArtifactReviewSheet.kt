package io.github.mitzacoder.kemiri.features.chat

import android.content.Context
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.Artifact
import io.github.mitzacoder.kemiri.protocol.ConversationSubmitRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonPrimitive

internal class PreferenceReviewStorage(context: Context, name: String = "kemiri-artifact-reviews") : ReviewStorage {
    private val preferences = context.getSharedPreferences(name, Context.MODE_PRIVATE)
    override fun get(key: String) = preferences.getString(key, null)
    override fun set(key: String, text: String) { check(preferences.edit().putString(key, text).commit()) }
    override fun remove(key: String) { check(preferences.edit().remove(key).commit()) }
}
@Stable internal class ArtifactReviewState(private val storage: ReviewStorage, private val key: String) {
    var review by mutableStateOf(loadArtifactReview(storage, key)); private set
    var sending by mutableStateOf(false)
    var tray by mutableStateOf(false); private set
    var pinAnchor by mutableStateOf<String?>(null); private set
    var selection by mutableStateOf<ArtifactSelection?>(null)
    var editing by mutableStateOf<Int?>(null)
    var status by mutableStateOf<String?>(null)
    val submission = ArtifactReviewSubmission()
    fun update(next: ArtifactReview) {
        review = next
        if (!saveArtifactReview(storage, key, next)) status = "Could not save on this device. Keep this viewer open until sending."
    }
    fun closePreview() { pinAnchor = null }
    fun closeTray() { tray = false }
    fun showTray() { closePreview(); tray = true }
    fun preview(anchor: String) {
        if (sending || selection != null) return
        closeTray(); pinAnchor = anchor
    }
    fun edit(index: Int) {
        if (sending) return
        review.comments.getOrNull(index)?.let { editing = index; selection = it.selection() }
    }
    fun delete(index: Int) {
        if (sending) return
        update(review.copy(comments = review.comments.filterIndexed { i, _ -> i != index }))
        if (review.comments.none { it.anchor == pinAnchor }) closePreview()
    }
    fun comment(selection: ArtifactSelection) {
        if (sending) { tray = true; return }
        if (review.comments.size >= 100) { status = "A review can hold 100 comments. Remove one first."; tray = true; return }
        closeTray(); closePreview(); editing = null; this.selection = selection
    }
}
@Composable internal fun rememberArtifactReview(context: ProjectScreenContext, artifact: Artifact?): ArtifactReviewState? {
    val android = LocalContext.current
    val storage = remember(android) { PreferenceReviewStorage(android.applicationContext) }
    val key = artifact?.takeIf { it.kind == "text" }?.let { artifactReviewKey(context.backend.config.key, context.route.projectId, it.id, it.version ?: 1L) }
    return remember(key) { key?.let { ArtifactReviewState(storage, it) } }
}
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable internal fun ArtifactReviewSheets(state: ArtifactReviewState, context: ProjectScreenContext, artifact: Artifact) {
    val scope = rememberCoroutineScope()
    val android = LocalContext.current
    val sending = state.sending
    val selection = state.selection
    if (selection != null) {
        val previous = state.editing?.let { state.review.comments.getOrNull(it) }
        var intent by remember(selection, state.editing) { mutableStateOf(previous?.intent) }
        var note by remember(selection, state.editing) { mutableStateOf(previous?.note.orEmpty()) }
        ModalBottomSheet(onDismissRequest = { state.selection = null }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(if (previous == null) "Comment" else "Edit comment", style = MaterialTheme.typography.titleLarge)
                val location = reviewLocation(selection)
                if (location.isNotEmpty()) Text(location, style = MaterialTheme.typography.labelLarge)
                Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium) {
                    Text(selection.text, Modifier.fillMaxWidth().heightIn(max = 180.dp).verticalScroll(rememberScrollState()).padding(12.dp))
                }
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    for (option in REVIEW_INTENTS) FilterChip(selected = intent == option, onClick = { intent = if (intent == option) null else option }, label = { Text(option) }, modifier = Modifier.heightIn(min = 48.dp))
                }
                OutlinedTextField(note, { note = it.take(4000) }, label = { Text("Note (optional)") }, modifier = Modifier.fillMaxWidth(), minLines = 2, maxLines = 5)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = { state.selection = null }) { Text("Cancel") }
                    Button(enabled = intent != null || note.isNotBlank(), onClick = {
                        val comment = ReviewComment(selection.text, selection.section, selection.elementId, selection.block, intent, reviewText(note, 4000), selection.anchor)
                        val comments = state.review.comments.toMutableList()
                        state.editing?.let { comments[it] = comment } ?: comments.add(comment)
                        state.update(state.review.copy(comments = comments)); state.selection = null
                    }) { Text(if (previous == null) "Add comment" else "Save comment") }
                }
            }
        }
    } else if (state.pinAnchor != null) {
        val comments = state.review.comments.withIndex().filter { it.value.anchor == state.pinAnchor }
        ModalBottomSheet(onDismissRequest = state::closePreview, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(reviewCommentCount(comments.size).replaceFirstChar(Char::titlecase), style = MaterialTheme.typography.titleLarge)
                comments.firstOrNull()?.value?.let { Text(it.text, maxLines = 3) }
                for ((index, comment) in comments) Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium) {
                    Column(Modifier.fillMaxWidth().padding(12.dp)) {
                        Text(comment.intent ?: "Note", style = MaterialTheme.typography.labelLarge)
                        if (comment.note.isNotBlank()) Text(comment.note, Modifier.padding(top = 6.dp))
                        Row {
                            TextButton(onClick = { state.edit(index) }) { Text("Edit comment ${index + 1}") }
                            TextButton(onClick = { state.delete(index) }) { Text("Delete comment ${index + 1}") }
                        }
                    }
                }
            }
        }
    } else if (state.tray) {
        ModalBottomSheet(onDismissRequest = { state.closeTray() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Review pass · ${reviewCommentCount(state.review.comments.size)}", style = MaterialTheme.typography.titleLarge)
                state.status?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                for ((index, comment) in state.review.comments.withIndex()) Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium) {
                    Column(Modifier.fillMaxWidth().padding(12.dp)) {
                        Text("${index + 1}. ${comment.intent ?: "Note"}" + reviewLocation(comment.selection()).let { if (it.isEmpty()) "" else " · $it" }, style = MaterialTheme.typography.labelLarge)
                        Text(comment.text, maxLines = 4)
                        if (comment.note.isNotBlank()) Text(comment.note, Modifier.padding(top = 8.dp))
                        Row {
                            TextButton(enabled = !sending, onClick = { state.edit(index) }) { Text("Edit comment ${index + 1}") }
                            TextButton(enabled = !sending, onClick = { state.delete(index) }) { Text("Remove comment ${index + 1}") }
                        }
                    }
                }
                OutlinedTextField(state.review.overall, { state.update(state.review.copy(overall = it.take(4000))) }, enabled = !sending,
                    label = { Text("Overall note (optional)") }, modifier = Modifier.fillMaxWidth(), maxLines = 4)
                val hasReview = state.review.comments.isNotEmpty() || state.review.overall.isNotBlank()
                fun transfer(draft: Boolean) {
                    if (state.sending) return
                    state.sending = true; state.status = null
                    val formatted = formatArtifactReview(ReviewArtifact(artifactTitle(artifact), artifact.id, artifact.version ?: 1L, artifact.name), state.review)
                    val recipient = context.route.copy(threadId = reviewThreadId(artifact.taskId, context.route.threadId), workerId = null, highlight = null)
                    scope.launch {
                        try {
                            if (draft) appendArtifactReviewDraft(android, context, recipient, formatted, artifact.taskId)
                            else submitReview(context, recipient, formatted, artifact.taskId, state.submission.requestIdFor(formatted))
                            state.submission.accepted(); state.update(ArtifactReview()); state.closeTray()
                            context.navigate(recipient)
                        } catch (e: CancellationException) { throw e }
                        catch (_: Exception) { state.status = if (draft) "Could not add to the draft. Your comments are still here." else "Send was not confirmed. Your comments are still here; retry when connected." }
                        finally { state.sending = false }
                    }
                }
                Button(onClick = { transfer(false) }, enabled = hasReview && !sending, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                    Text(if (sending) "Working…" else "Send ${reviewCommentCount(state.review.comments.size)}")
                }
                OutlinedButton(onClick = { transfer(true) }, enabled = hasReview && !sending, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) { Text("Add to chat draft") }
                TextButton(enabled = !sending, onClick = { state.closeTray() }) { Text("Continue reviewing") }
            }
        }
    }
}
@OptIn(ExperimentalMaterial3Api::class)
@Composable internal fun ArtifactParagraphPicker(text: String, dismiss: () -> Unit, choose: (ArtifactSelection) -> Unit) {
    val paragraphs = remember(text) { artifactReviewParagraphs(text) }
    ModalBottomSheet(onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("Pick a paragraph", style = MaterialTheme.typography.titleLarge)
            Text("Choose the passage to comment on. Source formatting is kept.")
            for ((index, paragraph) in paragraphs.withIndex()) OutlinedButton(onClick = { choose(paragraph) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)) {
                Column(Modifier.fillMaxWidth()) {
                    if (!paragraph.section.isNullOrEmpty()) Text(paragraph.section, style = MaterialTheme.typography.labelLarge)
                    Text("${index + 1}. ${paragraph.text}", maxLines = 5)
                }
            }
            TextButton(onClick = dismiss) { Text("Cancel") }
        }
    }
}

/** Both review surfaces record feedback using the existing conversation submission, not a second board write. */
internal suspend fun submitReview(context: ProjectScreenContext, recipient: io.github.mitzacoder.kemiri.navigation.Destination.Chat,
                                  text: String, taskId: String?, requestId: String) {
    context.backend.client.request(ConversationSubmitRequest(projectId = recipient.projectId, threadId = recipient.threadId,
        requestId = requestId, content = JsonPrimitive(text), taskId = taskId, whenBusy = "steer", keepDraft = true))
}
