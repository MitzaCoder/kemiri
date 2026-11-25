package io.github.mitzacoder.kemiri.features.settings

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mitzacoder.kemiri.data.*
import io.github.mitzacoder.kemiri.features.notifications.NotificationsSection
import io.github.mitzacoder.kemiri.features.status.BannerTone
import io.github.mitzacoder.kemiri.features.status.ToneBanner
import io.github.mitzacoder.kemiri.navigation.Destination
import io.github.mitzacoder.kemiri.navigation.ProjectScreenContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOf

@Composable
internal fun GeneralSettingsScreen(
    repository: HarnessRepository,
    page: GeneralPage,
    navigator: SettingsNavigator,
    scopes: SettingsScopes,
    navigate: (Destination) -> Unit,
    connectPayload: String?,
    onConnectHandled: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val sessions by repository.sessions.collectAsStateWithLifecycle()
    val notifications by repository.collectSettings { it.notifications }
    val counts by remember(sessions) {
        val flows: List<Flow<Pair<Boolean, Int>>> = sessions.map { s -> combine(s.client.state, s.projects) { c, p -> (c.status != ConnectionStatus.Ready) to p.archivedOnes().size } }
        if (flows.isEmpty()) flowOf(0 to 0) else combine(flows) { rows -> rows.count { it.first } to rows.sumOf { it.second } }
    }.collectAsStateWithLifecycle(0 to 0)
    val chips = generalChips(counts.first, notifications.enabled, counts.second)
    val backend = sessions.firstOrNull { it.config.key == page.backendKey }
    val computer = page.backendKey != null
    val parent = generalParent(page)
    val activeId = page.unavailableSection ?: if (computer) page.activeComputerSection?.id else page.section?.id
    SettingsShell(
        if (computer) ComputerSection.entries.map { SettingsNavItem(it) } else GeneralSection.entries.map { SettingsNavItem(it, chips[it]) },
        activeId, if (computer) "This computer sections" else "This device sections",
        parent?.let { if (it.backendKey != null) "This computer" else it.section?.label ?: "This device" },
        parent?.let { { navigator.up(Destination.Settings(it)) } },
        onSelect = { id ->
            val next = if (page.backendKey != null) computerSectionFor(id)?.let { computerPage(page.backendKey, it) }
            else generalSectionFor(id)?.let { GeneralPage(it) }
            next?.let { navigator.selectSection(Destination.Settings(it), fromIndex = activeId == null) }
        },
        modifier = modifier,
        header = {
            if (computer) ScopeHeader(SettingsScope.Computer, "Changes here apply to every project on ${backend?.config?.name ?: "this computer"}.", scopes,
                onComputer = if (scopes.computers.size > 1) ({ picked ->
                    if (picked.key != page.backendKey) navigator.switchScope(Destination.Settings(computerPage(picked.key, page.activeComputerSection)))
                }) else null,
            ) else ScopeHeader(SettingsScope.Device, "Changes here apply only to this phone.", scopes)
        },
    ) { active ->
        if (page.unavailableSection != null) {
            NotFound("Unknown settings section", "Choose a section from Settings.")
        } else if (computer) {
            if (backend == null) NotFound("Unknown computer", "This device has no computer with that address. Add it under Computers.")
            else key(backend.config.key) {
                when (computerSectionFor(active)) {
                    ComputerSection.Accounts -> AccountsPage(backend)
                    ComputerSection.Devices -> DevicesPage(repository, backend)
                    ComputerSection.Mcp -> McpServersPage(backend, navigate, navigator, scopes.visitProject, scopes.projectMcpParent)
                    ComputerSection.You -> ComputerYouAndMemory(backend)
                    ComputerSection.Advanced -> ComputerAdvanced(repository, backend, navigator)
                    ComputerSection.Overview, null -> ComputerOverview(repository, backend)
                }
            }
        } else when (generalSectionFor(active)) {
            GeneralSection.Appearance, null -> AppearanceSection(repository)
            GeneralSection.Backends -> BackendsSection(repository, navigator, connectPayload, onConnectHandled)
            GeneralSection.Notifications -> NotificationsSection(repository)
            GeneralSection.Archived -> ArchivedSection(repository, navigate)
            GeneralSection.About -> AboutSection(repository, navigator)
        }
    }
}

@Composable
private fun NotFound(title: String, text: String) {
    SettingsGroup { GroupNote("$title. $text") }
}

/**
 * A project's settings (web `.../settings/<section>`). Sections the backend does not offer are left out.
 * [section] null opens the section list.
 */
@Composable
internal fun ProjectSettingsScreen(context: ProjectScreenContext, section: ProjectSection?, scheduleId: String?, navigator: SettingsNavigator, scopes: SettingsScopes, modifier: Modifier = Modifier, unavailableSection: String? = null, advancedGroup: AdvancedGroup? = null) {
    key(context.backend.config.key, context.route.projectId) { ProjectSettingsContent(context, section, scheduleId, navigator, scopes, modifier, unavailableSection, advancedGroup) }
}

