package io.github.mitzacoder.kemiri.features.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.launch

@Composable
internal fun BackendsSection(repository: HarnessRepository, navigator: SettingsNavigator, connectPayload: String?, onConnectHandled: () -> Unit) {
    val backends by repository.collectSettings { it.backends }
    val sessions by repository.sessions.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val local = LocalContext.current
    val preferences = remember { local.getSharedPreferences("harness-discovery", android.content.Context.MODE_PRIVATE) }
    var publishedUrl by rememberSaveable { mutableStateOf(preferences.getString("url", DEFAULT_PUBLISHED_URL) ?: DEFAULT_PUBLISHED_URL) }
    var suggestions by remember { mutableStateOf<List<BackendConfig>>(emptyList()) }
    var refresh by remember { mutableIntStateOf(0) }
    var name by rememberSaveable { mutableStateOf("") }
    var address by rememberSaveable { mutableStateOf("") }
    var importValue by remember { mutableStateOf("") }
    var previewValue by rememberSaveable { mutableStateOf<String?>(null) }
    var suggestion by remember { mutableStateOf<BackendConfig?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var importError by remember { mutableStateOf<String?>(null) }
    // Do not put pairing links in saved UI state or route arguments.
    var pairingLink by remember { mutableStateOf<String?>(null) }
    if (pairingLink != null) PairDeviceDialog(repository, initialLink = requireNotNull(pairingLink), onDismiss = { pairingLink = null })
    fun preview(value: String) {
        val trimmed = value.trim()
        val fragment = trimmed.substringAfter('#', trimmed)
        if (fragment.startsWith("pair=") || fragment.startsWith("bootstrap=")) {
            runCatching { decodeDevicePairingLink(trimmed) }.onSuccess {
                pairingLink = trimmed; importValue = ""; importError = null
            }.onFailure { importError = "Could not read the pairing link. Check it or ask for a new one." }
        } else decodeConnect(fragment).onSuccess {
            previewValue = fragment; importError = null
        }.onFailure { importError = it.message }
    }
    val imported = previewValue?.let { decodeConnect(it.substringAfter('#', it)).getOrNull() } ?: suggestion?.let { listOf(it) }
    LaunchedEffect(refresh) { suggestions = fetchPublishedBackends(publishedUrl) }
    LaunchedEffect(connectPayload) { connectPayload?.let { preview(it); onConnectHandled() } }
    val missing = suggestions.filter { row -> backends.none { it.key == row.key } }

    SettingsSectionPage(GeneralSection.Backends) {
        SettingsGroup(title = "Your computers") {
            if (sessions.isEmpty()) GroupNote("No computers yet. Add one below.")
            sessions.forEach { backend -> key(backend.config.key) {
                val connection by backend.client.state.collectAsStateWithLifecycle()
                LinkRow(
                    backend.config.name, backend.config.url,
                    onClick = { navigator.open(Destination.Settings(computerPage(backend.config.key))) },
                    leading = { BackendTile() },
                    chip = { ConnectionBadge(connection.status, connection.attempt) },
                )
                backend.client.deviceAuth?.let { controller ->
                    val auth by controller.state.collectAsStateWithLifecycle()
                    auth.notice?.let { Text(if (auth.comparisonCode != null) "$it · code ${auth.comparisonCode}" else it,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted) }
                }
            } }
        }
        if (missing.isNotEmpty()) SettingsGroup(title = "Suggested computers", description = "Published beside the app. One tap adds one and connects.") {
            missing.forEach { row ->
                GroupRow {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        Column(Modifier.weight(1f)) {
                            Text(row.name, style = MaterialTheme.typography.bodyMedium, fontWeight = androidx.compose.ui.text.font.FontWeight.SemiBold)
                            Text(row.url, style = MaterialTheme.typography.labelMedium, fontFamily = FontFamily.Monospace, color = Jarvis.colors.fgMuted)
                        }
                        OutlinedButton(onClick = { suggestion = row.copy(name = row.name.take(48)) }, modifier = Modifier.heightIn(min = 44.dp)) { Text("Add") }
                    }
                }
            }
        }
        SettingsGroup(title = "Add a computer") {
            SettingsRow(
                "Name and address", hint = "A bare name like studio-pc expands to the published domain.", control = RowControl.Full,
                learn = { Text("A backend is a harness server reached over HTTPS: the app opens wss://<address>/ws and keeps one connection per backend. The list is stored on this device.") },
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(address, { address = it }, label = { Text("URL, host, or published name") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(name, { name = it }, label = { Text("Name (optional; filled from address)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    if (address.isNotBlank()) runCatching { resolveBackend(address, name, suggestions, publishedUrl) }.getOrNull()?.let {
                        Text("Will add ${it.name} · ${it.url}", style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted)
                    }
                    Button(enabled = address.isNotBlank(), modifier = Modifier.heightIn(min = 44.dp), onClick = {
                        scope.launch { runCatching {
                            repository.addBackends(listOf(resolveBackend(address, name, suggestions, publishedUrl)))
                            name = ""; address = ""; error = null
                        }.onFailure { error = it.message } }
                    }) { Text("Add computer") }
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
            }
            SettingsRow(
                "Published list", hint = "Where the suggestions above come from.", control = RowControl.Full,
                learn = { Text("Unavailable or invalid lists are ignored. Manual setup always works.") },
            ) {
                OutlinedTextField(publishedUrl, { publishedUrl = it }, label = { Text("Published list URL") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                TextButton(onClick = { preferences.edit().putString("url", publishedUrl).apply(); refresh++ }, modifier = Modifier.heightIn(min = 44.dp)) { Text("Reload suggestions") }
            }
        }
        SettingsGroup(title = "Connect to a computer") {
            SettingsRow("Scan or paste a link", hint = "Review the computer before adding it or signing in.", control = RowControl.Full) {
                ConnectScanner { preview(it) }
                OutlinedTextField(importValue, { importValue = it }, label = { Text("Pairing or connect link") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                TextButton(onClick = { preview(importValue) }, enabled = importValue.isNotBlank(), modifier = Modifier.heightIn(min = 44.dp)) { Text("Review link") }
                importError?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        }
    }
    imported?.let { rows ->
        AlertDialog(onDismissRequest = { previewValue = null; suggestion = null }, title = { Text("Add these computers?") },
            text = { Column {
                Text(rows.joinToString("\n\n") { "${it.name}\n${it.url}" })
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            } },
            confirmButton = { TextButton(onClick = { scope.launch { runCatching {
                repository.addBackends(rows); previewValue = null; suggestion = null; importValue = ""
            }.onFailure { error = it.message } } }) { Text("Add") } },
            dismissButton = { TextButton(onClick = { previewValue = null; suggestion = null }) { Text("Cancel") } })
    }
}

@Composable
internal fun BackendTile() {
    val colors = Jarvis.colors
    Box(Modifier.size(36.dp).background(colors.surface2.copy(alpha = .7f), RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
        io.github.mitzacoder.kemiri.ui.components.LucideGlyph(io.github.mitzacoder.kemiri.navigation.NavGlyphs.Server, size = 16.dp, tint = colors.fgMuted)
    }
}
