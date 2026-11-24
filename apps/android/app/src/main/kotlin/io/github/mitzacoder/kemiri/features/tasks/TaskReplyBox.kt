package io.github.mitzacoder.kemiri.features.tasks

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.content.contentReceiver
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.input.TextFieldState
import androidx.compose.foundation.text.input.rememberTextFieldState
import androidx.compose.foundation.text.input.setTextAndPlaceCursorAtEnd
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.features.chat.*
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonPrimitive

internal data class TaskReplyState(
    val taskId: String,
    val text: TextFieldState,
    val hint: String,
    val images: List<DraftImage>,
    val attachments: List<ChatFile>,
    val attaching: Boolean,
    val attachEnabled: Boolean,
    val attachLabel: String,
    val sending: Boolean,
    val sent: Boolean,
    val problem: String?,
    val fieldModifier: Modifier,
    val onAttach: () -> Unit,
    val onRemoveImage: (String) -> Unit,
    val onRemoveFile: (String) -> Unit,
    val onSend: () -> Unit,
)

/**
 * Talk about the task: the message goes to the coordinator in main's chat with the task's ID (the server writes
 * `[task T4] ` before it), whichever chat the sheet sits on; main passes it on to a thread that holds the task.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun rememberTaskReply(context: ProjectScreenContext, task: BoardTask, replyThread: String?, replyTitle: String, focus: FocusRequester): TaskReplyState {
    // Typed in a text field's own state, so the field can take pasted and keyboard images; kept per task.
    val reply = key(task.id) { rememberTextFieldState() }
    var sending by remember { mutableStateOf(false) }
    var sent by remember { mutableStateOf(false) }
    var replyProblem by remember { mutableStateOf<String?>(null) }
    // Images wait here, in memory only (the reply has no draft), until the message is sent.
    var images by remember(task.id) { mutableStateOf(listOf<DraftImage>()) }
    var attachments by remember(task.id) { mutableStateOf(listOf<ChatFile>()) }
    val android = LocalContext.current
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    var attaching by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    // Typing again after a send clears "Sent".
    LaunchedEffect(reply) { snapshotFlow { reply.text.toString() }.collect { if (it.isNotEmpty()) sent = false } }
    suspend fun addImages(files: List<Pair<RawImage?, String?>>) {
            replyProblem = attachFiles(files) { image ->
                val id = sha256Hex(image.bytes)
                when {
                    images.any { it.ref.id == id } -> null
                    else -> messageLimitError(images.size, images.sumOf { it.bytes?.size ?: 0 }, image.bytes.size, image.name) ?: run {
                        images = images + DraftImage(DraftAttachment(id = id, mimeType = image.mimeType, size = image.bytes.size.toLong(), name = image.name), image.bytes)
                        null
                    }
                }
            }
    }
    val intake = rememberImageIntake { files ->
        attaching = true
        try { addImages(files) } finally { attaching = false }
    }
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) scope.launch {
            attaching = true; replyProblem = null
            try {
                for (uri in uris) {
                    if (images.size + attachments.size >= INPUT_MAX_IMAGES) { replyProblem = "A message holds at most 8 attachments"; break }
                    try {
                        if (android.contentResolver.getType(uri) in INPUT_IMAGE_MIME_TYPES) {
                            val raw = withContext(Dispatchers.IO) { readRawImage(android.contentResolver, uri) }
                            addImages(listOf(raw to null))
                        } else attachments = attachments + uploadChatFile(context.backend.client, android.contentResolver, context.route.projectId, replyThread, uri)
                    } catch (cause: CancellationException) { throw cause }
                    catch (cause: Exception) { replyProblem = cause.message ?: "Could not attach file" }
                }
            } finally { attaching = false }
        }
    }
    fun send() {
        val text = reply.text.toString().trim()
        if ((text.isEmpty() && images.isEmpty() && attachments.isEmpty()) || sending || attaching) return
        sending = true
        replyProblem = null
        val sentImages = images
        val sentAttachments = attachments
        scope.launch {
            try {
                val blocks = sentImages.mapNotNull { image -> image.bytes?.let { imageBlock(image.ref.mimeType, it) } }
                context.backend.client.request(ConversationSubmitRequest(
                    projectId = context.route.projectId, threadId = null, requestId = java.util.UUID.randomUUID().toString(),
                    content = if (blocks.isEmpty()) JsonPrimitive(text) else kotlinx.serialization.json.buildJsonArray {
                        if (text.isNotEmpty()) add(kotlinx.serialization.json.buildJsonObject { put("type", JsonPrimitive("text")); put("text", JsonPrimitive(text)) })
                        blocks.forEach { add(it) }
                    },
                    whenBusy = "steer", taskId = task.id, fileIds = sentAttachments.map { it.id },
                ))
                reply.setTextAndPlaceCursorAtEnd("")
                // What was sent goes; images added while the request was out stay.
                images = images.filterNot { image -> sentImages.any { it.ref.id == image.ref.id } }
                attachments = attachments.filterNot { file -> sentAttachments.any { it.id == file.id } }
                sent = true
            } catch (cause: CancellationException) { throw cause }
            catch (cause: Exception) { replyProblem = cause.message ?: "Could not send" }
            finally { sending = false }
        }
    }
    val chatFilesEnabled = connection.supports("chat-files-v1")
    return TaskReplyState(
        taskId = task.id, text = reply,
        hint = "Message $replyTitle…",
        images = images, attachments = attachments, attaching = attaching,
        attachEnabled = !attaching && !sending && images.size + attachments.size < INPUT_MAX_IMAGES,
        attachLabel = if (chatFilesEnabled) "Attach files" else "Attach images",
        sending = sending, sent = sent, problem = replyProblem,
        fieldModifier = Modifier.focusRequester(focus).contentReceiver(intake.receiver).semantics { contentDescription = "Message about ${task.id}" },
        onAttach = if (chatFilesEnabled) ({ filePicker.launch(arrayOf("*/*")) }) else intake.pick,
        onRemoveImage = { id -> images = images.filterNot { it.ref.id == id } },
        onRemoveFile = { id -> attachments = attachments.filterNot { it.id == id } },
        onSend = ::send,
    )
}

