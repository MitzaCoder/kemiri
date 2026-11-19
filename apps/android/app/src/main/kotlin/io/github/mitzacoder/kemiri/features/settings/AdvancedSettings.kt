package io.github.mitzacoder.kemiri.features.settings

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onGloballyPositioned
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import androidx.compose.runtime.*
import io.github.mitzacoder.kemiri.data.ProjectSetting
import io.github.mitzacoder.kemiri.data.configureProject
import io.github.mitzacoder.kemiri.protocol.ProjectSummary
import io.github.mitzacoder.kemiri.protocol.ProjectsConfigureRequest

@Composable
internal fun AdvancedSection(context: ProjectScreenContext, project: ProjectSummary, support: ProjectSectionSupport, focus: AdvancedGroup?) {
    val backend = context.backend
    val showCodingSettings = support.showCodingSettings
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
        AdvancedAnchor(focus == AdvancedGroup.ConversationCache) { PromptCacheGroup(backend, project) }
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
        if (showCodingSettings || focus == AdvancedGroup.CodeDelivery) AdvancedAnchor(focus == AdvancedGroup.CodeDelivery) {
            when {
                !showCodingSettings -> CodingOnlyNote("Code delivery")
                codeDeliveryAvailable(support.supports) -> CodeDeliveryGroup(backend, project)
                else -> SettingsGroup(title = "Code delivery") { GroupNote("This computer does not offer this settings group.") }
            }
        }
        if ((showCodingSettings && project.links != null) || focus == AdvancedGroup.Tickets) AdvancedAnchor(focus == AdvancedGroup.Tickets) {
            when {
                !showCodingSettings -> CodingOnlyNote("Tickets and pull requests")
                project.links != null -> TicketsGroup(context, project.links)
                else -> SettingsGroup(title = "Tickets and pull requests") { GroupNote("This computer does not offer this settings group.") }
            }
        }
        if (support.supports("storage") || focus == AdvancedGroup.Storage) AdvancedAnchor(focus == AdvancedGroup.Storage) {
            if (support.supports("storage")) StorageGroups(backend, project.id)
            else SettingsGroup(title = "Storage") { GroupNote("This computer does not offer this settings group.") }
        }
    }
}

@Composable
private fun CodingOnlyNote(title: String) {
    SettingsGroup(title = title) { GroupNote("This project isn't a code repository, so these settings don't apply.") }
}

/** Request once after layout, so a legacy link doesn't add a second screen or override manual scrolling. */
@Composable
private fun AdvancedAnchor(focused: Boolean, content: @Composable () -> Unit) {
    if (!focused) { content(); return }
    val requester = remember { BringIntoViewRequester() }
    var positioned by remember { mutableStateOf(false) }
    Box(Modifier.bringIntoViewRequester(requester).onGloballyPositioned { positioned = true }) { content() }
    LaunchedEffect(positioned) { if (positioned) requester.bringIntoView() }
}

/** The choices of `uiProof`, in the web's order and words. */
private val UI_PROOF_OPTIONS = listOf(
    ComboOption("screenshots-and-videos", "Screenshots and videos", description = "Before/after screenshots and a short recording. The default."),
    ComboOption("screenshots", "Screenshots", description = "Before/after screenshots only."),
    ComboOption("off", "Off", description = "Agents are not asked to show UI changes."),
)
