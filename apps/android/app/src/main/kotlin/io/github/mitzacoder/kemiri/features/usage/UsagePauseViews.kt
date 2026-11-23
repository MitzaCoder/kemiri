package io.github.mitzacoder.kemiri.features.usage

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.BackendSession
import io.github.mitzacoder.kemiri.data.ConnectionStatus
import io.github.mitzacoder.kemiri.navigation.ChatHighlight
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import io.github.mitzacoder.kemiri.features.status.BannerTone
import io.github.mitzacoder.kemiri.features.status.ToneBanner
import io.github.mitzacoder.kemiri.features.status.exactTime
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
internal fun UsagePauseAction(backend: BackendSession, providerLogin: String, label: String, showComputer: Boolean = false) {
    val pauses by backend.usagePause.pauses.collectAsStateWithLifecycle()
    val state by backend.client.state.collectAsStateWithLifecycle()
    val snapshot = pauses ?: return
    val paused = snapshot.any { it.providerLogin == providerLogin }
    val scope = rememberCoroutineScope()
    var busy by remember(backend, providerLogin) { mutableStateOf(false) }
    var error by remember(backend, providerLogin) { mutableStateOf<String?>(null) }
    val action = if (paused) "Resume" else "Pause"
    Column {
        OutlinedButton(onClick = {
            busy = true
            error = null
            scope.launch {
                try { backend.usagePause.setPaused(providerLogin, !paused) }
                catch (cancelled: CancellationException) { throw cancelled }
                catch (failure: Exception) { error = failure.message ?: "Could not change the pause." }
                finally { busy = false }
            }
        }, enabled = !busy && state.status == ConnectionStatus.Ready, modifier = Modifier.semantics {
            contentDescription = "$action $label on ${backend.config.name}"
        }) { Text(if (busy) "Saving…" else if (showComputer) "$action · ${backend.config.name}" else action) }
        error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
    }
}

@Composable
fun UsagePauseBanners(context: ProjectScreenContext) {
    val backend = context.backend
    val pauses by backend.usagePause.pauses.collectAsStateWithLifecycle()
    pauses.orEmpty().forEach { pause -> key(pause.providerLogin) {
        val label = subscriptionProviderLabel(pause.providerLogin)
        ToneBanner(BannerTone.Warning) {
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), itemVerticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("$label work is paused on this computer.", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
                    val wait = pause.until?.let { "New requests continue automatically at ${exactTime(it)}." } ?: "New requests wait until resumed."
                    Text("${pause.reason} $wait", style = MaterialTheme.typography.bodySmall)
                    val drainStatus = when (pause.drain?.status) {
                        "investigating" -> "Kemiri is looking into the fast drain."
                        "needs-choice" -> "Kemiri needs a choice before resuming."
                        "kept-paused" -> "Work will stay paused until resumed."
                        else -> null
                    }
                    drainStatus?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                }
                val drain = pause.drain
                val projectId = drain?.projectId
                val questionId = drain?.questionId
                if (drain?.status == "needs-choice" && projectId != null && questionId != null) {
                    OutlinedButton(onClick = {
                        context.navigate(Destination.Chat(context.route.backendKey, projectId, highlight = ChatHighlight.Question(questionId, System.nanoTime())))
                    }) { Text("Open question") }
                } else if (drain == null || drain.status == "kept-paused") {
                    UsagePauseAction(backend, pause.providerLogin, label)
                }
            }
        }
    } }
}
