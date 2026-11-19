package io.github.mitzacoder.kemiri.features.settings

import kotlinx.serialization.Serializable
import io.github.mitzacoder.kemiri.data.HarnessFeature

/**
 * Settings, split in two as on the web (`lib/settings.ts`, `docs/DESIGN.md` "Settings"): General settings (this device and
 * its backends) and Project settings (one project). Both are a list of sections; the section ids are the web's URL
 * segments, so a web link maps to the same screen. Pure, so the lists, the parents and the availability rules are tested.
 */
enum class SettingsIcon { Palette, Server, Bell, Archive, Folder, Cpu, Users, CalendarClock, Ticket, DatabaseZap, HardDrive, KeyRound, Settings }

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
    Backends("backends", "Computers", "The computers running Kemiri, their AI accounts and apps", SettingsIcon.Server, "Backends"),
    Notifications("notifications", "Notifications", "What reaches this device, and when", SettingsIcon.Bell),
    Archived("archived", "Archived projects", "Bring a project back", SettingsIcon.Archive),
    About("about", "About and licences", "Kemiri versions and updates, plus licences", SettingsIcon.Settings),
}

@Serializable
enum class ProjectSection(override val id: String, override val label: String, override val hint: String, override val icon: SettingsIcon, override val term: String? = null) : SettingsSectionInfo {
    General("general", "General", "Name, folder, archive", SettingsIcon.Folder),
    Coordinator("coordinator", "Main chat", "The model the main chat runs on", SettingsIcon.Cpu, "Coordinator"),
    Workers("workers", "Workers", "Worker models and check-ins", SettingsIcon.Users),
    Schedules("schedules", "Scheduled tasks", "Clocks and event triggers", SettingsIcon.CalendarClock),
    Mcp("mcp", "Connected apps", "Which outside tools this project's agents may use", SettingsIcon.Server, "MCP"),
    Skills("skills", "Skills", "What this project's agents know how to do", SettingsIcon.Folder),
    Tickets("tickets", "Tickets and pull requests", "Turn ticket keys and PR numbers into links", SettingsIcon.Ticket),
    Cache("cache", "Conversation cache", "Pay a little more now so long pauses cost less", SettingsIcon.DatabaseZap, "Prompt cache"),
    Storage("storage", "Storage", "Finished workspaces and disk use", SettingsIcon.HardDrive),
    // Preserve Delivery in the saved back stack; web routes use the id instead of this enum's serial name.
    @kotlinx.serialization.SerialName("Delivery")
    Advanced("advanced", "Advanced", "Page privacy, proof of screen changes, report checks, live lines, code delivery", SettingsIcon.Settings),
}

fun generalSectionFor(id: String?): GeneralSection? = GeneralSection.entries.firstOrNull { it.id == id }
fun projectSectionFor(id: String?): ProjectSection? = if (id == "delivery") ProjectSection.Advanced else ProjectSection.entries.firstOrNull { it.id == id }

/** What a backend offers a project's settings: the features it advertises and what its project summary carries. */
data class ProjectSectionSupport(
    val supports: (String) -> Boolean,
    val links: Boolean,
    val longPromptCache: Boolean,
    val repository: Boolean? = null,
) {
    val showCodingSettings: Boolean get() = !supports(HarnessFeature.PROJECT_REPOSITORY) || repository != false
}

internal fun codeDeliveryAvailable(supports: (String) -> Boolean) = supports("task-changes") || supports("task-deploys")

/** Whether a section is shown for a project (web `projectSectionAvailable`); the list drops the rest. */
fun projectSectionAvailable(section: ProjectSection, has: ProjectSectionSupport): Boolean = when (section) {
    ProjectSection.General -> true
    ProjectSection.Coordinator -> has.supports("projects") && has.supports("models")
    ProjectSection.Advanced -> true
    ProjectSection.Workers -> has.supports("projects") && has.supports("models") && has.supports("workers")
    ProjectSection.Schedules -> has.supports("schedules")
    ProjectSection.Tickets -> has.links && has.showCodingSettings
    ProjectSection.Cache -> has.longPromptCache
    ProjectSection.Storage -> has.supports("storage")
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

/** Where a General settings screen sits: a section (null is the list), a backend's own page, or its Accounts page. */
@Serializable
data class GeneralPage(val section: GeneralSection? = null, val backendKey: String? = null, val accounts: Boolean = false, val devices: Boolean = false, val mcp: Boolean = false, val unavailableSection: String? = null)

/**
 * The screen one step up, for the back button: Accounts to its backend, a backend to the Backends list, a section to the
 * list of sections. Null on the list itself (web `settingsParentHref`).
 */
fun generalParent(page: GeneralPage): GeneralPage? = when {
    page.unavailableSection != null -> GeneralPage()
    page.section == null -> null
    page.backendKey != null && (page.accounts || page.devices || page.mcp) -> GeneralPage(GeneralSection.Backends, page.backendKey)
    page.backendKey != null -> GeneralPage(GeneralSection.Backends)
    else -> GeneralPage()
}
