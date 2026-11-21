package io.github.mitzacoder.kemiri.features.chat

import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.mapSaver
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.ConversationTarget
import io.github.mitzacoder.kemiri.data.ConversationWatch
import io.github.mitzacoder.kemiri.data.WatchState
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.navigation.screenStateKey
import io.github.mitzacoder.kemiri.protocol.ThreadsMessagesResponseMessagesItem
import kotlinx.coroutines.CoroutineScope

/** Oldest first. The shown coordinator is always the newest. */
internal fun <T> visitCoordinator(recents: List<T>, shown: T, limit: Int): List<T> =
    if (recents.lastOrNull() == shown) recents else (recents.filterNot { it == shown } + shown).takeLast(limit)

internal class CoordinatorChatState(
    val watch: ConversationWatch,
    val watchState: State<WatchState>,
    val list: LazyListState,
    val follow: MutableState<Boolean>,
    val draft: ChatDraftState,
    val scope: CoroutineScope,
    private val admission: SnapshotStateMap<String, String>,
    private val routeKey: String,
) {
    var pending: String?
        get() = admission["pending:$routeKey"]
        set(value) { if (value == null) admission.remove("pending:$routeKey") else admission["pending:$routeKey"] = value }
    var files: String
        get() = admission["files:$routeKey"] ?: "[]"
        set(value) { if (value == "[]") admission.remove("files:$routeKey") else admission["files:$routeKey"] = value }

    val shownRows = ShownRows()
    val submitting = mutableStateOf(false)
    val attaching = mutableStateOf(false)
    val error = mutableStateOf<String?>(null)
}

@Composable
internal fun rememberCoordinatorChat(
    context: ProjectScreenContext,
    retain: Boolean,
    messages: Map<String, ThreadsMessagesResponseMessagesItem>,
    memoryNotes: Boolean,
): Pair<CoordinatorChatState, List<ChatRow>> {
    val client = context.backend.client
    var recents by remember(client, context.route.projectId) { mutableStateOf(emptyList<ConversationTarget>()) }
    // Unsent file references and ambiguous admission IDs outlive the bounded live watches.
    val admission = rememberSaveable(saver = mapSaver(
        save = { it.toMap() },
        restore = { persisted -> mutableStateMapOf<String, String>().apply { persisted.forEach { (key, value) -> put(key, value as String) } } },
    )) { mutableStateMapOf<String, String>() }
    val target = context.target
    val visited = if (retain) visitCoordinator(recents, target, 4) else recents
    SideEffect { recents = visited }
    var selected: Pair<CoordinatorChatState, List<ChatRow>>? = null
    for (retained in (visited + target).distinct()) key(client, retained) {
        val watch = remember { ConversationWatch(client, retained) }
        DisposableEffect(watch) { onDispose { watch.close() } }
        val watchState = watch.state.collectAsStateWithLifecycle()
        val route = context.route.copy(threadId = retained.threadId, workerId = retained.workerId)
        val draft = rememberChatDraft(context.copy(route = route))
        val list = rememberLazyListState()
        val follow = rememberSaveable { mutableStateOf(true) }
        val scope = rememberCoroutineScope()
        val chat = remember(watch, draft) { CoordinatorChatState(watch, watchState, list, follow, draft, scope, admission, route.screenStateKey()) }
        val state = watchState.value
        val rows = remember(state.entries, state.view, messages, memoryNotes) {
            transcript(state.entries, state.view?.docs?.get("pi.live"), state.view?.keepWarm.orEmpty(), messages, memoryNotes && retained.workerId == null)
        }
        if (retained == target) selected = chat to rows
    }
    return checkNotNull(selected)
}
