package io.github.mitzacoder.kemiri.features.chat

import androidx.compose.runtime.*
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.navigation.*
import io.github.mitzacoder.kemiri.protocol.*
import kotlinx.coroutines.CancellationException

@Composable internal fun rememberTranscriptArtifacts(context: ProjectScreenContext): List<Artifact> {
    val client = context.backend.client
    val project = context.route.projectId
    var items by remember(client, project) { mutableStateOf<List<Artifact>>(emptyList()) }
    var revision by remember(client, project) { mutableIntStateOf(0) }
    val connection by client.state.collectAsStateWithLifecycle()
    LaunchedEffect(client,project) {
        client.events.collect { event ->
            if(event is ArtifactsChangedEvent && event.projectId == project) {
                if(event.deleted) ChatArtifactMetadata.remove(context.backend.config.key,project,event.artifact.id)
                else ChatArtifactMetadata.keep(context.backend.config.key,event.artifact)
                revision++
                items = items.filterNot { it.id == event.artifact.id } + if(event.deleted) emptyList() else listOf(event.artifact)
            }
        }
    }
    LaunchedEffect(client,project,connection,revision) {
        if(connection.status == ConnectionStatus.Ready && connection.supports("artifacts")) {
            val before = revision
            try {
                val loaded = client.request(ArtifactsListRequest(projectId = project,limit = 500)).artifacts
                if(before == revision) { items = loaded; loaded.forEach { ChatArtifactMetadata.keep(context.backend.config.key,it) } }
            } catch(e: CancellationException) { throw e }
            catch(_: Exception) { /* The artifact panel exposes retry/errors; retain last known metadata here. */ }
        }
    }
    return items
}
@Composable internal fun TranscriptArtifactStrip(items: List<Artifact>, context: ProjectScreenContext) {
    if(items.isEmpty()) return
    var expanded by remember { mutableStateOf(false) }
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(vertical = 4.dp),horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        (if(expanded) items else items.take(5)).forEach { artifact ->
            key(artifact.id) { ArtifactTile(artifact,context) }
        }
        if(items.size > 5) TextButton(onClick = { expanded = !expanded }) { Text(if(expanded) "Fewer" else "+${items.size-5}") }
    }
}
