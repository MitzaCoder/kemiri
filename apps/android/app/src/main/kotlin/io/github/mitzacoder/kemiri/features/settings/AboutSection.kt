package io.github.mitzacoder.kemiri.features.settings

import android.content.Intent
import androidx.compose.foundation.Image
import androidx.compose.ui.res.painterResource
import io.github.mitzacoder.kemiri.R
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.google.android.gms.oss.licenses.v2.OssLicensesMenuActivity
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.HarnessRepository
import io.github.mitzacoder.kemiri.features.status.*
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.BuildConfig

/** Offline notices remain accessible without any backend or relay account. */
@Composable
internal fun AboutSection(repository: HarnessRepository, navigator: SettingsNavigator) {
    val sessions by repository.sessions.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var document by remember { mutableStateOf<String?>(null) }
    Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
        SettingsGroup(title = "About Kemiri") {
            Image(painterResource(R.drawable.ic_brand), contentDescription = "Kemiri candlenut", modifier = Modifier.fillMaxWidth().height(88.dp).padding(top = 16.dp))
            GroupNote("Version ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})")
            GroupNote("A client for the computers where you run Kemiri.")
        }
        if (sessions.isNotEmpty()) SettingsGroup(title = "Computer versions") {
            sessions.forEach { backend -> key(backend.config.key) {
                val connection by backend.client.state.collectAsStateWithLifecycle()
                val status by backend.serverStatus.status.collectAsStateWithLifecycle()
                val version = "Kemiri ${backendVersion(connection.hello?.server?.version, status) ?: "—"}"
                val available = connection.supports(RELEASE_UPDATES_FEATURE) && status?.updates?.let { it.schemaVersion == 1L && it.available != null } == true
                if (available) LinkRow(backend.config.name, version, chip = { StatusChip("Update available", ChipTone.Info) }, onClick = {
                    navigator.open(Destination.Settings(computerPage(backend.config.key, ComputerSection.Overview)))
                }) else SettingsRow(backend.config.name, hint = version)
            } }
        }
        SettingsGroup(title = "Open-source licences") {
            GroupNote("Sora editor and language-textmate 0.24.6 use LGPL-2.1. Library source and replacement instructions are included with this release.")
            TextButton(onClick = { document = "Sora-NOTICE.txt" }) { Text("Sora notice and source") }
            TextButton(onClick = { document = "LGPL-2.1-Sora.txt" }) { Text("GNU LGPL 2.1") }
            TextButton(onClick = { document = "RELINKING.md" }) { Text("Rebuild with modified libraries") }
            TextButton(onClick = {
                OssLicensesMenuActivity.setActivityTitle("Open-source licences")
                context.startActivity(Intent(context, OssLicensesMenuActivity::class.java))
            }) { Text("All dependency licences") }
            for ((label, file) in listOf(
                "Atkinson Hyperlegible Next font" to "OFL-AtkinsonHyperlegibleNext.txt",
                "JetBrains Mono font" to "OFL-JetBrainsMono.txt",
                "Termux terminal" to "APACHE-2.0-termux-terminal.txt",
                "Chat syntax grammars and Catppuccin themes" to "CHAT-TEXTMATE-NOTICE.txt",
            )) TextButton(onClick = { document = file }) { Text(label) }
        }
    }
    document?.let { file ->
        val text = remember(file) { context.assets.open(file).bufferedReader().use { it.readText() } }
        AlertDialog(
            onDismissRequest = { document = null },
            title = { Text(file) },
            text = {
                SelectionContainer {
                    Text(text, Modifier.heightIn(max = 440.dp).verticalScroll(rememberScrollState()), style = MaterialTheme.typography.bodyMedium)
                }
            },
            confirmButton = { TextButton(onClick = { document = null }) { Text("Close") } },
        )
    }
}
