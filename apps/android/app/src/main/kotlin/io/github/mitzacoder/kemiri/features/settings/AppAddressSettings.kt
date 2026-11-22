package io.github.mitzacoder.kemiri.features.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
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
    var mode by remember(client) { mutableStateOf("off") }
    var tailscale by remember(client) { mutableStateOf<AppsSettingsGetResponseTailscale?>(null) }
    var startPort by remember(client) { mutableStateOf("47300") }
    var endPort by remember(client) { mutableStateOf("47319") }
    var template by remember(client) { mutableStateOf("") }
    var policy by remember(client) { mutableStateOf("ask") }
    var busy by remember(client) { mutableStateOf(false) }
    var error by remember(client) { mutableStateOf<String?>(null) }
    var readAttempt by remember(client) { mutableIntStateOf(0) }
    val scope = rememberCoroutineScope()
    val settings = AppSettings(when (mode) {
        "template" -> AppAddressesTemplate(template = template.trim())
        "tailscale-reserved" -> AppAddressesTailscaleReserved()
        "tailscale-serve" -> AppAddressesTailscaleServe(startPort = startPort.toLongOrNull() ?: 0, endPort = endPort.toLongOrNull() ?: 0)
        else -> AppAddressesOff()
    }, policy)
    val latestDraft by rememberUpdatedState(settings)
    val dirty = saved != null && settings != saved
    fun fill(value: AppSettings) {
        mode = when (value.addresses) {
            is AppAddressesTailscaleReserved -> "tailscale-reserved"
            is AppAddressesTailscaleServe -> "tailscale-serve"
            is AppAddressesTemplate -> "template"
            else -> "off"
        }
        val range = value.addresses as? AppAddressesTailscaleServe
        startPort = range?.startPort?.toString() ?: "47300"
        endPort = range?.endPort?.toString() ?: "47319"
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
            val response = client.request(AppsSettingsGetRequest())
            tailscale = response.tailscale
            val fetched = response.settings
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
        SettingsRow("App addresses", hint = "How app links reach devices. Links are not behind Kemiri sign-in.", control = RowControl.Full) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(mode == "off", { mode = "off" }, label = { Text("Off") }, enabled = enabled)
                FilterChip(mode == "template", { mode = "template" }, label = { Text("Address template") }, enabled = enabled)
                if (tailscale != null || mode == "tailscale-reserved") FilterChip(mode == "tailscale-reserved", { mode = "tailscale-reserved" },
                    label = { Text("Tailscale HTTPS (reserved ports)") }, enabled = enabled)
                if (tailscale != null || mode == "tailscale-serve") FilterChip(mode == "tailscale-serve", { mode = "tailscale-serve" },
                    label = { Text("Tailscale HTTPS (advanced)") }, enabled = enabled)
            }
            tailscale?.reservedPorts?.let { reservation ->
                Text(reservation.message, style = MaterialTheme.typography.bodySmall,
                    color = if (reservation.ok) Jarvis.colors.fgMuted else Jarvis.colors.warning)
            }
            if (mode == "tailscale-serve") Text("Advanced: gives Kemiri the right to change Tailscale Serve. Reserved ports do not need this permission.",
                style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.warning)
            if (mode == "template") OutlinedTextField(template, { template = it }, Modifier.fillMaxWidth(), enabled = enabled,
                label = { Text("Address template") }, placeholder = { Text("http://oven.example.test:{port}") }, singleLine = true,
                supportingText = { Text("Use {port} in the host or port. Optionally put {path} in the URL path.") })
        }
        if (mode == "tailscale-serve") {
            SettingsRow("HTTPS port range", hint = "Reserve 1–100 ports for app links. Do not include 8443 or Kemiri’s port.", control = RowControl.Full) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(startPort, { startPort = it }, Modifier.weight(1f), enabled = enabled,
                        label = { Text("First port") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                    OutlinedTextField(endPort, { endPort = it }, Modifier.weight(1f), enabled = enabled,
                        label = { Text("Last port") }, singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                }
            }
            tailscale?.let { status ->
                SettingsRow("Tailscale status", hint = "Reopen Settings to check again after making a change.", control = RowControl.Full) {
                    listOf(status.installed, status.running, status.magicDns, status.https, status.operator).forEach { line ->
                        Text(line.message, style = MaterialTheme.typography.bodySmall,
                            color = if (line.ok) Jarvis.colors.fgMuted else Jarvis.colors.warning)
                    }
                }
            }
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
            else Button(enabled = enabled && dirty && (mode != "template" || template.isNotBlank()), onClick = {
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
