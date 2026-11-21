package io.github.mitzacoder.kemiri.features.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.mitzacoder.kemiri.data.HarnessClient
import io.github.mitzacoder.kemiri.data.request
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.launch

@Composable
internal fun AppAddressSettings(client: HarnessClient, ready: Boolean) {
    var saved by remember(client) { mutableStateOf<AppSettings?>(null) }
    var useTemplate by remember(client) { mutableStateOf(false) }
    var template by remember(client) { mutableStateOf("") }
    var policy by remember(client) { mutableStateOf("ask") }
    var busy by remember(client) { mutableStateOf(false) }
    var error by remember(client) { mutableStateOf<String?>(null) }
    var readAttempt by remember(client) { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    val settings = AppSettings(if (useTemplate) AppAddressesTemplate(template = template.trim()) else AppAddressesOff(), policy)
    val latestDraft by rememberUpdatedState(settings)
    val dirty = saved != null && settings != saved
    fun fill(value: AppSettings) {
        useTemplate = value.addresses is AppAddressesTemplate
        template = (value.addresses as? AppAddressesTemplate)?.template.orEmpty()
        policy = value.policy
    }
    LaunchedEffect(client, ready, readAttempt) {
        if (!ready) return@LaunchedEffect
        var pushReceived = false
        launch(start = CoroutineStart.UNDISPATCHED) {
            client.events.collect { event ->
                if (event is AppsSettingsChangedEvent) {
                    pushReceived = true
                    if (!busy && (saved == null || latestDraft == saved)) fill(event.settings)
                    saved = event.settings
                }
            }
        }
        try {
            val fetched = client.request(AppsSettingsGetRequest()).settings
            if (!pushReceived) {
                if (saved == null || latestDraft == saved) fill(fetched)
                saved = fetched
            }
            error = null
        } catch (cause: CancellationException) { throw cause }
        catch (cause: Exception) { error = cause.message ?: "Could not read app settings." }
    }
    val enabled = ready && saved != null && !busy
    SettingsGroup(title = "Agent apps") {
        SettingsRow("App addresses", hint = "Links are not behind Kemiri sign-in. A template does not open ports or set up a proxy.", control = RowControl.Full) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(!useTemplate, { useTemplate = false }, label = { Text("Off") }, enabled = enabled)
                FilterChip(useTemplate, { useTemplate = true }, label = { Text("Address template") }, enabled = enabled)
            }
            if (useTemplate) OutlinedTextField(template, { template = it }, Modifier.fillMaxWidth(), enabled = enabled,
                label = { Text("Address template") }, placeholder = { Text("http://oven.example.test:{port}") }, singleLine = true,
                supportingText = { Text("Use {port} in the host or port. Optionally put {path} in the URL path.") })
        }
        SettingsRow("Agent publishing", hint = "Ask once per project, let agents publish, or prevent agent publishing on this computer.", control = RowControl.Full) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf("off" to "Off", "ask" to "Ask", "on" to "On").forEach { (value, label) ->
                    FilterChip(policy == value, { policy = value }, label = { Text(label) }, enabled = enabled)
                }
            }
            if (!ready) Text("Waiting for the backend…", color = Jarvis.colors.fgMuted)
            else if (saved == null && error == null) Text("Loading app settings…", color = Jarvis.colors.fgMuted)
            error?.let { Text(it, color = Jarvis.colors.danger) }
            if (saved == null && error != null) OutlinedButton(enabled = ready, onClick = { readAttempt++ }) { Text("Retry") }
            else Button(enabled = enabled && dirty && (!useTemplate || template.isNotBlank()), onClick = {
                error = null
                busy = true
                scope.launch {
                    try {
                        val updated = client.request(AppsSettingsSetRequest(settings = settings)).settings
                        fill(updated); saved = updated
                    } catch (cause: CancellationException) { throw cause }
                    catch (cause: Exception) { error = cause.message ?: "Could not save app settings." }
                    finally { busy = false }
                }
            }) { Text(if (busy) "Saving…" else "Save app settings") }
        }
    }
}
