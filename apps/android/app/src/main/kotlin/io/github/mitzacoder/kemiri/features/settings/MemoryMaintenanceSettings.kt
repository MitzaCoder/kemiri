package io.github.mitzacoder.kemiri.features.settings

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.protocol.*
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.CancellationException

internal fun maintenanceRequest(model: ModelRef?, thinking: String?, time: String, writes: String, enabled: Boolean? = null): MemorySettingsSetRequest {
    require(Regex("^([01][0-9]|2[0-3]):[0-5][0-9]$").matches(time)) { "Use a time like 03:00." }
    val count = writes.toLongOrNull()
    require(count != null && count in 1..1000) { "Enter a whole number from 1 to 1000." }
    require(model == null || (model.provider.isNotBlank() && model.modelId.isNotBlank())) { "Choose a valid model." }
    require(thinking == null || thinking in THINKING_ORDER) { "Choose a supported thinking level." }
    return MemorySettingsSetRequest(maintenance = MemoryMaintenanceSettings(enabled = enabled, model = model, thinkingLevel = if (model == null) null else thinking, time = time, afterWrites = count))
}

/** What the maintenance settings say in a line (web `memoryMaintenanceSummary`). */
internal fun maintenanceSummary(settings: MemoryMaintenanceSettings, timezone: String): String =
    if (settings.enabled == false) "Off: automatic cleanup is paused."
    else if (settings.model == null) "Off: no model is chosen, so maintenance does not run."
    else "Runs nightly at ${io.github.mitzacoder.kemiri.data.displayWallTime(settings.time)} (${timezone.ifEmpty { "the computer's time zone" }}) and after ${settings.afterWrites} new writes to a scope."

/**
 * A backend's memory maintenance: the model and thinking level a run uses, the nightly time in the computer's time zone and
 * how many writes to a scope start a run. New computers can pause cleanup without clearing the model.
 * Each field saves at once (`memory.settings.set`).
 */
@Composable
internal fun MemoryMaintenanceGroup(backend: BackendSession) {
    val connection by backend.client.state.collectAsStateWithLifecycle()
    val models by backend.models.collectAsStateWithLifecycle()
    val catalog by backend.modelCatalog.collectAsStateWithLifecycle()
    var settings by remember(backend) { mutableStateOf<MemoryMaintenanceSettings?>(null) }
    var timezone by remember(backend) { mutableStateOf("") }
    var readError by remember(backend) { mutableStateOf<String?>(null) }
    val switchSave = rememberSaveState(backend)
    var openModelRequest by remember(backend) { mutableIntStateOf(0) }
    val modelSave = rememberSaveState(backend)
    val thinkingSave = rememberSaveState(backend)
    val timeSave = rememberSaveState(backend)
    val writesSave = rememberSaveState(backend)
    LaunchedEffect(backend, connection.status) {
        if (connection.status != ConnectionStatus.Ready) return@LaunchedEffect
        try {
            val status = backend.client.request(MemoryStatusRequest(scope = "global"))
            settings = status.maintenance; timezone = status.timezone; readError = null
        } catch (e: CancellationException) { throw e }
        catch (_: Exception) { readError = "Unable to read the maintenance settings." }
    }
    val current = settings
    suspend fun apply(request: MemorySettingsSetRequest) { settings = backend.client.request(request).maintenance }
    val supportsEnabled = connection.supports(HarnessFeature.MEMORY_MAINTENANCE_ENABLED)
    val enabled = current?.let { (it.enabled.takeIf { supportsEnabled }) ?: (it.model != null) } == true
    val saving = listOf(switchSave, modelSave, thinkingSave, timeSave, writesSave).any { it.status == SaveStatus.Saving }
    SettingsGroup(
        title = "Automatic memory cleanup", term = "Memory maintenance",
        description = "Tidies this computer's memory notes: merges duplicates and archives old ones.",
        actions = { StatusChip(if (enabled) "On" else "Off", if (enabled) ChipTone.Ok else ChipTone.Muted) },
    ) {
        if (current == null) GroupNote(readError ?: "Reading the maintenance settings…")
        if (current != null && supportsEnabled) {
            SettingsRow("Automatic memory cleanup", control = RowControl.Inline, status = switchSave) {
                SettingsSwitch(enabled, { on ->
                    switchSave.launch {
                        openModelRequest = 0
                        apply(maintenanceRequest(current.model, current.thinkingLevel, current.time, current.afterWrites.toString(), on))
                        if (on && current.model == null) openModelRequest++
                    }
                }, "Automatic memory cleanup", enabled = !saving && connection.status == ConnectionStatus.Ready)
            }
        }
        if (current != null && (enabled || !supportsEnabled)) {
            val options = remember(models, catalog, supportsEnabled) {
                val offered = modelOptions(nonWorkerModels(models), catalog?.providers.orEmpty())
                if (supportsEnabled) offered else listOf(ComboOption("", "No model (off)", "Maintenance does not run")) + offered
            }
            val settingEnabled = enabled.takeIf { supportsEnabled }
            val canEditRun = current.model != null && !saving
            val levels = current.model?.let { picked ->
                models.firstOrNull { it.provider == picked.provider && it.modelId == picked.modelId }?.thinkingLevels
            }.orEmpty()
            SettingsRow(
                "Model", hint = when { !supportsEnabled -> "Pick a model to turn maintenance on."; current.model == null -> "Pick a model to start."; else -> "The model that tidies the notes." }, status = modelSave,
                learn = { Text("A run merges duplicates, resolves contradictions, fixes titles, tags and links, and archives stale memories. A scope is maintained only when it changed since its last run. Undoing an extraction or a run from the Memory tab works whether this is on or off.") },
            ) {
                Combobox(options, current.model?.let(::modelKey) ?: "", { key ->
                    val model = models.firstOrNull { modelKey(it) == key }
                    openModelRequest = 0
                    val keep = validThinking(current.thinkingLevel, model)
                    modelSave.launch { apply(maintenanceRequest(model?.let { ModelRef(it.provider, it.modelId) }, keep, current.time, current.afterWrites.toString(), settingEnabled)) }
                }, "Maintenance model", placeholder = "Choose a model…", searchPlaceholder = "Search models or providers…", enabled = models.isNotEmpty() && !saving,
                    openRequest = openModelRequest.takeIf { models.isNotEmpty() } ?: 0)
            }
            SettingsRow("Thinking level", hint = "How hard the model thinks during a run.", status = thinkingSave) {
                ThinkingSelect(levels, current.thinkingLevel, { level ->
                    thinkingSave.launch { apply(maintenanceRequest(current.model, level, current.time, current.afterWrites.toString(), settingEnabled)) }
                }, enabled = canEditRun)
            }
            SettingsRow("Nightly at", hint = "Computer time (${timezone.ifEmpty { "the computer's time zone" }}).", control = RowControl.Auto, status = timeSave) {
                AutoInput(current.time, timeSave, Modifier.widthIn(max = 160.dp), enabled = canEditRun, label = "Nightly time") { text ->
                    apply(maintenanceRequest(current.model, current.thinkingLevel, text, current.afterWrites.toString(), settingEnabled))
                }
            }
            SettingsRow("After writes", hint = "Also run once a scope has this many new writes.", control = RowControl.Auto, status = writesSave) {
                AutoInput(current.afterWrites.toString(), writesSave, Modifier.widthIn(max = 140.dp), enabled = canEditRun, numeric = true, label = "After writes") { text ->
                    apply(maintenanceRequest(current.model, current.thinkingLevel, current.time, text, settingEnabled))
                }
            }
            GroupRow { Text(maintenanceSummary(current, timezone), style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted) }
        }
    }
}
