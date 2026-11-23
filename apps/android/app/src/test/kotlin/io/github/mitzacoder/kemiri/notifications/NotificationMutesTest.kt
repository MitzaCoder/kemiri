package io.github.mitzacoder.kemiri.notifications

import io.github.mitzacoder.kemiri.data.ConnectionState
import io.github.mitzacoder.kemiri.data.ConnectionStatus
import io.github.mitzacoder.kemiri.data.wireJson
import io.github.mitzacoder.kemiri.features.notifications.*
import io.github.mitzacoder.kemiri.protocol.*
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class NotificationMutesTest {
    private val studio = "https://studio.example.test"
    private val lab = "https://lab.example.test"
    private val now = 2_000_000_000_000L

    @Test fun muteAppliesWithoutPushAndUsesExactExpiry() {
        val timed = NotificationSettings().withMute(studio, "recipes", NotificationMute(now + 50))
        assertFalse(timed.enabled)
        assertTrue(timed.isMuted(studio, "recipes", now + 49))
        assertFalse(timed.isMuted(studio, "recipes", now + 50))
        assertFalse(timed.isMuted(studio, null, now))
        assertFalse(timed.isMuted(lab, "recipes", now))
        val backend = timed.withMute(studio, null, NotificationMute(now + 100))
        assertTrue(backend.isMuted(studio, null, now + 50))
        assertTrue(backend.isMuted(studio, "garden", now + 50))
        assertFalse(backend.isMuted(studio, "garden", now + 100))
    }

    @Test fun timedAndIndefiniteEditsReplaceEachOtherWithoutDuplicateRows() {
        val forever = NotificationSettings().withMuted(studio, "recipes", true)
        assertEquals(listOf("recipes"), forever.preferencesFor(studio, now).mutedProjects)
        val timed = forever.withMute(studio, "recipes", NotificationMuteDuration.EightHours.startingAt(now))
        val until = now + 8L * 3_600_000
        assertEquals(listOf(ActiveNotificationMute(studio, "recipes", until)), timed.activeMutes(now))
        assertTrue(timed.preferencesFor(studio, now).mutedProjects.isEmpty())
        assertEquals(listOf(NotificationProjectMute("recipes", until)), timed.preferencesFor(studio, now).projectMutes)
        assertEquals(forever, timed.withMuted(studio, "recipes", true))
        assertEquals(NotificationSettings(), timed.withMute(studio, "recipes", null))
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    @Test fun listLosesExpiredRowsWithoutASettingsWrite() = runTest {
        val settings = MutableStateFlow(NotificationSettings()
            .withMute(studio, "recipes", NotificationMute(now + 50))
            .withMute(lab, null, NotificationMute(now + 80)))
        val lists = mutableListOf<List<ActiveNotificationMute>>()
        backgroundScope.launch { settings.activeMuteChanges { now + currentTime }.collect { lists.add(it) } }
        runCurrent()
        assertEquals(listOf(lab, studio), lists.last().map { it.backendKey })
        advanceTimeBy(50)
        runCurrent()
        assertEquals(listOf(lab), lists.last().map { it.backendKey })
        advanceTimeBy(30)
        runCurrent()
        assertTrue(lists.last().isEmpty())
    }

    @Test fun pushSyncOnlySendsNewFieldsToSupportingBackends() = runTest {
        val sent = mutableListOf<NotificationPreferences>()
        val rpc = object : NotificationRegistrationRpc {
            override suspend fun register(request: NotificationsRegisterFcmRequest): NotificationDevice {
                sent += request.preferences
                return NotificationDevice(request.deviceId, request.label, request.backendKey, request.preferences,
                    "2026-01-01T00:00:00Z", null, transport = "fcm")
            }
            override suspend fun device(deviceId: String): NotificationDevice? = null
            override suspend fun unregister(deviceId: String) = Unit
        }
        val settings = NotificationSettings(enabled = true, fcmToken = "synthetic")
            .withMuted(studio, "garden", true)
            .withMute(studio, "recipes", NotificationMute(now + 60))
            .withMute(studio, null, NotificationMute())
        val restored = wireJson.decodeFromString(NotificationSettings.serializer(), wireJson.encodeToString(NotificationSettings.serializer(), settings))
        assertEquals(settings, restored)
        for (features in listOf(listOf("fcm-push"), listOf("fcm-push", "notification-timed-mutes"))) {
            val connection = ConnectionState(ConnectionStatus.Ready,
                hello = HelloResponse(id = "hello", server = HelloResponseServer("Example", "1"), features = features))
            syncNotificationRegistration(restored, connection, "device", studio, "Phone", rpc) { null }
        }
        assertEquals(listOf("garden"), sent.first().mutedProjects)
        assertNull(sent.first().projectMutes)
        assertNull(sent.first().backendMute)
        assertEquals(listOf("garden"), sent.last().mutedProjects)
        assertEquals(listOf(NotificationProjectMute("recipes", now + 60)), sent.last().projectMutes)
        assertEquals(NotificationMute(), sent.last().backendMute)
        assertNull(settings.preferencesFor(studio, now + 60).projectMutes)
        assertNull(settings.preferencesFor(lab, now).backendMute)
        assertNull(settings.withMute(studio, null, null).preferencesFor(studio, now).backendMute)
    }
}
