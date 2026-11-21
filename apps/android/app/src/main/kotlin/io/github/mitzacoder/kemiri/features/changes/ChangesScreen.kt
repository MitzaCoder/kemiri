package io.github.mitzacoder.kemiri.features.changes

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.request
import io.github.mitzacoder.kemiri.features.chat.*
import io.github.mitzacoder.kemiri.features.files.*
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.components.JarvisIconButton
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.util.UUID

internal sealed interface ChangesRead<out T> {
    data object Loading : ChangesRead<Nothing>
    data class Ready<T>(val document: T) : ChangesRead<T>
    data class Failed(val message: String) : ChangesRead<Nothing>
}
internal suspend fun <T> fetchChanges(read: suspend () -> T): ChangesRead<T> = try { ChangesRead.Ready(read()) }
catch (e: CancellationException) { throw e }
catch (e: Exception) { ChangesRead.Failed(e.message?.take(300) ?: "Could not read these changes.") }

@Composable internal fun ChangesScreen(context: ProjectScreenContext, route: Destination.Changes, modifier: Modifier, onBack: () -> Unit) =
    ChangesScreen(context, route.taskId, route.title, route.commitHash, null, modifier, onBack)

@Composable internal fun WorkingChangesScreen(context: ProjectScreenContext, route: Destination.WorkingChanges, modifier: Modifier, onBack: () -> Unit) =
    ChangesScreen(context, route.taskId, route.title, null, route.root, modifier, onBack)

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun ChangesScreen(context: ProjectScreenContext, taskId: String?, title: String, initialCommit: String?,
                                      workingRoot: CodeRoot?, modifier: Modifier, onBack: () -> Unit) {
    val backend = context.backend
    val connection by backend.client.state.collectAsStateWithLifecycle()
    val project = context.route.projectId
    val android = LocalContext.current
    val storage = remember(android) { PreferenceReviewStorage(android.applicationContext, "kemiri-code-reviews") }
    val reviewKey = remember(backend.config.key, project, taskId, workingRoot) {
        codeReviewKey(backend.config.key, project, workingRoot?.let { "working:${it.rootKey()}" } ?: requireNotNull(taskId))
    }
    var review by remember(reviewKey) { mutableStateOf(loadCodeReview(storage, reviewKey)) }
    var status by remember(reviewKey) { mutableStateOf<String?>(null) }
    var sending by remember(reviewKey) { mutableStateOf(false) }
    var tray by rememberSaveable { mutableStateOf(false) }
    var filesOpen by rememberSaveable { mutableStateOf(false) }
    var editor by remember { mutableStateOf<CodeComment?>(null) }
    var extending by remember { mutableStateOf<CodeComment?>(null) }
    var chosenCommit by rememberSaveable { mutableStateOf(initialCommit) }
    var chosenPath by rememberSaveable { mutableStateOf<String?>(null) }
    var attempt by remember { mutableIntStateOf(0) }
    val viewedStore = remember(storage) { ViewedChanges(storage) }
    var viewed by remember(viewedStore) { mutableStateOf(viewedStore.load()) }
    val scope = rememberCoroutineScope()
    val reviewSource = remember(taskId, workingRoot, title) {
        if (workingRoot == null) CodeReviewSource("task", taskId = taskId) else CodeReviewSource("working", root = workingRoot.rootKey(), name = title)
    }
    val initialRequest = remember(taskId, workingRoot) {
        if (workingRoot == null) ChangeRequestSourceTask(taskId = requireNotNull(taskId)) else ChangeRequestSourceWorking(root = workingRoot)
    }
    val supported = connection.supports(PROJECT_CHANGES) && (workingRoot == null || connection.supports(WORKING_CHANGES))
    suspend fun list(source: ChangeRequestSource) = backend.client.request(ChangesListRequest(projectId = project, source = source))
    suspend fun file(source: ChangeRequestSource, path: String) = backend.client.request(ChangesFileRequest(projectId = project, source = source, path = path))

    val taskRead by produceState<ChangesRead<ChangesListResponse>>(ChangesRead.Loading, backend, project, initialRequest, supported, attempt) {
        value = ChangesRead.Loading
        if (supported) value = fetchChanges { list(initialRequest) }
    }
    val taskList = (taskRead as? ChangesRead.Ready)?.document
    val picker = taskList?.takeIf { workingRoot == null }?.let { commitPicker(it, chosenCommit) }
    val hash = picker?.hash
    val source = remember(hash, reviewSource) { hash?.let { CodeReviewSource("commit", hash = it) } ?: reviewSource }
    val request = remember(hash, initialRequest) { hash?.let { ChangeRequestSourceCommit(hash = it) } ?: initialRequest }
    val commitRead by key(hash) {
        produceState<ChangesRead<ChangesListResponse>>(ChangesRead.Loading, backend, project, supported, attempt) {
            value = ChangesRead.Loading
            if (supported && hash != null) value = fetchChanges { list(request) }
        }
    }
    val listRead = if (hash == null) taskRead else commitRead
    val listing = (listRead as? ChangesRead.Ready)?.document
    val files = listing?.files.orEmpty()
    val counts = remember(files) { changeCounts(files) }
    val selected = selectChangedFile(files, chosenPath)
    val index = selected?.let(files::indexOf) ?: -1
    val fileRead by key(request, selected?.path) {
        produceState<ChangesRead<ChangesFileResponse>>(ChangesRead.Loading, backend, project, supported, attempt) {
            value = ChangesRead.Loading
            if (supported && selected != null) value = fetchChanges { file(request, selected.path) }
        }
    }
    val response = (fileRead as? ChangesRead.Ready)?.document
    val diff by key(response) {
        produceState<ChangeDiff?>(null) {
            if (response != null && response.binary != true && response.tooLarge != true && response.sensitive != true) {
                value = withContext(Dispatchers.Default) { changeDiff(response.before?.text, response.after?.text) }
            }
        }
    }
    fun update(next: CodeReview) {
        review = next
        if (!saveCodeReview(storage, reviewKey, next)) status = "Could not save on this device. Keep this screen open until sending."
    }
    LaunchedEffect(response, diff, source, selected) {
        if (response == null || selected == null || sending) return@LaunchedEffect
        // Do not change the text of an unconfirmed request just by reopening a file.
        if (review.hasUnconfirmedAttempt(reviewSource)) return@LaunchedEffect
        if (diff == null && response.binary != true && response.tooLarge != true && response.sensitive != true) return@LaunchedEffect
        val comments = reconcileCodeComments(review.comments, source, selected.path, selected.previousPath, diff?.before.orEmpty(), diff?.after.orEmpty())
        if (comments != review.comments) update(review.copy(comments = comments))
    }
    fun select(path: String) { chosenPath = path; extending = null; filesOpen = false }
    var workingViewed by remember(attempt) { mutableStateOf(emptySet<String>()) }
    val viewedKeys = remember(backend, project, source, listing) {
        listing?.takeIf { workingRoot == null }?.files?.associate { it.path to viewedChangeKey(backend.config.key, project, source, listing, it.path) }.orEmpty()
    }
    fun setViewed(path: String, checked: Boolean) {
        if (workingRoot != null) workingViewed = if (checked) workingViewed + path else workingViewed - path
        else viewedKeys[path]?.let { viewed = viewedStore.set(viewed, it, checked) }
    }
    fun openComment(line: ChangeLine, range: Boolean) {
        if (sending || diff == null || selected == null) return
        val previous = extending
        if (previous == null && review.comments.size >= MAX_CODE_COMMENTS) {
            status = "This review holds 40 comments. Send or remove a comment first."; tray = true; return
        }
        val side = previous?.anchor?.side ?: line.side
        val number = (if (side == "before") line.before else line.after) ?: return
        val from = previous?.anchor?.startLine ?: number
        val doc = if (side == "before") diff!!.before else diff!!.after
        val anchor = anchorCodeLines(doc, selected.path, side, minOf(from, number), maxOf(from, number))
        if (anchor == null) { status = "Select up to 100 lines and 4,000 characters."; return }
        val comment = if (previous == null) CodeComment(UUID.randomUUID().toString(), source, anchor) else {
            val replacement = extendReplacement(doc, anchor, previous)
            if (replacement != null && replacement.length > MAX_CODE_QUOTE) { status = "The replacement would be too long for this range."; return }
            previous.copy(anchor = anchor, replacement = replacement)
        }
        status = null
        if (range && previous == null) extending = comment else { extending = null; editor = comment }
    }
    fun transfer(toDraft: Boolean) {
        if (sending || review.comments.isEmpty()) return
        sending = true; status = null
        val recipient = context.route.copy(threadId = reviewThreadId(taskId, (workingRoot as? CodeRootThread)?.threadId ?: context.route.threadId), workerId = null, highlight = null)
        scope.launch {
            try {
                // First establish whether the exact previous submission was accepted. Keep its payload on retry.
                if (!review.hasUnconfirmedAttempt(reviewSource)) {
                    val reconciled = recheckChangeComments(review.comments, reviewSource, { list(initialRequest) }) { file(initialRequest, it) }
                    if (reconciled != review.comments) update(review.copy(comments = reconciled))
                }
                val message = formatCodeReview(reviewSource, review)
                if (toDraft) appendArtifactReviewDraft(android, context, recipient, message, taskId)
                else {
                    val submission = codeReviewAttempt(review.attempt, message)
                    update(review.copy(attempt = submission))
                    submitReview(context, recipient, message, taskId, submission.requestId)
                }
                update(CodeReview()); tray = false
                if (toDraft) context.navigate(recipient) else onBack()
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { status = if (toDraft) "Could not add to the draft. Your comments are still here." else "Send was not confirmed. Your comments are still here; retry when connected." }
            finally { sending = false }
        }
    }

    Scaffold(modifier = modifier, topBar = {
        Column {
            TopAppBar(title = { Text("Changes", Modifier.semantics { heading() }) }, navigationIcon = {
                JarvisIconButton(Lucide.ArrowLeft, if (workingRoot == null) "Back to task" else "Back", onClick = onBack, enabled = !sending)
            }, actions = {
                if (connection.supports(PROJECT_FILES)) TextButton(onClick = {
                    val root = workingRoot ?: CodeRootProject()
                    context.navigate(Destination.Files(context.route, root = root, taskId = taskId))
                }, enabled = !sending) { Text("Files") }
                else TextButton(onClick = { filesOpen = true }, enabled = files.isNotEmpty() && !sending) { Text("Files") }
            })
            Box(Modifier.fillMaxWidth().height(2.dp).background(Jarvis.colors.grad()))
        }
    }, bottomBar = {
        if (supported) Surface(shadowElevation = 6.dp) {
            Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.SpaceBetween, verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = { tray = true }, enabled = !sending, modifier = Modifier.heightIn(min = 48.dp)) { Text(reviewCommentCount(review.comments.size)) }
                Button(onClick = { tray = true }, enabled = review.comments.isNotEmpty() && !sending, modifier = Modifier.heightIn(min = 48.dp)) { Text("Send") }
            }
        }
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
                if (workingRoot != null) {
                    Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
                    Text("Uncommitted changes", Modifier.semantics { heading() }, style = MaterialTheme.typography.titleLarge)
                    workingChangeMetadata(listing).forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted) }
                    TextButton({ extending = null; attempt++ }, enabled = !sending, modifier = Modifier.heightIn(min = 48.dp)) { Text("Refresh") }
                } else {
                    Text(taskId.orEmpty(), color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelLarge)
                    Text(title, Modifier.semantics { heading() }, style = MaterialTheme.typography.titleLarge, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    if (taskList != null && listing != null) {
                        val commits = taskList.commits.size
                        Text("$commits ${if (commits == 1) "commit" else "commits"} · ${counts.label()}${if (listing.truncated) " · partial" else ""}",
                            color = Jarvis.colors.fgMuted, style = MaterialTheme.typography.bodySmall)
                    }
                }
                if (picker != null && taskList.commits.isNotEmpty()) ChangeCommitMenu(taskList, picker, sending) {
                    chosenCommit = it; chosenPath = null; extending = null
                }
                picker?.reason?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted) }
            }
            HorizontalDivider()
            when {
                !supported -> ChangesNotice(if (connection.hello == null) "Waiting for this backend…" else "Changes are not available on this backend.")
                listRead is ChangesRead.Failed -> ChangesNotice((listRead as ChangesRead.Failed).message) { attempt++ }
                listing == null -> ChangesLoading()
                selected == null -> ChangesNotice("No changed files in this selection.")
                else -> {
                    ChangeFileBar(selected, index, files.size, { filesOpen = true }, { select(files[index - 1].path) }, { select(files[index + 1].path) })
                    HorizontalDivider()
                    if (selected.previousPath != null) Text("Renamed from ${selected.previousPath}", Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall)
                    if (extending != null) Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("Tap the last line of the range", Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
                        TextButton(onClick = { extending = null }) { Text("Cancel") }
                    }
                    if (status != null && !tray && editor == null) Text(status.orEmpty(), Modifier.padding(12.dp), color = MaterialTheme.colorScheme.error)
                    when {
                        fileRead is ChangesRead.Failed -> ChangesNotice((fileRead as ChangesRead.Failed).message) { attempt++ }
                        response == null -> ChangesLoading()
                        response.binary == true -> ChangesNotice("Binary file. No text diff is available.")
                        response.sensitive == true -> ChangesNotice("This file is hidden by the backend.")
                        response.tooLarge == true -> PlainChangePatch(response.patch, response.patchTruncated == true)
                        diff != null -> key(request, selected.path) {
                            UnifiedChangeDiff(diff!!, selected.path, selected.previousPath, review.comments, source, extending?.anchor,
                                onComment = ::openComment, onPin = { tray = true })
                        }
                        else -> ChangesLoading()
                    }
                }
            }
        }
    }
    if (filesOpen && supported) ChangeFilesSheet(files, selected?.path, { path -> if (workingRoot == null) viewedKeys[path] in viewed else path in workingViewed }, ::setViewed, ::select) { filesOpen = false }
    val comment = editor
    if (comment != null && supported) {
        CodeCommentSheet(comment, review.comments.any { it.id == comment.id }, status, { editor = null; status = null },
            canExtend = comment.anchor.startLine == comment.anchor.endLine && !comment.outdated && comment.source == source && comment.anchor.path == selected?.path && diff != null,
            extend = { extending = it; editor = null; tray = false }, save = { saved ->
                val comments = if (review.comments.any { it.id == saved.id }) review.comments.map { if (it.id == saved.id) saved else it } else review.comments + saved
                val next = review.copy(comments = comments)
                if (codeReviewFits(next)) { status = null; update(next); editor = null }
                else status = "This review is full. Send or remove a saved comment first."
            })
    } else if (tray && supported) {
        CodeReviewSheet(taskId, review, sending, status, { if (!sending) { tray = false; status = null } },
            overall = { update(review.copy(overall = it)) }, edit = { editor = it; status = null },
            remove = { update(review.copy(comments = review.comments.filterNot { row -> row.id == it.id })) }, send = { transfer(false) }, draft = { transfer(true) })
    }
}

