package io.github.mitzacoder.kemiri.features.chat

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.features.artifacts.*
import io.github.mitzacoder.kemiri.features.tasks.taskStatusWords
import io.github.mitzacoder.kemiri.navigation.*
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.components.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.CancellationException

internal data class DiscussionDetails(val root: Artifact?, val home: ArtifactTaskFolder?, val comments: Int?)

@Composable
internal fun rememberDiscussionDetails(context: ProjectScreenContext, reference: DiscussionReference, taskHint: String?, withFolder: Boolean, knownRoot: Artifact? = null): DiscussionDetails? {
    val project = context.route.projectId
    val client = context.backend.client
    val connection by client.state.collectAsStateWithLifecycle()
    val board by context.board.view.collectAsStateWithLifecycle()
    var details by remember(client, project, reference.artifactId) { mutableStateOf<DiscussionDetails?>(null) }
    LaunchedEffect(client, project, reference.artifactId, connection.generation, connection.status, knownRoot?.taskId, if (withFolder) board.board?.updatedAt else null) {
        if (connection.status != ConnectionStatus.Ready) return@LaunchedEffect
        try {
            if (withFolder && connection.supports("artifact-library")) {
                val trail = client.request(ArtifactsTrailRequest(projectId = project, artifactId = reference.artifactId))
                details = DiscussionDetails(trail.artifact, trail.tasks.find { it.id == trail.artifact.taskId }, trail.comments.size)
            } else {
                val root = knownRoot ?: client.request(ArtifactsListRequest(projectId = project, artifactId = reference.artifactId)).artifacts.firstOrNull { it.id == reference.artifactId }
                val id = if (root != null) root.taskId else taskHint
                val home = if (id != null && (withFolder || board.tasks.none { it.id == id })) readArtifactBoard(context.backend, project).find { it.id == id } else null
                details = DiscussionDetails(root, home, null)
            }
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { /* The pinned title and version remain usable. */ }
    }
    return details
}

@Composable
internal fun DiscussionComposerAttachment(context: ProjectScreenContext, reference: DiscussionReference, taskId: String?, onRemove: () -> Unit, onTask: (String?) -> Unit) {
    val details = rememberDiscussionDetails(context, reference, taskId, withFolder = true)
    DiscussionChip(context, reference, details?.root, onRemove)
    val homeId = details?.root?.let { it.taskId.orEmpty() } ?: taskId.orEmpty()
    if (homeId.isNotEmpty()) {
        val home = details?.home
        val description = buildString {
            append("Its task folder: ${home?.title ?: homeId}")
            if (home != null) {
                append(", ${taskStatusWords(home.status).lowercase()}")
                home.settledAt?.let { append(" ${libraryDate(it)}") }
            }
            append(". It holds the task report")
            home?.decisions?.size?.let { append(", $it ${if (it == 1) "decision" else "decisions"}") }
            details?.comments?.let { append(" and $it earlier ${if (it == 1) "comment" else "comments"}") }
            append('.')
        }
        Surface(shape = MaterialTheme.shapes.small, color = Jarvis.colors.surface,
            border = androidx.compose.foundation.BorderStroke(1.dp, Jarvis.colors.border)) {
            val checked = taskId == homeId
            Row(Modifier.fillMaxWidth().toggleable(checked, role = Role.Checkbox, onValueChange = { bring -> onTask(homeId.takeIf { bring }) })
                .padding(horizontal = 10.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(9.dp), verticalAlignment = Alignment.CenterVertically) {
                Checkbox(checked, onCheckedChange = null)
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text("Bring its task folder", style = MaterialTheme.typography.labelLarge)
                    Text(description, style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted)
                }
            }
        }
    }
}

@Composable
internal fun DiscussionChip(context: ProjectScreenContext, reference: DiscussionReference, root: Artifact?, onRemove: (() -> Unit)? = null) {
    val version = root?.let { artifactVersions(it).find { snapshot -> (snapshot.version ?: 1) == reference.version } }
    val open = { context.navigate(Destination.Artifact(context.route, if (root != null && root.version == null) root.id else reference.versionId)) }
    Surface(shape = MaterialTheme.shapes.medium, color = Jarvis.colors.surface2, border = androidx.compose.foundation.BorderStroke(1.dp, Jarvis.colors.border)) {
        Row(Modifier.padding(start = 8.dp, end = if (onRemove != null) 2.dp else 10.dp, top = 5.dp, bottom = 5.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(9.dp)) {
            Box(Modifier.size(55.dp, 38.dp).clip(MaterialTheme.shapes.small), contentAlignment = Alignment.Center) {
                when {
                    version != null && isHtmlArtifact(version.name, version.mimeType) -> ArtifactPageThumb(context, version, onOpen = open)
                    version != null -> ArtifactThumb(context, version, Modifier.fillMaxSize(), duration = false, play = false)
                    else -> LucideGlyph(Lucide.FileText, size = 21.dp, tint = Jarvis.colors.fgMuted)
                }
            }
            Column(Modifier.weight(1f, fill = false)) {
                Text(reference.title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text("Version ${reference.version}", style = MaterialTheme.typography.labelSmall, color = Jarvis.colors.fgMuted)
            }
            if (onRemove != null) IconButton(onClick = onRemove, modifier = Modifier.size(48.dp)) {
                LucideGlyph(Lucide.X, contentDescription = "Remove artifact", size = 17.dp)
            }
        }
    }
}