@Composable
internal fun TaskReplyBox(reply: TaskReplyState, onDismiss: () -> Unit, inputMaxHeight: Dp) {
    val colors = Jarvis.colors
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
        MessageComposer(
            textState = reply.text,
            hint = reply.hint,
            hintMaxLines = 1,
            compact = true,
            images = reply.images,
            onRemoveImage = reply.onRemoveImage,
            attaching = reply.attaching,
            attachEnabled = reply.attachEnabled,
            attachLabel = reply.attachLabel,
            onAttach = reply.onAttach,
            beforeInput = { if (reply.attachments.isNotEmpty()) FileChips(reply.attachments, onRemove = reply.onRemoveFile) },
            sendLabel = if (reply.sending) "Sending" else "Send to the coordinator about ${reply.taskId}",
            sendEnabled = !reply.sending && !reply.attaching && (reply.text.text.isNotBlank() || reply.images.isNotEmpty() || reply.attachments.isNotEmpty()),
            onSend = reply.onSend,
            modifier = Modifier.fillMaxWidth(),
            fieldModifier = Modifier.heightIn(max = inputMaxHeight).then(reply.fieldModifier),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
        )
        when {
            reply.problem != null -> Text(reply.problem, Modifier.padding(horizontal = 8.dp, vertical = 4.dp), style = TaskType.xs, color = colors.danger)
            reply.sent -> Row(Modifier.padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Sent. The answer appears in the chat.", style = TaskType.xs, color = colors.fgMuted)
                Text("Back to the chat", Modifier.clickableLink("Back to the chat", onDismiss).padding(vertical = 4.dp),
                    style = TaskType.xs.copy(textDecoration = TextDecoration.Underline), color = colors.fgMuted)
            }
        }
    }
}
