package io.github.mitzacoder.kemiri.features.settings

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.features.status.*
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.launch

@Composable
internal fun ComputerOverview(repository: HarnessRepository, backend: BackendSession) {
    val connection by backend.client.state.collectAsStateWithLifecycle()
    val backendError by backend.error.collectAsStateWithLifecycle()
    val status by backend.serverStatus.status.collectAsStateWithLifecycle()
    SettingsSectionPage(ComputerSection.Overview.label, ComputerSection.Overview.hint, ComputerSection.Overview.icon, actions = { ConnectionBadge(connection.status, connection.attempt) }) {
        listOfNotNull(backendError, connection.error).distinct().forEach { message ->
            ToneBanner(BannerTone.Error) { Text(message, style = MaterialTheme.typography.bodySmall) }
        }
        if (connection.supports(SERVER_STATUS_FEATURE)) DeployBanner(repository, backend)
        SettingsGroup(title = "Status") {
            if (connection.supports(SERVER_STATUS_FEATURE)) {
                SettingsRow("Release", hint = "The commit this computer runs.", control = RowControl.Full) { ReleaseLine(status, compact = false) }
                SettingsRow("Machine", hint = "Disk space on this computer.", control = RowControl.Full) {
                    MachineLine(status)
                    if (status == null || serverDisks(status).isEmpty()) GroupLessNote("Not reported.")
                }
            } else GroupNote("Kemiri ${backendVersion(connection.hello?.server?.version, status) ?: "—"}")
        }
        ComputerSoftwareUpdates(backend)
    }
}

@Composable
internal fun ComputerYouAndMemory(backend: BackendSession) {
    val connection by backend.client.state.collectAsStateWithLifecycle()
    val userName by backend.userName.collectAsStateWithLifecycle()
    val userNameSave = rememberSaveState(backend.config.key)
    SettingsSectionPage(ComputerSection.You) {
        if (connection.supports("user-settings")) SettingsGroup(title = "About you") {
            SettingsRow("Your name", hint = "Optional · up to 80 characters. Agents use this name across all projects on this computer, from their next turn. Clear it to stop using a name.", status = userNameSave) {
                AutoInput(userName.orEmpty(), userNameSave, label = "Your name", placeholder = "What should agents call you?", enabled = userName != null && connection.status == ConnectionStatus.Ready) { next ->
                    require(next.length <= 80 && next.none { Character.isISOControl(it) || Character.getType(it) == Character.FORMAT.toInt() }) { "Use a name of at most 80 characters, without control characters." }
                    backend.setUserName(next)
                }
            }
        }
        if (connection.supports("memory-maintenance")) MemoryMaintenanceGroup(backend)
        if (!connection.supports("user-settings") && !connection.supports("memory-maintenance")) SettingsGroup {
            GroupNote("These settings are not available on this computer.")
        }
    }
}

@Composable
internal fun ComputerAdvanced(repository: HarnessRepository, backend: BackendSession, navigator: SettingsNavigator) {
    val scope = rememberCoroutineScope()
    val nameSave = rememberSaveState(backend.config.key)
    val removeSave = rememberSaveState(backend.config.key)
    var confirmingRemove by rememberSaveable { mutableStateOf(false) }
    val connection by backend.client.state.collectAsStateWithLifecycle()
    SettingsSectionPage(ComputerSection.Advanced) {
        if (connection.supports(io.github.mitzacoder.kemiri.data.HarnessFeature.APPS)) {
            AppAddressSettings(backend.client, connection.status == ConnectionStatus.Ready)
        }
        if (connection.supports("coordinator-compaction-settings")) key(backend.config.key) {
            CoordinatorCompactionGroup(backend, connection.status == ConnectionStatus.Ready)
        }
        SettingsGroup(title = "This computer") {
            if (connection.supports("usage-drain")) key(backend.config.key) {
                UsageDrainRow(backend, connection.status == ConnectionStatus.Ready)
            }
            SettingsRow("Name on this device", hint = "Only for you, on this phone.", status = nameSave, badge = "This device only") {
                AutoInput(backend.config.name, nameSave, label = "Name on this device") { next ->
                    require(next.length in 1..48) { "Use a name of 1–48 characters." }
                    repository.renameBackend(backend.config.key, next)
                }
            }
            SettingsRow("Address", hint = "Where the app connects.", control = RowControl.Auto) { CopyableValue(backend.config.url, "Copy the address") }
        }
        SettingsGroup(title = "Remove", danger = true) {
            SettingsRow("Remove this computer from this phone", hint = "Its projects and data stay on the computer.", badge = "This device only", control = RowControl.Auto, status = removeSave) {
                if (confirmingRemove) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { confirmingRemove = false }, modifier = Modifier.heightIn(min = 44.dp)) { Text("Keep it") }
                    Button(
                        onClick = { scope.launch {
                            if (removeSave.run { repository.removeBackend(backend.config.key) }) {
                                navigator.up(Destination.Settings(GeneralPage(GeneralSection.Backends)))
                            }
                        } },
                        enabled = removeSave.status != SaveStatus.Saving,
                        colors = ButtonDefaults.buttonColors(containerColor = Jarvis.colors.danger), modifier = Modifier.heightIn(min = 44.dp),
                    ) { Text("Remove") }
                } else OutlinedButton(onClick = { confirmingRemove = true }, modifier = Modifier.heightIn(min = 44.dp)) { Text("Remove", color = Jarvis.colors.danger) }
            }
        }
    }
}

@Composable
internal fun GroupLessNote(text: String) = Text(text, style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted)

private val usageDrainOptions = listOf(
    ComboOption("pause-and-tell", "Pause and tell me"),
    ComboOption("tell-only", "Tell me only"),
    ComboOption("off", "Off"),
)

@Composable
private fun UsageDrainRow(backend: BackendSession, ready: Boolean) {
    val mode by backend.usageDrainMode.collectAsStateWithLifecycle()
    val saveState = rememberSaveState(backend.config.key)
    SettingsRow("Fast usage drain", hint = "When subscription use rises fast on this computer.", status = saveState) {
        Combobox(usageDrainOptions, mode.orEmpty(), { next ->
            if (next != mode) saveState.launch { backend.setUsageDrainMode(next) }
        }, label = "Fast usage drain", placeholder = "Loading…", enabled = ready && mode != null && saveState.status != SaveStatus.Saving)
    }
}
