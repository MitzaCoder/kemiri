package io.github.mitzacoder.kemiri.features.artifacts

import androidx.compose.animation.core.*
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.features.chat.*
import io.github.mitzacoder.kemiri.features.tasks.media.CompareSlider
import io.github.mitzacoder.kemiri.features.tasks.rememberReducedMotion
import io.github.mitzacoder.kemiri.features.tasks.taskKindTone
import io.github.mitzacoder.kemiri.features.tasks.taskStateLabel
import io.github.mitzacoder.kemiri.features.tasks.taskStatusTone
import io.github.mitzacoder.kemiri.navigation.*
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.*

@Composable
internal fun ArtifactLibraryScreen(
    repository: HarnessRepository,
    sessions: List<BackendSession>,
    reads: MutableMap<String, LibraryRead>,
    modifier: Modifier,
    navigate: (Destination) -> Unit,
    onDiscuss: ((Destination.Chat, Artifact) -> Unit)? = null,
) {
    var retry by remember { mutableIntStateOf(0) }
    sessions.forEach { backend -> key(backend.config.key) {
        val connection by backend.client.state.collectAsStateWithLifecycle()
        val projects by backend.projects.collectAsStateWithLifecycle()
        val id = backend.config.key
        val supported = connection.supports("artifact-library")
        var revision by remember(backend) { mutableIntStateOf(0) }
        LaunchedEffect(backend) {
            backend.client.events.collect { event ->
                when (event) {
                    is ArtifactsChangedEvent -> {
                        reads[id]?.let { read ->
                            val remaining = read.library.artifacts.filterNot { it.projectId == event.projectId && it.id == event.artifact.id }
                            reads[id] = read.copy(library = read.library.copy(artifacts = if (event.deleted) remaining else remaining + event.artifact))
                        }
                        revision++
                    }
                    is BoardStateEvent -> revision++
                    else -> Unit
                }
            }
        }
        LaunchedEffect(backend, connection.status, supported, if (supported) null else projects, revision, retry) {
            if (connection.status != ConnectionStatus.Ready) {
                reads[id] = (reads[id] ?: LibraryRead()).copy(problem = "Offline", loaded = true)
                return@LaunchedEffect
            }
            delay(250) // Coalesce saves and their board events; canceled reads cannot overwrite a push.
            try { reads[id] = readLibrary(backend, projects, supported) }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { reads[id] = (reads[id] ?: LibraryRead()).copy(problem = "Could not read artifacts.", loaded = true) }
        }
    } }
    val backends = sessions.associateBy { it.config.key }
    val activeReads = reads.filterKeys { it in backends }
    val entries = remember(activeReads) { mergeLibraries(activeReads.mapValues { it.value.library }) }
    val projects = remember(entries) { entries.distinctBy { it.key.project }.sortedBy { it.project.name.lowercase() } }
    var lens by rememberSaveable { mutableStateOf(LibraryLens.Task) }
    var search by rememberSaveable { mutableStateOf("") }
    var selectedProject by rememberSaveable { mutableStateOf<String?>(null) }
    var selectedTags by rememberSaveable { mutableStateOf(arrayListOf<String>()) }
    val project = projects.find { it.key.project.saveKey() == selectedProject }?.key?.project
    val availableTags = remember(entries, project, search) {
        filterLibrary(entries, project, emptySet(), search).flatMap { it.artifact.tags.orEmpty() }.groupingBy { it }.eachCount()
    }
    val visible = remember(entries, project, search, selectedTags) { filterLibrary(entries, project, selectedTags.toSet(), search) }
    val shelves = remember(visible, lens) { libraryShelves(visible, lens) }
    val pairs = remember(visible, lens) { if (lens == LibraryLens.Pairs) libraryPairs(visible) else emptyList() }
    val reducedMotion = rememberReducedMotion()
    val list = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val objectPositions = remember(lens) { ShelfPositions() }
    var priorPositions by remember { mutableStateOf(emptyMap<LibraryArtifactKey, Offset>()) }
    fun open(entry: LibraryArtifact) { navigate(Destination.ArtifactStudio(entry.chat(), entry.artifact.id)) }
    fun context(entry: LibraryArtifact) = ProjectScreenContext(repository, backends.getValue(entry.key.project.backend), entry.chat(), navigate)

    LazyColumn(modifier.fillMaxSize(), state = list, contentPadding = PaddingValues(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        item("filters") {
            Column(Modifier.fillMaxWidth().background(Jarvis.colors.surface).padding(top = 4.dp, bottom = 8.dp)) {
                val livingCount = entries.count { it.artifact.living != null }
                Text("${entries.size} saved · ${projects.size} ${if (projects.size == 1) "project" else "projects"}" +
                    if (livingCount > 0) " · $livingCount living" else "", Modifier.padding(horizontal = 16.dp), color = Jarvis.colors.fgMuted,
                    style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(search, { search = it }, label = { Text("Find artifacts") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp))
                LibraryChips {
                    LibraryLens.entries.forEach { next ->
                        FilterChip(lens == next, onClick = {
                            if (lens != next) {
                                priorPositions = if (reducedMotion) emptyMap() else objectPositions.visible.toMap()
                                lens = next
                                scope.launch { list.scrollToItem(0) }
                            }
                        }, label = { Text(next.label) })
                    }
                }
                if (projects.isNotEmpty()) LibraryChips {
                    FilterChip(project == null, onClick = { selectedProject = null; selectedTags = arrayListOf() }, label = { Text("All projects") })
                    projects.forEach { entry ->
                        val name = entry.project.name
                        val duplicate = projects.count { it.project.name == name } > 1
                        FilterChip(project == entry.key.project, onClick = { selectedProject = entry.key.project.saveKey(); selectedTags = arrayListOf() },
                            label = { Text(if (duplicate) "$name · ${backends[entry.key.project.backend]?.config?.name}" else name) })
                    }
                }
                if (availableTags.isNotEmpty() || selectedTags.isNotEmpty()) LibraryChips {
                    (availableTags.keys + selectedTags).sorted().forEach { tag ->
                        FilterChip(tag in selectedTags, onClick = {
                            selectedTags = ArrayList(if (tag in selectedTags) selectedTags - tag else selectedTags + tag)
                        }, label = { Text("$tag ${availableTags[tag] ?: 0}") })
                    }
                }
            }
        }
        val problems = activeReads.filterValues { it.problem != null }
        if (problems.isNotEmpty()) item("problems") {
            Column(Modifier.padding(horizontal = 16.dp)) {
                problems.forEach { (id, read) -> Text("${backends[id]?.config?.name} · ${read.problem}", color = Jarvis.colors.fgMuted) }
                TextButton(onClick = { retry++ }) { Text("Try again") }
            }
        }
        items(shelves, key = { shelfKey(lens.name, it.key) }) { shelf ->
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(shelf.title, style = MaterialTheme.typography.titleMedium)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        shelf.task?.let { TaskStateChip(it.status, it.settledAt, it.state) }
                        shelf.project?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted) }
                    }
                }
                LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    items(shelf.entries, key = { shelfKey(it.key.project.saveKey(), it.key.artifact) }) { entry ->
                        val openArtifact = { open(entry) }
                        ShelfArtifact(context(entry), entry.artifact, openArtifact, onDiscuss?.let { discuss -> { discuss(entry.chat(), entry.artifact) } },
                            reducedMotion, Modifier.shelfPlacement(entry.key, objectPositions, priorPositions[entry.key], reducedMotion))
                    }
                }
            }
        }
        items(pairs, key = { shelfKey("pair", it.second.key.project.saveKey(), it.second.key.artifact) }) { (before, after) ->
            Column(Modifier.padding(horizontal = 16.dp).shelfPlacement(after.key, objectPositions, priorPositions[after.key], reducedMotion), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(artifactTitle(after.artifact), style = MaterialTheme.typography.titleMedium)
                Text(after.task?.title ?: after.project.name, style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted)
                CompareSlider(context(after), before.artifact, after.artifact, reducedMotion, Modifier.fillMaxWidth().aspectRatio(16f / 10f), full = true)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(onClick = { open(before) }) { Text("Open before") }
                    TextButton(onClick = { open(after) }) { Text("Open after") }
                }
            }
        }
        if (shelves.isEmpty() && pairs.isEmpty()) item("empty") {
            val loading = sessions.any { activeReads[it.config.key]?.loaded != true }
            Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(when {
                    loading -> "Loading artifacts…"
                    project != null || search.isNotBlank() || selectedTags.isNotEmpty() -> "No matching artifacts"
                    lens == LibraryLens.Pairs -> "No before and after pairs"
                    lens == LibraryLens.Living -> "No living artifacts"
                    else -> "No artifacts yet"
                }, style = MaterialTheme.typography.titleMedium)
                if (!loading && (project != null || search.isNotBlank() || selectedTags.isNotEmpty())) {
                    TextButton(onClick = { selectedProject = null; selectedTags = arrayListOf(); search = "" }) { Text("Clear filters") }
                }
            }
        }
    }
}

