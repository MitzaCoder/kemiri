package io.github.mitzacoder.kemiri.data

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.protocol.*
import java.io.Closeable
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

internal enum class OverviewReader { Tasks, Roster }
internal data class OverviewScope(val coordinatorId: String?)
internal data class OverviewRead(val value: OverviewEvent? = null, val error: String? = null)

internal fun overviewRequest(projectId: String, scope: OverviewScope, subscribe: Boolean) =
    OverviewGetRequest(projectId = projectId, coordinatorId = scope.coordinatorId, subscribe = subscribe)

internal fun OverviewEvent.appliesTo(projectId: String, scope: OverviewScope, previous: OverviewEvent? = null): Boolean =
    this.scope.projectId == projectId && this.scope.coordinatorId == scope.coordinatorId && (previous == null || asOf >= previous.asOf)

/** One live scope per project socket. The open roster temporarily follows the roll-up instead of Tasks. */
internal class ProjectOverview(private val client: HarnessClient, private val projectId: String, session: CoroutineScope) {
    private data class Lease(val reader: OverviewReader, val scope: OverviewScope)
    private data class Socket(val ready: Boolean, val generation: Int)
    private val leases = MutableStateFlow<Map<Any, Lease>>(emptyMap())
    private val snapshots = MutableStateFlow<Map<OverviewScope, OverviewRead>>(emptyMap())
    val reads = snapshots.asStateFlow()

    init {
        session.launch {
            var subscribed: Pair<Int, OverviewScope>? = null
            val wanted = leases.map { requests ->
                val pane = requests.values.lastOrNull { it.reader == OverviewReader.Tasks }?.scope
                val roster = requests.values.any { it.reader == OverviewReader.Roster }
                if (roster) OverviewScope(null) else pane
            }.distinctUntilChanged()
            val sockets = client.state.map { Socket(it.status == ConnectionStatus.Ready && it.supports(HarnessFeature.COORDINATOR_OVERVIEW), it.generation) }.distinctUntilChanged()
            combine(sockets, wanted) { socket, scope -> socket to scope }.collectLatest { (socket, scope) ->
                if (!socket.ready) return@collectLatest
                if (scope == null) {
                    val last = subscribed
                    subscribed = null
                    if (last?.first == socket.generation) runCatching { read(last.second, false) }
                    return@collectLatest
                }
                coroutineScope {
                    launch(start = CoroutineStart.UNDISPATCHED) {
                        client.events.collect { if (it is OverviewEvent) accept(scope, it) }
                    }
                    subscribed = socket.generation to scope
                    fetch(scope)
                    awaitCancellation()
                }
            }
        }
    }

    fun follow(scope: OverviewScope, reader: OverviewReader): Closeable {
        val token = Any()
        leases.update { it + (token to Lease(reader, scope)) }
        return Closeable { leases.update { it - token } }
    }

    private suspend fun read(scope: OverviewScope, subscribe: Boolean): OverviewGetResponse = client.request(
        overviewRequest(projectId, scope, subscribe), explicitNulls = if (scope.coordinatorId == null) setOf("coordinatorId") else emptySet(),
    )

    private suspend fun fetch(scope: OverviewScope) {
        try {
            val reply = read(scope, true)
            accept(scope, OverviewEvent(asOf = reply.asOf, scope = reply.scope, counts = reply.counts, waiting = reply.waiting,
                inFlight = reply.inFlight, week = reply.week, more = reply.more, estimateInputs = reply.estimateInputs, coordinators = reply.coordinators))
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (error: Exception) {
            snapshots.update { it + (scope to OverviewRead(it[scope]?.value, error.message ?: "Could not load the overview")) }
        }
    }

    private fun accept(scope: OverviewScope, snapshot: OverviewEvent) = snapshots.update {
        if (snapshot.appliesTo(projectId, scope, it[scope]?.value)) it + (scope to OverviewRead(snapshot)) else it
    }
}

@Composable
internal fun rememberProjectOverview(context: ProjectScreenContext, enabled: Boolean, coordinatorId: String?, reader: OverviewReader): OverviewRead {
    if (!enabled) return OverviewRead()
    val store = remember(context.backend, context.route.projectId) { context.backend.overview(context.route.projectId) }
    val scope = OverviewScope(coordinatorId)
    DisposableEffect(store, scope, reader) {
        val lease = store.follow(scope, reader)
        onDispose { lease.close() }
    }
    val reads by store.reads.collectAsStateWithLifecycle()
    return reads[scope] ?: OverviewRead()
}
