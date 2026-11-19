package io.github.mitzacoder.kemiri.features.settings

import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.BackendSession
import io.github.mitzacoder.kemiri.protocol.*
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

@Composable
internal fun ReportAuditSettings(backend: BackendSession, project: ProjectSummary) =
    ProjectModelModeSettings(backend, project, watcher = false)

@Composable
internal fun TaskWatcherSettings(backend: BackendSession, project: ProjectSummary) =
    ProjectModelModeSettings(backend, project, watcher = true)

@Composable
private fun ProjectModelModeSettings(backend: BackendSession, project: ProjectSummary, watcher: Boolean) {
    val connection by backend.client.state.collectAsStateWithLifecycle()
    val features = connection.hello?.features
    if (!(if (watcher) taskWatcherVisible(features) else reportAuditVisible(features))) return
    val title = if (watcher) "Live news lines" else "Report check"
    val modelLabel = if (watcher) "Live news model" else "Report check model"
    val models by backend.models.collectAsStateWithLifecycle()
    val catalog by backend.modelCatalog.collectAsStateWithLifecycle()
    val providers = catalog?.providers.orEmpty()
    val options = remember(models, providers) { modelOptions(nonWorkerModels(models), providers) }
    val stored = if (watcher) project.taskWatcher ?: DEFAULT_TASK_WATCHER_SETTINGS
        else project.reportAudit ?: DEFAULT_REPORT_AUDIT_SETTINGS
    var latest by remember(project.id, stored) { mutableStateOf(stored) }
    var choosing by remember(project.id, stored.mode) { mutableStateOf(false) }
    var attemptedMode by remember(project.id) { mutableStateOf(stored.mode) }
    var attemptedModel by remember(project.id) { mutableStateOf<String?>(null) }
    val modeSave = rememberSaveState(project.id, "audit-mode")
    val modelSave = rememberSaveState(project.id, "audit-model")
    val budgetSave = rememberSaveState(project.id, "audit-budget")
    val queue = remember(project.id) { Mutex() }
    val enabled = listOf(modeSave, modelSave, budgetSave).none { it.status == SaveStatus.Saving }

    suspend fun persist(change: (ProjectsConfigureRequestReportAudit) -> ProjectsConfigureRequestReportAudit) {
        queue.withLock {
            val target = change(latest)
            backend.configure(if (watcher) taskWatcherConfiguration(project.id, target)
                else ProjectsConfigureRequest(projectId = project.id, reportAudit = target))
            latest = target
        }
    }
    fun pickMode(mode: String) {
        attemptedMode = mode
        if (mode == "model" && latest.model == null) { modeSave.reset(); choosing = true; return }
        choosing = false
        modeSave.launch { persist { it.copy(mode = mode, model = if (mode == "model") it.model else null) } }
    }
    fun pickModel(key: String) {
        val chosen = models.firstOrNull { modelKey(it) == key } ?: return
        attemptedModel = key
        modelSave.launch {
            persist { it.copy(mode = "model", model = ModelRef(provider = chosen.provider, modelId = chosen.modelId)) }
            choosing = false
        }
    }
    SettingsGroup(title = title) {
        GroupNote(if (watcher) "Short updates from the work log, marked auto. They stay in Live and do not change the task report."
            else "A small model checks once an hour whether active tasks' reports missed something, and asks the coordinator to update them", center = false)
        SettingsRow("Mode", hint = if (watcher) "Automatic picks from recorded tool steps without sending them to a model."
            else "Automatic uses the cheapest small model you're signed in to (Claude Haiku 5.5, else GPT-5 nano)",
            status = modeSave, onRetry = { pickMode(attemptedMode) }) {
            Combobox(listOf(ComboOption("auto", "Automatic"), ComboOption("off", "Off"), ComboOption("model", "Choose a model")),
                if (choosing) "model" else latest.mode, ::pickMode, "$title mode", enabled = enabled, invalid = modeSave.status == SaveStatus.Failed)
        }
        if (choosing || latest.mode == "model") SettingsRow(modelLabel, hint = "Choose a model to save this mode.", status = modelSave, onRetry = { attemptedModel?.let(::pickModel) }) {
            Combobox(options, latest.model?.let(::modelKey).orEmpty(), ::pickModel, modelLabel,
                placeholder = "Choose a model…", searchPlaceholder = "Search models or providers…", enabled = enabled && models.isNotEmpty(), invalid = modelSave.status == SaveStatus.Failed)
        }
        if (!watcher || choosing || latest.mode == "model") SettingsRow("Daily token budget", hint = "Resets each day at midnight UTC. From 0 to 10,000,000 tokens; default 65,000.", status = budgetSave) {
            AutoInput(latest.dailyTokens.toString(), budgetSave, numeric = true, label = "$title daily token budget", enabled = enabled) { text ->
                val tokens = reportAuditBudget(text) ?: throw IllegalArgumentException("Enter a whole number from 0 to 10,000,000.")
                persist { it.copy(dailyTokens = tokens) }
            }
        }
        if (watcher) {
            GroupNote(taskWatcherStatusWords(latest, project.taskWatcherStatus),
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }, center = false)
        } else {
            val now by produceState(System.currentTimeMillis()) { while (true) { delay(30_000); value = System.currentTimeMillis() } }
            val status = project.reportAuditStatus
            GroupNote(reportAuditModel(status?.effectiveModel, models, providers) + " · " +
                reportAuditUsage(status?.tokensUsed ?: 0, latest.dailyTokens) + "\n" +
                reportAuditStatusWords(status, now), center = false)
        }
    }
}
