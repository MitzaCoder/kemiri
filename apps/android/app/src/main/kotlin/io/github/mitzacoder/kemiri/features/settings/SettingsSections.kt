package io.github.mitzacoder.kemiri.features.settings

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNames

enum class SettingsIcon { Palette, Server, Bell, Archive, Folder, Cpu, Users, CalendarClock, Ticket, HardDrive, KeyRound, Settings }

/** One entry of a section list: [id] is the last URL segment, [hint] the line under the label on a phone. */
interface SettingsSectionInfo {
    val id: String
    val label: String
    val term: String?
    val hint: String
    val icon: SettingsIcon
}

@Serializable
enum class GeneralSection(override val id: String, override val label: String, override val hint: String, override val icon: SettingsIcon, override val term: String? = null) : SettingsSectionInfo {
    Appearance("appearance", "Appearance", "Theme, light or dark, time and reading", SettingsIcon.Palette),
    Notifications("notifications", "Notifications", "What reaches this device, and when", SettingsIcon.Bell),
    Backends("backends", "Computers", "The computers this phone connects to", SettingsIcon.Server, "Backends"),
    Archived("archived", "Archived projects", "Bring a project back", SettingsIcon.Archive),
    About("about", "About and licences", "Kemiri versions and licences", SettingsIcon.Settings),
}

@Serializable
enum class ComputerSection(override val id: String, override val label: String, override val hint: String, override val icon: SettingsIcon, override val term: String? = null) : SettingsSectionInfo {
    Overview("overview", "Overview", "Status and software updates", SettingsIcon.Server),
    Accounts("accounts", "AI accounts", "Sign in to AI providers or add API keys", SettingsIcon.KeyRound, "Accounts and API keys"),
    You("you", "You and memory", "Your name and automatic memory cleanup", SettingsIcon.Users),
    Mcp("mcp", "Connected apps", "Outside tools agents can use", SettingsIcon.Server, "MCP servers"),
    Devices("devices", "Devices", "Signed-in devices and pairing", SettingsIcon.Users),
    Advanced("advanced", "Advanced", "Name, address and removal on this device", SettingsIcon.Settings),
}

fun computerSectionFor(id: String?) = ComputerSection.entries.firstOrNull { it.id == id }

@OptIn(ExperimentalSerializationApi::class)
@Serializable
enum class ProjectSection(override val id: String, override val label: String, override val hint: String, override val icon: SettingsIcon, override val term: String? = null) : SettingsSectionInfo {
    General("general", "General", "Name, folder, archive", SettingsIcon.Folder),
    Coordinator("coordinator", "Main chat", "The model the main chat runs on", SettingsIcon.Cpu, "Coordinator"),
    Workers("workers", "Workers", "Worker models and check-ins", SettingsIcon.Users),
    Schedules("schedules", "Scheduled tasks", "Clocks and event triggers", SettingsIcon.CalendarClock),
    Mcp("mcp", "Connected apps", "Which outside tools this project's agents may use", SettingsIcon.Server, "MCP"),
    Skills("skills", "Skills", "What this project's agents know how to do", SettingsIcon.Folder),
    Tickets("tickets", "Tickets and pull requests", "Turn ticket keys and PR numbers into links", SettingsIcon.Ticket),
    Storage("storage", "Storage", "Finished workspaces and disk use", SettingsIcon.HardDrive),
    // Saved back stacks write "Delivery" and can still read the old standalone "Cache" section.
    @SerialName("Delivery")
    @JsonNames("Cache")
    Advanced("advanced", "Advanced", "Page privacy, conversation cache, proof of screen changes, report checks, live lines, code delivery", SettingsIcon.Settings),
}

fun generalSectionFor(id: String?): GeneralSection? = GeneralSection.entries.firstOrNull { it.id == id }
@Serializable
enum class AdvancedGroup { ConversationCache, CodeDelivery, Tickets, Storage }

fun advancedGroupFor(id: String?): AdvancedGroup? = when (id) {
    "cache" -> AdvancedGroup.ConversationCache
    "delivery" -> AdvancedGroup.CodeDelivery
    "tickets" -> AdvancedGroup.Tickets
    "storage" -> AdvancedGroup.Storage
    else -> null
}