@Composable
private fun ProjectSettingsContent(context: ProjectScreenContext, section: ProjectSection?, scheduleId: String?, navigator: SettingsNavigator, scopes: SettingsScopes, modifier: Modifier, unavailableSection: String?, advancedGroup: AdvancedGroup?) {
    val projects by context.backend.projects.collectAsStateWithLifecycle()
    val connection by context.backend.client.state.collectAsStateWithLifecycle()
    val project = projects.firstOrNull { it.id == context.route.projectId }
    val support = ProjectSectionSupport(connection::supports, project?.links != null, project?.repository)
    val offered = ProjectSection.entries.filter { projectSectionAvailable(it, support) }
    val chips = projectChips(project?.coordinator?.model != null)
    val items = offered.map { SettingsNavItem(it, chips[it]) }
    val effective = section?.settingsSection?.takeIf { it in offered }
    val focusGroup = advancedGroup ?: advancedGroupFor(section?.id)
    val snackbar = remember { SnackbarHostState() }
    Box(modifier.fillMaxSize()) {
        SettingsShell(
            items, unavailableSection ?: section?.settingsSection?.id, "Project settings sections",
            "This project", if (section != null || unavailableSection != null) ({ navigator.up(Destination.ProjectSettings(context.route)) }) else null,
            onSelect = { id -> projectSectionFor(id)?.let { navigator.selectSection(Destination.ProjectSettings(context.route, it), fromIndex = section == null && unavailableSection == null) } },
            modifier = Modifier.fillMaxSize(),
            header = {
                ScopeHeader(SettingsScope.Project, "Changes here apply to ${project?.name ?: "this project"} on every device.", scopes,
                    onProject = { picked ->
                        if (picked.location != ProjectLocation(context.backend.config.key, context.route.projectId)) {
                            val target = context.repository.sessions.value.firstOrNull { it.config.key == picked.location.backendKey }
                            val summary = target?.projects?.value?.firstOrNull { it.id == picked.location.projectId }
                            val support = target?.let { ProjectSectionSupport(it.client.state.value::supports, summary?.links != null, summary?.repository) }
                            val next = section?.settingsSection?.takeIf { candidate -> support != null && projectSectionAvailable(candidate, support) } ?: ProjectSection.General
                            navigator.switchScope(projectSettings(picked.location, next))
                        }
                    },
                )
            },
        ) { active ->
            if (unavailableSection != null || (section != null && effective == null)) {
                SettingsGroup {
                    GroupNote("This computer does not offer this settings section.")
                    TextButton(onClick = { navigator.up(Destination.ProjectSettings(context.route)) }) { Text("Up to project settings") }
                }
                return@SettingsShell
            }
            if (project == null) {
                SettingsGroup { GroupNote(if (connection.status == ConnectionStatus.Ready) "This project no longer exists on ${context.backend.config.name}." else "Waiting for ${context.backend.config.name}…") }
                return@SettingsShell
            }
            Column(verticalArrangement = Arrangement.spacedBy(20.dp)) {
                if (project.state == "failed") ToneBanner(BannerTone.Error) { Text(project.failure ?: "The project failed to open.", style = MaterialTheme.typography.bodySmall) }
                when (projectSectionFor(active) ?: ProjectSection.General) {
                    ProjectSection.General -> ProjectGeneralSection(context, project)
                    ProjectSection.Coordinator -> CoordinatorSection(context, project, context.navigate)
                    ProjectSection.Advanced -> AdvancedSection(context, project, support, focusGroup)
                    ProjectSection.Workers -> WorkersSection(context, project)
                    ProjectSection.Schedules -> SchedulesSection(context, scheduleId)
                    ProjectSection.Tickets, ProjectSection.Storage -> error("Legacy route should resolve to Advanced")
                    ProjectSection.Mcp -> McpProjectSection(context.backend, project.id) {
                        navigator.open(Destination.Settings(computerPage(context.backend.config.key, ComputerSection.Mcp)))
                    }
                    ProjectSection.Skills -> ProjectSkillsSection(context.backend, project.id, snackbar)
                }
            }
        }
        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter))
    }
}

@Composable
internal fun MissingProjectSettings(navigator: SettingsNavigator, scopes: SettingsScopes, modifier: Modifier) {
    SettingsShell(emptyList(), "missing", "This project sections", null, null, {}, modifier,
        header = { ScopeHeader(SettingsScope.Project, "This project’s computer is not configured on this phone.", scopes,
            onProject = if (scopes.project != null) ({ picked -> navigator.switchScope(projectSettings(picked.location)) }) else null) },
    ) { NotFound("Unknown computer", "Add it under This device → Computers.") }
}
