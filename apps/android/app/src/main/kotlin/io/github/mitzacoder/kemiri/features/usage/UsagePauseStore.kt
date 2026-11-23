package io.github.mitzacoder.kemiri.features.usage

import io.github.mitzacoder.kemiri.data.ConnectionStatus
import io.github.mitzacoder.kemiri.data.HarnessClient
import io.github.mitzacoder.kemiri.data.HarnessFeature
import io.github.mitzacoder.kemiri.data.request
import io.github.mitzacoder.kemiri.protocol.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/** One snapshot per computer, shared by project banners and Usage. Null means not negotiated or not yet read. */
class UsagePauseStore(private val client: HarnessClient, scope: CoroutineScope) {
    private val lock = Any()
    private var revision = 0L
    private val mutablePauses = MutableStateFlow<List<UsagePause>?>(null)
    val pauses = mutablePauses.asStateFlow()

    init {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            client.events.collect { event ->
                if (event is UsagePauseEvent && client.state.value.supports(HarnessFeature.USAGE_PAUSE)) {
                    synchronized(lock) { revision++; mutablePauses.value = event.pauses }
                }
            }
        }
        scope.launch {
            client.state.collectLatest { connection ->
                if (connection.status != ConnectionStatus.Ready || !connection.supports(HarnessFeature.USAGE_PAUSE)) {
                    synchronized(lock) { revision++; mutablePauses.value = null }
                } else {
                    try { update { client.request(UsagePauseGetRequest()).pauses } }
                    catch (cancelled: CancellationException) { throw cancelled }
                    catch (_: Exception) { /* Keep controls hidden if the backend could not return its state. */ }
                }
            }
        }
    }

    suspend fun setPaused(providerLogin: String, paused: Boolean) = update {
        if (paused) client.request(UsagePausePauseRequest(providerLogin = providerLogin)).pauses
        else client.request(UsagePauseResumeRequest(providerLogin = providerLogin)).pauses
    }

    private suspend fun update(read: suspend () -> List<UsagePause>) {
        val before = synchronized(lock) { revision }
        val result = read()
        synchronized(lock) { if (revision == before) mutablePauses.value = result }
    }
}
