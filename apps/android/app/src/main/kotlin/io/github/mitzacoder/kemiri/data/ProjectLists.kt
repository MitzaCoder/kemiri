package io.github.mitzacoder.kemiri.data

import androidx.compose.runtime.Composable
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*

internal data class ProjectListRead<T>(val value: T? = null, val loading: Boolean = true,
    val error: String? = null, val generation: Int = -1)

/** One read per connection generation regardless of how many screens watch this list. */
internal class ProjectListStore<T>(
    client: HarnessClient, scope: CoroutineScope, supported: (ConnectionState) -> Boolean,
    read: suspend () -> T, push: (ProtocolEvent) -> T?,
    mergePush: (previous: T?, pushed: T) -> T = { _, pushed -> pushed },
    mergeRacedRead: (read: T, latest: T) -> T = { _, latest -> latest },
    needsArchiveRead: (previous: T?, pushed: T) -> Boolean = { _, _ -> false },
) {
    private val pendingRead = Channel<Unit>(Channel.CONFLATED)
    private val mutableSnapshot = MutableStateFlow(ProjectListRead<T>())
    val snapshot = mutableSnapshot.asStateFlow()
    private val lock = Any()
    private var pushSequence = 0L
    private var pushGeneration = -1

    fun refresh() { pendingRead.trySend(Unit) }

    init {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            client.events.collect { event ->
                val pushed = push(event) ?: return@collect
                synchronized(lock) {
                    pushSequence++
                    pushGeneration = client.state.value.generation
                    val before = snapshot.value
                    mutableSnapshot.value = before.copy(value = mergePush(before.value, pushed), error = null)
                    if (needsArchiveRead(before.value, pushed)) refresh()
                }
            }
        }
        scope.launch {
            client.state.map { (it.status == ConnectionStatus.Ready && supported(it)) to it.generation }
                .distinctUntilChanged().collectLatest { (ready, generation) ->
                    if (!ready) { mutableSnapshot.update { it.copy(loading = false) }; return@collectLatest }
                    pendingRead.receiveAsFlow().onStart { emit(Unit) }.collectLatest {
                        val before = synchronized(lock) { pushSequence }
                        mutableSnapshot.update { it.copy(loading = true) }
                        try {
                            val value = read()
                            currentCoroutineContext().ensureActive()
                            synchronized(lock) {
                                if (client.state.value.generation == generation && client.state.value.status == ConnectionStatus.Ready) {
                                    val latest = snapshot.value.value
                                    val raced = before != pushSequence && pushGeneration == generation && latest != null
                                    mutableSnapshot.value = ProjectListRead(if (raced) mergeRacedRead(value, requireNotNull(latest)) else value,
                                        loading = false, generation = generation)
                                }
                            }
                        } catch (cancelled: CancellationException) { throw cancelled }
                        catch (error: Exception) { mutableSnapshot.update { it.copy(error = error.message ?: "Request failed") } }
                        finally { mutableSnapshot.update { it.copy(loading = false) } }
                    }
                }
        }
    }
}

internal data class ProjectThreadList(val threads: List<ThreadSummary>, val landingTurn: LandingTurn?)
internal data class ProjectWorkerList(val workers: List<WorkerSummary>, val defaults: WorkerDefaults)

/** Thread pushes omit archives; preserve known archives and re-read when a live row disappears. */
internal fun mergeThreadPush(known: ProjectThreadList?, pushed: ProjectThreadList): ProjectThreadList {
    val liveIds = pushed.threads.mapTo(HashSet()) { it.id }
    return pushed.copy(threads = pushed.threads + known?.threads.orEmpty().filter { it.archived && it.id !in liveIds })
}

internal fun ProjectThreads(client: HarnessClient, projectId: String, scope: CoroutineScope) = ProjectListStore(
    client, scope, supported = { it.supports("threads") || it.supports("coordinators") },
    read = { client.request(ThreadsListRequest(projectId = projectId, includeArchived = true)).let { ProjectThreadList(it.threads, it.landingTurn) } },
    push = { (it as? ThreadsStateEvent)?.takeIf { event -> event.projectId == projectId }?.let { ProjectThreadList(it.threads, it.landingTurn) } },
    mergePush = ::mergeThreadPush,
    mergeRacedRead = { read, latest -> mergeThreadPush(read, latest.copy(threads = latest.threads.filterNot { it.archived })) },
    needsArchiveRead = { before, pushed ->
        val liveIds = pushed.threads.mapTo(HashSet()) { it.id }
        before?.threads.orEmpty().any { !it.archived && it.id !in liveIds }
    },
)

internal fun ProjectWorkers(client: HarnessClient, projectId: String, scope: CoroutineScope) = ProjectListStore(
    client, scope, supported = { it.supports("workers") },
    read = { client.request(WorkersListRequest(projectId = projectId)).let { ProjectWorkerList(it.workers, it.defaults) } },
    push = { (it as? WorkersStateEvent)?.takeIf { event -> event.projectId == projectId }?.let { ProjectWorkerList(it.workers, it.defaults) } },
)

@Composable internal fun projectThreads(context: ProjectScreenContext, enabled: Boolean = true): ProjectListRead<ProjectThreadList>? =
    if (enabled) context.backend.threads(context.route.projectId).snapshot.collectAsStateWithLifecycle().value else null

@Composable internal fun projectWorkers(context: ProjectScreenContext, enabled: Boolean = true): ProjectListRead<ProjectWorkerList>? =
    if (enabled) context.backend.workers(context.route.projectId).snapshot.collectAsStateWithLifecycle().value else null
