package io.github.mitzacoder.kemiri.features.settings

import androidx.compose.material3.Text
import androidx.compose.runtime.*
import io.github.mitzacoder.kemiri.data.BackendSession
import io.github.mitzacoder.kemiri.data.ProjectSetting
import io.github.mitzacoder.kemiri.data.configureProject
import io.github.mitzacoder.kemiri.protocol.ProjectSummary
import io.github.mitzacoder.kemiri.protocol.ProjectsConfigureRequest

@Composable
internal fun AdvancedSection(backend: BackendSession, project: ProjectSummary, showCodingSettings: Boolean) {
    val uiProofSave = rememberSaveState(project.id)
    val artifactPrivacySave = rememberSaveState(project.id)
    var pendingUiProof by remember(project.id) { mutableStateOf<String?>(null) }
    val storedUiProof = project.uiProof
    val uiProofValue = pendingUiProof ?: storedUiProof ?: "screenshots-and-videos"
    fun pickUiProof(next: String) {
        pendingUiProof = next
        uiProofSave.launch {
            try { backend.client.configureProject(project.id, ProjectSetting.UiProof(next)); backend.refreshProjects() }
            finally { pendingUiProof = null }
        }
    }

    SettingsSectionPage(ProjectSection.Advanced) {
        if (project.blockArtifactRequests != null) SettingsGroup(title = "Page privacy", term = "Artifact pages") {
            SettingsRow("Stop pages from sending data", hint = "Blocks connections and form submissions from HTML pages agents make.", status = artifactPrivacySave, control = RowControl.Inline) {
                SettingsSwitch(project.blockArtifactRequests, { on ->
                    artifactPrivacySave.launch { backend.configure(ProjectsConfigureRequest(projectId = project.id, blockArtifactRequests = on)) }
                }, "Stop pages from sending data", enabled = artifactPrivacySave.status != SaveStatus.Saving)
            }
        }
        PromptCacheGroup(backend, project)
        // An older backend does not send the proof setting, so that group stays out.
        if (showCodingSettings && storedUiProof != null) SettingsGroup(title = "Proof of screen changes", term = "Show UI changes") {
            SettingsRow(
                "Prove UI work with", hint = "Agents show web and app changes before review; computers and terminals are never recorded.",
                status = uiProofSave, onRetry = { pickUiProof(uiProofValue) },
                learn = { Text("Any change a user can see in a web page or an app screen is shown before it goes to review: a bug before and after, using the real UI in a headless browser, emulator or device. The agent saves the pictures (and the recording) on the task. The coordinator works out how to demo this project once and keeps the recipe in memory. A change reaches the coordinator on its next turn and workers started after it.") },
            ) {
                Combobox(UI_PROOF_OPTIONS, uiProofValue, ::pickUiProof, "Proof of screen changes", invalid = uiProofSave.status == SaveStatus.Failed)
            }
        }
        ReportAuditSettings(backend, project)
        TaskWatcherSettings(backend, project)
        if (showCodingSettings) CodeDeliveryGroup(backend, project)
    }
}

/** The choices of `uiProof`, in the web's order and words. */
private val UI_PROOF_OPTIONS = listOf(
    ComboOption("screenshots-and-videos", "Screenshots and videos", description = "Before/after screenshots and a short recording. The default."),
    ComboOption("screenshots", "Screenshots", description = "Before/after screenshots only."),
    ComboOption("off", "Off", description = "Agents are not asked to show UI changes."),
)
