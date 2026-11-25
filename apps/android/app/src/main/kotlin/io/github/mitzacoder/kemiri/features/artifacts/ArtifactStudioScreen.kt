package io.github.mitzacoder.kemiri.features.artifacts

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.features.chat.*
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.components.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ArtifactStudioScreen(context: ProjectScreenContext, artifactId: String, close: () -> Unit,
    modifier: Modifier, onDiscuss: ((Artifact) -> Unit)? = null) {
    val client = context.backend.client
    val connection by client.state.collectAsStateWithLifecycle()
    val supported = connection.supports("artifact-library")
    val online = connection.status == ConnectionStatus.Ready
    val projects by context.backend.projects.collectAsStateWithLifecycle()
    val projectName = projects.find { it.id == context.route.projectId }?.name
    val scope = rememberCoroutineScope()
    var artifact by remember(artifactId) { mutableStateOf<Artifact?>(null) }
    var viewedForDiscussion by remember(artifactId) { mutableStateOf<Artifact?>(null) }
    var folders by remember(artifactId) { mutableStateOf(emptyList<ArtifactTaskFolder>()) }
    var comments by remember(artifactId) { mutableStateOf(emptyList<ArtifactComment>()) }
    var trailRevision by remember(artifactId) { mutableIntStateOf(0) }
    var trailProblem by remember(artifactId) { mutableStateOf(false) }
    var updateProblem by remember(artifactId) { mutableStateOf(false) }
    var saving by remember(artifactId) { mutableStateOf(false) }
    val keyboard = LocalSoftwareKeyboardController.current
    LaunchedEffect(client, artifactId, context.route.projectId) {
        client.events.collect { event ->
            when (event) {
                is BoardStateEvent -> if (event.projectId == context.route.projectId) trailRevision++
                is ArtifactsChangedEvent -> if (event.projectId == context.route.projectId && event.artifact.id == artifactId) {
                    if (event.deleted) { artifact = null; viewedForDiscussion = null } else trailRevision++
                }
                else -> Unit
            }
        }
    }
    LaunchedEffect(client, artifactId, context.route.projectId, online, supported, trailRevision) {
        if (!online) return@LaunchedEffect
        trailProblem = false
        try {
            if (supported) {
                val trail = client.request(ArtifactsTrailRequest(projectId = context.route.projectId, artifactId = artifactId))
                artifact = trail.artifact
                folders = trail.tasks
                comments = trail.comments
            } else folders = readArtifactBoard(context.backend, context.route.projectId)
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { trailProblem = true }
    }
    Scaffold(modifier, topBar = {
        Column {
            TopAppBar(title = { Text(artifact?.let(::artifactTitle) ?: "Artifact", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = { JarvisIconButton(Lucide.ArrowLeft, "Back to artifacts", onClick = { keyboard?.hide(); close() }) },
                actions = {
                    artifact?.let { ArtifactPinButton(context, it) }
                    viewedForDiscussion?.let { viewed -> onDiscuss?.let { discuss -> TextButton(onClick = { discuss(viewed) }) { Text("Discuss") } } }
                })
            val root = artifact
            if (supported && root != null) {
                val living = root.living != null
                val enabled = online && !saving
                Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(living, enabled = enabled, role = Role.Switch, onValueChange = { keep ->
                    saving = true
                    updateProblem = false
                    scope.launch {
                        try {
                            artifact = client.request(ArtifactsUpdateRequest(projectId = root.projectId, artifactId = root.id, living = keep)).artifact
                            trailRevision++
                        } catch (e: CancellationException) { throw e }
                        catch (_: Exception) { updateProblem = true }
                        finally { saving = false }
                    }
                }).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Keep alive", Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
                    Switch(checked = living, onCheckedChange = null, enabled = enabled)
                }
                if (updateProblem) Text("Could not change Keep alive. Try again.", Modifier.padding(horizontal = 16.dp), color = MaterialTheme.colorScheme.error)
                HorizontalDivider(color = Jarvis.colors.border)
            }
        }
    }) { padding ->
        ArtifactScreen(context, artifactId, Modifier.padding(padding), onBack = close, belowViewer = { root, viewed, select ->
            SideEffect {
                if (!supported && artifact != root) artifact = root
                if (viewedForDiscussion != viewed) viewedForDiscussion = viewed
            }
            val metadata = artifact ?: root
            val home = folders.find { it.id == root.taskId }
            val doneAt = home?.settledAt?.takeIf { home.status == "done" }
            val versions = remember(root) { artifactVersions(root) }
            val split = remember(versions, doneAt) { taskDoneSplit(versions, doneAt) }
            val filmstrip = rememberLazyListState()
            LaunchedEffect(viewed.id, versions, split) {
                val index = versions.indexOfFirst { it.id == viewed.id }
                if (index >= 0) {
                    val slot = index + if (split in 1..index) 1 else 0
                    if (filmstrip.layoutInfo.visibleItemsInfo.none { it.index == slot }) filmstrip.scrollToItem(slot)
                }
            }
            StudioHeading("Versions")
            LazyRow(Modifier.selectableGroup(), state = filmstrip, horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                versions.forEachIndexed { index, version ->
                    if (index == split) item("task-done") { Text("Task done", color = Jarvis.colors.success, style = MaterialTheme.typography.labelMedium) }
                    item(version.id) {
                        val number = version.version ?: 1
                        val task = version.madeForTaskId?.let { id -> folders.find { it.id == id }?.title ?: id }
                        val selected = version.id == viewed.id
                        Surface(shape = MaterialTheme.shapes.small, color = if (selected) Jarvis.colors.surface2 else Jarvis.colors.surface,
                            border = androidx.compose.foundation.BorderStroke(1.dp, if (selected) Jarvis.colors.accent2 else Jarvis.colors.border)) {
                            Column(Modifier.width(104.dp).selectable(selected, role = Role.Tab, onClick = { select(number) }).padding(8.dp),
                                verticalArrangement = Arrangement.spacedBy(3.dp)) {
                                if (version.kind == "image" || version.kind == "video") {
                                    ArtifactThumb(context, version, Modifier.fillMaxWidth().height(38.dp), duration = false, play = false)
                                } else LucideGlyph(Lucide.FileText, size = 17.dp, tint = Jarvis.colors.fgMuted)
                                Text("v$number · ${libraryDate(version.createdAt)}", style = MaterialTheme.typography.labelMedium, maxLines = 1)
                                if (task != null) Text(task, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                }
            }
            viewed.note?.takeIf(String::isNotBlank)?.let { RichMarkdown(it) }
            StudioHeading("Comes from")
            if (root.taskId != null) TaskLink(context, root.taskId, home?.title ?: "Task ${root.taskId}", home)
            else Text("Chat, no task")
            projectName?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted) }
            home?.summary?.takeIf(String::isNotBlank)?.let { RichMarkdown(it) }
            if (!home?.decisions.isNullOrEmpty()) {
                Text("What the task found", style = MaterialTheme.typography.titleSmall)
                home.decisions.forEach { decision ->
                    RichMarkdown(decision.text)
                    decision.why?.takeIf(String::isNotBlank)?.let { RichMarkdown(it) }
                }
            }
            if (!metadata.laterTaskIds.isNullOrEmpty()) {
                Text("Later tasks", style = MaterialTheme.typography.titleSmall)
                metadata.laterTaskIds.forEach { id ->
                    val task = folders.find { it.id == id }
                    TaskLink(context, id, task?.title ?: "Task $id", task)
                }
            }
            StudioHeading("History")
            if (trailProblem) {
                Text("Could not read the artifact history.")
                TextButton(onClick = { trailRevision++ }) { Text("Try again") }
            }
            val history = remember(versions, comments, doneAt, metadata.living?.since) { artifactHistory(versions, comments, doneAt, metadata.living?.since) }
            history.forEach { event -> StudioHistoryEvent(event, versions, select) }
        })
    }
}

@Composable
private fun StudioHeading(title: String) {
    HorizontalDivider(color = Jarvis.colors.border)
    Text(title, style = MaterialTheme.typography.titleMedium)
}

@Composable
private fun TaskLink(context: ProjectScreenContext, id: String, title: String, task: ArtifactTaskFolder?) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        TextButton(onClick = { context.openTask(id) }, modifier = Modifier.weight(1f, fill = false)) { Text(title) }
        task?.let { TaskStateChip(it.status, it.settledAt, it.state) }
    }
}

@Composable
private fun StudioHistoryEvent(event: ArtifactHistory, versions: List<Artifact>, select: (Long) -> Unit) {
    val date = libraryDate(event.at)
    when (event) {
        is ArtifactHistory.Save -> {
            val first = event.first.version ?: 1
            val last = event.last.version ?: 1
            val label = if (first == last) "Version $first" else "Versions $first to $last"
            Text("$label saved by ${savedByLabel(event.first)} · $date" + if (first != last) " to ${libraryDate(event.last.createdAt)}" else "",
                style = MaterialTheme.typography.bodySmall)
        }
        is ArtifactHistory.Done -> Text("Task done · $date", color = Jarvis.colors.success, style = MaterialTheme.typography.labelLarge)
        is ArtifactHistory.Living -> Text("The artifact lives on · $date", color = Jarvis.colors.accent2, style = MaterialTheme.typography.labelLarge)
        is ArtifactHistory.Comment -> {
            val comment = event.comment
            Surface(color = Jarvis.colors.surface2, shape = MaterialTheme.shapes.medium) {
                Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("Owner · $date", style = MaterialTheme.typography.labelMedium)
                        comment.version?.let { version ->
                            if (versions.any { (it.version ?: 1) == version }) TextButton(onClick = { select(version) }) { Text("Version $version") }
                            else Text("· Version $version", style = MaterialTheme.typography.labelMedium)
                        }
                    }
                    RichMarkdown(withoutArtifactReference(comment.text))
                    if (comment.state == "addressed") Text("Addressed" + (comment.note?.let(::withoutArtifactReference)?.takeIf(String::isNotBlank)?.let { " · $it" } ?: ""),
                        color = Jarvis.colors.success, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }
}