internal val ProjectSection.settingsSection get() = when (this) {
    ProjectSection.Tickets, ProjectSection.Storage -> ProjectSection.Advanced
    else -> this
}

fun projectSectionFor(id: String?): ProjectSection? = when (id) {
    "cache", "delivery", "tickets", "storage" -> ProjectSection.Advanced
    else -> ProjectSection.entries.firstOrNull { it.id == id }
}

/** What a backend offers a project's settings: the features it advertises and what its project summary carries. */
data class ProjectSectionSupport(
    val supports: (String) -> Boolean,
    val links: Boolean,
    val repository: Boolean? = null,
) {
    val showCodingSettings: Boolean get() = repository != false
}

internal fun codeDeliveryAvailable(supports: (String) -> Boolean) = supports("task-changes") || supports("task-deploys")

/** Whether a section is shown for a project (web `projectSectionAvailable`); the list drops the rest. */
fun projectSectionAvailable(section: ProjectSection, has: ProjectSectionSupport): Boolean = when (section) {
    ProjectSection.General -> true
    ProjectSection.Coordinator -> has.supports("projects") && has.supports("models")
    ProjectSection.Advanced -> true
    ProjectSection.Workers -> has.supports("projects") && has.supports("models") && has.supports("workers")
    ProjectSection.Schedules -> has.supports("schedules")
    ProjectSection.Tickets, ProjectSection.Storage -> false
    ProjectSection.Mcp -> has.supports(MCP_FEATURE)
    ProjectSection.Skills -> has.supports(PROJECT_SKILLS_FEATURE)
}

/** The tone of a status chip (web `StatusChip`). */
enum class ChipTone { Ok, Warn, Err, Info, Muted }

data class SectionChip(val label: String, val tone: ChipTone)

/** The chips of the General list: "2 offline" on Backends, On/Off on Notifications, the count of archived projects. */
fun generalChips(offline: Int, notificationsOn: Boolean, archived: Int): Map<GeneralSection, SectionChip> = buildMap {
    if (offline > 0) put(GeneralSection.Backends, SectionChip("$offline offline", ChipTone.Warn))
    put(GeneralSection.Notifications, if (notificationsOn) SectionChip("On", ChipTone.Ok) else SectionChip("Off", ChipTone.Muted))
    if (archived > 0) put(GeneralSection.Archived, SectionChip(archived.toString(), ChipTone.Muted))
}

/** The chips of the project list: a coordinator without a model is the one state worth seeing before opening. */
fun projectChips(coordinatorModelSet: Boolean): Map<ProjectSection, SectionChip> =
    if (coordinatorModelSet) emptyMap() else mapOf(ProjectSection.Coordinator to SectionChip("No model", ChipTone.Warn))

/** Keep the old fields readable in saved stacks. New routes write [computerSection]. */
@Serializable
data class GeneralPage(
    val section: GeneralSection? = null,
    val backendKey: String? = null,
    val accounts: Boolean = false,
    val devices: Boolean = false,
    val mcp: Boolean = false,
    val unavailableSection: String? = null,
    val computerSection: ComputerSection? = null,
) {
    val activeComputerSection: ComputerSection? get() = computerSection ?: when {
        accounts -> ComputerSection.Accounts
        devices -> ComputerSection.Devices
        mcp -> ComputerSection.Mcp
        else -> null
    }
}

internal fun computerPage(backendKey: String, section: ComputerSection? = null, unavailableSection: String? = null) =
    GeneralPage(GeneralSection.Backends, backendKey, unavailableSection = unavailableSection, computerSection = section)

fun generalParent(page: GeneralPage): GeneralPage? = when {
    page.backendKey != null && (page.activeComputerSection != null || page.unavailableSection != null) -> computerPage(page.backendKey)
    page.backendKey != null -> GeneralPage(GeneralSection.Backends)
    page.section != null || page.unavailableSection != null -> GeneralPage()
    else -> null
}
