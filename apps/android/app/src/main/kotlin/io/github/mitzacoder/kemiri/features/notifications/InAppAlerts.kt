package io.github.mitzacoder.kemiri.features.notifications

import io.github.mitzacoder.kemiri.protocol.*
import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

internal const val IN_APP_ALERTS_FEATURE = "in-app-alerts"
private const val BURST_MS = 5_000L
private const val RECENT_MS = 120_000L

@Serializable
enum class AlertPopUps(val label: String) {
    @SerialName("everything") Everything("Everything"),
    @SerialName("needs-me") NeedsMe("Things that need me"),
    @SerialName("urgent") Urgent("Only urgent"),
    @SerialName("off") Off("Off"),
}

@Serializable
enum class AlertSoundsSetting(val label: String) {
    @SerialName("urgent-important") UrgentImportant("Urgent and important"),
    @SerialName("urgent") Urgent("Only urgent"),
    @SerialName("off") Off("Off"),
}

@Serializable
data class InAppAlertSettings(
    val popUps: AlertPopUps = AlertPopUps.NeedsMe,
    val sounds: AlertSoundsSetting = AlertSoundsSetting.Urgent,
    val showMessageText: Boolean = true,
    val doNotDisturb: AlertPause = AlertPause.Off,
    val doNotDisturbUntil: Long? = null,
) {
    fun disturbedAt(now: Long): Boolean = (doNotDisturbUntil ?: 0L) > now

    fun withPause(pause: AlertPause, now: Long, zone: ZoneId = ZoneId.systemDefault()): InAppAlertSettings = copy(
        doNotDisturb = pause,
        doNotDisturbUntil = when (pause) {
            AlertPause.Off -> null
            AlertPause.OneHour -> now + 3_600_000L
            AlertPause.Tomorrow -> Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
                .plusDays(1).atTime(8, 0).atZone(zone).toInstant().toEpochMilli()
            AlertPause.Indefinite -> Long.MAX_VALUE
        },
    )
}

@Serializable
enum class AlertPause(val label: String) {
    Off("Off"), OneHour("1 hour"), Tomorrow("Until tomorrow morning"), Indefinite("Until turned off"),
}

@Serializable
internal data class AlertCursor(val epoch: String, val seq: Long)

internal data class InAppAlert(val backendKey: String, val alert: NotificationAlert) {
    val project get() = backendKey to alert.projectId
    val identity get() = backendKey to alert.key
    val urgent get() = alert.level == "urgent"
    val important get() = alert.level == "important"
    val sticky get() = urgent || alert.warning == true
    val inboxOnly get() = alert.level == "inbox" || alert.kind in setOf("compaction_failed", "maintenance_failed")

    fun onScreen(screen: AppPresence): Boolean = sameProject(screen) && (
        screen.taskId != null && screen.taskId == alert.taskId ||
            screen.coordinatorId != null && screen.coordinatorId == (alert.coordinatorId ?: alert.threadId ?: MAIN_THREAD_ID)
        )

    fun sameProject(screen: AppPresence): Boolean = alert.projectId != null && project == (screen.backendKey to screen.projectId)

    fun canPopUp(screen: AppPresence, settings: InAppAlertSettings, muted: Boolean, now: Long): Boolean =
        screen.visible && !muted && !settings.disturbedAt(now) && !inboxOnly && !onScreen(screen) && when (settings.popUps) {
            AlertPopUps.Everything -> urgent || important || alert.level == "info"
            AlertPopUps.NeedsMe -> urgent || important
            AlertPopUps.Urgent -> urgent
            AlertPopUps.Off -> false
        }

    fun inlineChoices() = alert.choices.orEmpty().takeIf { choices ->
        alert.kind == "board_question" && alert.projectId != null && alert.questionId != null && alert.questionRevision != null &&
            alert.warning != true && alert.approval != true && choices.size in 1..3 &&
            choices.all { it.label.isNotBlank() && it.label.codePointCount(0, it.label.length) <= 24 }
    }.orEmpty()
}

internal enum class AlertTone { Urgent, Soft }

/** Device-wide limits with a separate soft-note limit per project on each backend. */
internal class AlertSoundPolicy {
    private var lastTone: Long? = null
    private val lastSoftByProject = mutableMapOf<Pair<String, String?>, Long>()

    fun play(
        item: InAppAlert, permitted: Boolean, screen: AppPresence, settings: InAppAlertSettings,
        muted: Boolean, quietHours: QuietHours?, now: Long, elapsed: Long, playback: (AlertTone) -> Boolean,
    ): Boolean {
        if (!permitted || !screen.visible || item.sameProject(screen) || muted || item.inboxOnly ||
            settings.disturbedAt(now) || inAppQuietHours(quietHours, now)) return false
        val tone = when {
            item.urgent && settings.sounds != AlertSoundsSetting.Off -> AlertTone.Urgent
            item.important && settings.sounds == AlertSoundsSetting.UrgentImportant -> AlertTone.Soft
            else -> return false
        }
        if (lastTone?.let { elapsed - it < 8_000 } == true) return false
        lastSoftByProject.entries.removeAll { elapsed - it.value >= RECENT_MS }
        if (tone == AlertTone.Soft && item.project in lastSoftByProject) return false
        if (!playback(tone)) return false
        lastTone = elapsed
        if (tone == AlertTone.Soft) lastSoftByProject[item.project] = elapsed
        return true
    }
}

