package io.github.mitzacoder.kemiri.features.chat

import android.widget.Toast
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.ConnectionStatus
import io.github.mitzacoder.kemiri.data.request
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.Artifact
import io.github.mitzacoder.kemiri.protocol.ArtifactsUpdateRequest
import io.github.mitzacoder.kemiri.ui.components.JarvisIconButton
import io.github.mitzacoder.kemiri.ui.components.Lucide
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

internal data class ArtifactPinAction(val label: String, val enabled: Boolean, val invoke: () -> Unit)

@Composable
internal fun rememberArtifactPinAction(context: ProjectScreenContext, artifact: Artifact?): ArtifactPinAction? {
    val client = context.backend.client
    val connection by client.state.collectAsStateWithLifecycle()
    if (artifact == null || artifact.kind != "text" || !isHtmlArtifact(artifact.name, artifact.mimeType) || !connection.supports("project-artifacts")) return null
    val android = LocalContext.current
    val scope = rememberCoroutineScope()
    var saving by remember(client, artifact.projectId, artifact.id) { mutableStateOf(false) }
    return ArtifactPinAction(if (artifact.pinned == true) "Unpin" else "Pin", !saving && connection.status == ConnectionStatus.Ready) {
        if (!saving) {
            saving = true
            scope.launch {
                try {
                    client.request(ArtifactsUpdateRequest(projectId = artifact.projectId, artifactId = artifact.id, pinned = artifact.pinned != true))
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { Toast.makeText(android, "Could not change the pin. Try again.", Toast.LENGTH_SHORT).show() }
                finally { saving = false }
            }
        }
    }
}

@Composable
internal fun ArtifactPinButton(context: ProjectScreenContext, artifact: Artifact) {
    val action = rememberArtifactPinAction(context, artifact) ?: return
    JarvisIconButton(Lucide.Pin, "${action.label} ${artifactTitle(artifact)}", onClick = action.invoke,
        enabled = action.enabled, pressed = artifact.pinned == true)
}
