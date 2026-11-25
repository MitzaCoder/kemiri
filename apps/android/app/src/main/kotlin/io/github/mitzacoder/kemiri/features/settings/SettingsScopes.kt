package io.github.mitzacoder.kemiri.features.settings

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.ui.theme.Jarvis
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOf

internal enum class SettingsScope(val label: String) {
    Project("This project"), Computer("This computer"), Device("This device"),
}

internal data class ScopeProject(val location: ProjectLocation, val name: String)
internal data class ScopeComputer(val key: String, val name: String, val ready: Boolean, val projects: List<ScopeProject>)

internal fun resolveScopeProject(computers: List<ScopeComputer>, context: ProjectLocation?, last: ProjectLocation?): ScopeProject? {
    val projects = computers.flatMap { it.projects }
    return projects.firstOrNull { it.location == context }
        ?: projects.firstOrNull { it.location == last }
        ?: computers.firstOrNull { it.ready && it.projects.isNotEmpty() }?.projects?.first()
}

internal fun resolveScopeComputer(computers: List<ScopeComputer>, projectContext: ProjectLocation?, last: String?): ScopeComputer? =
    computers.firstOrNull { it.key == projectContext?.backendKey }
        ?: computers.singleOrNull()
        ?: computers.firstOrNull { it.key == last }
        ?: computers.firstOrNull { it.ready }
        ?: computers.firstOrNull()

@Composable
internal fun rememberScopeComputers(sessions: List<BackendSession>): List<ScopeComputer> {
    fun BackendSession.scopeComputer(ready: Boolean, projects: List<io.github.mitzacoder.kemiri.protocol.ProjectSummary>) =
        ScopeComputer(config.key, config.name, ready, projects.unarchived().map { ScopeProject(ProjectLocation(config.key, it.id), it.name) })
    val computers by remember(sessions) {
        if (sessions.isEmpty()) flowOf(emptyList()) else combine(sessions.map { session ->
            combine(session.projects, session.client.state) { projects, connection -> session.scopeComputer(connection.status == ConnectionStatus.Ready, projects) }
        }) { it.toList() }
    }.collectAsStateWithLifecycle(emptyList())
    return computers
}

internal class SettingsScopes(
    val computers: List<ScopeComputer>,
    private val projectContext: ProjectLocation?,
    lastOpenedProject: ProjectLocation?,
    lastUsedComputerKey: String?,
    private val navigator: SettingsNavigator,
    val projectMcpParent: Destination.ProjectSettings? = null,
) {
    val project = resolveScopeProject(computers, projectContext, lastOpenedProject)
    val computer = resolveScopeComputer(computers, projectContext, lastUsedComputerKey)
    val visitProject get() = computers.flatMap { it.projects }.firstOrNull { it.location == projectContext }

    fun select(scope: SettingsScope) {
        val destination = when (scope) {
            SettingsScope.Project -> project?.let { projectSettings(it.location) }
            SettingsScope.Computer -> computer?.let { Destination.Settings(computerPage(it.key)) }
            SettingsScope.Device -> Destination.Settings()
        }
        destination?.let(navigator.switchScope)
    }
}

internal fun projectSettings(location: ProjectLocation, section: ProjectSection? = null) =
    Destination.ProjectSettings(Destination.Chat(location.backendKey, location.projectId), section)

@Composable
internal fun ScopeHeader(
    scope: SettingsScope,
    note: String,
    scopes: SettingsScopes,
    onProject: ((ScopeProject) -> Unit)? = null,
    onComputer: ((ScopeComputer) -> Unit)? = null,
) {
    var picker by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
        Text("Settings", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            SettingsScope.entries.forEachIndexed { index, option ->
                val enabled = when (option) {
                    SettingsScope.Project -> scopes.project != null
                    SettingsScope.Computer -> scopes.computer != null
                    SettingsScope.Device -> true
                }
                SegmentedButton(
                    selected = scope == option, enabled = enabled || scope == option,
                    onClick = { if (scope != option) scopes.select(option) }, icon = {},
                    shape = SegmentedButtonDefaults.itemShape(index, SettingsScope.entries.size),
                    contentPadding = PaddingValues(horizontal = 3.dp, vertical = 6.dp),
                ) { Text(option.label, style = MaterialTheme.typography.labelMedium, maxLines = 1) }
            }
        }
        Row(Modifier.fillMaxWidth().heightIn(min = 32.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(note, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = Jarvis.colors.fgMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (onProject != null || onComputer != null) TextButton(onClick = { picker = true }) { Text("Change") }
        }
        if (scopes.project == null && scope != SettingsScope.Project) Text("No project yet", style = MaterialTheme.typography.labelSmall, color = Jarvis.colors.fgMuted)
    }
    if (picker) AlertDialog(
        onDismissRequest = { picker = false }, title = { Text(if (onProject != null) "Choose a project" else "Choose a computer") },
        text = {
            Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState())) {
                scopes.computers.forEach { computer ->
                    if (onProject != null && computer.projects.isNotEmpty()) {
                        Text(computer.name, style = MaterialTheme.typography.labelMedium, color = Jarvis.colors.fgMuted)
                        computer.projects.forEach { project ->
                            TextButton(onClick = { picker = false; onProject(project) }) { Text(project.name) }
                        }
                    } else if (onComputer != null) {
                        TextButton(onClick = { picker = false; onComputer(computer) }) { Text(computer.name) }
                    }
                }
            }
        }, confirmButton = { TextButton(onClick = { picker = false }) { Text("Cancel") } },
    )
}
