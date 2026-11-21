package io.github.mitzacoder.kemiri.features.apps

import androidx.compose.runtime.*
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.protocol.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.net.URI

internal const val APP_LINK_WARNING = "Anyone on your tailnet can open these links. They are not behind Kemiri sign-in."

internal fun visibleApps(apps: List<ProjectApp>, taskId: String? = null) =
    apps.filter { it.state != "unpublished" && (taskId == null || it.taskId == taskId) }

internal fun appCountLabel(apps: List<ProjectApp>): String {
    val live = apps.count { it.state == "live" }
    val pending = apps.count { it.state == "pending" }
    return "$live ${if (live == 1) "app" else "apps"} running" + if (pending > 0) " · $pending pending" else ""
}

internal fun appLink(app: ProjectApp): String? = app.url?.takeIf { link ->
    app.state == "live" && runCatching {
        val address = URI(link)
        address.scheme in listOf("http", "https") && address.host != null && address.rawUserInfo == null
    }.getOrDefault(false)
}

internal fun appStateLabel(app: ProjectApp): String = when (app.state) {
    "live" -> if (appLink(app) == null) "No address configured" else "Live"
    "pending" -> "Waiting for approval"
    "stopped" -> "Stopped · nothing listens on port ${app.port} any more"
    "unpublished" -> "Unpublished"
    else -> "App status unavailable"
}

internal class ProjectAppsFeed(private val client: HarnessClient, val projectId: String) {
    private val reads = Mutex()
    var list by mutableStateOf<AppsListResponse?>(null)
        private set
    var error by mutableStateOf<String?>(null)
        private set

    suspend fun refresh() = reads.withLock {
        try {
            list = client.request(AppsListRequest(projectId = projectId))
            error = null
        } catch (cause: CancellationException) { throw cause }
        catch (cause: Exception) { error = cause.message ?: "Could not read project apps." }
    }

    suspend fun allow(appId: String) { client.request(AppsAllowRequest(projectId = projectId, appId = appId)); refresh() }
    suspend fun remove(appId: String) { client.request(AppsUnpublishRequest(projectId = projectId, appId = appId)); refresh() }
    suspend fun publish(port: Long) { client.request(AppsPublishDetectedRequest(projectId = projectId, port = port)); refresh() }
    suspend fun ignore(port: Long) { client.request(AppsIgnoreDetectedRequest(projectId = projectId, port = port)); refresh() }
}

internal val LocalProjectApps = compositionLocalOf<ProjectAppsFeed?> { null }

@Composable
internal fun rememberProjectApps(client: HarnessClient?, projectId: String?): ProjectAppsFeed? {
    val connection = client?.state?.collectAsStateWithLifecycle()?.value
    val ready = connection?.status == ConnectionStatus.Ready && connection.supports(HarnessFeature.APPS)
    val feed = remember(client, projectId, ready) {
        if (client != null && projectId != null && ready) ProjectAppsFeed(client, projectId) else null
    }
    LaunchedEffect(feed) {
        if (feed == null || client == null) return@LaunchedEffect
        launch(start = CoroutineStart.UNDISPATCHED) {
            client.events.collect { event ->
                if (event is AppsChangedEvent && event.projectId == feed.projectId) feed.refresh()
            }
        }
        feed.refresh()
    }
    return feed
}
