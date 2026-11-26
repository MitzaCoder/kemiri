package io.github.mitzacoder.kemiri.notifications

import io.github.mitzacoder.kemiri.features.notifications.*
import java.io.File
import org.junit.Assert.*
import org.junit.Test

class NotificationPresetsTest {
    @Test fun presetsMatchTheProtocolLists() {
        val protocol = generateSequence(File(".").canonicalFile) { it.parentFile }
            .map { it.resolve("packages/protocol/src/notifications.ts") }.first { it.isFile }.readText()
        val kindNames = Regex("\"([a-z_]+)\"")
        fun names(text: String) = kindNames.findAll(text).map { it.groupValues[1] }.toSet()
        fun protocolList(name: String) = names(protocol.substringAfter("export const $name:").substringAfter("= [").substringBefore("];"))
        val all = names(protocol.substringAfter("export const NotificationKindSchema = Type.Union(").substringBefore("],"))
        val failures = protocolList("NOTIFICATION_FAILURE_KINDS")
        assertEquals(protocolList("DEFAULT_NOTIFICATION_KINDS") + "later_back", NotificationPreset.Important.kinds?.toSet())
        assertEquals(failures + setOf("login_prompt", "board_question", "task_review", "task_steps", "later_back"), NotificationPreset.Needed.kinds?.toSet())
        assertEquals(all, NotificationPreset.Everything.kinds?.toSet())
        assertEquals(failures, NOTIFICATION_ALERT_GROUPS.getValue("Problems").toSet())
        val individual = NOTIFICATION_ALERT_GROUPS.values.flatten()
        assertEquals(all, individual.toSet())
        assertEquals(all.size, individual.size)
    }

    @Test fun presetIsDerivedBySetEquality() {
        for (preset in NotificationPreset.entries.filter { it.kinds != null }) {
            val kinds = checkNotNull(preset.kinds)
            assertEquals(preset, notificationPreset(kinds.reversed() + kinds.first()))
        }
        assertEquals(NotificationPreset.Custom, notificationPreset(emptyList()))
        assertEquals(NotificationPreset.Custom, notificationPreset(DEFAULT_NOTIFICATION_KINDS - "reply"))
        assertNull(NotificationPreset.Custom.kinds)
    }
}