private fun LibraryProjectKey.saveKey() = shelfKey(backend, project)
private fun LibraryArtifact.chat() = Destination.Chat(key.project.backend, project.id, artifact.threadId.takeUnless { it == "main" })

@Composable
private fun LibraryChips(content: @Composable RowScope.() -> Unit) {
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp), content = content)
}

@Composable
internal fun TaskStateChip(status: String, settledAt: String?, state: BoardTaskState? = null) {
    val label = when {
        status == "done" -> settledAt?.let { "Done ${libraryDate(it)}" } ?: "Done"
        state != null -> taskStateLabel(status, state)
        status == "in_progress" -> "In progress"
        else -> status.replace('_', ' ').replaceFirstChar { it.uppercase() }
    }
    val colors = Jarvis.colors
    val tone = state?.let { colors.taskStatus(taskKindTone(it.kind, taskStatusTone(status))) }
        ?: if (status == "done") colors.success else null
    Surface(shape = RoundedCornerShape(50), color = tone?.copy(alpha = .12f) ?: colors.surface2) {
        Text(label, Modifier.padding(horizontal = 8.dp, vertical = 3.dp), style = MaterialTheme.typography.labelSmall,
            color = tone ?: colors.fgMuted)
    }
}

private class ShelfPositions { val visible = mutableMapOf<LibraryArtifactKey, Offset>() }

/** Snapshot old positions on a lens change, even when an object moves between lazy rows. */
@Composable
private fun Modifier.shelfPlacement(key: LibraryArtifactKey, positions: ShelfPositions, prior: Offset?, reduced: Boolean): Modifier {
    var initial by remember(positions, key) { mutableStateOf<Offset?>(null) }
    val progress = remember(positions, key) { Animatable(1f) }
    LaunchedEffect(initial, reduced) {
        if (initial != null && !reduced) { progress.snapTo(0f); progress.animateTo(1f, tween(430, easing = FastOutSlowInEasing)) }
    }
    DisposableEffect(positions, key) { onDispose { positions.visible.remove(key) } }
    return onGloballyPositioned {
        val point = it.positionInRoot()
        val bounds = it.boundsInWindow()
        if (bounds.width > 0 && bounds.height > 0) {
            positions.visible[key] = point
            if (!reduced && initial == null && prior != null) initial = prior - point
        } else positions.visible.remove(key)
    }.graphicsLayer {
        val delta = if (reduced) Offset.Zero else (initial ?: Offset.Zero) * (1f - progress.value)
        translationX = delta.x
        translationY = delta.y
    }
}
