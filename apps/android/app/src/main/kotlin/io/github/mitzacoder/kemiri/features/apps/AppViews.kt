package io.github.mitzacoder.kemiri.features.apps

import androidx.lifecycle.compose.collectAsStateWithLifecycle
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.features.chat.ChatPart
import io.github.mitzacoder.kemiri.features.chat.obj
import io.github.mitzacoder.kemiri.features.chat.s
import io.github.mitzacoder.kemiri.features.settings.QrCode
import io.github.mitzacoder.kemiri.features.settings.qrModules
import io.github.mitzacoder.kemiri.protocol.BoardTask
import io.github.mitzacoder.kemiri.protocol.ProjectApp
import io.github.mitzacoder.kemiri.data.wireJson
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.time.Instant

internal fun appIdFromCall(part: ChatPart): String? {
    if (part.name !in setOf("app_publish", "app_start") || part.status != "done") return null
    return part.details.obj()?.get("app").obj()?.s("appId")?.takeIf { it.isNotBlank() }
        ?: runCatching { wireJson.parseToJsonElement(part.text).obj()?.s("appId")?.takeIf { it.isNotBlank() } }.getOrNull()
}

@Composable
internal fun AppPublishCard(appId: String, feed: ProjectAppsFeed) {
    val app = feed.list?.apps?.find { it.appId == appId }
    Surface(shape = RoundedCornerShape(12.dp), color = Jarvis.colors.surface2) {
        Box(Modifier.fillMaxWidth().padding(12.dp)) {
            if (app != null) PublishedApp(app, warning = true)
            else AppMeta(feed.error ?: if (feed.list == null) "Loading app status…" else "This app is no longer recorded.")
        }
    }
}

@Composable
internal fun TaskApps(taskId: String) {
    val feed = LocalProjectApps.current ?: return
    val apps = visibleApps(feed.list?.apps.orEmpty(), taskId)
    if (apps.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Apps", style = MaterialTheme.typography.titleSmall, color = Jarvis.colors.fg)
        apps.forEach { app -> key(app.appId) {
            Surface(shape = RoundedCornerShape(12.dp), color = Jarvis.colors.surface2) {
                Box(Modifier.padding(12.dp)) {
                    PublishedApp(app, detail = app.port.takeIf { app.state != "stopped" }?.let { "port $it" }, feed = feed, warning = true)
                }
            }
        } }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RunningAppsChip(board: io.github.mitzacoder.kemiri.data.ProjectBoard, modifier: Modifier = Modifier) {
    val feed = LocalProjectApps.current ?: return
    val rows = visibleApps(feed.list?.apps.orEmpty())
    var open by rememberSaveable(feed.projectId) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    AssistChip(onClick = { open = true; scope.launch { feed.refresh() } }, label = { Text(appCountLabel(rows)) }, modifier = modifier,
        colors = AssistChipDefaults.assistChipColors(containerColor = Jarvis.colors.success.copy(alpha = .12f), labelColor = Jarvis.colors.success))
    if (!open) return
    val taskTitles by remember(board) { board.select { it.tasks.associate { task -> task.id to task.title } } }
        .collectAsStateWithLifecycle(emptyMap())
    ModalBottomSheet(onDismissRequest = { open = false }, containerColor = Jarvis.colors.bg) {
        val detected = feed.list?.detected.orEmpty()
        LazyColumn(Modifier.fillMaxWidth(), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item {
                Text("Running apps", style = MaterialTheme.typography.titleLarge)
                AppMeta("Stop app ends a process started by Kemiri and removes its link. Unpublish only removes the link.")
            }
            item { AppWarning() }
            if (rows.any { it.state == "pending" }) item {
                AppMeta("Allow publishes that app and lets agents publish future apps in this project.")
            }
            feed.error?.let { problem -> item { Text(problem, color = Jarvis.colors.danger) } }
            if (feed.list == null && feed.error == null) item { AppMeta("Loading apps…") }
            if (feed.list != null && rows.isEmpty() && detected.isEmpty()) item { AppMeta("No apps published in this project.") }
            items(rows, key = { it.appId }) { app ->
                val task = app.taskId?.let { id -> listOfNotNull(id, taskTitles[id]).joinToString(" ") } ?: "No task"
                val publisher = if (app.ownerPublished == true) "the owner" else with(app.publishedBy) { "$kind ${if (id == "main") "General" else id}" }
                val detail = listOfNotNull(task, "published by $publisher", appAge(app.createdAt), "port ${app.port}".takeIf { app.state != "stopped" }).joinToString(" · ")
                Surface(shape = RoundedCornerShape(12.dp), color = Jarvis.colors.surface2) {
                    Box(Modifier.padding(12.dp)) { PublishedApp(app, detail, feed, showDetails = true) }
                }
            }
            items(detected, key = { "detected-${it.port}" }) { DetectedApp(it.port, feed) }
            if (feed.list?.listenerChecksAvailable == false) item {
                AppMeta("Listener checks and port suggestions are unavailable on this backend.")
            }
        }
    }
}

internal fun appAge(createdAt: String, now: Long = System.currentTimeMillis()): String? {
    val created = runCatching { Instant.parse(createdAt).toEpochMilli() }.getOrNull() ?: return null
    val minutes = (now - created).coerceAtLeast(0) / 60_000
    return when {
        minutes < 1 -> "just now"
        minutes < 60 -> "$minutes min ago"
        minutes < 1440 -> "${minutes / 60} h ago"
        else -> "${minutes / 1440} d ago"
    }
}

@Composable
private fun PublishedApp(app: ProjectApp, detail: String? = null, feed: ProjectAppsFeed? = null,
    showDetails: Boolean = false, warning: Boolean = false) {
    val context = LocalContext.current
    val action = rememberAppAction()
    val link = appLink(app)
    var qrOpen by rememberSaveable(link) { mutableStateOf(false) }
    var copied by remember(link) { mutableStateOf(false) }
    var logsOpen by rememberSaveable(app.appId) { mutableStateOf(false) }
    val management = app.managed?.let { "Started by Kemiri · " + if (it.survivesRestart) "survives restarts" else "does not survive service restarts" }
    if (logsOpen && feed != null) AppLog(app, feed, onDismiss = { logsOpen = false })
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        AppRowDescription(app.name, listOfNotNull(appStateLabel(app), management, detail).joinToString(" · "), app.state, link)
        if (app.state == "live") app.addressMessage?.let { AppMeta(it) }
        if (link != null || feed != null) FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (link != null) {
                Button(onClick = {
                    try { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(link))) }
                    catch (_: ActivityNotFoundException) { action.error = "No browser can open this link." }
                }) { Text("Open") }
                if (showDetails) {
                    OutlinedButton(onClick = {
                        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                        clipboard.setPrimaryClip(ClipData.newPlainText(app.name, link)); copied = true
                    }) { Text(if (copied) "Copied" else "Copy link") }
                    OutlinedButton(onClick = { qrOpen = !qrOpen }) { Text(if (qrOpen) "Hide QR" else "QR") }
                }
            }
            if (showDetails && feed != null && app.managed != null) OutlinedButton(onClick = { logsOpen = true }) { Text("Logs") }
            if (feed != null && app.state != "unpublished") {
                if (showDetails && app.state == "pending") OutlinedButton(enabled = !action.busy, onClick = { action.run { feed.allow(app.appId) } }) { Text("Allow") }
                OutlinedButton(enabled = !action.busy, onClick = { action.run { feed.remove(app.appId) } }) {
                    when {
                        app.state == "stopped" -> Text("Remove")
                        app.managed != null -> Text("Stop app", color = Jarvis.colors.danger)
                        else -> Text("Unpublish")
                    }
                }
            }
        }
        if (qrOpen && link != null) {
            val modules = remember(link) { runCatching { qrModules(link) }.getOrNull() }
            if (modules != null) QrCode(modules, Modifier.semantics { contentDescription = "QR code for ${app.name}" })
            else AppMeta("Could not make a QR code for this link.")
        }
        if (link != null && warning) AppWarning()
        action.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.danger) }
    }
}

