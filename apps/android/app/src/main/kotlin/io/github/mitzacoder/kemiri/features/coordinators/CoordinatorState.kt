package io.github.mitzacoder.kemiri.features.coordinators

import android.content.Context
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.navigation.*
import io.github.mitzacoder.kemiri.protocol.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch

@Composable
internal fun rememberCoordinatorThreads(context: ProjectScreenContext, enabled: Boolean): List<ThreadSummary> {
    val client = context.backend.client
    val project = context.route.projectId
    val active = rememberPushedList(client, project, enabled,
        pushed = { (it as? ThreadsStateEvent)?.takeIf { event -> event.projectId == project }?.threads },
        read = { client.request(ThreadsListRequest(projectId = project, includeArchived = true)).threads })
    return if (enabled) active else emptyList()
}

private fun Context.coordinatorPreferences() = getSharedPreferences("coordinator-presentation", Context.MODE_PRIVATE)
private fun Destination.Chat.preferenceKey(field: String) = "$field|$backendKey|$projectId"

internal fun projectEntryRoute(android: Context, backend: BackendSession, chat: Destination.Chat): Destination.Chat {
    if (!backend.client.supports("coordinators")) return chat
    val id = android.coordinatorPreferences().getString(chat.preferenceKey("last"), null) ?: return chat
    return coordinatorRoute(chat, id)
}

@Composable
internal fun rememberCoordinatorVisit(context: ProjectScreenContext, coordinator: ThreadSummary?, visible: Boolean) {
    val android = LocalContext.current
    val key = context.route.preferenceKey("last")
    LaunchedEffect(key, coordinator?.id, coordinator?.lastReplyEntryId, visible) {
        if (!visible || coordinator == null || coordinator.archived) return@LaunchedEffect
        val preferences = android.coordinatorPreferences()
        val seenKey = context.route.preferenceKey("reply:${coordinator.id}")
        preferences.edit().putString(key, coordinator.id).apply {
            val reply = coordinator.lastReplyEntryId ?: 0
            if (reply > preferences.getLong(seenKey, 0)) putLong(seenKey, reply)
        }.apply()
    }
}

@Composable
internal fun coordinatorSeen(chat: Destination.Chat, id: String) =
    LocalContext.current.coordinatorPreferences().getLong(chat.preferenceKey("reply:$id"), 0)

internal fun forgetCoordinatorVisit(android: Context, chat: Destination.Chat, id: String) {
    val preferences = android.coordinatorPreferences()
    val key = chat.preferenceKey("last")
    if (preferences.getString(key, null) == id) preferences.edit().remove(key).apply()
}

internal class CoordinatorMessages {
    var messages by mutableStateOf(emptyMap<String, ThreadsMessagesResponseMessagesItem>())
        private set
    var before by mutableStateOf<String?>(null)
        private set
    var loading by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set

    fun merge(rows: List<ThreadsMessagesResponseMessagesItem>) { messages = mergeMessages(messages, rows) }

    suspend fun read(client: HarnessClient, project: String, taskId: String?, cursor: String?) {
        loading = true
        error = null
        try {
            val page = client.request(ThreadsMessagesRequest(projectId = project, taskId = taskId, before = cursor, limit = 60))
            merge(page.messages)
            before = page.nextBefore
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { error = e.message ?: "Could not load coordinator messages" }
        finally { loading = false }
    }
}

@Composable
internal fun rememberCoordinatorMessages(context: ProjectScreenContext, enabled: Boolean, taskId: String? = null, loadHistory: Boolean = false): CoordinatorMessages {
    val client = context.backend.client
    val project = context.route.projectId
    val connection by client.state.collectAsStateWithLifecycle()
    val feed = remember(client, project, taskId, enabled) { CoordinatorMessages() }
    LaunchedEffect(feed, connection.generation, connection.status) {
        if (!enabled || connection.status != ConnectionStatus.Ready) return@LaunchedEffect
        launch(start = CoroutineStart.UNDISPATCHED) {
            client.events.collect { event ->
                if (event is ThreadsMessageEvent && event.projectId == project) {
                    feed.merge(listOfNotNull(event.message, event.answeredRequest).filter { taskId == null || it.taskId == taskId })
                }
            }
        }
        feed.read(client, project, taskId, null)
        if (loadHistory) {
            // The backend retains at most 300 messages. Fetch the retained join index for older transcript pages.
            repeat(4) { feed.read(client, project, taskId, feed.before ?: return@repeat) }
        }
    }
    return feed
}

internal fun setAllCoordinators(android: Context, chat: Destination.Chat, all: Boolean) {
    android.coordinatorPreferences().edit().putBoolean(chat.preferenceKey("all-tasks"), all).apply()
}

internal fun allCoordinators(android: Context, chat: Destination.Chat) = android.coordinatorPreferences().getBoolean(chat.preferenceKey("all-tasks"), false)
