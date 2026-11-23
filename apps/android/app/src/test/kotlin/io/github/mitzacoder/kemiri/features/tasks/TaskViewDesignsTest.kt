package io.github.mitzacoder.kemiri.features.tasks

import io.github.mitzacoder.kemiri.data.DeviceSettings
import io.github.mitzacoder.kemiri.data.wireJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class TaskViewDesignsTest {
    @Test fun `registry only offers Classic and resolves every registered id`() {
        val designs = TaskViewDesigns.entries
        assertEquals(designs.size, designs.map { it.id }.toSet().size)
        assertEquals(listOf("classic"), designs.map { it.id })
        assertEquals("Classic", designs.single().label)
        for (design in designs) {
            assertTrue(design.id.isNotBlank() && design.label.isNotBlank())
            assertTrue(design.description.isNotBlank() && '\n' !in design.description)
            assertSame(design, TaskViewDesigns.resolve(design.id))
        }
    }

    @Test fun `missing choice in existing settings defaults to Classic`() {
        val settings = wireJson.decodeFromString(DeviceSettings.serializer(), """{"timeFormat":"Hour24"}""")
        assertEquals("classic", settings.taskViewDesignId)
        assertEquals("classic", TaskViewDesigns.resolve(settings.taskViewDesignId).id)
        assertEquals("classic", TaskViewDesigns.resolve(null).id)
    }

    @Test fun `unknown or retired stored choice falls back without losing device settings`() {
        for (id in listOf("unavailable-design", "route")) {
            val saved = DeviceSettings(deviceId = "test-device", taskViewDesignId = id)
            val json = wireJson.encodeToString(DeviceSettings.serializer(), saved)
            val settings = wireJson.decodeFromString(DeviceSettings.serializer(), json)
            assertEquals(saved, settings)
            assertEquals("classic", TaskViewDesigns.resolve(settings.taskViewDesignId).id)
        }
    }
}