@Composable
private fun AppLog(app: ProjectApp, feed: ProjectAppsFeed, onDismiss: () -> Unit) {
    var refresh by remember { mutableIntStateOf(0) }
    var log by remember { mutableStateOf<String?>(null) }
    var problem by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(app.appId, refresh) {
        problem = null
        try { log = feed.log(app.appId) }
        catch (cause: CancellationException) { throw cause }
        catch (cause: Exception) { problem = cause.message ?: "Could not load the app log." }
    }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("${app.name} logs") }, text = {
        Box(Modifier.fillMaxWidth().heightIn(max = 320.dp).verticalScroll(rememberScrollState())) {
            SelectionContainer {
                Text(problem ?: log?.ifBlank { "No output yet." } ?: "Loading log…", fontFamily = FontFamily.Monospace,
                    color = if (problem == null) Jarvis.colors.fg else Jarvis.colors.danger)
            }
        }
    }, confirmButton = { TextButton(onClick = onDismiss) { Text("Close") } },
        dismissButton = { TextButton(onClick = { refresh++ }) { Text("Refresh log") } })
}

@Composable
private fun DetectedApp(port: Long, feed: ProjectAppsFeed) {
    val action = rememberAppAction()
    Surface(shape = RoundedCornerShape(12.dp), color = Jarvis.colors.surface2) {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            AppRowDescription("Port $port, not published", "Detected · A process in this project listens on port $port.", "detected")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                OutlinedButton(enabled = !action.busy, onClick = { action.run { feed.publish(port) } }) { Text("Publish") }
                OutlinedButton(enabled = !action.busy, onClick = { action.run { feed.ignore(port) } }) { Text("Ignore") }
            }
            action.error?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.danger) }
        }
    }
}

@Composable
private fun AppRowDescription(name: String, meta: String, state: String, link: String? = null) {
    val colors = Jarvis.colors
    val dot = when (state) { "live" -> colors.success; "pending", "detected" -> colors.warning; else -> colors.fgSubtle }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.Top) {
        Box(Modifier.padding(top = 7.dp).size(8.dp).then(if (state == "detected") Modifier.border(1.dp, dot, CircleShape) else Modifier.background(dot, CircleShape)))
        Column(Modifier.weight(1f)) {
            Text(name, style = MaterialTheme.typography.titleSmall, color = colors.fg)
            if (link != null) Text(link, style = MaterialTheme.typography.bodySmall, color = colors.success)
            AppMeta(meta)
        }
    }
}

@Composable
private fun AppMeta(text: String) = Text(text, style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted)

@Composable
private fun AppWarning() = Text(APP_LINK_WARNING,
    Modifier.fillMaxWidth().background(Jarvis.colors.warning.copy(alpha = .12f), RoundedCornerShape(8.dp)).padding(8.dp),
    style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.warning)

private class AppAction(private val scope: kotlinx.coroutines.CoroutineScope) {
    var busy by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
    fun run(change: suspend () -> Unit) {
        if (busy) return
        busy = true
        error = null
        scope.launch {
            try { change() }
            catch (cause: CancellationException) { throw cause }
            catch (cause: Exception) { error = cause.message ?: "Could not update this app." }
            finally { busy = false }
        }
    }
}

@Composable private fun rememberAppAction(): AppAction {
    val scope = rememberCoroutineScope()
    return remember(scope) { AppAction(scope) }
}