private fun inAppQuietHours(quietHours: QuietHours?, now: Long): Boolean {
    if (quietHours == null) return false
    val zone = runCatching { ZoneId.of(quietHours.timezone) }.getOrDefault(ZoneId.systemDefault())
    val time = Instant.ofEpochMilli(now).atZone(zone)
    // Push's “Still notify failures” does not override local silence.
    return quietHoursActive(quietHours, time.hour * 60 + time.minute)
}

/** A replay has no sound permission. Only a live event can grant it. */
internal data class AlertCatchUp(val alerts: List<InAppAlert>, val summarize: Boolean)

internal fun alertCatchUp(
    backendKey: String, saved: AlertCursor?, recent: NotificationsRecentResponse, now: Long,
    eligible: (InAppAlert) -> Boolean,
): AlertCatchUp {
    if (saved == null || saved.epoch != recent.backendEpoch) return AlertCatchUp(emptyList(), false)
    val alerts = recent.events.filterIsInstance<NotificationRecentEntryAlert>()
        .filter { it.alert.seq > saved.seq }
        .sortedByDescending { it.alert.seq }
        .distinctBy { it.alert.tag }
        .asReversed()
        .filterNot { it.resolved }
        .map { InAppAlert(backendKey, it.alert) }
        .filter(eligible)
    return AlertCatchUp(alerts, alerts.size > 3 || alerts.any {
        val at = runCatching { Instant.parse(it.alert.at).toEpochMilli() }.getOrNull()
        at == null || now - at >= RECENT_MS
    })
}

internal enum class AlertBannerKind { Single, Burst, CatchUp }

internal data class AlertBanner(
    val id: Long,
    val kind: AlertBannerKind,
    val alerts: List<InAppAlert>,
    val arrivedAt: Long,
    val visibleMs: Long = 0,
) {
    val latest get() = alerts.last()
    val level get() = when {
        alerts.any { it.urgent } -> "Urgent"
        alerts.any { it.important } -> "Important"
        else -> "Info"
    }
    val durationMs get() = when {
        alerts.any { it.sticky } -> 600_000L
        level == "Important" -> 10_000L
        else -> 6_000L
    }
}

/** Holds only pending banners. The clock counts only the banner actually shown in the foreground. */
internal class AlertBannerQueue {
    private var nextId = 0L
    private var presenting: Pair<Long, Long>? = null
    private val banners = mutableListOf<AlertBanner>()
    val ordered get() = banners.sortedWith(compareByDescending<AlertBanner> { it.alerts.any { alert -> alert.sticky } }.thenByDescending { it.id })

    fun add(alert: InAppAlert, elapsed: Long) {
        val index = banners.indexOfFirst { it.alerts.any { old -> old.backendKey == alert.backendKey && old.alert.tag == alert.alert.tag } }
        if (index != -1) {
            val previous = banners[index]
            banners[index] = previous.copy(alerts = previous.alerts.map {
                if (it.backendKey == alert.backendKey && it.alert.tag == alert.alert.tag) alert else it
            })
            return
        }
        val sameProject = banners.filter { it.kind != AlertBannerKind.CatchUp && it.latest.project == alert.project && elapsed - it.arrivedAt < BURST_MS }
        val burst = sameProject.firstOrNull { it.kind == AlertBannerKind.Burst }
        if (alert.alert.projectId != null && (burst != null || sameProject.sumOf { it.alerts.size } >= 3)) {
            val siblings = sameProject.flatMap { it.alerts } + alert
            banners.removeAll(sameProject.toSet())
            banners += (burst?.copy(alerts = siblings, arrivedAt = elapsed) ?: AlertBanner(++nextId, AlertBannerKind.Burst, siblings, elapsed))
        } else banners += AlertBanner(++nextId, AlertBannerKind.Single, listOf(alert), elapsed)
    }

    fun addCatchUp(catchUp: AlertCatchUp, elapsed: Long) {
        if (catchUp.summarize) {
            catchUp.alerts.forEach { resolve(it.backendKey, setOf(it.alert.tag)) }
            banners += AlertBanner(++nextId, AlertBannerKind.CatchUp, catchUp.alerts, elapsed)
        } else catchUp.alerts.forEach { add(it, elapsed) }
    }

    fun resolve(backendKey: String, tags: Set<String>) = retain { it.backendKey != backendKey || it.alert.tag !in tags }

    fun retain(keep: (InAppAlert) -> Boolean) {
        for (index in banners.indices.reversed()) {
            val banner = banners[index]
            val remaining = banner.alerts.filter(keep)
            if (remaining.isEmpty()) banners.removeAt(index)
            else if (remaining != banner.alerts) banners[index] = banner.copy(alerts = remaining)
        }
    }

    fun dismiss(id: Long) { banners.removeAll { it.id == id } }

    fun startPresenting(id: Long, elapsed: Long): Long? {
        stopPresenting(presenting?.first, elapsed)
        val banner = ordered.firstOrNull()?.takeIf { it.id == id } ?: return null
        presenting = id to elapsed
        return (banner.durationMs - banner.visibleMs).coerceAtLeast(0)
    }

    fun stopPresenting(id: Long?, elapsed: Long) {
        val (_, since) = presenting?.takeIf { it.first == id } ?: return
        presenting = null
        val index = banners.indexOfFirst { it.id == id }
        if (index != -1) banners[index] = banners[index].let { it.copy(visibleMs = it.visibleMs + (elapsed - since).coerceAtLeast(0)) }
    }
}
