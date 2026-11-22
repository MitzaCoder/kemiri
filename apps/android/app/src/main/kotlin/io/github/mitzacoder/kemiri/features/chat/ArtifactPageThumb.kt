package io.github.mitzacoder.kemiri.features.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.compose.AsyncImage
import coil3.request.CachePolicy
import coil3.request.ImageRequest
import io.github.mitzacoder.kemiri.data.ConnectionStatus
import io.github.mitzacoder.kemiri.data.request
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.Artifact
import io.github.mitzacoder.kemiri.protocol.ArtifactsUrlRequest
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.CancellationException
import okhttp3.HttpUrl.Companion.toHttpUrl

/** Stable partition; pages keep their order, as do all other artifacts. */
internal fun pagesFirst(artifacts: List<Artifact>): List<Artifact> = artifacts.sortedBy { !isHtmlArtifact(it.name, it.mimeType) }

@Composable
internal fun ArtifactPageThumb(context: ProjectScreenContext, artifact: Artifact, modifier: Modifier = Modifier, onOpen: () -> Unit) {
    HtmlArtifactThumbnail(context, artifact, modifier.fillMaxWidth().aspectRatio(16f / 9f)
        .clickable(onClickLabel = "Open ${artifactTitle(artifact)}", onClick = onOpen))
}

/** Pixels only. No HTML source or WebView enters a list, and offscreen cells do not mint signed URLs. */
@Composable
internal fun HtmlArtifactThumbnail(context: ProjectScreenContext, artifact: Artifact, modifier: Modifier = Modifier) {
    val client = context.backend.client
    val connection by client.state.collectAsStateWithLifecycle()
    val version = artifactVersionAddress(artifact)
    val host = LocalView.current
    val android = LocalContext.current
    var visible by remember { mutableStateOf(false) }
    var url by remember(client, artifact.projectId, version) { mutableStateOf<String?>(null) }
    var ready by remember(url) { mutableStateOf(false) }
    val online = connection.status == ConnectionStatus.Ready && connection.supports("artifact-thumbnails")
    LaunchedEffect(client, artifact.projectId, version, visible, online, connection.generation) {
        if (!visible || !online || url != null && ready) return@LaunchedEffect
        try {
            val signed = client.request(ArtifactsUrlRequest(projectId = artifact.projectId, artifactId = version))
            url = signed.url.toHttpUrl().newBuilder().setQueryParameter("preview", "1").build().toString()
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { /* Keep the titled placeholder. */ }
    }
    val picture = remember(android, url) {
        url?.let { ImageRequest.Builder(android).data(it).diskCachePolicy(CachePolicy.DISABLED).build() }
    }
    Box(modifier.clipToBounds().background(Jarvis.colors.surface2).onGloballyPositioned { coordinates ->
        val bounds = coordinates.boundsInWindow()
        visible = bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < host.height && bounds.right > 0 && bounds.left < host.width
    }, contentAlignment = Alignment.Center) {
        if (!ready) Text(artifactTitle(artifact), Modifier.padding(3.dp).clearAndSetSemantics {},
            style = MaterialTheme.typography.labelSmall, maxLines = 2, overflow = TextOverflow.Ellipsis, color = Jarvis.colors.fgMuted)
        if (visible && picture != null) AsyncImage(model = picture, contentDescription = null, contentScale = ContentScale.Crop,
            modifier = Modifier.matchParentSize(), onSuccess = { ready = true }, onError = { ready = false })
    }
}
