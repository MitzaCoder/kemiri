package io.github.mitzacoder.kemiri.features.files

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.data.request
import io.github.mitzacoder.kemiri.features.changes.*
import io.github.mitzacoder.kemiri.features.chat.*
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.CodeRootThread
import io.github.mitzacoder.kemiri.protocol.FilesReadRequest
import io.github.mitzacoder.kemiri.protocol.FilesReadResponse
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import java.util.UUID

@Composable internal fun CheckoutFileViewer(context: ProjectScreenContext, route: Destination.Files, path: String) {
    // Reveal is not saveable or shared with another file, checkout, or navigation entry.
    var reveal by remember(route.root, path) { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }
    val read by key(reveal, attempt) {
        produceState<ChangesRead<FilesReadResponse>>(ChangesRead.Loading) {
            value = fetchChanges { context.backend.client.request(FilesReadRequest(projectId = route.chat.projectId,
                root = route.root, path = path, reveal = true.takeIf { reveal })) }
        }
    }
    val language = remember(path) { changeLanguage(path).ifEmpty { "Plain text" } }
    when (val response = read) {
        ChangesRead.Loading -> ChangesLoading()
        is ChangesRead.Failed -> ChangesNotice(response.message) { attempt++ }
        is ChangesRead.Ready -> {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically) {
                Text("$language · ${fileBytes(response.document.size)}", color = Jarvis.colors.fgMuted, style = MaterialTheme.typography.labelLarge)
                Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerHigh) {
                    Text("Read-only", Modifier.padding(horizontal = 8.dp, vertical = 4.dp), style = MaterialTheme.typography.labelMedium)
                }
            }
            when (val file = checkoutFile(response.document)) {
                CheckoutFile.Sensitive -> Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Hidden by default", style = MaterialTheme.typography.titleMedium)
                    Text("This filename may contain sensitive material.", color = Jarvis.colors.fgMuted)
                    OutlinedButton({ reveal = true }, enabled = !reveal) { Text("Show") }
                }
                is CheckoutFile.Binary -> ChangesNotice("Binary file · ${file.mime}")
                is CheckoutFile.TooLarge -> ChangesNotice("Too large to preview · ${fileBytes(file.bytes)}")
                CheckoutFile.Unavailable -> ChangesNotice("No text preview is available.")
                is CheckoutFile.Text -> FileSourceReview(context, route, path, file, language in setOf("markdown", "md", "mdx"))
            }
        }
    }
}