private suspend fun recheckChangeComments(comments: List<CodeComment>, source: CodeReviewSource,
                                        list: suspend () -> ChangesListResponse, file: suspend (String) -> ChangesFileResponse): List<CodeComment> {
    val paths = comments.filter { it.source == source }.map { it.anchor.path }.distinct()
    if (paths.isEmpty()) return comments
    val listing = (fetchChanges(list) as? ChangesRead.Ready)?.document ?: return comments
    var checked = comments
    for (path in paths) {
        val row = listing.files.find { it.path == path } ?: listing.files.find { it.previousPath == path }
        // A failed read, a truncated list or a range that has split is not evidence the line disappeared.
        if (listing.contiguous == false && listing.nonContiguousReason != "no-commits" || (row == null && listing.truncated)) continue
        val response = if (row == null || row.binary) null else (fetchChanges { file(row.path) } as? ChangesRead.Ready)?.document ?: continue
        checked = withContext(Dispatchers.Default) {
            reconcileCodeComments(checked, source, row?.path ?: path, path,
                response?.before?.text?.let(::codeLines).orEmpty(), response?.after?.text?.let(::codeLines).orEmpty())
        }
    }
    return checked
}

@Composable private fun ChangeCommitMenu(list: ChangesListResponse, picker: CommitPicker, sending: Boolean, choose: (String?) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    val commit = list.commits.find { it.hash == picker.hash }
    Box {
        OutlinedButton(onClick = { expanded = true }, enabled = !sending, modifier = Modifier.heightIn(min = 48.dp)) {
            Text(commit?.let { "${it.hash.take(7)} · ${it.subject}" } ?: "All commits", maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        DropdownMenu(expanded, { expanded = false }) {
            if (picker.allowAll) DropdownMenuItem(text = { Text("All commits") }, onClick = { choose(null); expanded = false })
            list.commits.forEach { row -> DropdownMenuItem(text = { Text("${row.hash.take(7)} · ${row.subject}", maxLines = 2) }, onClick = { choose(row.hash); expanded = false }) }
        }
    }
}

@Composable internal fun ChangesNotice(text: String, retry: (() -> Unit)? = null) {
    Column(Modifier.fillMaxWidth().padding(20.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(text, color = Jarvis.colors.fgMuted)
        if (retry != null) OutlinedButton(onClick = retry) { Text("Retry") }
    }
}
@Composable internal fun ChangesLoading() {
    Box(Modifier.fillMaxWidth().padding(24.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
}
