package io.github.mitzacoder.kemiri.notifications

import io.github.mitzacoder.kemiri.features.notifications.*
import io.github.mitzacoder.kemiri.protocol.*
import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

class InAppAlertsTest {
    private val now = Instant.parse("2026-01-17T23:00:00Z").toEpochMilli()
    private val foreground = AppPresence(visible = true)
    private val defaults = InAppAlertSettings()
    private val bakery = "https://bakery.example.test"
    private val recipes = "https://recipes.example.test"
    private val questionChoices = listOf(NotificationPayloadQuestionChoicesItem("Grams", true), NotificationPayloadQuestionChoicesItem("Cups", false))

    private fun alert(
        level: String = "urgent", seq: Long = 1, kind: String = "board_question", tag: String = "tag-$seq",
        backend: String = bakery, project: String = "bread", age: Long = 0,
    ) = InAppAlert(backend, NotificationAlert(kind, "Choose units", "Both units are available.", "server-key", project,
        null, null, coordinatorId = "menu", taskId = "T1", tag = tag,
        at = Instant.ofEpochMilli(now - age).toString(), seq = seq, key = "key-$seq", level = level, backendEpoch = "epoch",
        questionId = "Q1", questionRevision = 1, choices = questionChoices))

    private fun InAppAlert.popUp(settings: InAppAlertSettings = defaults, screen: AppPresence = foreground, muted: Boolean = false) =
        canPopUp(screen, settings, muted, now)

