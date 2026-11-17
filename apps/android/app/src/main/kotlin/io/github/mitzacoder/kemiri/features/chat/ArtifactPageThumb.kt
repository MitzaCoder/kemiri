package io.github.mitzacoder.kemiri.features.chat

import android.view.View
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.ConnectionStatus
import io.github.mitzacoder.kemiri.data.request
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.Artifact
import io.github.mitzacoder.kemiri.protocol.ArtifactsUrlRequest
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import okhttp3.Request
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Stable partition; pages keep their order, as do all other artifacts. */
internal fun pagesFirst(artifacts: List<Artifact>): List<Artifact> = artifacts.sortedBy { !isHtmlArtifact(it.name, it.mimeType) }

internal const val PAGE_PREVIEW_BYTES = 1024 * 1024
internal fun artifactPageThumbPolicy() = artifactPagePolicy().copy(javaScript = false)
private val pageThumbSlots = Semaphore(2)
private val pageThumbHttp = okhttp3.OkHttpClient.Builder().callTimeout(10, java.util.concurrent.TimeUnit.SECONDS).build()

/** Cancellation closes the HTTP call too, including when a server ignores Range or stalls its body. */
private suspend fun readPageThumb(url: String, size: Long, retryAuth: Boolean): String? = suspendCancellableCoroutine { continuation ->
    val call = pageThumbHttp.newCall(Request.Builder().url(url).header("Range", "bytes=0-$PAGE_PREVIEW_BYTES").build())
    continuation.invokeOnCancellation { call.cancel() }
    call.enqueue(object : okhttp3.Callback {
        override fun onFailure(call: okhttp3.Call, e: java.io.IOException) { continuation.resumeWithException(e) }
        override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
            try {
                val text = response.use {
                    if (it.code in listOf(401, 403, 410) && retryAuth) null else {
                        check(it.isSuccessful)
                        val bytes = it.body.byteStream().readAtMost(PAGE_PREVIEW_BYTES + 1)
                        check(bytes.size <= PAGE_PREVIEW_BYTES && size <= PAGE_PREVIEW_BYTES)
                        bytes.toString(Charsets.UTF_8)
                    }
                }
                continuation.resume(text)
            } catch (e: Exception) { continuation.resumeWithException(e) }
        }
    })
}

/**
 * A cheap, non-interactive page thumbnail, never a second viewer. Only visible cells acquire one of two live WebViews.
 * The full viewer policy and CSP apply, with scripts additionally disabled (no thumbnail timers/charts/pop-ups).
 * Leaving the viewport destroys the WebView and cancels its bounded source read. No signed URL enters saved state.
 */
@Composable
internal fun ArtifactPageThumb(context: ProjectScreenContext, artifact: Artifact, modifier: Modifier = Modifier, onOpen: () -> Unit) {
    val colors = Jarvis.colors
    val host = LocalView.current
    var visible by remember { mutableStateOf(false) }
    var permitted by remember { mutableStateOf(false) }
    var source by remember(context.backend.config.key, artifactVersionAddress(artifact)) { mutableStateOf<String?>(null) }
    var failed by remember(artifactVersionAddress(artifact)) { mutableStateOf(false) }
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    val projects by context.backend.projects.collectAsStateWithLifecycle()
    val blockRequests = projects.find { it.id == artifact.projectId }?.let { it.blockArtifactRequests == true } ?: true
    LaunchedEffect(visible, connection.status) {
        if (!visible || connection.status != ConnectionStatus.Ready) return@LaunchedEffect
        pageThumbSlots.withPermit {
            permitted = true
            try { awaitCancellation() } finally { permitted = false }
        }
    }
    LaunchedEffect(permitted, context.backend.client, artifactVersionAddress(artifact)) {
        if (!permitted) { source = null; return@LaunchedEffect }
        if (source != null) return@LaunchedEffect
        failed = false
        try {
            for (attempt in 0..2) {
                val signed = context.backend.client.request(ArtifactsUrlRequest(projectId = artifact.projectId, artifactId = artifactVersionAddress(artifact)))
                val text = readPageThumb(signed.url, artifact.size, retryAuth = attempt < 2)
                if (text != null) { source = text; break }
            }
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { failed = true }
    }
    Box(modifier.fillMaxWidth().aspectRatio(16f / 9f).clipToBounds().background(colors.surface2)
        .onGloballyPositioned { coordinates ->
            val bounds = coordinates.boundsInWindow()
            visible = bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < host.height && bounds.right > 0 && bounds.left < host.width
        }, contentAlignment = Alignment.Center) {
        Text(if (failed) "Preview unavailable · open page" else "Page", color = colors.fgSubtle)
        if (permitted && source != null) {
            val android = LocalContext.current
            val document = artifactPageDocument(source!!, colors.dark, artifactThemeTokens(colors), blockRequests, false)
            val view = remember(android, artifactVersionAddress(artifact)) {
                WebView(android).also {
                    applyArtifactPagePolicy(it, artifactPageThumbPolicy())
                    it.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
                    it.isVerticalScrollBarEnabled = false
                    it.isHorizontalScrollBarEnabled = false
                    it.webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
                    }
                }
            }
            DisposableEffect(view) { onDispose { view.stopLoading(); view.loadUrl("about:blank"); view.destroy() } }
            LaunchedEffect(view, document) { view.loadDataWithBaseURL(null, document, "text/html", "utf-8", null) }
            AndroidView(factory = { view }, modifier = Modifier.matchParentSize().clearAndSetSemantics {}.layout { measurable, constraints ->
                val width = 800.dp.roundToPx()
                val height = 450.dp.roundToPx()
                val child = measurable.measure(Constraints.fixed(width, height))
                layout(constraints.maxWidth, constraints.maxHeight) {
                    child.placeWithLayer(0, 0) {
                        transformOrigin = TransformOrigin(0f, 0f)
                        scaleX = constraints.maxWidth.toFloat() / width
                        scaleY = constraints.maxHeight.toFloat() / height
                    }
                }
            })
        }
        // The native child never owns input or accessibility; the gallery opens the ordinary artifact route.
        Box(Modifier.matchParentSize().clickable(onClickLabel = "Open ${artifactTitle(artifact)}", onClick = onOpen))
    }
}
