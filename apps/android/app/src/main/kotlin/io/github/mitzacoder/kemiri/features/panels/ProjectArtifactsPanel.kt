package io.github.mitzacoder.kemiri.features.panels

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.ConnectionStatus
import io.github.mitzacoder.kemiri.data.request
import io.github.mitzacoder.kemiri.features.chat.ArtifactPinButton
import io.github.mitzacoder.kemiri.features.chat.artifactKindIcon
import io.github.mitzacoder.kemiri.features.chat.artifactTitle
import io.github.mitzacoder.kemiri.features.chat.isHtmlArtifact
import io.github.mitzacoder.kemiri.features.tasks.relativeTime
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.components.Lucide
import io.github.mitzacoder.kemiri.ui.components.LucideGlyph
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

private fun Artifact.isHtmlPage() = kind == "text" && isHtmlArtifact(name, mimeType)

/** Loaded only while Artifacts is shown. Board changes only supply task titles, never another catalogue request. */
@Composable
internal fun ArtifactsPanel(context: ProjectScreenContext) {
    val client = context.backend.client
    val projectId = context.route.projectId
    val board by context.board.view.collectAsStateWithLifecycle()
    val taskTitles = remember(board.tasks) { board.tasks.associate { it.id to it.title } }
    var catalogue by remember(client, projectId) { mutableStateOf(emptyMap<String, Artifact>()) }
    var loaded by remember(client, projectId) { mutableStateOf(false) }
    var problem by remember(client, projectId) { mutableStateOf(false) }
    var retry by remember { mutableIntStateOf(0) }
    var query by rememberSaveable { mutableStateOf("") }
    var otherExpanded by rememberSaveable { mutableStateOf(false) }
    var kind by rememberSaveable { mutableStateOf("") }

    LaunchedEffect(client, projectId, retry) {
        var pending: MutableMap<String, ArtifactsChangedEvent>? = null
        fun applyChange(rows: Map<String, Artifact>, event: ArtifactsChangedEvent): Map<String, Artifact> =
            if (event.deleted) rows - event.artifact.id else rows + (event.artifact.id to event.artifact.copy(versions = null))
        launch(start = CoroutineStart.UNDISPATCHED) {
            client.events.collect { event ->
                if (event is ArtifactsChangedEvent && event.projectId == projectId) {
                    pending?.set(event.artifact.id, event)
                    catalogue = applyChange(catalogue, event)
                }
            }
        }
        client.state.map { if (it.status == ConnectionStatus.Ready) it.generation else null }.distinctUntilChanged().collectLatest { generation ->
            if (generation == null) return@collectLatest
            val changes = mutableMapOf<String, ArtifactsChangedEvent>()
            pending = changes
            problem = false
            try {
                val modern = client.state.value.supports("project-artifacts")
                val rows = client.request(ArtifactsListRequest(projectId = projectId, catalogue = true.takeIf { modern }, limit = 500L.takeUnless { modern })).artifacts
                catalogue = changes.values.fold(rows.associate { it.id to it.copy(versions = null) }, ::applyChange)
                loaded = true
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { problem = true; loaded = true }
            finally { pending = null }
        }
    }

    val sorted = remember(catalogue) { catalogue.values.sortedWith(compareByDescending<Artifact> { it.createdAt }.thenByDescending { it.id }) }
    val matching = remember(sorted, query, taskTitles) {
        val terms = query.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
        sorted.filter { artifact ->
            val search = (listOf(artifact.title, artifact.name, artifact.note, artifact.taskId, artifact.taskId?.let(taskTitles::get)).filterNotNull() + artifact.tags.orEmpty()).joinToString(" ")
            terms.all { search.contains(it, ignoreCase = true) }
        }
    }
    val (html, other) = remember(matching) { matching.partition { it.isHtmlPage() } }
    val (pinned, unpinned) = remember(html) { html.partition { it.pinned == true } }
    val kinds = remember(other) { other.map { it.kind }.distinct().sorted() }
    val shownOther = if (kind in kinds) other.filter { it.kind == kind } else other
    fun open(artifact: Artifact) { context.navigate(Destination.Artifact(context.route, artifact.id)) }

    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 12.dp)) {
        item {
            OutlinedTextField(query, { query = it; if (it.isNotBlank()) otherExpanded = true }, Modifier.fillMaxWidth(),
                label = { Text("Search project artifacts") }, singleLine = true)
        }
        if (problem) item { TextButton(onClick = { retry++ }) { Text("Could not load artifacts. Retry") } }
        if (pinned.isNotEmpty()) item { SectionTitle("Pinned HTML · ${pinned.size}", pinned = true) }
        items(pinned, key = { it.id }) { ArtifactRow(context, it, taskTitles, ::open) }
        if (unpinned.isNotEmpty()) item { SectionTitle("HTML artifacts · ${unpinned.size}") }
        items(unpinned, key = { it.id }) { ArtifactRow(context, it, taskTitles, ::open) }
        if (other.isNotEmpty()) item {
            TextButton(onClick = { otherExpanded = !otherExpanded }, modifier = Modifier.padding(top = 8.dp)) {
                LucideGlyph(if (otherExpanded) Lucide.ChevronDown else Lucide.ChevronRight, size = 16.dp)
                Spacer(Modifier.width(8.dp)); Text("Other files · ${other.size}")
            }
        }
        if (otherExpanded && kinds.size > 1) item {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                FilterChip(kind !in kinds, { kind = "" }, label = { Text("All kinds") })
                kinds.forEach { value -> FilterChip(kind == value, { kind = value }, label = { Text(panelArtifactKindLabel(value, true)) }) }
            }
        }
        if (otherExpanded) items(shownOther, key = { it.id }) { ArtifactRow(context, it, taskTitles, ::open) }
        if (!loaded) item { SectionTitle("Loading artifacts…") }
        else if (catalogue.isEmpty() && !problem) item { SectionTitle("No saved artifacts in this project yet.") }
        else if (matching.isEmpty() && !problem) item { SectionTitle("No artifacts match this search.") }
    }
}

@Composable
private fun SectionTitle(title: String, pinned: Boolean = false) {
    Text(title, Modifier.padding(start = 8.dp, top = 16.dp, bottom = 4.dp).semantics { heading() },
        style = MaterialTheme.typography.labelLarge, color = if (pinned) Jarvis.colors.accent2 else Jarvis.colors.fgMuted)
}

@Composable
private fun ArtifactRow(context: ProjectScreenContext, artifact: Artifact, taskTitles: Map<String, String>, open: (Artifact) -> Unit) {
    val html = artifact.isHtmlPage()
    val versions = artifact.versionCount ?: 1
    val task = artifact.taskId?.let { id -> taskTitles[id]?.let { "$id · $it" } ?: id } ?: "No home task"
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f).clickable { open(artifact) }.padding(horizontal = 8.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
            LucideGlyph(if (html) Lucide.Paperclip else artifactKindIcon(artifact.kind), size = 18.dp,
                tint = if (html) Jarvis.colors.accent2 else Jarvis.colors.fgMuted)
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(artifactTitle(artifact), style = MaterialTheme.typography.titleSmall)
                Text(task, style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted)
                val time = relativeTime(artifact.createdAt)
                Text("$versions ${if (versions == 1L) "version" else "versions"} · Updated $time",
                    style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgSubtle)
            }
        }
        if (html) ArtifactPinButton(context, artifact)
    }
    HorizontalDivider(color = Jarvis.colors.border)
}