    @Test fun sharedWebPolicyCases() {
        val fixture = requireNotNull(javaClass.getResourceAsStream("/in-app-alert-policy-cases.json"))
            .bufferedReader().use { it.readText() }
        val cases = Json.decodeFromString<List<SharedPolicyCase>>(fixture)
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            val (name, input, context, burst, expected) = case
            val screen = context.screen
            val presence = AppPresence(context.visible, screen?.backendId, screen?.projectId, screen?.coordinatorId, screen?.taskId)
            val item = alert(input.level, kind = input.kind, backend = context.backendId).let {
                it.copy(alert = it.alert.copy(projectId = input.projectId, coordinatorId = input.coordinatorId,
                    taskId = input.taskId, threadId = input.threadId))
            }
            val decision = item.popUpDecision(presence, defaults.copy(popUps = context.setting), false, now, context.soundAllowed)
            val merges = decision.pop && item.alert.projectId != null && burst != null &&
                mergesAlertBurst(burst.previousProjectArrivals, burst.now)
            assertEquals(name, expected, ExpectedPolicy(decision.pop, decision.silent, merges))
        }
    }

    @Serializable
    private data class SharedPolicyCase(val name: String, val alert: FixtureAlert, val context: FixtureContext,
        val burst: FixtureBurst? = null, val expected: ExpectedPolicy)

    @Serializable
    private data class FixtureAlert(val kind: String, val level: String, val projectId: String?,
        val coordinatorId: String? = null, val taskId: String? = null, val threadId: String? = null)

    @Serializable
    private data class FixtureContext(val backendId: String, val setting: AlertPopUps, val visible: Boolean,
        val soundAllowed: Boolean, val screen: FixtureScreen? = null)

    @Serializable
    private data class FixtureScreen(val backendId: String, val projectId: String, val coordinatorId: String? = null,
        val taskId: String? = null)

    @Serializable
    private data class FixtureBurst(val now: Long, val previousProjectArrivals: List<Long>)

    @Serializable
    private data class ExpectedPolicy(val pop: Boolean, val silent: Boolean, val merge: Boolean)

    @Test fun popUpMatrix() {
        val allowed = mapOf(AlertPopUps.Everything to listOf("urgent", "important", "info"),
            AlertPopUps.NeedsMe to listOf("urgent", "important"), AlertPopUps.Urgent to listOf("urgent"), AlertPopUps.Off to emptyList())
        for ((setting, allowedLevels) in allowed) for (level in listOf("urgent", "important", "info", "inbox")) {
            assertEquals("$setting/$level", level in allowedLevels, alert(level).popUp(defaults.copy(popUps = setting)))
        }
        for (kind in listOf("compaction_failed", "maintenance_failed")) {
            assertFalse(alert("info", kind = kind).popUp(defaults.copy(popUps = AlertPopUps.Everything)))
        }
        assertFalse(alert().popUp(screen = AppPresence()))
        assertFalse(alert().popUp(muted = true))
        assertTrue(alert().popUpDecision(foreground, defaults, true, now, true).silent)
    }

    @Test fun sameProjectAndTheExactChatOrTaskAreOnScreen() {
        val screen = foreground.copy(backendKey = bakery, projectId = "bread", coordinatorId = "menu")
        assertFalse(alert().popUp(screen = screen))
        assertFalse(alert().popUp(screen = screen.copy(coordinatorId = null, taskId = "T1")))
        assertTrue(alert().popUp(screen = screen.copy(taskId = "T2")))
        assertFalse(alert().popUpDecision(screen.copy(coordinatorId = null, taskId = "T2"), defaults, false, now, true).silent)
        assertTrue(alert().popUp(screen = screen.copy(coordinatorId = "ordering")))
        assertTrue(alert(backend = recipes).popUp(screen = screen))
        assertTrue(alert(project = "cakes").popUp(screen = screen))
        assertEquals(bakery, alert().pushPayload().backendKey)
    }

    @Test fun burstsArePerBackendAndProjectAndResolveByTag() {
        val queue = AlertBannerQueue()
        for (seq in 1L..3) queue.add(alert(seq = seq), seq * 1_000)
        queue.add(alert(seq = 6, backend = recipes), 3_500)
        queue.add(alert(seq = 4), 6_000)
        val burst = queue.ordered.single { it.kind == AlertBannerKind.Burst }
        assertEquals(listOf(1L, 2L, 3L, 4L), burst.alerts.map { it.alert.seq })
        assertEquals(2, queue.ordered.size)
        queue.resolve(bakery, setOf("tag-4"))
        assertEquals(3, queue.ordered.single { it.id == burst.id }.alerts.size)
        queue.add(alert(seq = 5), 9_001)
        assertEquals(3, queue.ordered.size)
        queue.resolve(bakery, setOf("tag-1", "tag-2", "tag-3"))
        assertFalse(queue.ordered.any { it.id == burst.id })
    }

    @Test fun replacementsKeepPositionAndResolutionIsBackendScoped() {
        val queue = AlertBannerQueue()
        queue.add(alert(), 0)
        val id = queue.ordered.single().id
        queue.add(alert(seq = 2, tag = "tag-1"), 10)
        queue.add(alert(backend = recipes), 15)
        assertEquals(2L, queue.ordered.single { it.id == id }.latest.alert.seq)
        queue.resolve(bakery, setOf("tag-1"))
        assertEquals(recipes, queue.ordered.single().latest.backendKey)
    }

    @Test fun onlyTheDisplayedBannerSpendsItsForegroundTime() {
        val queue = AlertBannerQueue()
        queue.add(alert("info", project = "cakes"), 100)
        queue.add(alert("important", seq = 2), 200)
        queue.add(alert("important", seq = 3).let { it.copy(alert = it.alert.copy(warning = true)) }, 300)
        queue.add(alert(seq = 4), 400)
        assertEquals(listOf(600_000L, 600_000L, 10_000L, 6_000L), queue.ordered.map { it.durationMs })
        val important = queue.ordered[2]
        assertNull(queue.startPresenting(important.id, 500))
        queue.ordered.take(2).forEach { queue.dismiss(it.id) }
        assertEquals(10_000L, queue.startPresenting(important.id, 5_000)!!)
        queue.stopPresenting(important.id, 8_000)
        assertEquals(7_000L, queue.startPresenting(important.id, 30_000)!!)
    }

    @Test fun firstConnectionAndChangedEpochDoNotShowOldEvents() {
        val page = page(alert())
        assertTrue(alertCatchUp(bakery, null, page, now) { true }.alerts.isEmpty())
        assertTrue(alertCatchUp(bakery, AlertCursor("old-epoch", 1), page, now) { true }.alerts.isEmpty())
        assertTrue(alertCatchUp(bakery, AlertCursor("epoch", 1), page, now) { true }.alerts.isEmpty())
    }

    @Test fun catchUpShowsThreeFreshOpenEventsOtherwiseSummarizes() {
        val cursor = AlertCursor("epoch", 0)
        val fresh = listOf(alert(seq = 1), alert(seq = 2), alert(seq = 3, project = "cakes"))
        fun catchUp(vararg alerts: InAppAlert) = alertCatchUp(bakery, cursor, page(*alerts), now) { it.popUp() }
        assertEquals(AlertCatchUp(fresh, false), catchUp(*fresh.toTypedArray()))
        assertTrue(catchUp(*(fresh + alert(seq = 4)).toTypedArray()).summarize)
        assertTrue(catchUp(alert(age = 120_000)).summarize)
        assertFalse(catchUp(alert(age = 119_999)).summarize)
        val updated = alert(seq = 4, tag = "tag-1")
        val resolved = page(*fresh.toTypedArray()).copy(events = page(*fresh.toTypedArray()).events + NotificationRecentEntryAlert(alert = updated.alert, resolved = true))
        assertEquals(fresh.drop(1), alertCatchUp(bakery, cursor, resolved, now) { true }.alerts)
    }

    private fun page(vararg alerts: InAppAlert) = NotificationsRecentResponse(id = "request", backendEpoch = "epoch",
        latestSeq = alerts.maxOf { it.alert.seq }, events = alerts.map { NotificationRecentEntryAlert(alert = it.alert, resolved = false) })

    @Test fun onlyShortOrdinaryQuestionsCanBeAnsweredInline() {
        val question = alert()
        assertEquals(questionChoices, question.inlineChoices())
        for (ineligible in listOf(question.alert.copy(warning = true), question.alert.copy(approval = true), question.alert.copy(questionRevision = null),
            question.alert.copy(kind = "login_prompt"), question.alert.copy(choices = questionChoices + questionChoices),
            question.alert.copy(choices = listOf(questionChoices.first(), questionChoices.first())),
            question.alert.copy(choices = listOf(NotificationPayloadQuestionChoicesItem("x".repeat(25), true))))) {
            assertTrue(question.copy(alert = ineligible).inlineChoices().isEmpty())
        }
    }

    @Test fun permissionLevelsAndQuietRulesGateSoundBeforePlayback() {
        val policy = AlertSoundPolicy()
        val tones = mutableListOf<AlertTone>()
        fun play(item: InAppAlert = alert(), permission: Boolean = true, screen: AppPresence = foreground,
            settings: InAppAlertSettings = defaults, quiet: QuietHours? = null) =
            policy.play(item, permission, screen, settings, false, quiet, now, 0) { tones.add(it) }
        assertFalse(play(permission = false)) // Replay and summaries never grant permission.
        assertFalse(play(item = alert("important")))
        assertFalse(play(item = alert("info"), settings = defaults.copy(sounds = AlertSoundsSetting.UrgentImportant)))
        assertFalse(play(screen = foreground.copy(backendKey = bakery, projectId = "bread", coordinatorId = "another")))
        assertFalse(play(quiet = QuietHours("22:30", "06:00", "UTC", allowFailures = true), item = alert(kind = "deploy_problem")))
        assertFalse(play(settings = defaults.withPause(AlertPause.Indefinite, now)))
        assertFalse(play(settings = defaults.copy(sounds = AlertSoundsSetting.Off)))
        assertFalse(play(settings = defaults.copy(popUps = AlertPopUps.Off)))
        assertTrue(play())
        assertEquals(listOf(AlertTone.Urgent), tones)
    }

    @Test fun soundUsesGlobalAndPerProjectLimits() {
        val policy = AlertSoundPolicy()
        val settings = defaults.copy(sounds = AlertSoundsSetting.UrgentImportant)
        fun play(elapsed: Long, item: InAppAlert = alert("important"), played: Boolean = true) =
            policy.play(item, true, foreground, settings, false, null, now, elapsed) { played }
        assertFalse(play(0, played = false))
        assertTrue(play(0))
        assertFalse(play(7_999, alert()))
        assertTrue(play(8_000, alert()))
        assertTrue(play(16_000, alert("important", backend = recipes)))
        assertFalse(play(119_999))
        assertTrue(play(120_000))
    }

    @Test fun doNotDisturbUsesDeviceMorningAndExpires() {
        val paused = defaults.withPause(AlertPause.OneHour, now)
        assertFalse(alert().popUp(paused))
        assertTrue(paused.disturbedAt(now + 3_599_999))
        assertFalse(paused.disturbedAt(now + 3_600_000))
        assertEquals(Instant.parse("2026-01-18T08:00:00Z").toEpochMilli(),
            defaults.withPause(AlertPause.Tomorrow, now, ZoneId.of("UTC")).doNotDisturbUntil!!)
        assertFalse(paused.withPause(AlertPause.Off, now).disturbedAt(now))
    }
}