@Composable private fun FileSourceReview(context: ProjectScreenContext, route: Destination.Files, path: String, file: CheckoutFile.Text, markdown: Boolean) {
    val android = LocalContext.current
    val scope = rememberCoroutineScope()
    val storage = remember(android) { PreferenceReviewStorage(android.applicationContext, "kemiri-code-reviews") }
    val root = route.root.rootKey()
    val reviewKey = remember(context.backend.config.key, route.chat.projectId, root, path) {
        "file-review.v1:" + Json.encodeToString(listOf(context.backend.config.key, route.chat.projectId, root, path))
    }
    val source = remember(root, path, file.hash) { CodeReviewSource("file", root = root, path = path, hash = file.hash) }
    val lines by produceState(emptyList<String>(), file.hash) { value = withContext(Dispatchers.Default) { codeLines(file.text) } }
    var review by remember(reviewKey) { mutableStateOf(loadCodeReview(storage, reviewKey)) }
    var editor by remember { mutableStateOf<CodeComment?>(null) }
    var extending by remember { mutableStateOf<CodeComment?>(null) }
    var tray by rememberSaveable { mutableStateOf(false) }
    var sourceMode by rememberSaveable { mutableStateOf(!markdown || route.line != null) }
    var sending by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    fun update(next: CodeReview) {
        review = next
        if (!saveCodeReview(storage, reviewKey, next)) status = "Could not save on this device. Keep this screen open until sending."
    }
    LaunchedEffect(lines, source) {
        if (lines.isEmpty() || review.attempt != null) return@LaunchedEffect
        val reconciled = reconcileFileComments(review.comments, source, lines)
        if (reconciled != review.comments) update(review.copy(comments = reconciled))
    }
    fun comment(number: Int, range: Boolean) {
        if (sending) return
        val previous = extending
        if (previous == null && review.comments.size >= MAX_CODE_COMMENTS) { status = "This review holds 40 comments."; tray = true; return }
        val start = previous?.anchor?.startLine ?: number
        val anchor = anchorCodeLines(lines, path, "file", minOf(start, number), maxOf(start, number))
        if (anchor == null) { status = "Select up to 100 lines and 4,000 characters."; return }
        val draft = previous?.copy(anchor = anchor, replacement = extendReplacement(lines, anchor, previous))
            ?: CodeComment(UUID.randomUUID().toString(), source, anchor)
        if ((draft.replacement?.length ?: 0) > MAX_CODE_QUOTE) { status = "The replacement would be too long for this range."; return }
        status = null
        if (previous == null && range) extending = draft else { extending = null; editor = draft }
    }
    fun transfer(toDraft: Boolean) {
        if (sending || review.comments.isEmpty()) return
        sending = true; status = null
        val recipient = route.chat.copy(threadId = reviewThreadId(route.taskId, (route.root as? CodeRootThread)?.threadId ?: route.chat.threadId),
            workerId = null, highlight = null)
        scope.launch {
            try {
                val message = formatCodeReview(source, review)
                if (toDraft) appendArtifactReviewDraft(android, context, recipient, message, route.taskId)
                else {
                    val attempt = codeReviewAttempt(review.attempt, message)
                    update(review.copy(attempt = attempt))
                    submitReview(context, recipient, message, route.taskId, attempt.requestId)
                }
                update(CodeReview()); tray = false
                if (toDraft) context.navigate(recipient)
                else status = if (route.taskId == null) "Review sent to chat." else "Review sent to ${route.taskId}."
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { status = "The review was not transferred. The comments are still here." }
            finally { sending = false }
        }
    }
    Column(Modifier.fillMaxSize()) {
        if (markdown) Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(!sourceMode, { sourceMode = false; extending = null }, label = { Text("Preview") }, modifier = Modifier.heightIn(min = 48.dp))
            FilterChip(sourceMode, { sourceMode = true }, label = { Text("Source") }, modifier = Modifier.heightIn(min = 48.dp))
        }
        if (extending != null) Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Tap the last line of the range", Modifier.weight(1f))
            TextButton({ extending = null }) { Text("Cancel") }
        }
        status?.takeIf { !tray && editor == null }?.let { Text(it, Modifier.padding(12.dp)) }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (!sourceMode) HarnessMarkdown(file.text, Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp))
            else if (lines.isEmpty()) ChangesLoading()
            else {
                val highlighted = highlightedChangeLines(lines, path)
                val pins = remember(review.comments, source) {
                    review.comments.withIndex().filter { it.value.source == source && !it.value.outdated }.groupBy { it.value.anchor.startLine }
                }
                val focus = route.line?.coerceIn(1, lines.size)
                val scroll = rememberLazyListState(initialFirstVisibleItemIndex = ((focus ?: 1) - 3).coerceAtLeast(0))
                LazyColumn(state = scroll, contentPadding = PaddingValues(vertical = 8.dp)) {
                    itemsIndexed(lines, key = { index, _ -> index }) { index, text ->
                        val number = index + 1
                        ReviewCodeLine(number, text, "Line $number", highlighted.getOrNull(index), pins = pins[number].orEmpty().map { it.index + 1 },
                            selected = number == (extending?.anchor?.startLine ?: focus), onComment = { comment(number, it) }, onPin = { tray = true })
                    }
                }
            }
        }
        if (sourceMode || review.comments.isNotEmpty()) Surface(shadowElevation = 4.dp) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                TextButton({ tray = true }, enabled = !sending) { Text(reviewCommentCount(review.comments.size)) }
                Button({ tray = true }, enabled = !sending && review.comments.isNotEmpty()) { Text("Send") }
            }
        }
    }
    val comment = editor
    if (comment != null) CodeCommentSheet(comment, review.comments.any { it.id == comment.id }, status, { editor = null; status = null },
        canExtend = !comment.outdated && comment.anchor.startLine == comment.anchor.endLine,
        extend = { extending = it; tray = false; editor = null; sourceMode = true }, save = { saved ->
            val existing = review.comments
            val next = review.copy(comments = if (existing.any { it.id == saved.id }) existing.map { if (it.id == saved.id) saved else it } else existing + saved)
            if (codeReviewFits(next)) { status = null; update(next); editor = null } else status = "This review is full. Send or remove a saved comment first."
        })
    else if (tray) CodeReviewSheet(route.taskId, review, sending, status, { if (!sending) tray = false },
        overall = { update(review.copy(overall = it)) }, edit = { editor = it; status = null },
        remove = { update(review.copy(comments = review.comments.filterNot { row -> row.id == it.id })) },
        send = { transfer(false) }, draft = { transfer(true) })
}

internal fun reconcileFileComments(comments: List<CodeComment>, source: CodeReviewSource, lines: List<String>): List<CodeComment> = comments.map { comment ->
    if (comment.anchor.side != "file" || comment.source.root != source.root || comment.source.path != source.path) comment
    else reanchorCodeLines(lines, comment.anchor)?.let { comment.copy(source = source, anchor = it, outdated = false) }
        ?: comment.copy(outdated = true)
}
