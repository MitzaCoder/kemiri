package io.github.mitzacoder.kemiri.settings

import io.github.mitzacoder.kemiri.data.DeviceSettings
import io.github.mitzacoder.kemiri.data.ProjectLocation
import io.github.mitzacoder.kemiri.data.wireJson
import io.github.mitzacoder.kemiri.features.settings.*
import org.junit.Assert.*
import org.junit.Test

class SettingsScopesTest {
    private val first = ScopeProject(ProjectLocation("first", "same-id"), "Bakery site")
    private val last = ScopeProject(ProjectLocation("second", "same-id"), "Garden notes")
    private val computers = listOf(ScopeComputer("first", "Bakery computer", true, listOf(first)), ScopeComputer("second", "Studio computer", true, listOf(last)))

    @Test fun projectChoosesVisitThenSavedThenFirstReady() {
        assertEquals(first, resolveScopeProject(computers, first.location, last.location))
        assertEquals(last, resolveScopeProject(computers, null, last.location))
        assertEquals(first, resolveScopeProject(computers, null, ProjectLocation("removed", "same-id")))
        assertEquals(last, resolveScopeProject(listOf(computers.first().copy(ready = false), computers.last()), null, null))
        assertNull(resolveScopeProject(computers.map { it.copy(projects = emptyList()) }, null, null))
        val settings = DeviceSettings(lastOpenedProject = last.location, lastUsedComputerKey = last.location.backendKey)
        assertEquals(settings, wireJson.decodeFromString<DeviceSettings>(wireJson.encodeToString(DeviceSettings.serializer(), settings)))
        assertNull(wireJson.decodeFromString<DeviceSettings>("{}").lastOpenedProject)
    }

    @Test fun computerChoosesProjectThenOnlyThenMostRecent() {
        assertEquals(computers.first(), resolveScopeComputer(computers, first.location, last.location.backendKey))
        assertEquals(computers.last(), resolveScopeComputer(computers, null, last.location.backendKey))
        assertEquals(computers.first(), resolveScopeComputer(computers.take(1), last.location, last.location.backendKey))
        assertNull(resolveScopeComputer(emptyList(), first.location, null))
    }

    @Test fun restoredComputerFlagsAndProjectSectionsKeepTheirMeaning() {
        for ((flag, section) in mapOf("accounts" to ComputerSection.Accounts, "mcp" to ComputerSection.Mcp, "devices" to ComputerSection.Devices)) {
            val page = wireJson.decodeFromString<GeneralPage>("""{"section":"Backends","backendKey":"first","$flag":true}""")
            assertEquals(section, page.activeComputerSection)
        }
        for ((name, group) in mapOf("Tickets" to AdvancedGroup.Tickets, "Storage" to AdvancedGroup.Storage, "Delivery" to null, "Cache" to null)) {
            val section = wireJson.decodeFromString<ProjectSection>("\"$name\"")
            assertEquals(ProjectSection.Advanced, section.settingsSection)
            assertEquals(group, advancedGroupFor(section.id))
        }
    }
}
